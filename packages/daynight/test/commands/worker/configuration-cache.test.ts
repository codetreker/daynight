import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configurationCacheChunks, createConfigurationCache, parseConfigurationCache, readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudItemKey } from "../../../src/api/worker-configuration.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";

const uuid = (n: number): string => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const generation = uuid(1), projectId = uuid(2), previousProjectId = uuid(3);
const identity = { serverOrigin: "https://daynight.example", userId: uuid(4), workerId: uuid(5) };
const native = { agent: "codex" as const, model: "current", args: ["--search"] };
const desired: WorkerCloudDesired = { revision: "10", updatedAt: "2026-11-04T00:00:00Z", value: {
  maxConcurrent: 4, pollIntervalMs: 1500, recoveryLimit: 2, preferPlatformSpecificTasks: true, native,
  agentControlMode: "web", projects: [{ projectId, nativeOverrides: {} }],
} };
const failure = { code: "permission_denied" as const, category: "runtime" as const, phase: "stop" as const, occurredAt: "2026-11-04T01:00:00Z" };
const value = (key: WorkerCloudItemKey): WorkerCloudItem["appliedValue"] => {
  switch (key.kind) {
    case "native": case "projectNative": return native;
    case "maxConcurrent": return 4;
    case "pollIntervalMs": return 1500;
    case "recoveryLimit": return 2;
    case "archiveSessions": case "preferPlatformSpecificTasks": case "projectPreparation": case "projectRemoval": return true;
    case "agentControlMode": return "web";
  }
};
const tracked = (n: number, key: WorkerCloudItemKey, revision = "10"): TrackedConfigurationItem => ({
  recordId: uuid(n), origin: { generation, targetRevision: revision, source: "application" },
  value: { key, targetRevision: revision, appliedValue: value(key), state: "applied", error: null, lastFailure: null, nextAttemptAt: null },
  backoffStep: 0, failureId: null, started: false, nativeMode: key.kind === "native" || key.kind === "projectNative" ? "web" : null,
  actualSource: { kind: "observed", recordId: uuid(n), generation, targetRevision: revision }, blockedByRemovalId: null,
});
const currentKeys: WorkerCloudItemKey[] = [
  { kind: "maxConcurrent" }, { kind: "pollIntervalMs" }, { kind: "recoveryLimit" }, { kind: "preferPlatformSpecificTasks" },
  { kind: "native" }, { kind: "agentControlMode" }, { kind: "projectPreparation", projectId }, { kind: "projectNative", projectId },
];
const cache = (): WorkerConfigurationCache => ({
  schemaVersion: 7, identity, authority: { generation, desiredJson: JSON.stringify(desired), applicationRevision: "10", observationRevision: "9" }, remoteObservation: null, nextFailureId: 6,
  projectionCursor: uuid(90), currentItems: currentKeys.map((key, n) => tracked(10 + n, key)), retainedItems: [],
});
const legacy = (version: 1 | 2 | 3 | 4) => {
  const initial = cache(), { agentControlMode: _mode, ...withoutMode } = desired.value;
  const legacyDesired = version === 1 ? (() => { const { preferPlatformSpecificTasks: _preference, ...previous } = withoutMode; return previous; })() : withoutMode;
  const items = initial.currentItems.filter(item => item.value.key.kind !== "agentControlMode" && (version !== 1 || item.value.key.kind !== "preferPlatformSpecificTasks")).map(item => ({ value: item.value, attempts: item.backoffStep, failureId: item.failureId, started: item.started }));
  return { schemaVersion: version, identity, desired: { ...desired, value: legacyDesired }, observationRevision: "9", nextFailureId: 6, items,
    ...(version >= 3 ? { nativeModes: { "native:": "web", [`projectNative:${projectId}`]: "web" } } : {}) };
};
const directories: string[] = [];
const directory = async (): Promise<string> => {
  const root = path.resolve(".tmp/configuration-cache-tests");
  await mkdir(root, { recursive: true });
  const result = await mkdtemp(path.join(root, "run-"));
  directories.push(result);
  return result;
};
afterEach(async () => { for (const folder of directories.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe("Worker configuration cache", () => {
  it("creates an immutable uninitialized cache with a fresh local generation", () => {
    const first = createConfigurationCache(identity), second = createConfigurationCache(identity);
    expect(first).toMatchObject({ schemaVersion: 7, identity, authority: { desiredJson: null, applicationRevision: null, observationRevision: "0" }, remoteObservation: null, currentItems: [], retainedItems: [], projectionCursor: null });
    expect(first.authority.generation).not.toBe(second.authority.generation);
    expect(Object.isFrozen(first.authority)).toBe(true);
    expect(parseConfigurationCache(first, identity)).toEqual({ cache: first, migrated: false });
  });

  it("upgrades schema 6 without inventing an applied archive value", () => {
    const original = cache();
    const old = { ...original, schemaVersion: 6, authority: { ...original.authority, desiredJson: JSON.stringify({ ...desired, value: { ...desired.value, archiveSessions: false } }) } };
    const upgraded = parseConfigurationCache(old, identity);
    expect(upgraded.migrated).toBe(true);
    expect(upgraded.cache.currentItems.find(item => item.value.key.kind === "archiveSessions")).toMatchObject({ value: { state: "pending", appliedValue: null, targetRevision: "10" }, actualSource: null });
    expect(parseConfigurationCache(upgraded.cache, identity).migrated).toBe(false);
  });

  it("preserves observed success provenance and a cursor whose record has retired", () => {
    const original = cache();
    const result = parseConfigurationCache(original, identity);
    expect(result).toEqual({ cache: original, migrated: false });
    expect(Object.isFrozen(result.cache.currentItems[0]!.actualSource)).toBe(true);
  });

  it("upgrades schema 5 without replacing its ledger identities, dependencies or retry facts", () => {
    const original = cache(), stop = tracked(60, { kind: "projectRemoval", projectId }, "9");
    const previous = original.currentItems[4]!;
    const currentItems = original.currentItems.map(item => item === previous ? {
      ...item, value: { ...item.value, state: "applying" as const, lastFailure: failure }, backoffStep: 4, failureId: 4,
    } : item.value.key.kind === "projectPreparation" ? { ...item, blockedByRemovalId: stop.recordId } : item);
    const { remoteObservation: _remote, authority: _authority, ...ledger } = original;
    const source = { ...ledger, schemaVersion: 5, authority: { generation, desired, observationRevision: "9" }, currentItems, retainedItems: [stop] };
    const result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache).toEqual({
      ...original, authority: { ...original.authority, desiredJson: expect.any(String) },
      currentItems: currentItems.map(item => item === currentItems[4] ? { ...item, value: { ...item.value, state: "pending" } } : item), retainedItems: [stop],
    });
    expect(JSON.parse(result.cache.authority.desiredJson!)).toEqual(desired);
    expect(source.currentItems[4]!.value.state).toBe("applying");
  });

  it("preserves future source values and older remote observation separately from the execution ledger", async () => {
    const original = cache();
    const desiredJson = JSON.stringify({ ...desired, revision: "12" }).replace('"value":{', '"value":{"future":{"__proto__":[-1.25,1e100000,900719925474099312345],"0":null},');
    const observationJson = '{"baseRevision":"6","desiredRevision":"11","reportedAt":"2026-11-04T02:00:00Z","items":[{"key":{"kind":"future"},"targetRevision":"11","appliedValue":[-1e-100000,900719925474099312345],"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}';
    const source = { ...original, authority: { ...original.authority, desiredJson }, remoteObservation: { observationRevision: "7", json: observationJson },
      currentItems: [...original.currentItems, tracked(80, { kind: "projectRemoval", projectId: previousProjectId }, "11")] };
    const folder = await directory(), file = path.join(folder, "future.json");
    await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(parseConfigurationCache(source, identity).cache), 0o600);
    const reopened = await readConfigurationCache(file, identity, new AbortController().signal);
    expect(reopened).toEqual({ cache: source, migrated: false });
    expect(reopened.cache.currentItems).toEqual(source.currentItems);
    expect(reopened.cache.retainedItems).toEqual([]);
  });

  it("validates optional hidden capability facts without changing older schema 6 caches", () => {
    const original = cache(), json = '{"codex":{"kind":"auto","future":[-1.25,900719925474099312345]},"copilot":null,"herdr":null}';
    const source = { ...original, hiddenCapabilitySources: { toolPaths: { revision: "10", json } } };
    expect(parseConfigurationCache(original, identity)).toEqual({ cache: original, migrated: false });
    expect(parseConfigurationCache(source, identity)).toEqual({ cache: source, migrated: false });
    for (const invalid of [
      { toolPaths: { revision: "11", json } },
      { toolPaths: { revision: "10", json: '{"codex":null,"codex":null,"copilot":null,"herdr":null}' } },
      { toolPaths: { revision: "10", json: '{"codex":false,"copilot":null,"herdr":null}' } },
      { agentControlMode: { revision: "10", json: '"web"' } },
      { future: { revision: "10", json } },
      {},
    ]) expect(() => parseConfigurationCache({ ...original, hiddenCapabilitySources: invalid }, identity)).toThrow();
  });

  it("retains the independent remote snapshot across lower or null authority recovery", () => {
    const remoteObservation = { observationRevision: "12", json: '{"baseRevision":"11","desiredRevision":"20","reportedAt":"2026-11-04T02:00:00Z","items":[]}' };
    const restored = { ...cache(), remoteObservation };
    expect(parseConfigurationCache(restored, identity).cache.remoteObservation).toEqual(remoteObservation);
    const empty = { ...createConfigurationCache(identity), remoteObservation };
    expect(parseConfigurationCache(empty, identity).cache).toEqual(empty);
  });

  it.each([1, 2, 3, 4] as const)("explicitly upgrades schema %i without inventing a prior success revision", version => {
    const source = legacy(version), result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache.schemaVersion).toBe(7);
    expect(JSON.parse(result.cache.authority.desiredJson!)).toEqual({ ...source.desired, value: { ...source.desired.value, preferPlatformSpecificTasks: version === 1 ? false : desired.value.preferPlatformSpecificTasks } });
    expect(result.cache.authority).toMatchObject({ applicationRevision: "10", observationRevision: "9" });
    expect(result.cache.remoteObservation).toBeNull();
    expect(result.cache.currentItems).toHaveLength(version === 1 ? source.items.length + 1 : source.items.length);
    expect(new Set(result.cache.currentItems.map(item => item.recordId)).size).toBe(result.cache.currentItems.length);
    for (const item of result.cache.currentItems) {
      expect(item.origin).toEqual({ generation: result.cache.authority.generation, targetRevision: "10", source: "schema4" });
      if (item.value.appliedValue !== null) expect(item.actualSource).toEqual({ kind: "schema4", successRevision: null });
    }
    if (version === 1) expect(JSON.parse(result.cache.authority.desiredJson!).value.preferPlatformSpecificTasks).toBe(false);
    expect(result.cache.currentItems.find(item => item.value.key.kind === "native")?.nativeMode).toBe(version >= 3 ? "web" : null);
    expect(parseConfigurationCache(result.cache, identity)).toEqual({ cache: result.cache, migrated: false });
  });

  it("moves unselected project history into retained while preserving original stop ownership and failures", () => {
    const source = legacy(4), history = tracked(50, { kind: "projectNative", projectId: previousProjectId }, "3");
    const stop = tracked(51, { kind: "projectRemoval", projectId: previousProjectId }, "4");
    source.items.push({ value: { ...history.value, lastFailure: failure }, attempts: 4, failureId: 4, started: false });
    source.items.push({ value: { ...stop.value, state: "applying", appliedValue: null }, attempts: 2, failureId: null, started: true });
    if ("nativeModes" in source) Object.assign(source.nativeModes, { [`projectNative:${previousProjectId}`]: "herdr" });
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.retainedItems).toHaveLength(1);
    expect(result.retainedItems[0]).toMatchObject({ value: { ...history.value, lastFailure: failure }, backoffStep: 4, failureId: 4, nativeMode: "herdr", actualSource: { kind: "schema4", successRevision: null } });
    expect(result.retainedItems[0]!.value.lastFailure).toEqual(failure);
    expect(result.currentItems.find(item => item.value.key.kind === "projectRemoval")).toMatchObject({ value: { targetRevision: "4", state: "pending", appliedValue: null }, started: true, backoffStep: 2, actualSource: null });
    expect(result.nextFailureId).toBe(source.nextFailureId);
  });

  it("accepts future historical provenance and a completed retained stop dependency", () => {
    const original = cache(), stop = tracked(60, { kind: "projectRemoval", projectId }, "20");
    const currentItems = original.currentItems.map(item => item.value.key.kind === "projectPreparation" ? { ...item, blockedByRemovalId: stop.recordId } : item);
    const retained = { ...tracked(61, { kind: "projectNative", projectId }, "30"), actualSource: { kind: "observed" as const, recordId: uuid(100), generation: uuid(101), targetRevision: "40" } };
    const source = { ...original, currentItems, retainedItems: [stop, retained, tracked(62, retained.value.key, "50")] };
    expect(parseConfigurationCache(source, identity)).toEqual({ cache: source, migrated: false });
  });

  it("keeps historical native tokens above current API limits structurally readable", () => {
    const original = cache(), hugeNative = { ...native, args: ["x".repeat(9000)] };
    const source = { ...original, retainedItems: [{ ...tracked(70, { kind: "projectNative", projectId: previousProjectId }, "30"), value: { ...tracked(70, { kind: "projectNative", projectId: previousProjectId }, "30").value, appliedValue: hugeNative } }] };
    expect(parseConfigurationCache(source, identity).cache.retainedItems[0]!.value.appliedValue).toEqual(hugeNative);
  });

  it("resets an interrupted application to pending while retaining actual and failure facts", () => {
    const original = cache(), previous = original.currentItems[4]!;
    const source = { ...original, currentItems: original.currentItems.map(item => item === previous ? { ...item, value: { ...item.value, state: "applying", lastFailure: failure }, failureId: 2, backoffStep: 3 } : item) };
    expect(parseConfigurationCache(source, identity).cache.currentItems[4]).toEqual({ ...source.currentItems[4], value: { ...source.currentItems[4]!.value, state: "pending" } });
  });

  const invalid: readonly [string, (input: WorkerConfigurationCache) => unknown][] = [
    ["unknown schema", input => ({ ...input, schemaVersion: 8 })],
    ["unknown fields", input => ({ ...input, extra: true })],
    ["missing application revision", input => ({ ...input, authority: { ...input.authority, applicationRevision: null } })],
    ["future application revision", input => ({ ...input, authority: { ...input.authority, applicationRevision: "11" } })],
    ["unmatched application revision", input => ({ ...input, authority: { ...input.authority, applicationRevision: "9" } })],
    ["duplicate desired keys", input => ({ ...input, authority: { ...input.authority, desiredJson: input.authority.desiredJson!.replace('"value":{', '"value":{"future":{"a":1,"a":2},') } })],
    ["invalid desired source", input => ({ ...input, authority: { ...input.authority, desiredJson: "not-json" } })],
    ["remote revision without matching base", input => ({ ...input, remoteObservation: { observationRevision: "10", json: '{"baseRevision":"8","desiredRevision":"10","reportedAt":"2026-11-04T02:00:00Z","items":[]}' } })],
    ["invalid remote source", input => ({ ...input, remoteObservation: { observationRevision: "8", json: "not-json" } })],
    ["different identity", input => ({ ...input, identity: { ...identity, workerId: uuid(99) } })],
    ["noncanonical record ID", input => ({ ...input, currentItems: [{ ...input.currentItems[0], recordId: "A0000000-1111-4111-8111-111111111111" }, ...input.currentItems.slice(1)] })],
    ["invalid generation", input => ({ ...input, authority: { ...input.authority, generation: "not-a-uuid" } })],
    ["duplicate record IDs", input => ({ ...input, retainedItems: [input.currentItems[0]] })],
    ["duplicate current keys", input => ({ ...input, currentItems: [...input.currentItems, { ...input.currentItems[0], recordId: uuid(80) }] })],
    ["missing required row", input => ({ ...input, currentItems: input.currentItems.slice(1) })],
    ["future current row", input => ({ ...input, currentItems: [...input.currentItems, tracked(81, { kind: "projectRemoval", projectId }, "11")] })],
    ["unselected current project", input => ({ ...input, currentItems: [...input.currentItems, tracked(82, { kind: "projectNative", projectId: previousProjectId })] })],
    ["mismatched origin revision", input => ({ ...input, currentItems: [{ ...input.currentItems[0], origin: { ...input.currentItems[0]!.origin, targetRevision: "9" } }, ...input.currentItems.slice(1)] })],
    ["out-of-range backoff", input => ({ ...input, currentItems: [{ ...input.currentItems[0], backoffStep: 6 }, ...input.currentItems.slice(1)] })],
    ["missing failure ID", input => ({ ...input, currentItems: [{ ...input.currentItems[0], value: { ...input.currentItems[0]!.value, lastFailure: failure } }, ...input.currentItems.slice(1)] })],
    ["exhausted failure sequence", input => ({ ...input, currentItems: [{ ...input.currentItems[0], failureId: 6, value: { ...input.currentItems[0]!.value, lastFailure: failure } }, ...input.currentItems.slice(1)] })],
    ["missing provenance", input => ({ ...input, currentItems: [{ ...input.currentItems[0], actualSource: null }, ...input.currentItems.slice(1)] })],
    ["invented legacy success revision", input => ({ ...input, currentItems: [{ ...input.currentItems[0], actualSource: { kind: "schema4", successRevision: "10" } }, ...input.currentItems.slice(1)] })],
    ["native mode on scalar", input => ({ ...input, currentItems: [{ ...input.currentItems[0], nativeMode: "web" }, ...input.currentItems.slice(1)] })],
    ["started nonremoval", input => ({ ...input, currentItems: [{ ...input.currentItems[0], started: true }, ...input.currentItems.slice(1)] })],
    ["missing removal dependency", input => ({ ...input, currentItems: [{ ...input.currentItems[0], blockedByRemovalId: uuid(100) }, ...input.currentItems.slice(1)] })],
  ];
  it.each(invalid)("rejects %s", (_name, mutate) => { expect(() => parseConfigurationCache(mutate(cache()), identity)).toThrow(); });

  it("rejects removal dependencies from another project or a cycle", () => {
    const original = cache(), first = tracked(90, { kind: "projectRemoval", projectId }, "9"), other = tracked(91, { kind: "projectRemoval", projectId: previousProjectId }, "9");
    expect(() => parseConfigurationCache({ ...original, retainedItems: [{ ...first, blockedByRemovalId: other.recordId }, other] }, identity)).toThrow("removal dependency");
    const second = tracked(92, first.value.key, "8");
    expect(() => parseConfigurationCache({ ...original, retainedItems: [{ ...first, blockedByRemovalId: second.recordId }, { ...second, blockedByRemovalId: first.recordId }] }, identity)).toThrow("cycle");
  });

  it("reads, upgrades, atomically writes and reopens a file with repeatable chunks", async () => {
    const folder = await directory(), file = path.join(folder, "configuration.json"), source = legacy(3);
    const { items, nativeModes, ...rest } = source;
    await replaceFileAtomicallyFromChunks(file, [JSON.stringify({ items, nativeModes, ...rest })], 0o600);
    const upgraded = await readConfigurationCache(file, identity, new AbortController().signal);
    expect(upgraded.migrated).toBe(true);
    const bytes = [...configurationCacheChunks(upgraded.cache)].join("");
    expect([...configurationCacheChunks(upgraded.cache)].join("")).toBe(bytes);
    await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(upgraded.cache), 0o600);
    expect(await readConfigurationCache(file, identity, new AbortController().signal)).toEqual({ cache: upgraded.cache, migrated: false });
  });

  it("propagates missing files and pre-cancelled reads", async () => {
    const folder = await directory(), file = path.join(folder, "missing.json");
    await expect(readConfigurationCache(file, identity, new AbortController().signal)).rejects.toMatchObject({ code: "ENOENT" });
    const controller = new AbortController(), error = new Error("cancelled");
    controller.abort(error);
    await expect(readConfigurationCache(file, identity, controller.signal)).rejects.toBe(error);
  });
});
