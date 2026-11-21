import { receivedDesired, receivedReceipt } from "../../helpers/worker-received-configuration.js";
import { taskTagFilterKey } from "../../../src/api/task-tag-filter.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationApplicationEvent, WorkerConfigurationManager, WorkerConfigurationManagerOptions, WorkerConfigurationSnapshot } from "../../../src/commands/worker/configuration.js";
import { parseWorkerCloudReport } from "../../../src/api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudNative, WorkerCloudReport } from "../../../src/api/worker-configuration.js";
import { replaceFileAtomically } from "../../../src/platform/files.js";
import { createApiClient } from "../../../src/api/client.js";
import { createOperation, OperationError } from "../../../src/api/operation.js";
import { ToolSelectionError } from "../../../src/platform/tool-executables.js";
import { syncWorkerConfigurationOnce } from "../../../src/commands/worker/reporter.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";
import type { Tool, ToolPaths } from "../../../src/platform/tool-path-choice.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const desired = (revision = "1", model = "original", projects = true): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-04T00:00:00Z", value: { maxConcurrent: Number(revision) + 1, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } }, native: { agent: "codex", model, args: [] }, projects: projects ? [{ projectId, nativeOverrides: {} }] : [] } });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const fixtures: { manager: WorkerConfigurationManager; directory: string; expectedStopError?: unknown }[] = [];
const item = (snapshot: WorkerConfigurationSnapshot, kind: WorkerCloudItem["key"]["kind"]): WorkerCloudItem | undefined => snapshot.items.find(value => value.key.kind === kind);
// Count and lifecycle fixtures retain chunk encoding and file readback; atomic replacement has its own mechanism tests.
const persistLifecycleCache: NonNullable<WorkerConfigurationManagerOptions["persist"]> = (file, chunks) => writeFile(file, chunks(), { mode: 0o600 });
const legacyCache = async (file: string) => {
  const cache: WorkerConfigurationCache = JSON.parse(await readFile(file, "utf8"));
  const records = new Map([...cache.retainedItems, ...cache.currentItems].map(entry => [JSON.stringify(entry.value.key), entry]));
  const target = cache.authority.desiredJson === null ? null : JSON.parse(cache.authority.desiredJson);
  if (target !== null) delete target.value.toolPaths;
  const nativeModes = Object.fromEntries([...records.values()].filter(entry => (entry.value.key.kind === "native" || entry.value.key.kind === "projectNative") && entry.value.appliedValue !== null).map(entry => [`${entry.value.key.kind}:${"projectId" in entry.value.key ? entry.value.key.projectId : ""}`, "web"]));
  const items = [...records.values()].map(entry => ({ value: entry.value, attempts: entry.backoffStep, failureId: entry.failureId, started: entry.started }));
  if (target?.value.agentControlMode !== undefined && !items.some(entry => entry.value.key.kind === "agentControlMode")) items.push({ value: { key: { kind: "agentControlMode" }, targetRevision: cache.authority.applicationRevision!, appliedValue: "web", state: "applied", error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started: false });
  return JSON.parse(JSON.stringify({ schemaVersion: 4, identity: cache.identity, desired: target, observationRevision: cache.authority.observationRevision, nextFailureId: cache.nextFailureId, nativeModes, items }));
};
const fixture = async (overrides: Partial<WorkerConfigurationManagerOptions> = {}) => {
  const root = path.resolve(".tmp/worker-cloud-configuration-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-")), file = path.join(directory, "configuration.json"), listeners = new Set<() => void>();
  const manager = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {}, now: () => Date.now(), ...overrides, onChange: snapshot => { overrides.onChange?.(snapshot); for (const listener of listeners) listener(); } });
  fixtures.push({ manager, directory });
  const wait = (predicate: (snapshot: WorkerConfigurationSnapshot) => boolean): Promise<void> => {
    if (predicate(manager.current())) return Promise.resolve();
    return new Promise(resolve => {
      const listener = () => { if (predicate(manager.current())) { listeners.delete(listener); resolve(); } };
      listeners.add(listener);
    });
  };
  return { manager, directory, file, wait };
};
afterEach(async () => {
  vi.useRealTimers();
  const failures: unknown[] = [], active = fixtures.splice(0);
  for (const { manager, expectedStopError } of active) {
    try { await manager.stop(); } catch (error) { if (error !== expectedStopError) failures.push(error); }
  }
  for (const directory of new Set(active.map(fixture => fixture.directory))) await rm(directory, { recursive: true, force: true });
  if (failures.length !== 0) throw new AggregateError(failures, "Configuration fixture shutdown failed.");
});

describe("Worker cloud configuration application", () => {
  it("retains pending filter proof and selected projects when the application commit fails", async () => {
    const failure = new Error("filter proof persistence failed"), published: WorkerConfigurationSnapshot[] = [];
    const { manager, file } = await fixture({ onChange: snapshot => { published.push(snapshot); }, persist: async (target, chunks) => {
      const bytes = [...chunks()].join("");
      const checkpoint = JSON.parse(bytes) as WorkerConfigurationCache;
      if (checkpoint.currentItems.some(entry => entry.value.key.kind === "taskTagFilter" && entry.value.state === "applied")) throw failure;
      await replaceFileAtomically(target, bytes, 0o600);
    } });
    fixtures.find(entry => entry.manager === manager)!.expectedStopError = failure;
    const initial = desired();
    await manager.receive(receivedDesired({ ...initial, value: { ...initial.value, taskTagFilter: { names: ["backend"], match: "any" } } }));
    await expect(manager.settle()).rejects.toBe(failure);
    expect(published.every(snapshot => snapshot.effective.taskTagFilterKey === null)).toBe(true);
    expect(manager.current().selectedProjects?.map(project => project.projectId)).toEqual([projectId]);
    expect(manager.current().effective.taskTagFilterKey).toBeNull();
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.currentItems.find(entry => entry.value.key.kind === "taskTagFilter")?.value).toMatchObject({ state: "pending", appliedValue: null });
  });

  it("keeps a filter unavailable until its application proof is durably replaced and synchronized again after restart", async () => {
    const writing = deferred(), release = deferred();
    const filter = { names: ["backend"], match: "any" as const }, digest = taskTagFilterKey(filter);
    let held = false;
    const { manager, file } = await fixture({ persist: async (target, chunks) => {
      const bytes = [...chunks()].join("");
      const checkpoint = JSON.parse(bytes) as WorkerConfigurationCache;
      if (!held && checkpoint.currentItems.some(entry => entry.value.key.kind === "taskTagFilter" && entry.value.state === "applied")) {
        held = true; writing.resolve(); await release.promise;
      }
      await replaceFileAtomically(target, bytes, 0o600);
    } });
    const original = desired();
    const target = { ...original, value: { ...original.value, taskTagFilter: filter } };
    await manager.receive(receivedDesired(target));
    await writing.promise;
    expect(manager.current().effective.taskTagFilterKey).toBeNull();
    expect(manager.current().selectedProjects?.map(project => project.projectId)).toEqual([projectId]);
    const before = (await readConfigurationCache(file, identity, new AbortController().signal)).cache;
    expect(before.currentItems.find(entry => entry.value.key.kind === "taskTagFilter")?.value).toMatchObject({ state: "pending", appliedValue: null });
    release.resolve(); await manager.settle();
    expect(manager.current().effective.taskTagFilterKey).toBe(digest);
    expect(manager.current().effective.taskTagFilter).toEqual(filter);
    expect(manager.report().observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "taskTagFilter" }, appliedValue: digest, state: "applied" }));
    await manager.stop();
    const restarted = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: restarted, directory: path.dirname(file) });
    expect(restarted.current().effective.taskTagFilterKey).toBeNull();
    await restarted.receive(receivedDesired(target)); await restarted.settle();
    expect(restarted.current().effective.taskTagFilterKey).toBe(digest);
  });

  it("applies a synchronized target without reporting mode adoption", async () => {
    const { manager } = await fixture();
    await manager.receive(receivedDesired(desired("1", "original", false))); await manager.settle();
    expect(manager.current().effective.agentControlMode).toBe("web");
    expect(manager.report()).not.toHaveProperty("controlModeBootstrap");
    expect(manager.report().observation?.items.some(entry => entry.key.kind === "agentControlMode")).toBe(false);
  });

  it("persists and reports the applied archive setting, including a legacy projection", async () => {
    const { manager, file } = await fixture();
    const initial = desired("1", "original", false);
    await manager.receive(receivedDesired({ ...initial, value: { ...initial.value, archiveSessions: false } }));
    await manager.settle();
    expect(manager.current().effective.archiveSessions).toBe(false);
    expect(item(manager.current(), "archiveSessions")).toMatchObject({ state: "applied", appliedValue: false });
    expect(manager.report().observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "archiveSessions" }, state: "applied", appliedValue: false }));
    await manager.receive(receivedDesired({ ...initial, revision: "2" }));
    await manager.settle();
    expect(manager.current().effective.archiveSessions).toBe(false);
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ key: { kind: "archiveSessions" }, appliedValue: false }) }));
  });

  it("recreates the frozen checkpoint iterator and joins an active writer before stop", async () => {
    const entered = deferred(), release = deferred();
    let first = true, stopped = false;
    const { manager } = await fixture({ persist: async (file, chunks) => {
      if (first) {
        first = false;
        const initial = [...chunks()].join("");
        expect([...chunks()].join("")).toBe(initial);
        entered.resolve();
        await release.promise;
      }
      await replaceFileAtomically(file, [...chunks()].join(""), 0o600);
    } });
    const receive = manager.receive(receivedDesired(desired("1", "original", false)));
    await entered.promise;
    const stopping = manager.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await receive;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("publishes each cloud adoption without substituting local choices", async () => {
    const localToolPaths: ToolPaths = { codex: { kind: "path", path: "/local/codex" }, copilot: { kind: "path", path: "/local/copilot" } };
    const { manager } = await fixture({ localToolPaths });
    expect(manager.current().toolTargets).toBeNull();
    const original = desired("1", "original", false);
    await manager.receive(receivedDesired(original)); await manager.settle();
    expect(manager.current().toolTargets).toEqual({ source: "cloud", revision: "1", choices: original.value.toolPaths });
    expect(manager.report()).toMatchObject({ bootstrap: null, toolPathsBootstrap: null });
    await manager.receive(receivedDesired({ ...original, revision: "2", value: { ...original.value, toolPaths: { codex: { kind: "auto" }, copilot: null } } }));
    expect(manager.current().toolTargets).toEqual({ source: "cloud", revision: "2", choices: { codex: { kind: "auto" }, copilot: null } });
    expect(manager.report()).toMatchObject({ toolPathsBootstrap: { codex: { kind: "auto" }, copilot: { kind: "path", path: "/local/copilot" } } });
    const cloud = { codex: { kind: "auto" as const }, copilot: { kind: "path" as const, path: "/cloud/copilot" } };
    await manager.receive(receivedDesired({ ...original, revision: "3", value: { ...original.value, toolPaths: cloud } })); await manager.settle();
    expect(manager.current().toolTargets).toEqual({ source: "cloud", revision: "3", choices: cloud });
    expect(manager.report()).toMatchObject({ toolPathsBootstrap: null });
  });

  it.each([
    ["web", "codex", "codex", false], ["web", "codex", "copilot", true],
    ["web", "copilot", "codex", true], ["web", "copilot", "copilot", false],
    ["web", "claude", "codex", true], ["web", "claude", "copilot", true],
  ] as const)("qualifies %s %s with missing %s: %s", async (_mode, agent, missing, ready) => {
    const applyNative = vi.fn(async () => {});
    const { manager } = await fixture({ readToolSelectionKeys: () => ({ codex: "a".repeat(64), copilot: "b".repeat(64) }), applyNative });
    const original = desired("1", "original", false);
    const choices = { codex: { kind: "auto" as const }, copilot: { kind: "auto" as const }, [missing]: null };
    await manager.receive(receivedDesired({ ...original, value: { ...original.value, native: { agent, model: null, args: [] }, toolPaths: choices } }));
    await manager.settle();
    expect(manager.current().effective.native?.agent ?? null).toBe(ready ? agent : null);
    expect(applyNative).toHaveBeenCalledTimes(ready ? 1 : 0);
  });

  it("reads and upgrades a real checkpoint within a bounded JSON operation budget", async () => {
    const first = await fixture();
    const target = desired("1", "original", false);
    await first.manager.receive(receivedDesired({ ...target, value: { ...target.value, native: { ...target.value.native, args: Array<string>(100).fill("x".repeat(4096)) } } }));
    await first.manager.settle();
    await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.schemaVersion = 3;
    await writeFile(first.file, JSON.stringify({ items: saved.items, nativeModes: saved.nativeModes, identity: saved.identity, desired: saved.desired, nextFailureId: saved.nextFailureId, observationRevision: saved.observationRevision, schemaVersion: 3 }));
    const originalParse = JSON.parse, originalStringify = JSON.stringify;
    // The raw desired is one string token; the surrounding cache still exceeds this bounded batch.
    const parseBudget = JSON.stringify(JSON.stringify(saved.desired)).length + 65_536;
    try {
      JSON.parse = ((source: string, ...args: unknown[]) => {
        if (source.length > parseBudget) throw new RangeError("parse text budget exceeded");
        return Reflect.apply(originalParse, JSON, [source, ...args]);
      }) as typeof JSON.parse;
      JSON.stringify = ((input: unknown, ...args: unknown[]) => {
        const result = Reflect.apply(originalStringify, JSON, [input, ...args]) as string | undefined;
        if (result !== undefined && result.length > 65_536 && typeof input !== "string") throw new RangeError("stringify text budget exceeded");
        return result;
      }) as typeof JSON.stringify;
      const options = { file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} };
      const migrated = await createWorkerConfigurationManager(options);
      expect(JSON.parse((await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.authority.desiredJson!).value.native.args).toHaveLength(100);
      await migrated.stop();
      const reopened = await createWorkerConfigurationManager(options);
      expect(JSON.parse((await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.authority.desiredJson!).value.native.args[99]).toBe("x".repeat(4096));
      await reopened.stop();
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
    }
    expect(JSON.parse(await readFile(first.file, "utf8")).schemaVersion).toBe(12);
  });

  it("migrates a structurally valid historical native value larger than the current item limit", async () => {
    const first = await fixture();
    await first.manager.receive(receivedDesired(desired("1", "original", false)));
    await first.manager.settle();
    await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.schemaVersion = 3;
    const native = saved.items.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native");
    native.value.appliedValue.args = Array<string>(2050).fill("x".repeat(4096));
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    const actual = item(reopened.current(), "native")?.appliedValue as WorkerCloudNative;
    expect(actual.args).toHaveLength(2050);
    expect(actual.args[2049]).toBe("x".repeat(4096));
    expect(JSON.parse(await readFile(first.file, "utf8")).schemaVersion).toBe(12);
  });

  it("invalidates only native proofs that depend on a changed tool selection", async () => {
    const blocked = deferred(), release = deferred();
    const selections: Record<Tool, string> = { codex: "a".repeat(64), copilot: "b".repeat(64) };
    let changing = false;
    const { manager } = await fixture({ readToolSelectionKeys: () => selections,
      applyNative: async native => { if (changing && native.agent === "codex") { blocked.resolve(); await release.promise; } },
    });
    const original = desired();
    await manager.receive(receivedDesired({ ...original, value: { ...original.value, projects: [{ projectId, nativeOverrides: { agent: "copilot" } }] } })); await manager.settle();
    changing = true; selections.codex = "d".repeat(64);
    await manager.refreshToolSelections(); await blocked.promise;
    try {
      expect(manager.current().effective.native).toBeNull();
      expect(manager.current().effective.projects[0]?.native?.agent).toBe("copilot");
      expect(manager.current().effective.agentControlMode).toBe("web");
      expect(item(manager.current(), "native")?.state).toBe("applying");
    } finally { release.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.agent).toBe("codex");
  });

  it("prepares missing tool keys before validation without cancelling its own proof", async () => {
    const entered = deferred(), release = deferred(), applied: string[] = [];
    let key: string | undefined;
    const { manager } = await fixture({ readToolSelectionKeys: () => key === undefined ? {} : { codex: key },
      prepareToolSelection: async () => { entered.resolve(); await release.promise; key = "a".repeat(64); },
      applyNative: async () => { applied.push(key!); },
    });
    await manager.receive(receivedDesired(desired("1", "original", false))); await entered.promise;
    await manager.refreshToolSelections(); release.resolve(); await manager.settle();
    expect(applied).toEqual(["a".repeat(64)]); expect(manager.current().effective.native?.model).toBe("original");
    key = undefined;
    expect(manager.current().effective.native).toBeNull();
  });

  it("discards preparation after a newer target and validates only that target's recipe", async () => {
    const entered = deferred(), release = deferred(); let key: string | undefined;
    const applied: string[] = [];
    const { manager } = await fixture({ readToolSelectionKeys: () => key === undefined ? {} : { codex: key },
      prepareToolSelection: async (_native, targets) => {
        if (targets.revision === "1") { entered.resolve(); await release.promise; key = "a".repeat(64); }
        else key = "b".repeat(64);
      }, applyNative: async () => { applied.push(key!); },
    });
    const original = desired("1", "original", false), tools: ToolPaths = { codex: { kind: "path", path: "/old/codex" }, copilot: { kind: "auto" } };
    await manager.receive(receivedDesired({ ...original, value: { ...original.value, toolPaths: { codex: tools.codex, copilot: tools.copilot } } })); await entered.promise;
    await manager.receive(receivedDesired({ ...original, revision: "2", value: { ...original.value, toolPaths: { copilot: tools.copilot, codex: { kind: "path", path: "/new/codex" } } } }));
    release.resolve(); await manager.settle(); expect(applied).toEqual(["b".repeat(64)]);
    expect(manager.current().effective.native?.model).toBe("original");
  });

  it("keeps native validation unavailable when the runtime has no tool selection proof", async () => {
    const { manager } = await fixture({ readToolSelectionKeys: () => ({}) });
    await manager.receive(receivedDesired(desired("1", "original", false))); await manager.settle();
    expect(manager.current().effective.native).toBeNull();
    expect(item(manager.current(), "native")).toMatchObject({ state: "error", error: { code: "unavailable" } });
  });

  it("qualifies an unrelated project in the proven mode while the global tool is unavailable", async () => {
    let selections: Partial<Record<Tool, string>> = { codex: "a".repeat(64), copilot: "b".repeat(64) };
    const { manager } = await fixture({ readToolSelectionKeys: () => selections });
    const original = desired("1", "original", false), first = original;
    await manager.receive(receivedDesired(first)); await manager.settle();
    selections = { copilot: "b".repeat(64) };
    await manager.refreshToolSelections(); await manager.settle();
    await manager.receive(receivedDesired({ ...first, revision: "2", value: { ...first.value, projects: [{ projectId, nativeOverrides: { agent: "copilot" } }] } })); await manager.settle();
    expect(manager.current().effective.native).toBeNull();
    expect(manager.current().effective.projects[0]?.native?.agent).toBe("copilot");
    expect(manager.current().effective.agentControlMode).toBe("web");
  });

  it("invalidates a changed path even before a new selection key is published", async () => {
    const entered = deferred(), release = deferred();
    let changing = false;
    const { manager } = await fixture({ applyNative: async native => {
      if (changing && native.agent === "codex") { entered.resolve(); await release.promise; }
    } });
    const original = desired(), tools: ToolPaths = { codex: { kind: "path", path: "/old/codex" }, copilot: { kind: "auto" } };
    const first = { ...original, value: { ...original.value, toolPaths: { codex: tools.codex, copilot: tools.copilot }, projects: [{ projectId, nativeOverrides: { agent: "copilot" as const } }] } };
    await manager.receive(receivedDesired(first)); await manager.settle();
    changing = true;
    await manager.receive(receivedDesired({ ...first, revision: "2", value: { ...first.value, toolPaths: { copilot: tools.copilot, codex: { kind: "path", path: "/new/codex" } } } }));
    await entered.promise;
    try {
      expect(manager.current().effective.native).toBeNull();
      expect(manager.current().effective.projects[0]?.native?.agent).toBe("copilot");
      expect(manager.current().toolTargets?.choices.codex).toEqual({ kind: "path", path: "/new/codex" });
    } finally { release.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.agent).toBe("codex");
  });

  it("discards a late native validation when its tool selection changed during validation", async () => {
    const entered = deferred(), release = deferred(), latestEntered = deferred(), latestRelease = deferred();
    let key = "a".repeat(64), checks = 0;
    const { manager } = await fixture({ readToolSelectionKeys: () => ({ codex: key }), applyNative: async () => {
      if (++checks === 1) { entered.resolve(); await release.promise; }
      else { latestEntered.resolve(); await latestRelease.promise; }
    } });
    await manager.receive(receivedDesired(desired("1", "original", false))); await entered.promise;
    key = "b".repeat(64);
    await manager.refreshToolSelections(); release.resolve(); await latestEntered.promise;
    try {
      expect(manager.current().effective.native).toBeNull();
      expect(item(manager.current(), "native")?.state).toBe("applying");
    } finally { latestRelease.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.model).toBe("original");
  });

  it("migrates schema 2 without treating historical native settings as current-process proof", async () => {
    const original = desired("1", "original", false), first = await fixture();
    await first.manager.receive(receivedDesired(original)); await first.manager.settle(); await first.manager.stop();
    const cache = await legacyCache(first.file);
    cache.schemaVersion = 2; delete cache.nativeModes;
    await writeFile(first.file, JSON.stringify(cache));
    const checked: string[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async native => { checked.push(native.agent); } });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(reopened.current().effective.native).toBeNull();
    const migrated = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(migrated).toMatchObject({ schemaVersion: 12, authority: { applicationRevision: original.revision, observationRevision: cache.observationRevision } });
    expect(JSON.parse(migrated.authority.desiredJson!)).toEqual(cache.desired);
    expect(migrated.currentItems.every(entry => !("nativeMode" in entry))).toBe(true);
    await reopened.receive(receivedDesired({ ...original, revision: "2" })); await reopened.settle();
    expect(checked).toEqual(["codex"]);
    expect(reopened.current().effective.agentControlMode).toBe("web");
  });

  it("keeps an old target without toolPaths unsupported across GET and restart", async () => {
    const first = await fixture(), valid = desired("1", "original", false);
    await first.manager.receive(receivedDesired(valid)); await first.manager.settle();
    const { toolPaths: _tools, ...oldValue } = valid.value;
    const old = { ...valid, revision: "2", value: oldValue }, raw = JSON.stringify(old), operation = createOperation();
    const client = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: identity.userId, operation, fetch: async () => new Response(`{"desired":${raw},"observationRevision":"0","observation":null}`, { headers: { "Content-Type": "application/json", "Daynight-User-ID": identity.userId, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Tool-Paths": "2" } }) });
    try {
      const received = await client.getWorkerConfiguration(identity.workerId);
      expect(received.desired).toMatchObject({ json: raw, known: null });
      await first.manager.receive(received.desired); await first.manager.settle(); await first.manager.stop();
      const invalid = vi.fn(), applyNative = vi.fn(async () => {});
      const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative, onInvalidDesired: invalid });
      fixtures.push({ manager: reopened, directory: first.directory });
      await reopened.receive(received.desired); await reopened.settle();
      expect(reopened.current().desired).toBeNull();
      expect(reopened.current().effective.native).toBeNull();
      expect(applyNative).not.toHaveBeenCalled();
      expect(invalid).toHaveBeenCalledWith("2", "unsupported_configuration");
      expect((JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache).authority.desiredJson).toBe(raw);
    } finally { operation.dispose(); }
  });

  it.each(["mode", "tools"] as const)("rejects a same-revision removal of retired %s from raw authority", async field => {
    const applyNative = vi.fn(async () => {}), first = await fixture({ applyNative }), valid = desired("1", "original", false);
    const legacy = { ...valid, value: field === "mode" ? { ...valid.value, agentControlMode: "web" as const } : { ...valid.value, toolPaths: { ...valid.value.toolPaths!, herdr: { kind: "auto" as const } } } };
    await first.manager.receive(receivedDesired(legacy)); await first.manager.settle();
    const raw = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.authority.desiredJson;
    let failure: unknown;
    try { await first.manager.receive(receivedDesired(valid)); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    fixtures.find(entry => entry.manager === first.manager)!.expectedStopError = failure;
    expect((await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.authority.desiredJson).toBe(raw);
    expect(first.manager.current().effective.native).toEqual(valid.value.native);
    expect(applyNative).toHaveBeenCalledTimes(1);
  });

  it("accepts an archive capability projection at the same revision", async () => {
    const { manager } = await fixture(), valid = desired("1", "original", false);
    await manager.receive(receivedDesired({ ...valid, value: { ...valid.value, archiveSessions: false } })); await manager.settle();
    await manager.receive(receivedDesired(valid)); await manager.settle();
    expect(manager.current().desired?.value).not.toHaveProperty("archiveSessions");
    expect(manager.current().effective.archiveSessions).toBe(false);
  });

  it("applies a pending schema 10 target with retired fields after the same authoritative GET and revalidates on restart", async () => {
    const first = await fixture(), initial = desired("1", "original", false);
    await first.manager.receive(receivedDesired(initial)); await first.manager.settle(); await first.manager.stop();
    const cache = JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache;
    const updated = desired("2", "updated", false);
    const retained = { ...updated, value: { ...updated.value, agentControlMode: "herdr", toolPaths: { ...updated.value.toolPaths, herdr: { kind: "auto" } }, future: { retained: true } } };
    const raw = JSON.stringify(retained);
    await writeFile(first.file, JSON.stringify({ ...cache, authority: { ...cache.authority, desiredJson: raw, pendingApplication: true } }));
    const applyNative = vi.fn(async () => {}), invalid = vi.fn(), operation = createOperation();
    const client = createApiClient({ serverUrl: "http://localhost:8787", expectedUserId: identity.userId, operation, fetch: async () => new Response(JSON.stringify({ desired: retained, observationRevision: "0", observation: null }), { headers: { "Content-Type": "application/json", "Daynight-User-ID": identity.userId, "Daynight-Worker-Configuration": "1", "Daynight-Worker-Tool-Paths": "2" } }) });
    try {
      const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative, onInvalidDesired: invalid });
      fixtures.push({ manager: reopened, directory: first.directory });
      expect(reopened.current().effective.native).toBeNull();
      expect(applyNative).not.toHaveBeenCalled();
      const resource = await client.getWorkerConfiguration(identity.workerId);
      expect(resource.desired).toMatchObject({ json: raw, known: updated });
      await reopened.receive(resource.desired, resource.observationRevision); await reopened.settle();
      expect(reopened.current().effective.native).toEqual(updated.value.native);
      expect(reopened.current().effective.maxConcurrent).toBe(updated.value.maxConcurrent);
      expect(applyNative).toHaveBeenCalledTimes(1);
      expect(invalid).not.toHaveBeenCalled();
      expect(reopened.report().observation?.items.some(item => item.key.kind === "agentControlMode")).toBe(false);
      const saved = JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache;
      expect(saved).toMatchObject({ schemaVersion: 12, authority: { desiredJson: raw, applicationRevision: "2", pendingApplication: false } });
      await reopened.stop();
      const againApply = vi.fn(async () => {});
      const again = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: againApply });
      fixtures.push({ manager: again, directory: first.directory });
      expect(again.current().effective.native).toBeNull();
      expect(againApply).not.toHaveBeenCalled();
      await again.receive(resource.desired, resource.observationRevision); await again.settle();
      expect(again.current().effective.native).toEqual(updated.value.native);
      expect(againApply).toHaveBeenCalledTimes(1);
      expect((JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache).authority.desiredJson).toBe(raw);
    } finally { operation.dispose(); }
  });

  it("retains an unsupported raw native value without applying it or accepting an old receipt", async () => {
    const applyNative = vi.fn(async () => {}), invalid = vi.fn();
    const { manager, file } = await fixture({ applyNative, onInvalidDesired: invalid });
    const first = desired("1", "original", false);
    await manager.receive(receivedDesired(first)); await manager.settle();
    const sent = manager.report();
    const rejected = { ...first, revision: "2", value: { ...first.value, native: { ...first.value.native, model: " " } } };
    await manager.receive(receivedDesired(rejected)); await manager.settle();
    expect(manager.current().desired).toBeNull();
    expect(manager.current().effective.native).toBeNull();
    expect(manager.current().selectedProjects).toBeNull();
    expect(manager.report().observation).toBeNull();
    expect(JSON.parse((JSON.parse(await readFile(file, "utf8")) as WorkerConfigurationCache).authority.desiredJson!)).toEqual(rejected);
    expect(invalid).toHaveBeenCalledWith("2", "unsupported_configuration");
    expect(applyNative).toHaveBeenCalledTimes(1);
    expect(await manager.acknowledge(sent, receivedReceipt({ desired: first, observationRevision: "1", observationAccepted: true }))).toBe("ignored");
    expect(manager.current().desired).toBeNull();
  });

  it("reports a cached unsupported native value again after the first authoritative read", async () => {
    const first = await fixture(), original = desired("1", "original", false);
    const rejected = { ...original, value: { ...original.value, native: { ...original.value.native, model: " " } } };
    await first.manager.receive(receivedDesired(rejected)); await first.manager.settle(); await first.manager.stop();
    const before = (JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache).authority.desiredJson;
    const applyNative = vi.fn(async () => {}), invalid = vi.fn();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative, onInvalidDesired: invalid });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(invalid).not.toHaveBeenCalled();
    await reopened.receive(receivedDesired(rejected)); await reopened.settle();
    expect(invalid).toHaveBeenCalledWith("1", "unsupported_configuration");
    expect(applyNative).not.toHaveBeenCalled();
    expect(reopened.current().effective.native).toBeNull();
    expect((JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache).authority.desiredJson).toBe(before);
  });

  it("hot-applies platform preference in both directions and reports false as an applied value", async () => {
    const { manager } = await fixture();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBeNull();
    const first = desired("1", "original", false);
    await manager.receive(receivedDesired({ ...first, value: { ...first.value, preferPlatformSpecificTasks: true } }));
    await manager.settle();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBe(true);
    await manager.receive(receivedDesired(desired("2", "original", false)));
    await manager.settle();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBe(false);
    expect(item(manager.current(), "preferPlatformSpecificTasks")).toMatchObject({ state: "applied", appliedValue: false, targetRevision: "2" });
    expect(parseWorkerCloudReport(manager.report(), { controlMode: false, toolPaths: true }).observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "preferPlatformSpecificTasks" }, appliedValue: false }));
  });

  it("atomically migrates a full schema-1 cache without discarding removal or failure ownership", async () => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(receivedDesired(target)); await first.manager.settle(); await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.schemaVersion = 1;
    delete saved.nativeModes;
    delete saved.desired.value.preferPlatformSpecificTasks;
    delete saved.desired.value.agentControlMode;
    saved.items = saved.items.filter((entry: { value: WorkerCloudItem }) => entry.value.key.kind !== "preferPlatformSpecificTasks" && entry.value.key.kind !== "agentControlMode");
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    for (let n = 0; n < 1020; n++) saved.items.push({ value: {
      key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null,
      state: n === 0 ? "error" : "pending", error: n === 0 ? failure : null, lastFailure: n === 0 ? failure : null, nextAttemptAt: null,
    }, attempts: n === 0 ? 2 : 0, failureId: n === 0 ? 1 : null, started: n === 0 });
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    const migrated = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(migrated.schemaVersion).toBe(12);
    expect(JSON.parse(migrated.authority.desiredJson!)).toEqual({ ...saved.desired, value: { ...saved.desired.value, preferPlatformSpecificTasks: false } });
    expect(migrated.nextFailureId).toBe(saved.nextFailureId);
    expect(migrated.authority.observationRevision).toBe(saved.observationRevision);
    const expectedItems = saved.items.map((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native" ? { ...entry, value: { ...entry.value, appliedValue: null, state: "pending" } } : entry);
    expect(migrated.currentItems.filter(entry => entry.value.key.kind !== "preferPlatformSpecificTasks").map(entry => ({ value: entry.value, attempts: entry.backoffStep, failureId: entry.failureId, started: entry.started }))).toEqual(expectedItems);
    expect(item(reopened.current(), "preferPlatformSpecificTasks")).toMatchObject({ state: "pending", appliedValue: null });
    expect(reopened.current().effective.preferPlatformSpecificTasks).toBeNull();
    await reopened.receive(receivedDesired({ ...target, revision: "2" })); await reopened.settle();
    expect(reopened.current().effective.preferPlatformSpecificTasks).toBe(false);
    expect(parseWorkerCloudReport(reopened.report(), { controlMode: false, toolPaths: true }).observation?.items).toHaveLength(1025);
    expect((await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.retainedItems).toContainEqual(expect.objectContaining({ failureId: 1, started: true, value: expect.objectContaining({ key: { kind: "projectRemoval", projectId: "00000000-0000-4000-8000-000000000000" }, state: "error", lastFailure: failure }) }));
  });

  it("rejects a missing preference in a current cache without rewriting it", async () => {
    const first = await fixture();
    await first.manager.receive(receivedDesired(desired("1", "original", false))); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    const savedDesired = JSON.parse(saved.authority.desiredJson!);
    delete savedDesired.value.preferPlatformSpecificTasks;
    saved.authority.desiredJson = JSON.stringify(savedDesired);
    const source = JSON.stringify(saved);
    await writeFile(first.file, source);
    await expect(createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow();
    expect(await readFile(first.file, "utf8")).toBe(source);
  });
  it.each([false, true])("installs a target above the report item limit while preserving removal ownership (started=%s)", async started => {
    const first = await fixture({ persist: persistLifecycleCache }), target = desired("1", "original", false);
    await first.manager.receive(receivedDesired(target)); await first.manager.settle(); await first.manager.stop();
    const saved = await legacyCache(first.file);
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    saved.items.push({ value: { key: { kind: "projectRemoval", projectId }, targetRevision: "1", appliedValue: null, state: "pending", error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started });
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    for (let n = 0; n < 1019; n++) saved.items.push({ value: { key: { kind: "projectRemoval", projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null, state: "error", error: failure, lastFailure: failure, nextAttemptAt: retryAt }, attempts: 1, failureId: n + 1, started: true });
    saved.nextFailureId = 1020;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {}, persist: persistLifecycleCache });
    fixtures.push({ manager: reopened, directory: first.directory });
    const next = desired("2"), expanded = { ...next, value: { ...next.value, projects: [...next.value.projects, { projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: {} }] } };
    await reopened.receive(receivedDesired(expanded));
    const remove = vi.fn(async (_projectId: string, _signal: AbortSignal) => {});
    await reopened.configureProjectAdapters({ remove }); await reopened.settle();
    expect(reopened.current().synchronized).toBe(true);
    expect(reopened.current().desired).toEqual(expanded);
    expect(parseWorkerCloudReport(reopened.report(), { controlMode: false, toolPaths: true }).observation!.items.length).toBeLessThanOrEqual(1025);
    const migrated = JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache;
    expect(migrated.retainedItems.filter(entry => entry.failureId !== null)).toHaveLength(1019);
    if (started) {
      expect(remove.mock.calls.map(([id]) => id)).toEqual([projectId, projectId]);
      expect(item(reopened.current(), "projectRemoval")).toMatchObject({ targetRevision: "2", state: "applied", appliedValue: true });
      expect(migrated.retainedItems.find(entry => entry.value.key.kind === "projectRemoval" && entry.value.key.projectId === projectId)).toMatchObject({ origin: { targetRevision: "1" }, value: { targetRevision: "1", state: "applied" } });
    } else {
      expect(remove).not.toHaveBeenCalled();
      expect(reopened.current().items.some(entry => entry.key.kind === "projectRemoval" && entry.key.projectId === projectId)).toBe(false);
    }
  });
  it("retains the exact unsupported authority without executing it and resumes with a valid lower target", async () => {
    const invalid = { ...desired("10", "original", false), value: { ...desired("10", "original", false).value, maxConcurrent: 65 } };
    const onInvalidDesired = vi.fn(), applyNative = vi.fn(async () => {});
    const { manager } = await fixture({ onInvalidDesired, applyNative });
    expect(manager.hasAuthority()).toBe(false);
    await manager.receive(receivedDesired(invalid)); await manager.settle();
    expect(manager.hasAuthority()).toBe(true);
    expect(manager.current().synchronized).toBe(false);
    expect(manager.current().desired).toEqual(invalid);
    expect(applyNative).not.toHaveBeenCalled();
    const sent = manager.report();
    await manager.acknowledge(sent,receivedReceipt( { desired: invalid, observationRevision: "0", observationAccepted: false }));
    expect(onInvalidDesired).toHaveBeenCalledOnce();
    await manager.receive(receivedDesired(desired("2", "original", false))); await manager.settle();
    expect(manager.current().effective.maxConcurrent).toBe(3);
    expect(applyNative).toHaveBeenCalled();
  });
  it("reloads legacy over-limit cache structurally and applies a valid newer target without discarding failures", async () => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(receivedDesired(target)); await first.manager.settle(); await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.desired.value.maxConcurrent = 65;
    saved.items.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "maxConcurrent").value.appliedValue = 65;
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    saved.items.push({ value: { key: { kind: "projectRemoval", projectId }, targetRevision: "1", appliedValue: null, state: "error", error: failure, lastFailure: failure, nextAttemptAt: null }, attempts: 1, failureId: 1, started: true });
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(desired("2", "original", false))); await reopened.settle();
    expect(reopened.current().effective.maxConcurrent).toBe(3);
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "pending", lastFailure: failure });
    expect((await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.retainedItems).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ key: { kind: "projectRemoval", projectId }, state: "error", lastFailure: failure }) }));
    expect(reopened.report().observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId }, lastFailure: failure }));
  });
  it("cancels obsolete preparation and installs a newer target above the report item limit", async () => {
    const first = await fixture({ persist: persistLifecycleCache });
    await first.manager.receive(receivedDesired(desired())); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache;
    const pendingRemovals = Array.from({ length: 1018 }, (_, n) => ({ recordId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      origin: { generation: saved.authority.generation, targetRevision: "1", source: "application" as const },
      value: { key: { kind: "projectRemoval" as const, projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null, state: "pending" as const, error: null, lastFailure: null, nextAttemptAt: null },
      backoffStep: 0, failureId: null, started: false, actualSource: null, blockedByRemovalId: null }));
    await writeFile(first.file, JSON.stringify({ ...saved, currentItems: [...saved.currentItems, ...pendingRemovals] }));
    const entered = deferred(), released = deferred(), cancelled = deferred();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {}, persist: persistLifecycleCache });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.configureProjectAdapters({ prepare: async (_id, signal) => { signal.addEventListener("abort", () => cancelled.resolve(), { once: true }); entered.resolve(); await released.promise; } });
    await reopened.receive(receivedDesired(desired())); await entered.promise;
    const next = desired("2", "original", false);
    await reopened.receive(receivedDesired({ ...next, value: { ...next.value, projects: [{ projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: {} }] } }));
    await cancelled.promise;
    released.resolve(); await reopened.settle();
    expect(reopened.current().synchronized).toBe(true);
    expect(reopened.current().desired?.revision).toBe("2");
    expect(item(reopened.current(), "projectPreparation")).toMatchObject({ state: "applied", appliedValue: true });
    expect(reopened.report().observation!.items.length).toBeLessThanOrEqual(1025);
  });
  it("retains saturated local facts and advances only the accepted bounded projection across restart", async () => {
    const first = await fixture();
    const target = desired("1", "original", false);
    await first.manager.receive(receivedDesired(target));
    await first.manager.settle();
    await first.manager.stop();
    const saved = await legacyCache(first.file);
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    for (let n = 0; n < 1020; n++) {
      const state = n === 0 || n === 2 ? "applied" : n === 1 ? "error" : "pending";
      saved.items.push({ value: { key: { kind: "projectRemoval", projectId: id(n) }, targetRevision: "1", appliedValue: state === "applied" ? true : null, state, error: n === 1 ? failure : null, lastFailure: n === 1 ? failure : null, nextAttemptAt: null }, attempts: 0, failureId: n === 1 ? 1 : null, started: n === 0 || n === 1 });
    }
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const next = { ...desired("2", "original", false), value: { ...target.value, projects: [{ projectId: id(0), nativeOverrides: {} }] } };
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(next)); await reopened.settle();
    expect(reopened.current().items.length).toBeGreaterThan(1025);
    expect(reopened.current().synchronized).toBe(true);
    expect(reopened.current().desired?.revision).toBe("2");
    await reopened.ensureProjectRemoval(id(1021));
    const before = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    const originalFailure = before.retainedItems.find(entry => entry.value.key.kind === "projectRemoval" && entry.value.key.projectId === id(1))!;
    expect(originalFailure).toMatchObject({ origin: { targetRevision: "1" }, failureId: 1, value: { state: "error", lastFailure: failure } });
    const unknown = reopened.report();
    expect(unknown.observation!.items.length).toBeLessThanOrEqual(1025);
    await reopened.acknowledge(unknown,receivedReceipt( { desired: next, observationRevision: "0", observationAccepted: false }));
    const unconfirmed = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(unconfirmed.projectionCursor).toBe(before.projectionCursor);
    expect(unconfirmed.retainedItems.find(entry => entry.recordId === originalFailure.recordId)).toEqual(originalFailure);
    const accepted = reopened.report();
    expect(accepted.observation!.items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId: id(1) }, lastFailure: failure }));
    await reopened.acknowledge(accepted,receivedReceipt( { desired: next, observationRevision: "1", observationAccepted: true }));
    const committed = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(committed.projectionCursor).not.toBeNull();
    expect(committed.retainedItems.find(entry => entry.recordId === originalFailure.recordId)).toMatchObject({ value: { state: "error", lastFailure: null }, failureId: null });
    expect(committed.currentItems.some(entry => entry.value.key.kind === "projectRemoval" && entry.value.key.projectId === id(0) && entry.value.state === "pending")).toBe(true);
    await reopened.stop();
    const afterRestart = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: afterRestart, directory: first.directory });
    expect(afterRestart.current().synchronized).toBe(false);
    await afterRestart.receive(receivedDesired(next)); await afterRestart.settle();
    const resumed = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(resumed.projectionCursor).toBe(committed.projectionCursor);
    expect(afterRestart.current().items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId: id(1021) }, state: "pending" }));
    await afterRestart.ensureProjectRemoval(id(1022));
    expect(afterRestart.report().observation!.items.length).toBeLessThanOrEqual(1025);
  });
  it("applies independent values while native failure and unprepared projects remain truthful", async () => {
    const { manager, file, wait } = await fixture({ applyNative: async () => { throw new Error("secret native arguments must not be reported"); } });
    await manager.receive(receivedDesired(desired()));
    await wait(snapshot => item(snapshot, "native")?.state === "error" && snapshot.effective.maxConcurrent === 2 && snapshot.effective.pollIntervalMs === 1200 && snapshot.effective.recoveryLimit === 4);
    expect(manager.current().effective).toMatchObject({ maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: null, projects: [{ projectId, ready: false }] });
    expect(item(manager.current(), "projectPreparation")).toMatchObject({ state: "pending", appliedValue: null });
    expect(JSON.stringify(manager.report())).not.toContain("secret native arguments");
    expect(JSON.parse(JSON.parse(await readFile(file, "utf8")).authority.desiredJson).revision).toBe("1");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("does not grant readiness from native validation and defers unavailable bindings until reconfigured", async () => {
    const prepare = vi.fn(async () => false as const);
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare });
    await manager.receive(receivedDesired(desired()));
    await wait(snapshot => item(snapshot, "projectNative")?.state === "applied" && item(snapshot, "projectPreparation")?.state === "pending" && prepare.mock.calls.length === 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    await manager.configureProjectAdapters({ prepare: async () => {} });
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
  });

  it("resolves project inheritance and explicit clears before validating each native tuple", async () => {
    const { manager, wait } = await fixture();
    const current = desired();
    await manager.receive(receivedDesired({ ...current, value: { ...current.value, native: { agent: "codex", model: "global", args: ["--global"] }, projects: [
      { projectId, nativeOverrides: { agent: "claude" } },
      { projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: { model: null, args: [] } },
    ] } }));
    await wait(snapshot => snapshot.effective.projects.every(project => project.native !== null));
    expect(manager.current().effective.projects).toEqual([
      { projectId, native: { agent: "claude", model: null, args: [] }, ready: false },
      { projectId: "44444444-4444-4444-8444-444444444444", native: { agent: "codex", model: null, args: [] }, ready: false },
    ]);
  });

  it("serializes a paused application write with a newer target without losing either transition", async () => {
    const application = deferred(), writeEntered = deferred(), releaseWrite = deferred();
    let pause = true;
    const { manager, file, wait } = await fixture({ applyNative: async native => { if (native.model === "original") await application.promise; }, persist: async (file, chunks) => {
      const contents = [...chunks()].join("");
      const cache = JSON.parse(contents);
      if (pause && cache.currentItems.some((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native" && entry.value.state === "applied")) { pause = false; writeEntered.resolve(); await releaseWrite.promise; }
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.receive(receivedDesired(desired("1", "original", false)));
    await wait(snapshot => snapshot.effective.maxConcurrent === 2);
    application.resolve();
    await writeEntered.promise;
    const receiving = manager.receive(receivedDesired(desired("2", "new", false)));
    expect(manager.current().desired?.revision).toBe("1");
    releaseWrite.resolve();
    await receiving;
    await wait(snapshot => snapshot.effective.native?.model === "new");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(JSON.parse(saved.authority.desiredJson!).revision).toBe("2");
    expect(saved.currentItems.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native").value.appliedValue.model).toBe("new");
  });

  it("discards a late superseded native result and converges after its cancellation joins", async () => {
    const oldStarted = deferred(), releaseOld = deferred();
    const { manager, wait } = await fixture({ applyNative: async native => { if (native.model === "old") { oldStarted.resolve(); await releaseOld.promise; } } });
    await manager.receive(receivedDesired(desired("1", "old", false)));
    await oldStarted.promise;
    await manager.receive(receivedDesired(desired("2", "latest", false)));
    releaseOld.resolve();
    await wait(snapshot => snapshot.effective.native?.model === "latest");
    expect(item(manager.current(), "native")).toMatchObject({ targetRevision: "2", appliedValue: { model: "latest" }, state: "applied" });
    await manager.receive(receivedDesired(desired("1", "old", false)));
    await manager.settle();
    expect(manager.current().desired?.revision).toBe("1");
    expect(item(manager.current(), "native")).toMatchObject({ targetRevision: "1", appliedValue: { model: "old" }, state: "applied" });
  });

  it("retains recovered failures until accepted and cannot clear a new failure with an older ACK", async () => {
    let failed = true;
    const { manager, wait } = await fixture({ now: () => Date.parse("2026-11-04T00:00:00Z"), applyNative: async () => { if (failed) throw new TypeError("bad args"); } });
    await manager.receive(receivedDesired(desired("1", "bad", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const firstReport = manager.report();
    failed = false;
    await manager.receive(receivedDesired(desired("2", "recovered", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    await manager.acknowledge(firstReport,receivedReceipt( { desired: desired("2", "recovered", false), observationRevision: "1", observationAccepted: false }));
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    expect(manager.report().observation?.baseRevision).toBe("0");
    const recoveredReport = manager.report();
    failed = true;
    await manager.receive(receivedDesired(desired("3", "bad-again", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const newFailure = item(manager.current(), "native")?.lastFailure;
    await manager.acknowledge(recoveredReport,receivedReceipt( { desired: desired("3", "bad-again", false), observationRevision: "1", observationAccepted: true }));
    expect(item(manager.current(), "native")?.lastFailure).toEqual(newFailure);
    const latestReport = manager.report();
    await manager.acknowledge(latestReport,receivedReceipt( { desired: desired("3", "bad-again", false), observationRevision: "1", observationAccepted: true }));
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    const historicalReport = manager.report();
    await manager.acknowledge(historicalReport,receivedReceipt( { desired: desired("3", "bad-again", false), observationRevision: "2", observationAccepted: true }));
    expect(item(manager.current(), "native")?.lastFailure).toBeNull();
    expect(item(manager.current(), "native")?.error).not.toBeNull();
  });

  it("retries failed items with bounded backoff and preserves the successful value", async () => {
    const { manager, wait } = await fixture({ applyNative: async native => { if (native.model === "invalid") throw new Error("provider unavailable"); } });
    await manager.receive(receivedDesired(desired("1", "good", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    vi.useFakeTimers();
    await manager.receive(receivedDesired(desired("2", "invalid", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    expect(manager.current().effective.native?.model).toBe("good");
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const before = item(manager.current(), "native")!;
      expect(Date.parse(before.nextAttemptAt!) - Date.now()).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
      await wait(snapshot => item(snapshot, "native")?.state === "error" && item(snapshot, "native")?.nextAttemptAt !== before.nextAttemptAt);
    }
  });

  it("does not lose an already started project removal when the project is re-added", async () => {
    const removing = deferred(), releaseRemoval = deferred();
    const { manager, wait, file } = await fixture();
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => { removing.resolve(); await releaseRemoval.promise; } });
    await manager.receive(receivedDesired(desired("1")));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await manager.receive(receivedDesired(desired("2", "original", false)));
    expect(manager.current().effective.projects).toEqual([]);
    await removing.promise;
    const original = (await readConfigurationCache(file, identity, new AbortController().signal)).cache.currentItems.find(entry => entry.value.key.kind === "projectRemoval")!;
    await manager.receive(receivedDesired(desired("3")));
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    releaseRemoval.resolve();
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "3", state: "applied", appliedValue: true });
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems.find(entry => entry.recordId === original.recordId)).toMatchObject({ origin: original.origin, value: { targetRevision: "2", state: "applied", appliedValue: true } });
  });

  it("cancels preparation when the project is removed and joins it before preparing again", async () => {
    const entered = deferred(), release = deferred(), cancelled = deferred();
    let calls = 0;
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare: async (_projectId, signal) => {
      calls += 1;
      if (calls === 1) {
        signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
        entered.resolve();
        await release.promise;
      }
    }, remove: async () => {} });
    await manager.receive(receivedDesired(desired()));
    await entered.promise;
    await manager.receive(receivedDesired(desired("2", "original", false)));
    await cancelled.promise;
    release.resolve();
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await manager.receive(receivedDesired(desired("3")));
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(calls).toBe(2);
  });

  it("reports and retries stopping a retained project absent from the initial cloud target", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ remove: async () => { if (++attempts === 1) throw new Error("stop failed"); } });
    await manager.receive(receivedDesired(desired("1", "original", false)));
    await manager.ensureProjectRemoval(projectId);
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "error");
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "1", error: { phase: "stop" }, lastFailure: { phase: "stop" } });
    await manager.ensureProjectRemoval(projectId);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "1", lastFailure: { phase: "stop" } });
    expect(attempts).toBe(2);
  });

  it("reconfirms an unacknowledged cached removal after restart", async () => {
    const first = await fixture();
    await first.manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    await first.manager.receive(receivedDesired(desired()));
    await first.wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await first.manager.receive(receivedDesired(desired("2", "original", false)));
    await first.wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await first.manager.stop();
    const stop = vi.fn(async () => {});
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(desired("2", "original", false)));
    await reopened.configureProjectAdapters({ remove: stop });
    await reopened.ensureProjectRemoval(projectId);
    await reopened.settle();
    expect(stop).toHaveBeenCalledOnce();
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ targetRevision: "2", state: "applied" });
  });

  it("keeps an in-flight removal across repeated selection changes", async () => {
    const removing = deferred(), releaseRemoval = deferred();
    const prepare = vi.fn(async () => {});
    let removalSignal: AbortSignal | undefined;
    const { manager, wait, file } = await fixture();
    await manager.configureProjectAdapters({ prepare, remove: async (_projectId, signal) => { removalSignal = signal; removing.resolve(); await releaseRemoval.promise; } });
    await manager.receive(receivedDesired(desired("1")));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await manager.receive(receivedDesired(desired("2", "original", false)));
    await removing.promise;
    const original = (await readConfigurationCache(file, identity, new AbortController().signal)).cache.currentItems.find(entry => entry.value.key.kind === "projectRemoval")!;
    await manager.receive(receivedDesired(desired("3")));
    await manager.receive(receivedDesired(desired("4", "original", false)));
    await manager.receive(receivedDesired(desired("5")));
    try {
      expect(removalSignal?.aborted).toBe(false);
      expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "5", state: "pending" });
      expect((JSON.parse(await readFile(file, "utf8")) as WorkerConfigurationCache).retainedItems.find(entry => entry.recordId === original.recordId)).toMatchObject({ origin: original.origin, value: { targetRevision: "2", state: "applying" } });
      expect(manager.current().effective.projects[0]?.ready).toBe(false);
      expect(prepare).toHaveBeenCalledTimes(1);
    } finally { releaseRemoval.resolve(); }
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ targetRevision: "5", state: "applied" });
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems.find(entry => entry.recordId === original.recordId)).toMatchObject({ origin: original.origin, value: { targetRevision: "2", state: "applied" } });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("retains completed removal until its matching result has been acknowledged", async () => {
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    await manager.receive(receivedDesired(desired()));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    const earlier = manager.report();
    await manager.receive(receivedDesired(desired("2", "original", false)));
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await manager.acknowledge(earlier,receivedReceipt( { desired: desired("2", "original", false), observationRevision: "1", observationAccepted: true }));
    expect(item(manager.current(), "projectRemoval")).toBeDefined();
    const completed = manager.report();
    await manager.acknowledge(completed,receivedReceipt( { desired: desired("2", "original", false), observationRevision: "1", observationAccepted: true }));
    expect(manager.current().items.every(item => !("projectId" in item.key))).toBe(true);
  });

  it.each(["before acknowledgement", "in acknowledgement"])("revalidates reselected applied project history %s", async selection => {
    const checked: WorkerCloudNative[] = [], published: WorkerConfigurationSnapshot[] = [], reports: WorkerCloudReport[] = [];
    const { manager, file } = await fixture({ applyNative: async native => { checked.push(native); }, onChange: snapshot => {
      published.push(snapshot);
      if (snapshot.desired?.revision === "3") reports.push(manager.report());
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), global = original.value.native, projectNative = { ...global, model: "project" };
    const initial: WorkerCloudDesired = { ...original, value: { ...original.value, projects: [{ projectId, nativeOverrides: { model: projectNative.model } }] } };
    const removed: WorkerCloudDesired = { ...initial, revision: "2", value: { ...initial.value, projects: [] } };
    const reselected = { ...initial, revision: "3", value: { ...initial.value, toolPaths: { codex: { kind: "path" as const, path: "/new/codex" }, copilot: { kind: "auto" as const } } } };
    await manager.receive(receivedDesired(initial)); await manager.settle();
    await manager.receive(receivedDesired(removed)); await manager.settle();
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ state: "applied", targetRevision: "2" });
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ key: { kind: "projectNative", projectId }, state: "applied", appliedValue: projectNative }) }));
    const report = manager.report();
    let beforeAcknowledgement: WorkerConfigurationSnapshot | undefined;
    if (selection === "before acknowledgement") {
      await manager.receive(receivedDesired(reselected)); await manager.settle();
      beforeAcknowledgement = manager.current();
    }
    await manager.acknowledge(report,receivedReceipt( { desired: reselected, observationRevision: "1", observationAccepted: true }));
    await manager.settle();
    if (selection === "before acknowledgement") {
      expect(manager.current().observationRevision).toBe("0");
      await manager.acknowledge(manager.report(),receivedReceipt( { desired: reselected, observationRevision: "1", observationAccepted: true }));
      await manager.settle();
    }
    expect(reports[0]?.observation?.items.find(value => value.key.kind === "projectNative")).toMatchObject({ targetRevision: "3", state: "pending" });
    expect(item(published.find(snapshot => snapshot.desired?.revision === "3")!, "projectNative")).toMatchObject({ state: "pending", appliedValue: projectNative });
    expect(published.filter(snapshot => snapshot.desired?.revision === "3").every(snapshot => item(snapshot, "projectNative")?.state !== "applied" || snapshot.effective.projects[0]?.native !== null)).toBe(true);
    expect(manager.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ ready: true, native: projectNative }] });
    if (beforeAcknowledgement !== undefined) expect(beforeAcknowledgement.effective.projects).toEqual([{ projectId, ready: true, native: projectNative }]);
    expect(item(manager.current(), "projectRemoval")).toBeUndefined();
    expect(checked.filter(value => value.model === global.model)).toHaveLength(2);
    expect(checked.filter(value => value.model === projectNative.model)).toHaveLength(2);
    await manager.receive(receivedDesired({ ...reselected, revision: "4", value: { ...reselected.value, maxConcurrent: 8 } })); await manager.settle();
    expect(manager.current().effective.projects[0]?.native).toEqual(projectNative);
    expect(checked).toHaveLength(4);
    await manager.receive(receivedDesired({ ...removed, revision: "5" })); await manager.settle();
    await manager.acknowledge(manager.report(),receivedReceipt( { desired: { ...reselected, revision: "6" }, observationRevision: "2", observationAccepted: true })); await manager.settle();
    expect(manager.current().effective.projects[0]?.native).toEqual(projectNative);
    expect(checked).toHaveLength(6);
  });

  it("reports a reselected project as pending before either native proof completes", async () => {
    const globalStarted = deferred(), globalRelease = deferred(), projectStarted = deferred(), projectRelease = deferred();
    let reselecting = false;
    const { manager, file } = await fixture({ applyNative: async native => {
      if (!reselecting) return;
      if (native.model === "project") { projectStarted.resolve(); await projectRelease.promise; }
      else { globalStarted.resolve(); await globalRelease.promise; }
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, projects: [{ projectId, nativeOverrides: { model: "project" } }] } };
    await manager.receive(receivedDesired(initial)); await manager.settle();
    await manager.receive(receivedDesired({ ...initial, revision: "2", value: { ...initial.value, projects: [] } })); await manager.settle();
    const reselected = { ...initial, revision: "3", value: { ...initial.value, toolPaths: { codex: { kind: "path" as const, path: "/new/codex" }, copilot: { kind: "auto" as const } } } }, operation = createOperation();
    reselecting = true;
    try {
      await syncWorkerConfigurationOnce({ operation, report: () => ({ ...workerTelemetry, taskInventory: null }), configuration: {
        prepare: async () => { await manager.receive(receivedDesired(reselected)); }, capture: () => manager.report(),
        send: async (_report, captured) => {
          expect(captured.observation?.items.find(value => value.key.kind === "projectNative")).toMatchObject({ targetRevision: "3", state: "pending" });
          return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: receivedReceipt({ desired: reselected, observationRevision: "1", observationAccepted: true }) };
        }, accept: (sent, receipt) => manager.acknowledge(sent,receipt),
      } });
      await globalStarted.promise;
      expect(manager.current().effective.projects[0]?.native).toBeNull();
      globalRelease.resolve(); await projectStarted.promise;
      expect(manager.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ native: null }] });
      expect(manager.report().observation?.items.find(value => value.key.kind === "projectNative")?.state).toBe("applying");
      expect(JSON.parse(await readFile(file, "utf8")).currentItems.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "projectNative").value.state).toBe("applying");
    } finally { globalRelease.resolve(); projectRelease.resolve(); operation.dispose(); }
    await manager.settle();
    expect(manager.current().effective.projects[0]?.native?.model).toBe("project");
  });

  it("revalidates cached applied native items when the first synchronization is an acknowledgement", async () => {
    const first = await fixture(), original = desired(), initial = { ...original, value: { ...original.value, toolPaths: { codex: { kind: "auto" as const }, copilot: { kind: "auto" as const } } } };
    await first.manager.receive(receivedDesired(initial)); await first.manager.settle(); await first.manager.stop();
    const entered = deferred(), release = deferred(), published: WorkerConfigurationSnapshot[] = [];
    let calls = 0;
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async () => { if (++calls === 1) { entered.resolve(); await release.promise; } }, onChange: snapshot => { published.push(snapshot); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    const operation = createOperation();
    try {
      await syncWorkerConfigurationOnce({ operation, report: () => ({ ...workerTelemetry, taskInventory: null }), configuration: {
        capture: () => reopened.report(),
        send: async (_report, captured) => {
          expect(captured.observation).toBeNull();
          return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: receivedReceipt({ desired: initial, observationRevision: "0", observationAccepted: false }) };
        }, accept: (sent, receipt) => reopened.acknowledge(sent,receipt),
      } });
      await entered.promise;
      expect(item(published[0]!, "native")?.state).toBe("pending");
      expect(item(published[0]!, "projectNative")?.state).toBe("pending");
      expect(reopened.current().effective).toMatchObject({ native: null, projects: [{ native: null }] });
    } finally { release.resolve(); operation.dispose(); }
    await reopened.settle();
    expect(reopened.current().effective).toMatchObject({ native: initial.value.native, projects: [{ native: initial.value.native }] });
    expect(calls).toBe(2);
  });

  it("reuses a still-proven applied project when reselected", async () => {
    const applyNative = vi.fn(async () => {}), { manager } = await fixture({ applyNative });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial = original;
    await manager.receive(receivedDesired(initial)); await manager.settle();
    await manager.receive(receivedDesired({ ...initial, revision: "2", value: { ...initial.value, projects: [] } })); await manager.settle();
    await manager.acknowledge(manager.report(),receivedReceipt( { desired: { ...initial, revision: "3" }, observationRevision: "1", observationAccepted: true })); await manager.settle();
    expect(manager.current().effective.projects).toEqual([{ projectId, ready: true, native: initial.value.native }]);
    expect(applyNative).toHaveBeenCalledTimes(2);
  });

  it("preserves failure history and retry deadlines while revalidating a reselected project", async () => {
    let failProject = true, projectCalls = 0, now = Date.parse("2026-11-10T00:00:00Z");
    const published: WorkerConfigurationSnapshot[] = [];
    const { manager } = await fixture({ now: () => now, onChange: snapshot => { published.push(snapshot); }, applyNative: async native => {
      if (native.model === "project") { projectCalls++; if (failProject) throw new TypeError("project unavailable"); }
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, projects: [{ projectId, nativeOverrides: { model: "project" } }] } };
    await manager.receive(receivedDesired(initial)); await manager.settle();
    const originalFailure = item(manager.current(), "projectNative")!.lastFailure;
    failProject = false;
    await manager.receive(receivedDesired({ ...initial, revision: "2", value: { ...initial.value, maxConcurrent: 3 } })); await manager.settle();
    await manager.receive(receivedDesired({ ...initial, revision: "3", value: { ...initial.value, projects: [] } })); await manager.settle();
    const reselected = { ...initial, revision: "4", value: { ...initial.value, toolPaths: { codex: { kind: "path" as const, path: "/new/codex" }, copilot: { kind: "auto" as const } } } };
    failProject = true;
    await manager.receive(receivedDesired(reselected)); await manager.settle();
    expect(item(published.find(snapshot => snapshot.desired?.revision === "4")!, "projectNative")).toMatchObject({ state: "pending", lastFailure: originalFailure });
    expect(manager.current().effective.projects[0]?.native).toBeNull();
    expect(item(manager.current(), "projectNative")).toMatchObject({ state: "error", nextAttemptAt: "2026-11-10T00:00:05.000Z" });
    expect(projectCalls).toBe(4);
    await manager.receive(receivedDesired(reselected)); await manager.settle();
    expect(projectCalls).toBe(4);
    now += 5_000; failProject = false;
    await manager.receive(receivedDesired(reselected)); await manager.settle();
    expect(projectCalls).toBe(5);
    expect(item(manager.current(), "projectNative")).toMatchObject({ state: "applied", error: null, lastFailure: { code: "invalid_configuration" } });
    expect(manager.current().effective.projects[0]?.native?.model).toBe("project");
    await manager.acknowledge(manager.report(),receivedReceipt( { desired: reselected, observationRevision: "1", observationAccepted: true }));
    expect(item(manager.current(), "projectNative")?.lastFailure).toEqual(originalFailure);
    await manager.acknowledge(manager.report(),receivedReceipt( { desired: reselected, observationRevision: "2", observationAccepted: true }));
    expect(item(manager.current(), "projectNative")?.lastFailure).toBeNull();
  });

  it("does not publish reselected project proof when its result cannot be persisted", async () => {
    const disk = new Error("project proof commit failed"), published: WorkerConfigurationSnapshot[] = [];
    const { manager } = await fixture({ onChange: snapshot => { published.push(snapshot); }, persist: async (file, chunks) => {
      const contents = [...chunks()].join("");
      const cache = JSON.parse(contents);
      if ((cache.authority.desiredJson === null ? null : JSON.parse(cache.authority.desiredJson).revision) === "3" && cache.currentItems.some((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "projectNative" && entry.value.state === "applied")) throw disk;
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial = original;
    await manager.receive(receivedDesired(initial)); await manager.settle();
    await manager.receive(receivedDesired({ ...initial, revision: "2", value: { ...initial.value, projects: [] } })); await manager.settle();
    fixtures.find(entry => entry.manager === manager)!.expectedStopError = disk;
    await manager.receive(receivedDesired({ ...initial, revision: "3", value: { ...initial.value, toolPaths: { codex: { kind: "path", path: "/new/codex" }, copilot: { kind: "auto" } } } }));
    await expect(manager.settle()).rejects.toBe(disk);
    expect(published.filter(snapshot => snapshot.desired?.revision === "3").every(snapshot => snapshot.effective.projects[0]?.native === null && item(snapshot, "projectNative")?.state !== "applied")).toBe(true);
    expect(manager.current().effective.projects[0]?.native).toBeNull();
    expect(() => manager.report()).toThrow(disk);
  });

  it("rejects an unrelated accepted receipt without erasing unreported failure information", async () => {
    const { manager, wait } = await fixture({ applyNative: async () => { throw new TypeError("invalid"); } });
    await manager.receive(receivedDesired(desired("1", "bad", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const report = manager.report();
    await expect(manager.acknowledge(report,receivedReceipt( { desired: desired("1", "bad", false), observationRevision: "8", observationAccepted: true }))).rejects.toThrow("does not acknowledge");
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    expect(manager.current().observationRevision).toBe("0");
  });

  it("loads applied values without granting authority, then checks the cloud and repository again", async () => {
    const first = await fixture();
    await first.manager.configureProjectAdapters({ prepare: async () => {} });
    await first.manager.receive(receivedDesired(desired()));
    await first.wait(snapshot => snapshot.effective.projects[0]?.ready === true && snapshot.effective.native !== null);
    await first.manager.stop();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(reopened.current().synchronized).toBe(false);
    expect(reopened.current().effective.native).toBeNull();
    expect(reopened.report().observation).toBeNull();
    await reopened.receive(receivedDesired(desired()), "9");
    expect(reopened.current().effective.projects[0]?.ready).toBe(false);
    expect(reopened.report().observation?.baseRevision).toBe("9");
  });

  it("rejects corrupted or foreign caches instead of inventing defaults", async () => {
    const { manager, file, wait } = await fixture();
    await manager.receive(receivedDesired(desired("1", "good", false)));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    await manager.stop();
    await expect(createWorkerConfigurationManager({ file, identity: { ...identity, workerId: projectId }, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow("identity");
    const cache = JSON.parse(await readFile(file, "utf8"));
    cache.currentItems = [];
    await writeFile(file, JSON.stringify(cache));
    await expect(createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow("missing target");
  });

  it("does not consume a cached native tuple before preflight under the current local control mode", async () => {
    const first = await fixture();
    await first.manager.receive(receivedDesired(desired("1", "previous-mode", false)));
    await first.wait(snapshot => snapshot.effective.native?.model === "previous-mode");
    await first.manager.stop();
    const entered = deferred(), release = deferred(), observedFailure = deferred();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async () => { entered.resolve(); await release.promise; },
      onChange: snapshot => { if (item(snapshot, "native")?.state === "error") observedFailure.resolve(); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(desired("1", "previous-mode", false)));
    expect(reopened.current().effective.native).toBeNull();
    await entered.promise;
    expect(reopened.current().effective.native).toBeNull();
    release.reject(new TypeError("Arguments are invalid in the current control mode."));
    await observedFailure.promise;
    expect(reopened.current().effective.native).toBeNull();
    expect(item(reopened.current(), "native")?.appliedValue).toMatchObject({ model: "previous-mode" });
    await reopened.receive(receivedDesired(desired("2", "previous-mode", false)));
    await reopened.settle();
    expect(item(reopened.current(), "native")?.state).toBe("error");
    expect(reopened.current().effective.native).toBeNull();
  });

  it.each([
    { scope: "global", projects: false, model: "current-model", args: ["--no-alt-screen"] },
    { scope: "project", projects: true, model: "current-model", args: ["--no-alt-screen"] },
    { scope: "global", projects: false, model: null, args: [] },
    { scope: "project", projects: true, model: null, args: [] },
  ])("validates the current $scope target before exposing cached settings with model $model", async ({ projects, model, args }) => {
    const previous = desired("1", "previous-good", projects);
    const first = await fixture();
    await first.manager.receive(receivedDesired({ ...previous, value: { ...previous.value, native: { ...previous.value.native, args: ["--search"] } } }));
    await first.manager.settle();
    await first.manager.stop();
    const release = deferred(), entered = deferred(), checked: WorkerCloudNative[] = [], published: WorkerConfigurationSnapshot[] = [];
    const current = desired("2", "current-model", projects), native = { ...current.value.native, model, args };
    const effective = (snapshot: WorkerConfigurationSnapshot): WorkerCloudNative | null => projects ? snapshot.effective.projects[0]?.native ?? null : snapshot.effective.native;
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async value => {
        checked.push(value);
        if (value.model === model) {
          if (checked.filter(value => value.model === model).length === (projects ? 2 : 1)) entered.resolve();
          await release.promise;
        }
      },
      onChange: snapshot => { published.push(snapshot); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired({ ...current, value: { ...current.value, native } }));
    try {
      await entered.promise;
      expect(effective(reopened.current())).toBeNull();
      expect(published.every(snapshot => effective(snapshot) === null)).toBe(true);
    } finally { release.resolve(); }
    await reopened.settle();
    expect(effective(reopened.current())).toEqual(native);
    expect(checked).toEqual(Array.from({ length: projects ? 2 : 1 }, () => native));
    expect(published.every(snapshot => effective(snapshot)?.model !== "previous-good")).toBe(true);
  });

  it("revalidates a historical successful tuple when the newest cloud native target fails", async () => {
    const first = await fixture();
    await first.manager.receive(receivedDesired(desired("1", "previous-good", false)));
    await first.wait(snapshot => snapshot.effective.native?.model === "previous-good");
    await first.manager.stop();
    const checked: string[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async native => { checked.push(native.model!); if (native.model === "new-invalid") throw new TypeError("invalid current target"); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(desired("2", "new-invalid", false)));
    await reopened.settle();
    expect(checked).toEqual(["new-invalid", "previous-good"]);
    expect(reopened.current().effective.native?.model).toBe("previous-good");
    expect(item(reopened.current(), "native")).toMatchObject({ state: "error", targetRevision: "2", appliedValue: { model: "previous-good" } });
  });

  it("carries current-process historical validation to a new target after restart", async () => {
    const first = await fixture({ applyNative: async native => { if (native.model === "invalid") throw new TypeError("current target unavailable"); } });
    await first.manager.configureProjectAdapters({ prepare: async () => {} });
    await first.manager.receive(receivedDesired(desired("1", "previous-good"))); await first.manager.settle();
    await first.manager.receive(receivedDesired(desired("2", "invalid"))); await first.manager.settle();
    await first.manager.stop();
    const saved: WorkerConfigurationCache = JSON.parse(await readFile(first.file, "utf8"));
    const entered = deferred(), release = deferred(), checked: string[] = [], published: WorkerConfigurationSnapshot[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, now: () => Date.parse("2026-11-10T00:00:00Z"), onChange: snapshot => { published.push(snapshot); }, applyNative: async native => {
      checked.push(native.model!);
      if (native.model === "next-invalid") { entered.resolve(); await release.promise; }
      if (native.model !== "previous-good") throw new TypeError("current target unavailable");
    } });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.configureProjectAdapters({ prepare: async () => {} });
    await reopened.receive(receivedDesired(desired("2", "invalid"))); await reopened.settle();
    expect(checked.toSorted()).toEqual(["invalid", "invalid", "previous-good", "previous-good"]);
    expect(reopened.current().effective).toMatchObject({ native: { model: "previous-good" }, projects: [{ ready: true, native: { model: "previous-good" } }] });
    try {
      await reopened.receive(receivedDesired(desired("3", "next-invalid"))); await entered.promise;
      expect(reopened.current().effective).toMatchObject({ native: { model: "previous-good" }, projects: [{ ready: true, native: { model: "previous-good" } }] });
    } finally { release.resolve(); await reopened.settle(); }
    expect(published.filter(snapshot => snapshot.desired?.revision === "3").every(snapshot => snapshot.effective.native?.model === "previous-good" && snapshot.effective.projects[0]?.native?.model === "previous-good")).toBe(true);
    expect(checked.toSorted()).toEqual(["invalid", "invalid", "next-invalid", "next-invalid", "previous-good", "previous-good"]);
    const continued: WorkerConfigurationCache = JSON.parse(await readFile(first.file, "utf8"));
    for (const kind of ["native", "projectNative"] as const) {
      const before = saved.currentItems.find(entry => entry.value.key.kind === kind)!;
      const after = continued.currentItems.find(entry => entry.value.key.kind === kind)!;
      expect(after.actualSource).toEqual(before.actualSource);
      expect(after.recordId).not.toBe(before.recordId);
      expect(after.value).toMatchObject({ state: "error", targetRevision: "3", appliedValue: { model: "previous-good" } });
    }
    await reopened.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    await reopened.receive(receivedDesired(desired("4", "next-invalid", false))); await reopened.settle();
    await reopened.receive(receivedDesired(desired("5", "next-invalid"))); await reopened.settle();
    expect(reopened.current().effective.projects[0]).toMatchObject({ ready: true, native: { model: "previous-good" } });
    expect(checked.filter(model => model === "previous-good")).toHaveLength(2);
  });

  it("keeps an already validated live tuple available while applying the current target", async () => {
    const entered = deferred(), release = deferred();
    const { manager } = await fixture({ applyNative: async native => {
      if (native.model === "current-model") { entered.resolve(); await release.promise; }
    } });
    await manager.receive(receivedDesired(desired("1", "previous-good")));
    await manager.settle();
    await manager.receive(receivedDesired(desired("2", "current-model")));
    try {
      await entered.promise;
      expect(manager.current().effective.native?.model).toBe("previous-good");
      expect(manager.current().effective.projects[0]?.native?.model).toBe("previous-good");
    } finally { release.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.model).toBe("current-model");
    expect(manager.current().effective.projects[0]?.native?.model).toBe("current-model");
  });

  it.each([true, false])("retains the current failure when cached null-model history is usable: %s", async usable => {
    const first = await fixture(), original = desired("1");
    const previous = { ...original.value.native, model: null, args: ["--search"] };
    await first.manager.receive(receivedDesired({ ...original, value: { ...original.value, native: previous } }));
    await first.manager.settle();
    await first.manager.stop();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async native => {
        if (native.model === "new-invalid") throw new TypeError("invalid current target");
        if (!usable) throw new Error("historical provider unavailable");
      },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(desired("2", "new-invalid")));
    await reopened.settle();
    expect(reopened.current().effective.native).toEqual(usable ? previous : null);
    expect(reopened.current().effective.projects[0]?.native).toEqual(usable ? previous : null);
    for (const kind of ["native", "projectNative"] as const) {
      expect(item(reopened.current(), kind)).toMatchObject({ state: "error", appliedValue: previous, error: { code: "invalid_configuration" }, lastFailure: { code: "invalid_configuration" } });
    }
  });

  it.each(["superseded", "cancelled"] as const)("does not publish a %s historical validation", async transition => {
    const first = await fixture();
    await first.manager.receive(receivedDesired(desired("1", "previous-good", false)));
    await first.manager.settle();
    await first.manager.stop();
    const entered = deferred(), release = deferred(), cancellation = new AbortController(), published: WorkerConfigurationSnapshot[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: cancellation.signal,
      applyNative: async native => {
        if (native.model === "new-invalid") throw new TypeError("invalid current target");
        if (native.model === "previous-good") { entered.resolve(); await release.promise; }
      },
      onChange: snapshot => { published.push(snapshot); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(receivedDesired(desired("2", "new-invalid", false)));
    try {
      await entered.promise;
      if (transition === "superseded") await reopened.receive(receivedDesired(desired("3", "latest", false)));
      else cancellation.abort(new Error("Worker stopped during historical validation."));
    } finally { release.resolve(); }
    await reopened.settle();
    expect(reopened.current().effective.native?.model ?? null).toBe(transition === "superseded" ? "latest" : null);
    expect(published.every(snapshot => snapshot.effective.native?.model !== "previous-good")).toBe(true);
  });

  it("settles immediate application work without waiting for a future retry", async () => {
    const { manager } = await fixture({ applyNative: async () => { throw new TypeError("invalid"); } });
    await manager.receive(receivedDesired(desired("1", "invalid", false)));
    await manager.settle();
    expect(manager.current().effective).toMatchObject({ maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: null });
    expect(item(manager.current(), "native")?.state).toBe("error");
    expect(Date.parse(item(manager.current(), "native")!.nextAttemptAt!)).toBeGreaterThan(Date.now());
  });

  it("propagates persistence failure and never publishes an uncommitted success", async () => {
    const storageError = new Error("disk write rejected"), errors: unknown[] = [], nativeEvents: string[] = [];
    let rejectWrites = false;
    const { manager, wait } = await fixture({ onError: error => { errors.push(error); }, onNativeApplication: event => { if (event.key.kind === "native") nativeEvents.push(event.kind); }, applyNative: async () => { rejectWrites = true; }, persist: async (file, chunks) => {
      const contents = [...chunks()].join("");
      const cache = JSON.parse(contents);
      if (rejectWrites && cache.currentItems.some((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native" && entry.value.state === "applied")) throw storageError;
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.receive(receivedDesired(desired("1", "good", false)));
    await wait(snapshot => snapshot.effective.maxConcurrent === 2);
    await vi.waitFor(() => expect(errors).toEqual([storageError]));
    expect(nativeEvents).toEqual(["started", "cancelled"]);
    expect(manager.current().effective.native).toBeNull();
    expect(() => manager.report()).toThrow(storageError);
    await expect(manager.stop()).rejects.toBe(storageError);
    fixtures.find(fixture => fixture.manager === manager)!.expectedStopError = storageError;
  });

  it("persists an uninitialized target with its zero baseline while retaining unacknowledged facts", async () => {
    const { manager, file, directory } = await fixture({ applyNative: async native => { if (native.model === "invalid") throw new TypeError("native unavailable"); } });
    const target = desired("1", "invalid", false);
    await manager.receive(receivedDesired(target)); await manager.settle();
    await manager.receive(receivedDesired(target), "7");
    await manager.receive(null, "0");
    const persisted = (await readConfigurationCache(file, identity, new AbortController().signal)).cache;
    expect(persisted.authority).toMatchObject({ desiredJson: null, applicationRevision: null, observationRevision: "0" });
    expect(persisted.retainedItems).toContainEqual(expect.objectContaining({ failureId: 1, value: expect.objectContaining({ key: { kind: "native" }, lastFailure: expect.objectContaining({ code: "invalid_configuration" }) }) }));
    await manager.stop();
    const reopened = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory });
    expect(reopened.current().desired).toBeNull();
    expect(reopened.report().observation).toBeNull();
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems).toEqual(persisted.retainedItems);
  });

  it("bounds asynchronous application jobs while scalar progress and every stable record remain available", async () => {
    const release = deferred(), ready = deferred(), prepared = new Set<string>();
    let active = 0, peak = 0, nativeCalls = 0;
    const work = async (): Promise<void> => { active++; peak = Math.max(peak, active); if (active === 16) ready.resolve(); await release.promise; active--; };
    const { manager } = await fixture({ persist: persistLifecycleCache, applyNative: async () => { nativeCalls++; await work(); } });
    const target = desired("1", "global", false);
    const projects = Array.from({ length: 40 }, (_, index) => ({ projectId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, nativeOverrides: { model: `project-${index}` } }));
    await manager.configureProjectAdapters({ prepare: async projectId => { await work(); prepared.add(projectId); } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await manager.receive(receivedDesired({ ...target, value: { ...target.value, projects } }));
      await Promise.race([ready.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for 16 adapter entries.")), 15_000); })]);
      // Drain the already queued applying commits before checking for an excess job.
      await manager.refreshToolSelections(AbortSignal.timeout(15_000));
      expect(active).toBe(16);
      expect(peak).toBe(16);
      expect(manager.current().effective.maxConcurrent).toBe(2);
      expect(prepared.size).toBe(0);
      release.resolve(); await manager.settle();
      expect(peak).toBe(16);
      expect(prepared).toEqual(new Set(projects.map(project => project.projectId)));
      expect(nativeCalls).toBe(41);
      expect(manager.current().effective.projects.every(project => project.ready && project.native !== null)).toBe(true);
    } finally { clearTimeout(timer); release.resolve(); }
  }, 30_000);

  it("keeps native application independent of an observer failure", async () => {
    const { manager } = await fixture({ onNativeApplication: () => { throw new Error("observer failed"); } });
    await manager.receive(receivedDesired(desired("1", "good", false)));
    await manager.settle();
    expect(item(manager.current(), "native")).toMatchObject({ state: "applied", appliedValue: { agent: "codex", model: "good" } });
  });

  it.each([
    [new ToolSelectionError("codex", "web", "resolve", "not_found"), "not_found"],
    [new ToolSelectionError("codex", "web", "verify", "permission_denied"), "permission_denied"],
    [new ToolSelectionError("codex", "web", "probe", "probe_timeout"), "timeout"],
    [new ToolSelectionError("codex", "web", "verify", "incompatible_runtime"), "invalid_configuration"],
    [new ToolSelectionError("codex", "web", "probe", "unrecognized_output"), "invalid_output"],
    [new ToolSelectionError("codex", "web", "probe", "cleanup_unknown"), "unavailable"],
    [new OperationError("request_timeout"), "timeout"],
    [Object.assign(new Error("Untrusted upstream detail"), { code: "EACCES" }), "unavailable"],
  ] as const)("persists the established native failure classification for %s", async (failure, code) => {
    const { manager, file } = await fixture({ applyNative: async () => { throw failure; } });
    await manager.receive(receivedDesired(desired("1", "bad", false))); await manager.settle();
    const expected = { code, category: "agent", phase: "validate" };
    expect(item(manager.current(), "native")).toMatchObject({ state: "error", error: expected, lastFailure: expected });
    const persisted = await readConfigurationCache(file, identity, new AbortController().signal);
    expect(persisted.cache.currentItems.find(entry => entry.value.key.kind === "native")?.value.lastFailure).toMatchObject(expected);
  });

  it("reports tool preparation at its actual phase and retains one attempt across checkpoint progress", async () => {
    const events: WorkerConfigurationApplicationEvent[] = [];
    const error = new ToolSelectionError("codex", "web", "probe", "probe_timeout");
    const { manager } = await fixture({ prepareToolSelection: async () => { throw error; }, onApplication: event => { events.push(event); } });
    await manager.receive(receivedDesired(desired("1", "bad", false))); await manager.settle();
    expect(item(manager.current(), "native")?.error).toMatchObject({ code: "timeout", phase: "prepare" });
    const failures = events.filter(event => event.kind === "failed");
    expect(failures).toHaveLength(2);
    expect(failures.map(event => event.local)).toEqual(["pending", "persisted"]);
    expect(new Set(failures.map(event => event.attemptId)).size).toBe(1);
    expect(failures[0]).toMatchObject({ phase: "prepare", key: { kind: "native" }, revision: "1", source: { state: "initialized", desiredRevision: "1", observationRevision: "0" }, error });
    expect(failures[1]).toMatchObject({ recordId: failures[0]!.recordId, generation: failures[0]!.generation, backoffStep: 1, nextAttemptAt: expect.any(String) });
    const scalar = events.filter(event => event.key.kind === "maxConcurrent");
    expect(scalar.map(event => [event.phase, event.kind, event.local])).toEqual([["apply", "succeeded", "pending"], ["apply", "succeeded", "persisted"]]);
    expect(scalar[0]!.attemptId).toBe(scalar[1]!.attemptId);
  });

  it("keeps application results durable when its diagnostic observer fails and exposes the original failure at stop", async () => {
    const diagnosticFailure = new Error("Diagnostic formatter failed"), applyNative = vi.fn(async () => {});
    const { manager, file } = await fixture({ applyNative, onApplication: () => { throw diagnosticFailure; } });
    fixtures.at(-1)!.expectedStopError = diagnosticFailure;
    await manager.receive(receivedDesired(desired("1", "good", false))); await manager.settle();
    expect(applyNative).toHaveBeenCalledOnce();
    expect(item(manager.current(), "native")?.state).toBe("applied");
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.currentItems.find(entry => entry.value.key.kind === "native")?.value.state).toBe("applied");
    await expect(manager.stop()).rejects.toBe(diagnosticFailure);
  });

  it("exposes only the exact captured token and reports a stale queued acknowledgement as ignored", async () => {
    const entered = deferred(), release = deferred(); let block = false;
    const { manager } = await fixture({ persist: async (file, chunks) => {
      const bytes = [...chunks()].join("");
      if (block && JSON.parse(JSON.parse(bytes).authority.desiredJson).revision === "2") { block = false; entered.resolve(); await release.promise; }
      await writeFile(file, bytes);
    } });
    const original = desired("1", "original", false);
    await manager.receive(receivedDesired(original)); await manager.settle();
    const captured = manager.report(), context = manager.reportContext(captured)!;
    expect(context).toMatchObject({ reportId: expect.any(String), generation: manager.current().generation, baseRevision: "0", recordIds: expect.any(Array), failures: [] });
    expect(context.items).toEqual(captured.observation!.items.map((entry, index) => ({ key: entry.key, targetRevision: entry.targetRevision, recordId: context.recordIds[index] })));
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.items)).toBe(true);
    expect(manager.reportContext(structuredClone(captured))).toBeUndefined();
    block = true;
    const receiving = manager.receive(receivedDesired(desired("2", "canonical", false)), "7"); await entered.promise;
    const acknowledging = manager.acknowledge(captured,receivedReceipt( { desired: original, observationRevision: "1", observationAccepted: true }));
    release.resolve(); await receiving;
    const generation = manager.current().generation;
    await expect(acknowledging).resolves.toBe("ignored");
    expect(manager.current()).toMatchObject({ generation, desired: { revision: "2" }, observationRevision: "7" });
    expect(manager.reportContext(captured)).toBeUndefined();
    await manager.settle();
    await expect(manager.acknowledge(manager.report(),receivedReceipt( { desired: desired("2", "canonical", false), observationRevision: "8", observationAccepted: true }))).resolves.toBe("persisted");
  });
});
