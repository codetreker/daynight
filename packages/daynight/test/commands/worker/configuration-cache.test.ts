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
    case "preferPlatformSpecificTasks": case "projectPreparation": case "projectRemoval": return true;
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
  schemaVersion: 5, identity, authority: { generation, desired, observationRevision: "9" }, nextFailureId: 6,
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
    expect(first).toMatchObject({ schemaVersion: 5, identity, authority: { desired: null, observationRevision: "0" }, currentItems: [], retainedItems: [], projectionCursor: null });
    expect(first.authority.generation).not.toBe(second.authority.generation);
    expect(Object.isFrozen(first.authority)).toBe(true);
    expect(parseConfigurationCache(first, identity)).toEqual({ cache: first, migrated: false });
  });

  it("preserves observed success provenance and a cursor whose record has retired", () => {
    const original = cache();
    const result = parseConfigurationCache(original, identity);
    expect(result).toEqual({ cache: original, migrated: false });
    expect(Object.isFrozen(result.cache.currentItems[0]!.actualSource)).toBe(true);
  });

  it.each([1, 2, 3, 4] as const)("explicitly upgrades schema %i without inventing a prior success revision", version => {
    const source = legacy(version), result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache.schemaVersion).toBe(5);
    expect(result.cache.authority).toMatchObject({ desired: source.desired, observationRevision: "9" });
    expect(result.cache.currentItems).toHaveLength(version === 1 ? source.items.length + 1 : source.items.length);
    expect(new Set(result.cache.currentItems.map(item => item.recordId)).size).toBe(result.cache.currentItems.length);
    for (const item of result.cache.currentItems) {
      expect(item.origin).toEqual({ generation: result.cache.authority.generation, targetRevision: "10", source: "schema4" });
      if (item.value.appliedValue !== null) expect(item.actualSource).toEqual({ kind: "schema4", successRevision: null });
    }
    if (version === 1) expect(result.cache.authority.desired?.value.preferPlatformSpecificTasks).toBe(false);
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
    ["unknown schema", input => ({ ...input, schemaVersion: 6 })],
    ["unknown fields", input => ({ ...input, extra: true })],
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
