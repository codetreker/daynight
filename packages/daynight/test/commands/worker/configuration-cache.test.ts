import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurationCacheChunks, createConfigurationCache, parseConfigurationCache, readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import { receiveWorkerDesired } from "../../../src/api/worker-configuration.js";
import type { TrackedConfigurationItem, WorkerConfigurationCache, WorkerCloudItem, WorkerCloudItemKey } from "../../../src/commands/worker/configuration-storage-types.js";
import type { WorkerConfigurationCache as ActiveCache } from "../../../src/commands/worker/configuration-model.js";
import type { WorkerCloudDesired } from "../../../src/api/worker-configuration.js";
import { taskTagFilterKey } from "../../../src/api/task-tag-filter.js";
import { replaceFileAtomicallyFromChunks } from "../../../src/platform/files.js";
import { configurationSnapshot, transitionConfigurationDesired } from "../../../src/commands/worker/configuration-state.js";

const uuid = (n: number): string => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const generation = uuid(1), projectId = uuid(2), previousProjectId = uuid(3);
const identity = { serverOrigin: "https://daynight.example", userId: uuid(4), workerId: uuid(5) };
const native = { agent: "codex" as const, model: "current", args: ["--search"] };
const desired: WorkerCloudDesired = { revision: "10", updatedAt: "2026-11-04T00:00:00Z", value: {
  maxConcurrent: 4, pollIntervalMs: 1500, recoveryLimit: 2, preferPlatformSpecificTasks: true, native,
  agentControlMode: "web", projects: [{ projectId, nativeOverrides: {} }],
} };
const modern = (target: WorkerCloudDesired, revision = target.revision): WorkerCloudDesired => {
  const { agentControlMode: _mode, ...rest } = target.value;
  return { ...target, revision, value: { ...rest, toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } } } };
};
const correct = (cache: ActiveCache, target: WorkerCloudDesired): ActiveCache => {
  let next = 1000;
  return transitionConfigurationDesired(cache, receiveWorkerDesired(JSON.stringify(modern(target, "12"))), new Set(), () => uuid(next++));
};
const failure = { code: "permission_denied" as const, category: "runtime" as const, phase: "stop" as const, occurredAt: "2026-11-04T01:00:00Z" };
// The storage wire types are frozen at the shape of deployed checkpoints, so
// they cannot name a member added afterwards. Fixtures for current envelopes
// still need one, and the decoder reads them through the active key type.
type FixtureKey = WorkerCloudItemKey | { readonly kind: "enableWindowsProcessCleanup" };
const value = (key: FixtureKey): WorkerCloudItem["appliedValue"] => {
  switch (key.kind) {
    case "native": case "projectNative": return native;
    case "maxConcurrent": return 4;
    case "pollIntervalMs": return 1500;
    case "recoveryLimit": return 2;
    case "archiveSessions": case "enableSudoCleanup": case "enableWindowsProcessCleanup": case "preferPlatformSpecificTasks": case "projectPreparation": case "projectRemoval": return true;
    case "agentControlMode": return "web";
  }
};
const tracked = (n: number, key: FixtureKey, revision = "10"): TrackedConfigurationItem => ({
  recordId: uuid(n), origin: { generation, targetRevision: revision, source: "application" },
  value: { key: key as WorkerCloudItemKey, targetRevision: revision, appliedValue: value(key), state: "applied", error: null, lastFailure: null, nextAttemptAt: null },
  backoffStep: 0, failureId: null, started: false, nativeMode: key.kind === "native" || key.kind === "projectNative" ? "web" : null,
  actualSource: { kind: "observed", recordId: uuid(n), generation, targetRevision: revision }, blockedByRemovalId: null,
});
const currentKeys: WorkerCloudItemKey[] = [
  { kind: "maxConcurrent" }, { kind: "pollIntervalMs" }, { kind: "recoveryLimit" }, { kind: "preferPlatformSpecificTasks" },
  { kind: "native" }, { kind: "agentControlMode" }, { kind: "projectPreparation", projectId }, { kind: "projectNative", projectId },
];
const cache = (): WorkerConfigurationCache => ({
  schemaVersion: 8, identity, authority: { generation, desiredJson: JSON.stringify(desired), applicationRevision: "10", observationRevision: "9" }, remoteObservation: null, nextFailureId: 6,
  projectionCursor: uuid(90), currentItems: currentKeys.map((key, n) => tracked(10 + n, key)), retainedItems: [],
});
const withoutMode = (item: TrackedConfigurationItem) => { const { nativeMode: _mode, ...rest } = item; return rest; };
const withoutModeItems = (items: readonly TrackedConfigurationItem[]) => items.filter(item => item.value.key.kind !== "agentControlMode").map(withoutMode);
const synchronizedSnapshot = (cache: ActiveCache) => configurationSnapshot(cache, true, new Map(), { codex: { kind: "auto" }, copilot: { kind: "auto" } }, (_cache, native) => ({ native, tools: [] }));
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
    expect(first).toMatchObject({ schemaVersion: 12, identity, authority: { desiredJson: null, applicationRevision: null, observationRevision: "0", pendingApplication: true }, remoteObservation: null, currentItems: [], retainedItems: [], projectionCursor: null });
    expect(first.authority.generation).not.toBe(second.authority.generation);
    expect(Object.isFrozen(first.authority)).toBe(true);
    expect(parseConfigurationCache(first, identity)).toEqual({ cache: first, migrated: false });
  });

  it("migrates schema 9 Web authority with a pending adoption while preserving other facts", () => {
    const original = cache(), failed = original.currentItems[0]!;
    const currentItems = withoutModeItems(original.currentItems.map(item => item === failed ? {
      ...item, value: { ...item.value, state: "error" as const, error: failure, lastFailure: failure, nextAttemptAt: "2026-11-04T02:00:00Z" }, backoffStep: 3, failureId: 4,
    } : item));
    const stop = { ...withoutMode(tracked(70, { kind: "projectRemoval", projectId: previousProjectId })), started: true,
      value: { ...tracked(70, { kind: "projectRemoval", projectId: previousProjectId }).value, state: "pending" as const, appliedValue: null }, actualSource: null };
    const remoteObservation = { observationRevision: "7", json: '{"baseRevision":"6","desiredRevision":"10","reportedAt":"2026-11-04T02:00:00Z","items":[]}' };
    const desiredJson = original.authority.desiredJson!.replace('"value":{', '"value":{"future":[-1e100000,900719925474099312345],');
    const source = { ...original, schemaVersion: 9, authority: { ...original.authority, desiredJson, pendingApplication: false }, currentItems, retainedItems: [stop], remoteObservation };
    const result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache.schemaVersion).toBe(12);
    expect(result.cache.authority).toMatchObject({ desiredJson, applicationRevision: "10", observationRevision: "9" });
    expect(result.cache.remoteObservation).toEqual(remoteObservation);
    expect(result.cache.currentItems.filter(item => item.value.key.kind !== "agentControlMode")).toEqual(currentItems);
    expect(result.cache.retainedItems).toEqual([stop]);
    expect(result.cache.authority.pendingApplication).toBe(true);
    expect(result.cache.currentItems.some(item => item.value.key.kind === "agentControlMode")).toBe(false);
    expect(parseConfigurationCache(result.cache, identity)).toEqual({ cache: result.cache, migrated: false });
  });

  it("restarts an unsupported schema 9 Web target without changing raw authority or applied archive and sudo facts", async () => {
    const original = cache(), archive = { ...tracked(80, { kind: "archiveSessions" }), value: { ...tracked(80, { kind: "archiveSessions" }).value, appliedValue: false } }, sudo = tracked(81, { kind: "enableSudoCleanup" });
    const raw = JSON.stringify({ ...desired, value: { ...desired.value, archiveSessions: false, enableSudoCleanup: true } });
    const source = { ...original, schemaVersion: 9, authority: { ...original.authority, desiredJson: raw, pendingApplication: false }, currentItems: withoutModeItems([...original.currentItems, archive, sudo]) };
    const folder = await directory(), file = path.join(folder, "historical.json"), signal = new AbortController().signal;
    await replaceFileAtomicallyFromChunks(file, [JSON.stringify(source)], 0o600);
    const applyNative = vi.fn(async () => {}), invalid = vi.fn(), options = { file, identity, signal, applyNative, onInvalidDesired: invalid };
    const first = await createWorkerConfigurationManager(options);
    await first.receive(receiveWorkerDesired(raw), "9"); await first.settle();
    expect(first.current().effective.native).toBeNull();
    expect(first.current().retainedArchiveSessions).toBe(false);
    expect(first.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "10" });
    expect(invalid).toHaveBeenCalledWith("10", "unsupported_configuration");
    await first.stop();
    const second = await createWorkerConfigurationManager(options);
    await second.receive(receiveWorkerDesired(raw), "9"); await second.settle();
    const saved = (await readConfigurationCache(file, identity, signal)).cache;
    expect(saved.authority).toMatchObject({ desiredJson: raw, applicationRevision: "10", pendingApplication: true });
    expect(saved.currentItems).toContainEqual(withoutMode(archive));
    expect(saved.currentItems).toContainEqual(withoutMode(sudo));
    expect(second.current().effective.native).toBeNull();
    expect(second.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "10" });
    expect(applyNative).not.toHaveBeenCalled();
    await second.receive(receiveWorkerDesired(JSON.stringify(modern({ ...desired, value: { ...desired.value, archiveSessions: false, enableSudoCleanup: true } }, "11"))), "9");
    await second.settle();
    expect(second.readCleanupPolicy()).toEqual({ enableSudoCleanup: true, revision: "10" });
    expect(second.current().effective.archiveSessions).toBe(false);
    expect(applyNative).toHaveBeenCalledTimes(2);
    await second.stop();
  });

  it.each([
    { target: false, applied: true, source: "observed", expected: true },
    { target: true, applied: false, source: "observed", expected: false },
    { target: undefined, applied: true, source: "observed", expected: null },
    { target: "invalid", applied: true, source: "observed", expected: null },
    { target: true, applied: true, source: "schema4", expected: null },
    { target: true, applied: null, source: null, expected: null },
  ] as const)("keeps cleanup based on observed applied sudo facts through two restarts: $target / $applied / $source", async ({ target, applied, source: actualKind, expected }) => {
    const original = cache(), recorded = tracked(81, { kind: "enableSudoCleanup" });
    const actualSource = actualKind === "observed" ? recorded.actualSource : actualKind === "schema4" ? { kind: "schema4" as const, successRevision: null } : null;
    const sudo = { ...recorded, value: { ...recorded.value, appliedValue: applied, state: applied === null ? "pending" as const : "applied" as const }, actualSource };
    const raw = JSON.stringify({ ...desired, value: { ...desired.value, ...(target === undefined ? {} : { enableSudoCleanup: target }) } });
    const source = { ...original, schemaVersion: 9, authority: { ...original.authority, desiredJson: raw, pendingApplication: true }, currentItems: withoutModeItems([...original.currentItems, sudo]) };
    const folder = await directory(), file = path.join(folder, "sudo.json"), signal = new AbortController().signal;
    await replaceFileAtomicallyFromChunks(file, [JSON.stringify(source)], 0o600);
    const options = { file, identity, signal, applyNative: async () => { throw new Error("Unsupported target must not execute."); } };
    for (let restart = 0; restart < 3; restart++) {
      const manager = await createWorkerConfigurationManager(options);
      try {
        await manager.receive(receiveWorkerDesired(raw), "9"); await manager.settle();
        expect(manager.readCleanupPolicy()).toEqual(expected === null ? null : { enableSudoCleanup: expected, revision: "10" });
        const saved = (await readConfigurationCache(file, identity, signal)).cache;
        expect(saved.authority.desiredJson).toBe(raw);
        expect(saved.currentItems).toContainEqual(withoutMode(sudo));
      } finally { await manager.stop(); }
    }
  });

  it.each(["herdr", null, "absent", "future"] as const)("does not adopt schema 9 %s authority or lose its prior native proof", mode => {
    const original = cache(), currentItems = withoutModeItems(original.currentItems);
    const { agentControlMode: _mode, ...withoutControlMode } = desired.value;
    const desiredJson = JSON.stringify({ ...desired, revision: "11", value: mode === "absent" ? withoutControlMode : { ...desired.value, agentControlMode: mode } });
    const source = { ...original, schemaVersion: 9, authority: { ...original.authority, desiredJson, pendingApplication: true }, currentItems };
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.authority).toMatchObject({ desiredJson, pendingApplication: true, applicationRevision: "10" });
    expect(result.currentItems).toEqual(currentItems);
    expect(result.currentItems.some(item => item.value.key.kind === "agentControlMode")).toBe(false);
    expect(parseConfigurationCache(result, identity)).toEqual({ cache: result, migrated: false });
  });

  it("keeps the application revision when schema 9 received an equal newer target", () => {
    const original = cache();
    const source = { ...original, schemaVersion: 9, authority: { ...original.authority, desiredJson: JSON.stringify({ ...desired, revision: "12" }), pendingApplication: false }, currentItems: withoutModeItems(original.currentItems) };
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.authority.applicationRevision).toBe("10");
    expect(result.authority.pendingApplication).toBe(true);
    expect(result.currentItems.some(item => item.value.key.kind === "agentControlMode")).toBe(false);
    expect(parseConfigurationCache(result, identity)).toEqual({ cache: result, migrated: false });
  });

  it("reopens schema 10 mode failures and retained proofs without changing their identities", async () => {
    const original = cache();
    const currentItems = original.currentItems.map(item => withoutMode(item.value.key.kind === "agentControlMode" ? {
      ...item, value: { ...item.value, state: "error" as const, error: failure, lastFailure: failure, nextAttemptAt: "2026-11-04T02:00:00Z" }, backoffStep: 3, failureId: 4,
    } : item));
    const retained = tracked(71, { kind: "agentControlMode" });
    const retainedItems = [withoutMode({ ...retained, value: { ...retained.value, lastFailure: failure }, backoffStep: 1, failureId: 5 })];
    const remoteObservation = { observationRevision: "7", json: '{"baseRevision":"6","desiredRevision":"10","reportedAt":"2026-11-04T02:00:00Z","items":[]}' };
    const source = { ...original, schemaVersion: 10, authority: { ...original.authority, desiredJson: JSON.stringify(modern(desired)).replace('"value":{', '"value":{"future":1e+999,'), pendingApplication: false }, currentItems, retainedItems, remoteObservation };
    const migrated = parseConfigurationCache(source, identity);
    expect(migrated.migrated).toBe(true);
    expect(migrated.cache).toMatchObject({ schemaVersion: 12, authority: { desiredJson: source.authority.desiredJson, pendingApplication: false }, currentItems, retainedItems, remoteObservation });
    expect(() => parseConfigurationCache({ ...source, currentItems: currentItems.filter(item => item.value.key.kind !== "maxConcurrent") }, identity)).toThrow(/missing target/);
    const file = path.join(await directory(), "schema10.json"), signal = new AbortController().signal;
    await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(migrated.cache), 0o600);
    for (let restart = 0; restart < 2; restart++) {
      const reopened = await readConfigurationCache(file, identity, signal);
      expect(reopened).toEqual({ cache: migrated.cache, migrated: false });
      await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(reopened.cache), 0o600);
    }
    expect(await readConfigurationCache(file, identity, signal)).toEqual({ cache: migrated.cache, migrated: false });
  });

  it("migrates opaque schema 10 filters into an unconfirmed obligation while retaining the ledger", () => {
    const original = cache(), modernDesired = modern(desired);
    const raw = JSON.stringify({ ...modernDesired, value: { ...modernDesired.value, taskTagFilter: { names: [" Backend ", "urgent"], match: "all" }, future: { anything: true } } });
    const currentItems = original.currentItems.map(withoutMode), stop = { ...withoutMode(tracked(70, { kind: "projectRemoval", projectId: previousProjectId })), started: true };
    const remoteObservation = { observationRevision: "7", json: '{"baseRevision":"6","desiredRevision":"10","reportedAt":"2026-11-04T02:00:00Z","items":[{"key":{"kind":"taskTagFilter"},"future":1e1000}]}' };
    const source = { ...original, schemaVersion: 10, authority: { ...original.authority, desiredJson: raw, pendingApplication: false }, currentItems, retainedItems: [stop], remoteObservation };
    const migrated = parseConfigurationCache(source, identity);
    expect(migrated.migrated).toBe(true);
    expect(migrated.cache.authority).toMatchObject({ desiredJson: raw, applicationRevision: "10", observationRevision: "9", pendingApplication: false });
    expect(migrated.cache.currentItems.slice(0, currentItems.length)).toEqual(currentItems);
    expect(migrated.cache.retainedItems).toEqual([stop]);
    expect(migrated.cache.remoteObservation).toEqual(remoteObservation);
    const filter = migrated.cache.currentItems.find(item => item.value.key.kind === "taskTagFilter")!;
    expect(filter).toMatchObject({ origin: { targetRevision: "10", source: "application" }, value: { targetRevision: "10", state: "pending", appliedValue: null }, actualSource: null });
    expect(synchronizedSnapshot(migrated.cache).effective.taskTagFilterKey).toBeNull();
    expect(parseConfigurationCache(migrated.cache, identity)).toEqual({ cache: migrated.cache, migrated: false });
  });

  it("preserves pending schema 10 authority when its formerly opaque filter cannot be applied", () => {
    const original = cache(), target = modern(desired), raw = JSON.stringify({ ...target, revision: "11", value: { ...target.value, taskTagFilter: { names: [""], match: "any" } } });
    const source = { ...original, schemaVersion: 10, authority: { ...original.authority, desiredJson: raw, pendingApplication: true }, currentItems: original.currentItems.map(withoutMode) };
    const migrated = parseConfigurationCache(source, identity).cache;
    expect(migrated.authority).toMatchObject({ desiredJson: raw, applicationRevision: "10", pendingApplication: true });
    expect(migrated.currentItems).toEqual(source.currentItems);
    expect(migrated.currentItems.some(item => item.value.key.kind === "taskTagFilter")).toBe(false);
    expect(synchronizedSnapshot(migrated)).toMatchObject({ desired: null, desiredRevision: "11", effective: { taskTagFilterKey: null } });
    expect(parseConfigurationCache(migrated, identity)).toEqual({ cache: migrated, migrated: false });
  });

  it("round-trips durable digest proofs and rejects malformed or missing schema 11 filter facts", () => {
    const target = modern(desired), filter = { names: ["Backend"], match: "any" as const }, key = taskTagFilterKey(filter);
    let next = 500;
    const initialized = transitionConfigurationDesired(createConfigurationCache(identity), receiveWorkerDesired(JSON.stringify({ ...target, value: { ...target.value, taskTagFilter: filter } })), new Set(), () => uuid(next++));
    const pending = initialized.currentItems.find(item => item.value.key.kind === "taskTagFilter")!;
    const proof = { ...pending, value: { ...pending.value, appliedValue: key, state: "applied" as const }, actualSource: { kind: "observed" as const, recordId: pending.recordId, generation: pending.origin.generation, targetRevision: pending.value.targetRevision } };
    const applied = { ...initialized, currentItems: initialized.currentItems.map(item => item === pending ? proof : item) };
    expect(parseConfigurationCache(applied, identity)).toEqual({ cache: applied, migrated: false });
    expect(synchronizedSnapshot(applied).effective.taskTagFilterKey).toBe(key);
    expect(() => parseConfigurationCache({ ...applied, currentItems: applied.currentItems.filter(item => item !== proof) }, identity)).toThrow(/missing target/);
    for (const invalid of ["a".repeat(63), "A".repeat(64), true, filter]) {
      expect(() => parseConfigurationCache({ ...applied, currentItems: applied.currentItems.map(item => item === proof ? { ...proof, value: { ...proof.value, appliedValue: invalid } } : item) }, identity)).toThrow();
    }
    expect(() => parseConfigurationCache({ ...applied, currentItems: applied.currentItems.map(item => item === proof ? { ...proof, actualSource: null } : item) }, identity)).toThrow(/provenance/);
    expect(() => parseConfigurationCache({ ...applied, currentItems: [...applied.currentItems, proof] }, identity)).toThrow();
  });

  it("upgrades schema 6 without inventing an applied archive value", () => {
    const original = cache();
    const old = { ...original, schemaVersion: 6, authority: { ...original.authority, desiredJson: JSON.stringify({ ...desired, value: { ...desired.value, archiveSessions: false } }) } };
    const upgraded = parseConfigurationCache(old, identity);
    expect(upgraded.migrated).toBe(true);
    expect(upgraded.cache.authority.pendingApplication).toBe(true);
    expect(upgraded.cache.currentItems.some(item => item.value.key.kind === "archiveSessions")).toBe(false);
    const corrected = correct(upgraded.cache, { ...desired, value: { ...desired.value, archiveSessions: false } });
    expect(corrected.currentItems.find(item => item.value.key.kind === "archiveSessions")).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    expect(parseConfigurationCache(upgraded.cache, identity).migrated).toBe(false);
  });

  it("keeps a schema 11 Windows process cleanup target opaque and reidentifies it as pending", () => {
    const original = cache();
    const desiredJson = JSON.stringify({ ...modern(desired), value: { ...modern(desired).value, enableWindowsProcessCleanup: true } });
    const source = { ...original, schemaVersion: 11, authority: { ...original.authority, desiredJson, pendingApplication: false }, currentItems: withoutModeItems(original.currentItems) };
    const { cache: upgraded, migrated } = parseConfigurationCache(source, identity);
    expect(migrated).toBe(true);
    // The writing binary could not apply this member, so the upgrade records an
    // obligation rather than inheriting an application that never happened.
    expect(upgraded.authority.desiredJson).toBe(desiredJson);
    expect(upgraded.currentItems.find(item => item.value.key.kind === "enableWindowsProcessCleanup")?.value).toMatchObject({ state: "pending", appliedValue: null, targetRevision: "10" });
    expect(parseConfigurationCache(upgraded, identity).migrated).toBe(false);
  });

  it("keeps a schema 11 cache without the Windows process cleanup target unchanged apart from its version", () => {
    const original = cache();
    const source = { ...original, schemaVersion: 11, authority: { ...original.authority, desiredJson: JSON.stringify(modern(desired)), pendingApplication: false }, currentItems: withoutModeItems(original.currentItems) };
    const { cache: upgraded } = parseConfigurationCache(source, identity);
    expect(upgraded.schemaVersion).toBe(12);
    expect(upgraded.currentItems.some(item => item.value.key.kind === "enableWindowsProcessCleanup")).toBe(false);
    expect(upgraded.currentItems).toEqual(source.currentItems);
  });

  it("rejects a schema 11 envelope that already claims a Windows process cleanup result", () => {
    const original = cache();
    const desiredJson = JSON.stringify({ ...modern(desired), value: { ...modern(desired).value, enableWindowsProcessCleanup: true } });
    const source = { ...original, schemaVersion: 11, authority: { ...original.authority, desiredJson, pendingApplication: false },
      currentItems: [...withoutModeItems(original.currentItems), withoutMode(tracked(84, { kind: "enableWindowsProcessCleanup" }))] };
    expect(() => parseConfigurationCache(source, identity)).toThrow("future application result");
  });

  it("leaves a schema 9 Windows process cleanup member opaque without inventing an obligation", () => {
    const original = cache();
    const desiredJson = JSON.stringify({ ...desired, value: { ...desired.value, enableWindowsProcessCleanup: true } });
    const source = { ...original, schemaVersion: 9, authority: { ...original.authority, desiredJson, pendingApplication: false }, currentItems: withoutModeItems(original.currentItems) };
    const { cache: upgraded, migrated } = parseConfigurationCache(source, identity);
    expect(migrated).toBe(true);
    // The envelope predates the member, so it stays raw authority. Only the
    // next received document introduces it together with its ledger entry.
    expect(upgraded.authority.desiredJson).toBe(desiredJson);
    expect(upgraded.currentItems.some(item => item.value.key.kind === "enableWindowsProcessCleanup")).toBe(false);
  });

  it("upgrades schema 6 without reidentifying an absent sudo target", () => {
    const source = { ...cache(), schemaVersion: 6 };
    const result = parseConfigurationCache(source, identity);
    expect(result.migrated).toBe(true);
    expect(result.cache).toEqual({ ...source, schemaVersion: 12, authority: { ...source.authority, generation: expect.any(String), pendingApplication: true }, projectionCursor: null, currentItems: withoutModeItems(source.currentItems) });
    expect(result.cache.currentItems.some(item => item.value.key.kind === "enableSudoCleanup")).toBe(false);
  });

  it.each([true, false])("reidentifies a schema 6 sudo target %s as pending", enabled => {
    const previous = cache();
    const desiredJson = JSON.stringify({ ...desired, revision: "11", value: { ...desired.value, enableSudoCleanup: enabled } });
    const source = { ...previous, schemaVersion: 6, authority: { ...previous.authority, desiredJson } };
    const { cache: upgraded, migrated } = parseConfigurationCache(source, identity);
    expect(migrated).toBe(true);
    expect(upgraded.authority).toMatchObject({ applicationRevision: "10", pendingApplication: true, desiredJson });
    expect(upgraded.currentItems).toEqual(withoutModeItems(previous.currentItems));
    const corrected = correct(upgraded, { ...desired, value: { ...desired.value, enableSudoCleanup: enabled } });
    expect(corrected.currentItems.find(item => item.value.key.kind === "enableSudoCleanup")?.value).toMatchObject({ state: "pending", appliedValue: null, targetRevision: "12" });
    expect(parseConfigurationCache(upgraded, identity)).toEqual({ cache: upgraded, migrated: false });
  });

  it.each(["archiveSessions", "enableSudoCleanup"] as const)("upgrades schema 7 with known %s and a previously unknown second field", knownKind => {
    const old = cache(), missingKind = knownKind === "archiveSessions" ? "enableSudoCleanup" : "archiveSessions";
    const known = tracked(80, { kind: knownKind });
    const failed = { ...old.currentItems[4]!, value: { ...old.currentItems[4]!.value, state: "error" as const, error: failure, lastFailure: failure, nextAttemptAt: "2026-11-04T01:01:00Z" }, backoffStep: 2, failureId: 3 };
    const remoteObservation = { observationRevision: "12", json: '{"baseRevision":"11","desiredRevision":"20","reportedAt":"2026-11-04T02:00:00Z","items":[{"key":{"kind":"future"},"future":-1.25}]}' };
    const source = { ...old, schemaVersion: 7, authority: { ...old.authority, desiredJson: JSON.stringify({ ...desired, revision: "11", value: { ...desired.value, archiveSessions: true, enableSudoCleanup: true } }) }, remoteObservation,
      currentItems: old.currentItems.map((item, index) => index === 4 ? failed : item).concat(known) };
    const { cache: upgraded, migrated } = parseConfigurationCache(source, identity);
    expect(migrated).toBe(true);
    expect(upgraded.authority).toMatchObject({ applicationRevision: "10", pendingApplication: true, desiredJson: source.authority.desiredJson });
    expect(upgraded.currentItems).toEqual(withoutModeItems(source.currentItems));
    const corrected = correct(upgraded, { ...desired, value: { ...desired.value, archiveSessions: true, enableSudoCleanup: true } });
    expect(corrected.currentItems.find(item => item.value.key.kind === missingKind)).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    expect(corrected.currentItems.find(item => item.value.key.kind === knownKind)).toMatchObject({ value: { state: "applied", appliedValue: true }, actualSource: known.actualSource });
    expect(corrected.retainedItems).toContainEqual(withoutMode(failed));
    expect(upgraded.remoteObservation).toEqual(remoteObservation);
    expect(parseConfigurationCache(upgraded, identity)).toEqual({ cache: upgraded, migrated: false });
  });

  it.each([6, 7])("upgrades schema %s with both previously unknown targets without inventing actual values", version => {
    const old = cache();
    const source = { ...old, schemaVersion: version, authority: { ...old.authority, desiredJson: JSON.stringify({ ...desired, revision: "11", value: { ...desired.value, archiveSessions: false, enableSudoCleanup: true } }) } };
    const upgraded = parseConfigurationCache(source, identity).cache;
    expect(upgraded.authority).toMatchObject({ applicationRevision: "10", pendingApplication: true, desiredJson: source.authority.desiredJson });
    expect(upgraded.currentItems).toEqual(withoutModeItems(old.currentItems));
    const corrected = correct(upgraded, { ...desired, value: { ...desired.value, archiveSessions: false, enableSudoCleanup: true } });
    for (const kind of ["archiveSessions", "enableSudoCleanup"]) expect(corrected.currentItems.find(item => item.value.key.kind === kind)).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    expect(parseConfigurationCache(upgraded, identity)).toEqual({ cache: upgraded, migrated: false });
  });

  it("retains hidden confirmed archive=false when schema 7 newly recognizes sudo", () => {
    const old = cache(), archive = tracked(81, { kind: "archiveSessions" });
    const savedArchive = { ...archive, value: { ...archive.value, appliedValue: false } };
    const source = { ...old, schemaVersion: 7, authority: { ...old.authority, desiredJson: JSON.stringify({ ...desired, revision: "11", value: { ...desired.value, enableSudoCleanup: true } }) },
      hiddenCapabilitySources: { archiveSessions: { revision: "10", json: "false" } }, retainedItems: [savedArchive] };
    const upgraded = parseConfigurationCache(source, identity).cache;
    expect(upgraded.authority).toMatchObject({ applicationRevision: "10", pendingApplication: true, desiredJson: source.authority.desiredJson });
    const corrected = correct(upgraded, { ...desired, value: { ...desired.value, enableSudoCleanup: true } });
    expect(corrected.currentItems.find(item => item.value.key.kind === "enableSudoCleanup")).toMatchObject({ value: { state: "pending", appliedValue: null }, actualSource: null });
    expect(upgraded.retainedItems).toContainEqual(withoutMode(savedArchive));
    expect(upgraded.hiddenCapabilitySources).toEqual(source.hiddenCapabilitySources);
    const snapshot = (value: ActiveCache) => configurationSnapshot(value, false, new Map(), { codex: { kind: "auto" }, copilot: { kind: "auto" } }, () => { throw new Error("An unsynchronized snapshot cannot prove a native selection."); });
    expect(snapshot(upgraded).retainedArchiveSessions).toBe(false);
    const unknown = parseConfigurationCache({ ...source, retainedItems: [] }, identity).cache;
    expect(snapshot(unknown).retainedArchiveSessions).toBeNull();
    expect(parseConfigurationCache(upgraded, identity)).toEqual({ cache: upgraded, migrated: false });
  });

  it.each([5, 6, 7, 8])("requires fresh mode adoption after schema %i Web success", version => {
    const original = cache();
    const { remoteObservation: _remote, authority: _authority, ...ledger } = original;
    const source = version === 5
      ? { ...ledger, schemaVersion: 5, authority: { generation, desired, observationRevision: "9" } }
      : { ...original, schemaVersion: version };
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.currentItems.filter(item => item.value.key.kind !== "agentControlMode")).toEqual(withoutModeItems(original.currentItems));
    expect(result.authority.pendingApplication).toBe(true);
    expect(result.currentItems.some(item => item.value.key.kind === "agentControlMode")).toBe(false);
    expect(parseConfigurationCache(result, identity)).toEqual({ cache: result, migrated: false });
  });

  it.each([5, 6, 7, 8])("reads historical mode and all three tool choices from schema %i", version => {
    const original = cache();
    const historical = { ...desired, value: { ...desired.value, agentControlMode: "herdr", toolPaths: {
      codex: { kind: "path", path: "/opt/codex" }, copilot: null, herdr: { kind: "auto" },
    } } };
    const items = original.currentItems.map(item => item.value.key.kind === "agentControlMode"
      ? { ...item, value: { ...item.value, appliedValue: "herdr" } }
      : item.value.key.kind === "native" || item.value.key.kind === "projectNative" ? { ...item, nativeMode: "herdr" } : item);
    const { remoteObservation: _remote, authority: _authority, ...ledger } = original;
    const source = version === 5
      ? { ...ledger, schemaVersion: 5, authority: { generation, desired: historical, observationRevision: "9" }, currentItems: items }
      : { ...original, schemaVersion: version, authority: { ...original.authority, desiredJson: JSON.stringify(historical) }, currentItems: items };
    const parsed = parseConfigurationCache(source, identity).cache;
    expect(JSON.parse(parsed.authority.desiredJson!)).toEqual(historical);
    expect(parsed.currentItems.some(item => item.value.key.kind === "agentControlMode")).toBe(false);
    expect(parsed.currentItems.find(item => item.value.key.kind === "native")).toMatchObject({ value: { appliedValue: null, state: "pending" }, actualSource: null });
    const invalid = { ...historical, value: { ...historical.value, toolPaths: { ...historical.value.toolPaths, herdr: { kind: "path", path: "relative" } } } };
    const malformed = version === 5
      ? { ...source, authority: { generation, desired: invalid, observationRevision: "9" } }
      : { ...source, authority: { ...original.authority, desiredJson: JSON.stringify(invalid) } };
    expect(() => parseConfigurationCache(malformed, identity)).toThrow();
  });

  it("rejects a schema 8 target whose application item is missing", () => {
    const source = cache();
    expect(() => parseConfigurationCache({ ...source, authority: { ...source.authority, desiredJson: JSON.stringify({ ...desired, value: { ...desired.value, enableSudoCleanup: true } }) } }, identity)).toThrow(/missing target/);
  });

  it("round-trips an unsupported raw target without projecting it over prior project obligations", () => {
    const previous = parseConfigurationCache(cache(), identity).cache;
    const stopped = { ...withoutMode(tracked(70, { kind: "projectRemoval", projectId }, "10")), started: true,
      value: { ...tracked(70, { kind: "projectRemoval", projectId }, "10").value, state: "pending" as const, appliedValue: null }, actualSource: null };
    const raw = JSON.stringify({ ...desired, revision: "2", value: { ...desired.value, agentControlMode: "herdr", projects: [] } });
    const saved = { ...previous, authority: { ...previous.authority, desiredJson: raw, pendingApplication: true }, retainedItems: [stopped] };
    expect(parseConfigurationCache(saved, identity)).toEqual({ cache: saved, migrated: false });
    expect(parseConfigurationCache({ ...saved, authority: { ...saved.authority, applicationRevision: null }, currentItems: [] }, identity).cache.retainedItems).toEqual([stopped]);
  });

  it("validates the last applied ledger after a future-only raw update", () => {
    const migrated = parseConfigurationCache(cache(), identity).cache;
    const previous = { ...migrated, authority: { ...migrated.authority, desiredJson: JSON.stringify(modern(desired)), pendingApplication: false } };
    const raw = JSON.stringify({ ...modern(desired), revision: "11", future: { retained: true } });
    const source = { ...previous, authority: { ...previous.authority, desiredJson: raw } };
    expect(parseConfigurationCache(source, identity)).toEqual({ cache: source, migrated: false });
    expect(() => parseConfigurationCache({ ...source, currentItems: source.currentItems.filter(item => item.value.key.kind !== "native") }, identity)).toThrow(/missing target/);
    expect(() => parseConfigurationCache({ ...source, currentItems: source.currentItems.filter(item => item.value.key.kind !== "projectPreparation") }, identity)).toThrow(/missing target/);
    expect(() => parseConfigurationCache({ ...source, currentItems: source.currentItems.map(item => item.value.key.kind === "projectNative"
      ? { ...item, value: { ...item.value, key: { kind: "projectNative", projectId: previousProjectId } } } : item) }, identity)).toThrow(/inconsistent current/);
  });

  it("does not select projects from an over-limit web target", () => {
    const previous = parseConfigurationCache(cache(), identity).cache;
    const raw = JSON.stringify({ ...desired, revision: "11", value: { ...desired.value, maxConcurrent: 65, projects: [] } });
    const source = { ...previous, authority: { ...previous.authority, desiredJson: raw, pendingApplication: true } };
    expect(parseConfigurationCache(source, identity)).toEqual({ cache: source, migrated: false });
    expect(source.currentItems.some(item => item.value.key.kind === "projectPreparation" && item.value.key.projectId === projectId)).toBe(true);
  });

  it("round-trips an unknown raw target and its hidden sources without replacing the execution ledger", async () => {
    const previous = parseConfigurationCache(cache(), identity).cache;
    const stop = { ...withoutMode(tracked(70, { kind: "projectRemoval", projectId }, "10")), started: true,
      value: { ...tracked(70, { kind: "projectRemoval", projectId }, "10").value, state: "pending" as const, appliedValue: null }, actualSource: null };
    const currentItems = previous.currentItems.map(item => item.value.key.kind === "projectPreparation" ? { ...item, blockedByRemovalId: stop.recordId } : item);
    const raw = '{"revision":"12","updatedAt":"2026-11-04T00:00:00Z","value":{"native":{"agent":"future-agent"},"projects":{"newShape":true},"future":1e+999}}';
    const hiddenCapabilitySources = {
      agentControlMode: { revision: "10", json: '"future-control"' },
      toolPaths: { revision: "10", json: '{"codex":{"kind":"future","future":1e1000},"copilot":null,"herdr":null}' },
      archiveSessions: { revision: "10", json: '{"policy":"future","cutoff":-1.0}' },
    };
    const source = { ...previous, authority: { ...previous.authority, desiredJson: raw, pendingApplication: true }, currentItems, retainedItems: [stop], hiddenCapabilitySources };
    const file = path.join(await directory(), "unknown.json");
    await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(source), 0o600);
    const reopened = await readConfigurationCache(file, identity, new AbortController().signal);
    expect(reopened).toEqual({ cache: source, migrated: false });
    expect(reopened.cache.authority.desiredJson).toBe(raw);
    expect(reopened.cache.currentItems.find(item => item.value.key.kind === "projectPreparation")?.blockedByRemovalId).toBe(stop.recordId);
    const { agentControlMode: _mode, ...knownValue } = desired.value;
    const knownRaw = JSON.stringify({ ...desired, revision: "12", value: knownValue });
    const restoredKnown = { ...source, authority: { ...source.authority, desiredJson: knownRaw } };
    expect(parseConfigurationCache(restoredKnown, identity)).toEqual({ cache: restoredKnown, migrated: false });
  });

  it("rejects malformed schema 9 envelopes and hidden sources even for unknown raw targets", () => {
    const previous = parseConfigurationCache(cache(), identity).cache;
    const invalid = [
      '{"revision":"0","updatedAt":"2026-11-04T00:00:00Z","value":{"native":{"agent":"future"}}}',
      '{"revision":"12","updatedAt":"bad","value":{"native":{"agent":"future"}}}',
      '{"revision":"12","updatedAt":"2026-11-04T00:00:00Z","value":{"x":1,"x":2}}',
      '{"revision":"12","updatedAt":"2026-11-04T00:00:00Z","value":null}',
    ];
    for (const raw of invalid) expect(() => parseConfigurationCache({ ...previous, authority: { ...previous.authority, desiredJson: raw } }, identity)).toThrow();
    const raw = '{"revision":"12","updatedAt":"2026-11-04T00:00:00Z","value":{"native":{"agent":"future"}}}';
    const source = { ...previous, authority: { ...previous.authority, desiredJson: raw, pendingApplication: true }, hiddenCapabilitySources: { archiveSessions: { revision: "10", json: '{"invalid":}' } } };
    expect(() => parseConfigurationCache(source, identity)).toThrow();
    expect(() => parseConfigurationCache({ ...source, hiddenCapabilitySources: { archiveSessions: { revision: "13", json: '"future"' } } }, identity)).toThrow();
    expect(() => parseConfigurationCache({ ...source, authority: { ...source.authority, desiredJson: raw.replace('"value":{', '"value":{"archiveSessions":true,') }, hiddenCapabilitySources: { archiveSessions: { revision: "10", json: '"future"' } } }, identity)).toThrow();
    expect(() => parseConfigurationCache({ ...cache(), authority: { ...cache().authority, desiredJson: raw } }, identity)).toThrow();
  });

  it("strictly rejects legacy mode fields and mode items in schema 9", () => {
    const parsed = parseConfigurationCache(cache(), identity).cache;
    const current = { ...parsed, schemaVersion: 9, currentItems: parsed.currentItems.filter(item => item.value.key.kind !== "agentControlMode") };
    expect(() => parseConfigurationCache({ ...current, currentItems: [{ ...current.currentItems[0], nativeMode: null }, ...current.currentItems.slice(1)] }, identity)).toThrow();
    expect(() => parseConfigurationCache({ ...current, retainedItems: [withoutMode(tracked(90, { kind: "agentControlMode" }))] }, identity)).toThrow();
  });

  it("persists an unadopted target separately from the prior application ledger", () => {
    const previous = parseConfigurationCache(cache(), identity).cache;
    const raw = JSON.stringify({ ...desired, revision: "12", value: { ...desired.value, projects: [] } });
    const source = { ...previous, authority: { ...previous.authority, desiredJson: raw, pendingApplication: true } };
    expect(parseConfigurationCache(source, identity)).toEqual({ cache: source, migrated: false });
    expect(() => parseConfigurationCache({ ...source, authority: { ...source.authority, pendingApplication: false } }, identity)).toThrow();
    const { pendingApplication: _pending, ...withoutPending } = source.authority;
    expect(() => parseConfigurationCache({ ...source, authority: withoutPending }, identity)).toThrow();
    expect(() => parseConfigurationCache({ ...source, authority: { ...source.authority, pendingApplication: "true" } }, identity)).toThrow();
  });

  it("restarts after a null authority while retaining started removal responsibility", async () => {
    const root = await directory(), file = path.join(root, "configuration.json"), signal = new AbortController().signal;
    const options = { file, identity, signal, applyNative: async () => {} };
    await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(createConfigurationCache(identity)), 0o600);
    const emptyManager = await createWorkerConfigurationManager(options);
    await emptyManager.receive(null, "0");
    await emptyManager.stop();
    const emptyRestart = await createWorkerConfigurationManager(options);
    expect(emptyRestart.current().desired).toBeNull();
    await emptyRestart.stop();
    expect((await readConfigurationCache(file, identity, signal)).cache.authority).toMatchObject({ desiredJson: null, applicationRevision: null, pendingApplication: true });

    let removing = false;
    const manager = await createWorkerConfigurationManager(options);
    let original!: ActiveCache["currentItems"][number];
    try {
      await manager.configureProjectAdapters({ prepare: async () => {}, remove: async (_projectId, jobSignal) => {
        removing = true;
        await new Promise<void>(resolve => { if (jobSignal.aborted) resolve(); else jobSignal.addEventListener("abort", () => resolve(), { once: true }); });
        jobSignal.throwIfAborted();
      } });
      await manager.receive(receiveWorkerDesired(JSON.stringify(modern(desired))), "0");
      await manager.settle();
      const removed = { ...modern(desired), revision: "11", value: { ...modern(desired).value, projects: [] } };
      await manager.receive(receiveWorkerDesired(JSON.stringify(removed)), "0");
      await vi.waitFor(() => expect(removing).toBe(true), { timeout: 3000 });
      const before = await readConfigurationCache(file, identity, signal);
      original = before.cache.currentItems.find(item => item.value.key.kind === "projectRemoval")!;
      expect(original.started).toBe(true);
      await manager.receive(null, "0");
      const cleared = await readConfigurationCache(file, identity, signal);
      expect(cleared.cache.authority).toMatchObject({ desiredJson: null, applicationRevision: null, pendingApplication: true });
      expect(cleared.cache.retainedItems).toContainEqual(expect.objectContaining({ recordId: original.recordId, started: true }));
    } finally { await manager.stop(); }
    const reopened = await createWorkerConfigurationManager(options);
    expect(reopened.current().desired).toBeNull();
    await reopened.stop();
    const after = await readConfigurationCache(file, identity, signal);
    expect(after.cache.authority).toMatchObject({ desiredJson: null, applicationRevision: null, pendingApplication: true });
    expect(after.cache.retainedItems).toContainEqual(expect.objectContaining({ recordId: original.recordId, started: true }));
  });

  it("preserves observed success provenance and a cursor whose record has retired", () => {
    const original = cache();
    const result = parseConfigurationCache(original, identity);
    expect(result.cache.authority.generation).not.toBe(original.authority.generation);
    expect(result.cache.currentItems.find(item => item.recordId === original.currentItems[0]!.recordId)?.actualSource).toEqual(original.currentItems[0]!.actualSource);
    expect(result.cache.projectionCursor).toBeNull();
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
      ...original, schemaVersion: 12, projectionCursor: null, authority: { ...original.authority, generation: expect.any(String), desiredJson: expect.any(String), pendingApplication: true },
      currentItems: withoutModeItems(currentItems.map(item => item === currentItems[4] ? { ...item, value: { ...item.value, state: "pending" } } : item)), retainedItems: [withoutMode(stop)],
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
    const expected = parseConfigurationCache(source, identity).cache;
    await replaceFileAtomicallyFromChunks(file, configurationCacheChunks(expected), 0o600);
    const reopened = await readConfigurationCache(file, identity, new AbortController().signal);
    expect(reopened).toEqual({ cache: expected, migrated: false });
    expect(reopened.cache.currentItems.filter(item => item.value.key.kind !== "agentControlMode")).toEqual(withoutModeItems(source.currentItems));
    expect(reopened.cache.retainedItems).toEqual([]);
  });

  it("validates optional hidden capability facts in schema 7 caches", () => {
    const original = cache(), json = '{"codex":{"kind":"auto","future":[-1.25,900719925474099312345]},"copilot":null,"herdr":null}';
    const source = { ...original, hiddenCapabilitySources: { toolPaths: { revision: "10", json } } };
    expect(parseConfigurationCache(original, identity).cache.hiddenCapabilitySources).toBeUndefined();
    expect(parseConfigurationCache(source, identity).cache.hiddenCapabilitySources).toEqual(source.hiddenCapabilitySources);
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
    expect(result.cache.schemaVersion).toBe(12);
    expect(JSON.parse(result.cache.authority.desiredJson!)).toEqual({ ...source.desired, value: { ...source.desired.value, preferPlatformSpecificTasks: version === 1 ? false : desired.value.preferPlatformSpecificTasks } });
    expect(result.cache.authority).toMatchObject({ applicationRevision: "10", observationRevision: "9" });
    expect(result.cache.remoteObservation).toBeNull();
    expect(result.cache.currentItems).toHaveLength(version === 1 ? source.items.length + 1 : source.items.length);
    expect(new Set(result.cache.currentItems.map(item => item.recordId)).size).toBe(result.cache.currentItems.length);
    for (const item of result.cache.currentItems) {
      expect(item.origin).toMatchObject({ targetRevision: "10", source: "schema4" });
      expect(item.origin.generation).not.toBe(result.cache.authority.generation);
      if (item.value.appliedValue !== null) expect(item.actualSource).toEqual({ kind: "schema4", successRevision: null });
    }
    if (version === 1) expect(JSON.parse(result.cache.authority.desiredJson!).value.preferPlatformSpecificTasks).toBe(false);
    expect(result.cache.currentItems.find(item => item.value.key.kind === "native")?.value.appliedValue).toEqual(version >= 3 ? native : null);
    expect(parseConfigurationCache(result.cache, identity)).toEqual({ cache: result.cache, migrated: false });
  });

  it.each([2, 3, 4] as const)("replaces schema %i historical Web confirmation with an unadopted mode", version => {
    const previous = legacy(version);
    const old = tracked(90, { kind: "agentControlMode" });
    const source = { ...previous, desired: { ...previous.desired, value: { ...previous.desired.value, agentControlMode: "web" } },
      items: [...previous.items, { value: old.value, attempts: 0, failureId: null, started: false }] };
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.authority.pendingApplication).toBe(true);
    expect(result.currentItems.some(item => item.value.key.kind === "agentControlMode")).toBe(false);
    expect(parseConfigurationCache(result, identity)).toEqual({ cache: result, migrated: false });
  });

  it("moves unselected project history into retained while preserving original stop ownership and failures", () => {
    const source = legacy(4), history = tracked(50, { kind: "projectNative", projectId: previousProjectId }, "3");
    const stop = tracked(51, { kind: "projectRemoval", projectId: previousProjectId }, "4");
    source.items.push({ value: { ...history.value, lastFailure: failure }, attempts: 4, failureId: 4, started: false });
    source.items.push({ value: { ...stop.value, state: "applying", appliedValue: null }, attempts: 2, failureId: null, started: true });
    if ("nativeModes" in source) Object.assign(source.nativeModes, { [`projectNative:${previousProjectId}`]: "herdr" });
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.retainedItems).toHaveLength(1);
    expect(result.retainedItems[0]).toMatchObject({ value: { ...history.value, state: "pending", appliedValue: null, lastFailure: null }, backoffStep: 0, failureId: null, actualSource: null });
    expect(result.currentItems.find(item => item.value.key.kind === "projectRemoval")).toMatchObject({ value: { targetRevision: "4", state: "pending", appliedValue: null }, started: true, backoffStep: 2, actualSource: null });
    expect(result.nextFailureId).toBe(source.nextFailureId);
  });

  it("accepts future historical provenance and a completed retained stop dependency", () => {
    const original = cache(), stop = tracked(60, { kind: "projectRemoval", projectId }, "20");
    const currentItems = original.currentItems.map(item => item.value.key.kind === "projectPreparation" ? { ...item, blockedByRemovalId: stop.recordId } : item);
    const retained = { ...tracked(61, { kind: "projectNative", projectId }, "30"), actualSource: { kind: "observed" as const, recordId: uuid(100), generation: uuid(101), targetRevision: "40" } };
    const source = { ...original, currentItems, retainedItems: [stop, retained, tracked(62, retained.value.key, "50")] };
    const result = parseConfigurationCache(source, identity).cache;
    expect(result.retainedItems).toEqual(withoutModeItems(source.retainedItems));
    expect(result.currentItems.find(item => item.value.key.kind === "projectPreparation")?.blockedByRemovalId).toBe(stop.recordId);
  });

  it("keeps historical native tokens above current API limits structurally readable", () => {
    const original = cache(), hugeNative = { ...native, args: ["x".repeat(9000)] };
    const source = { ...original, retainedItems: [{ ...tracked(70, { kind: "projectNative", projectId: previousProjectId }, "30"), value: { ...tracked(70, { kind: "projectNative", projectId: previousProjectId }, "30").value, appliedValue: hugeNative } }] };
    expect(parseConfigurationCache(source, identity).cache.retainedItems[0]!.value.appliedValue).toEqual(hugeNative);
  });

  it("resets an interrupted application to pending while retaining actual and failure facts", () => {
    const original = cache(), previous = original.currentItems[4]!;
    const source = { ...original, currentItems: original.currentItems.map(item => item === previous ? { ...item, value: { ...item.value, state: "applying" as const, lastFailure: failure }, failureId: 2, backoffStep: 3 } : item) };
    expect(parseConfigurationCache(source, identity).cache.currentItems[4]).toEqual({ ...withoutMode(source.currentItems[4]!), value: { ...source.currentItems[4]!.value, state: "pending" } });
  });

  const invalid: readonly [string, (input: WorkerConfigurationCache) => unknown][] = [
    ["unknown schema", input => ({ ...input, schemaVersion: 13 })],
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
    ["sudo result without a target", input => ({ ...input, currentItems: [...input.currentItems, tracked(83, { kind: "enableSudoCleanup" })] })],
    ["Windows process cleanup result in a schema 8 envelope", input => ({ ...input, currentItems: [...input.currentItems, tracked(84, { kind: "enableWindowsProcessCleanup" })] })],
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
