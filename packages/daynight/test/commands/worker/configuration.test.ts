import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { WorkerConfigurationManager, WorkerConfigurationManagerOptions, WorkerConfigurationSnapshot } from "../../../src/commands/worker/configuration.js";
import { parseWorkerCloudReport } from "../../../src/api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudNative, WorkerCloudReport } from "../../../src/api/worker-configuration.js";
import { replaceFileAtomically } from "../../../src/platform/files.js";
import { parseProviderArguments } from "../../../src/commands/controller/providers/projection.js";
import { createOperation } from "../../../src/api/operation.js";
import { syncWorkerConfigurationOnce } from "../../../src/commands/worker/reporter.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";
import type { Tool, ToolPaths } from "../../../src/platform/tool-path-choice.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import { readConfigurationCache } from "../../../src/commands/worker/configuration-cache.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const identity = { serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" };
const desired = (revision = "1", model = "original", projects = true): WorkerCloudDesired => ({ revision, updatedAt: "2026-11-04T00:00:00Z", value: { maxConcurrent: Number(revision) + 1, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: { agent: "codex", model, args: [] }, projects: projects ? [{ projectId, nativeOverrides: {} }] : [] } });
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
  return JSON.parse(JSON.stringify({ schemaVersion: 4, identity: cache.identity, desired: cache.authority.desired, observationRevision: cache.authority.observationRevision, nextFailureId: cache.nextFailureId,
    nativeModes: Object.fromEntries([...records.values()].filter(entry => entry.nativeMode !== null && entry.value.appliedValue !== null).map(entry => [`${entry.value.key.kind}:${"projectId" in entry.value.key ? entry.value.key.projectId : ""}`, entry.nativeMode])),
    items: [...records.values()].map(entry => ({ value: entry.value, attempts: entry.backoffStep, failureId: entry.failureId, started: entry.started })) }));
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
const failedModeSwitchCache = async () => {
  const original = desired(), global = { ...original.value.native, args: ["--search"] }, previous = { ...global, model: "project-history" };
  const initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "herdr", native: global, projects: [{ projectId, nativeOverrides: { model: previous.model } }] } };
  const rejected: WorkerCloudDesired = { ...initial, revision: "2", value: { ...initial.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { model: "project-web-target", args: [] } }] } };
  const validate = async (native: WorkerCloudNative, _signal: AbortSignal, mode: "herdr" | "web") => { if (mode === "web") parseProviderArguments(native.agent, native.args); };
  const first = await fixture({ applyNative: validate });
  await first.manager.configureProjectAdapters({ prepare: async () => {} });
  await first.manager.receive(initial); await first.manager.settle();
  await first.manager.receive(rejected); await first.manager.settle();
  expect(first.manager.current().effective).toMatchObject({ agentControlMode: "herdr", projects: [{ ready: true, native: previous }] });
  await first.manager.stop();
  return { first, global, previous, rejected, validate };
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
    const receive = manager.receive(desired("1", "original", false));
    await entered.promise;
    const stopping = manager.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await receive;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("publishes local targets until complete cloud adoption and retains explicit auto", async () => {
    const localToolPaths: ToolPaths = { codex: { kind: "path", path: "/local/codex" }, copilot: { kind: "path", path: "/local/copilot" }, herdr: { kind: "auto" } };
    const { manager } = await fixture({ localToolPaths });
    expect(manager.current().toolTargets).toEqual({ source: "local", revision: null, choices: localToolPaths });
    const original = desired("1", "original", false);
    await manager.receive(original); await manager.settle();
    expect(manager.current().toolTargets).toEqual({ source: "local", revision: null, choices: localToolPaths });
    expect(manager.report()).toMatchObject({ bootstrap: null, toolPathsBootstrap: localToolPaths });
    await manager.receive({ ...original, revision: "2", value: { ...original.value, toolPaths: { codex: { kind: "auto" }, copilot: null, herdr: null } } });
    expect(manager.current().toolTargets).toBeNull();
    const cloud: ToolPaths = { codex: { kind: "auto" }, copilot: { kind: "path", path: "/cloud/copilot" }, herdr: { kind: "auto" } };
    await manager.receive({ ...original, revision: "3", value: { ...original.value, toolPaths: cloud } }); await manager.settle();
    expect(manager.current().toolTargets).toEqual({ source: "cloud", revision: "3", choices: cloud });
    expect(manager.report()).toMatchObject({ toolPathsBootstrap: localToolPaths });
  });

  it("reads and upgrades a real checkpoint within a bounded JSON operation budget", async () => {
    const first = await fixture();
    const target = desired("1", "original", false);
    await first.manager.receive({ ...target, value: { ...target.value, native: { ...target.value.native, args: Array<string>(100).fill("x".repeat(4096)) } } });
    await first.manager.settle();
    await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.schemaVersion = 3;
    await writeFile(first.file, JSON.stringify({ items: saved.items, nativeModes: saved.nativeModes, identity: saved.identity, desired: saved.desired, nextFailureId: saved.nextFailureId, observationRevision: saved.observationRevision, schemaVersion: 3 }));
    const originalParse = JSON.parse, originalStringify = JSON.stringify;
    try {
      JSON.parse = ((source: string, ...args: unknown[]) => {
        if (source.length > 65_536) throw new RangeError("parse text budget exceeded");
        return Reflect.apply(originalParse, JSON, [source, ...args]);
      }) as typeof JSON.parse;
      JSON.stringify = ((input: unknown, ...args: unknown[]) => {
        const result = Reflect.apply(originalStringify, JSON, [input, ...args]) as string | undefined;
        if (result !== undefined && result.length > 65_536) throw new RangeError("stringify text budget exceeded");
        return result;
      }) as typeof JSON.stringify;
      const options = { file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} };
      const migrated = await createWorkerConfigurationManager(options);
      expect(migrated.current().desired?.value.native.args).toHaveLength(100);
      await migrated.stop();
      const reopened = await createWorkerConfigurationManager(options);
      expect(reopened.current().desired?.value.native.args[99]).toBe("x".repeat(4096));
      await reopened.stop();
    } finally {
      JSON.parse = originalParse;
      JSON.stringify = originalStringify;
    }
    expect(JSON.parse(await readFile(first.file, "utf8")).schemaVersion).toBe(5);
  });

  it("migrates a structurally valid historical native value larger than the current item limit", async () => {
    const first = await fixture();
    await first.manager.receive(desired("1", "original", false));
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
    expect(JSON.parse(await readFile(first.file, "utf8")).schemaVersion).toBe(5);
  });

  it("migrates schema 3 without dropping native modes or unacknowledged failures", async () => {
    const { first, rejected } = await failedModeSwitchCache();
    const saved = await legacyCache(first.file);
    saved.schemaVersion = 3;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    const migrated = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    const records = [...migrated.currentItems, ...migrated.retainedItems];
    expect(migrated.schemaVersion).toBe(5);
    for (const previous of saved.items) expect(records.find(entry => JSON.stringify(entry.value.key) === JSON.stringify(previous.value.key))).toMatchObject({ value: previous.value, backoffStep: previous.attempts, failureId: previous.failureId, started: previous.started,
      nativeMode: saved.nativeModes[`${previous.value.key.kind}:${"projectId" in previous.value.key ? previous.value.key.projectId : ""}`] ?? null });
    expect(reopened.current().desired).toEqual(rejected);
    expect(reopened.current().effective.native).toBeNull();
    expect(reopened.current().items.some(entry => entry.lastFailure !== null)).toBe(true);
    expect(reopened.current()).not.toHaveProperty("toolPaths");
  });

  it("invalidates only native proofs that depend on a changed tool selection", async () => {
    const blocked = deferred(), release = deferred();
    const selections: Record<Tool, string> = { codex: "a".repeat(64), copilot: "b".repeat(64), herdr: "c".repeat(64) };
    let changing = false;
    const { manager } = await fixture({ localControlMode: "web", readToolSelectionKeys: () => selections,
      applyNative: async native => { if (changing && native.agent === "codex") { blocked.resolve(); await release.promise; } },
    });
    const original = desired();
    await manager.receive({ ...original, value: { ...original.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { agent: "copilot" } }] } }); await manager.settle();
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
    const { manager } = await fixture({ localControlMode: "web", readToolSelectionKeys: () => key === undefined ? {} : { codex: key },
      prepareToolSelection: async () => { entered.resolve(); await release.promise; key = "a".repeat(64); },
      applyNative: async () => { applied.push(key!); },
    });
    await manager.receive(desired("1", "original", false)); await entered.promise;
    await manager.refreshToolSelections(); release.resolve(); await manager.settle();
    expect(applied).toEqual(["a".repeat(64)]); expect(manager.current().effective.native?.model).toBe("original");
    key = undefined;
    expect(manager.current().effective.native).toBeNull();
  });

  it("discards preparation after a newer target and validates only that target's recipe", async () => {
    const entered = deferred(), release = deferred(); let key: string | undefined;
    const applied: string[] = [];
    const { manager } = await fixture({ localControlMode: "web", readToolSelectionKeys: () => key === undefined ? {} : { codex: key },
      prepareToolSelection: async (_native, _mode, targets) => {
        if (targets.revision === "1") { entered.resolve(); await release.promise; key = "a".repeat(64); }
        else key = "b".repeat(64);
      }, applyNative: async () => { applied.push(key!); },
    });
    const original = desired("1", "original", false), tools: ToolPaths = { codex: { kind: "path", path: "/old/codex" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } };
    await manager.receive({ ...original, value: { ...original.value, toolPaths: tools } }); await entered.promise;
    await manager.receive({ ...original, revision: "2", value: { ...original.value, toolPaths: { ...tools, codex: { kind: "path", path: "/new/codex" } } } });
    release.resolve(); await manager.settle(); expect(applied).toEqual(["b".repeat(64)]);
    expect(manager.current().effective.native?.model).toBe("original");
  });

  it("allows legacy Herdr only for automatic related tools without manufacturing selection keys", async () => {
    const applyNative = vi.fn(async () => {});
    const { manager } = await fixture({ localControlMode: "herdr", allowLegacyHerdrAuto: true, readToolSelectionKeys: () => ({}), applyNative });
    const original = desired("1", "original", false);
    await manager.receive(original); await manager.settle(); expect(applyNative).toHaveBeenCalledTimes(1);
    expect(manager.current().effective.native?.agent).toBe("codex");
    await manager.receive({ ...original, revision: "2", value: { ...original.value, toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "path", path: "/explicit/herdr" } } } });
    await manager.settle(); expect(applyNative).toHaveBeenCalledTimes(1); expect(manager.current().effective.native).toBeNull();
  });

  it("keeps native validation unavailable when the runtime has no tool selection proof", async () => {
    const { manager } = await fixture({ localControlMode: "web", readToolSelectionKeys: () => ({}) });
    await manager.receive(desired("1", "original", false)); await manager.settle();
    expect(manager.current().effective.native).toBeNull();
    expect(item(manager.current(), "native")).toMatchObject({ state: "error", error: { code: "unavailable" } });
  });

  it("qualifies an unrelated project in the proven mode while the global tool is unavailable", async () => {
    let selections: Partial<Record<Tool, string>> = { codex: "a".repeat(64), copilot: "b".repeat(64) };
    const { manager } = await fixture({ readToolSelectionKeys: () => selections });
    const original = desired("1", "original", false), first = { ...original, value: { ...original.value, agentControlMode: "web" as const } };
    await manager.receive(first); await manager.settle();
    selections = { copilot: "b".repeat(64) };
    await manager.refreshToolSelections(); await manager.settle();
    await manager.receive({ ...first, revision: "2", value: { ...first.value, projects: [{ projectId, nativeOverrides: { agent: "copilot" } }] } }); await manager.settle();
    expect(manager.current().effective.native).toBeNull();
    expect(manager.current().effective.projects[0]?.native?.agent).toBe("copilot");
    expect(manager.current().effective.agentControlMode).toBe("web");
  });

  it("invalidates a changed path even before a new selection key is published", async () => {
    const entered = deferred(), release = deferred();
    let changing = false;
    const { manager } = await fixture({ localControlMode: "web", applyNative: async native => {
      if (changing && native.agent === "codex") { entered.resolve(); await release.promise; }
    } });
    const original = desired(), tools: ToolPaths = { codex: { kind: "path", path: "/old/codex" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } };
    const first = { ...original, value: { ...original.value, toolPaths: tools, projects: [{ projectId, nativeOverrides: { agent: "copilot" as const } }] } };
    await manager.receive(first); await manager.settle();
    changing = true;
    await manager.receive({ ...first, revision: "2", value: { ...first.value, toolPaths: { ...tools, codex: { kind: "path", path: "/new/codex" } } } });
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
    const { manager } = await fixture({ localControlMode: "web", readToolSelectionKeys: () => ({ codex: key }), applyNative: async () => {
      if (++checks === 1) { entered.resolve(); await release.promise; }
      else { latestEntered.resolve(); await latestRelease.promise; }
    } });
    await manager.receive(desired("1", "original", false)); await entered.promise;
    key = "b".repeat(64);
    await manager.refreshToolSelections(); release.resolve(); await latestEntered.promise;
    try {
      expect(manager.current().effective.native).toBeNull();
      expect(item(manager.current(), "native")?.state).toBe("applying");
    } finally { latestRelease.resolve(); }
    await manager.settle();
    expect(manager.current().effective.native?.model).toBe("original");
  });

  it.each(["web", "herdr"] as const)("invalidates Herdr-dependent native proof only in %s mode", async mode => {
    let herdr = "a".repeat(64), allow = true;
    const { manager } = await fixture({ localControlMode: mode, readToolSelectionKeys: () => ({ codex: "b".repeat(64), herdr }),
      applyNative: async () => { if (!allow) throw new Error("changed Herdr unavailable"); },
    });
    await manager.receive(desired("1", "original", false)); await manager.settle();
    herdr = "c".repeat(64); allow = false;
    await manager.refreshToolSelections(); await manager.settle();
    expect(manager.current().effective.native?.model ?? null).toBe(mode === "web" ? "original" : null);
    expect(item(manager.current(), "native")?.state).toBe(mode === "web" ? "applied" : "error");
  });

  it("migrates schema 2 without treating historical native settings as current-process proof", async () => {
    const original = desired("1", "original", false), first = await fixture();
    await first.manager.receive(original); await first.manager.settle(); await first.manager.stop();
    const cache = await legacyCache(first.file);
    cache.schemaVersion = 2; delete cache.nativeModes;
    await writeFile(first.file, JSON.stringify(cache));
    const checked: string[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, localControlMode: "web", signal: new AbortController().signal, applyNative: async (_native, _signal, mode) => { checked.push(mode); } });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(reopened.current().effective.native).toBeNull();
    const migrated = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(migrated).toMatchObject({ schemaVersion: 5, authority: { desired: original, observationRevision: cache.observationRevision } });
    expect(migrated.currentItems.every(entry => entry.nativeMode === null)).toBe(true);
    await reopened.receive(original); await reopened.settle();
    expect(checked).toEqual(["web"]);
    expect(reopened.current().effective.agentControlMode).toBe("web");
  });

  it("does not publish either part of a mode change when its combined cache write fails", async () => {
    const disk = new Error("mode commit failed"), initial = desired("1", "original", false);
    const { manager, file } = await fixture({ persist: async (file, chunks) => {
      const contents = [...chunks()].join("");
      const cache = JSON.parse(contents);
      if (cache.currentItems.find((entry: { value: WorkerCloudItem; nativeMode: string | null }) => entry.value.key.kind === "native")?.nativeMode === "web") throw disk;
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.receive({ ...initial, value: { ...initial.value, agentControlMode: "herdr" } }); await manager.settle();
    const next = desired("2", "updated", false);
    await manager.receive({ ...next, value: { ...next.value, agentControlMode: "web" } });
    fixtures.at(-1)!.expectedStopError = disk;
    await expect(manager.settle()).rejects.toBe(disk);
    expect(manager.current().effective).toMatchObject({ agentControlMode: "herdr", native: initial.value.native });
    expect(JSON.parse(await readFile(file, "utf8")).currentItems.find((entry: { value: WorkerCloudItem; nativeMode: string | null }) => entry.value.key.kind === "native")?.nativeMode).toBe("herdr");
  });

  it("ignores a late project validation from the previous mode", async () => {
    const started = deferred(), release = deferred(), webStarted = deferred(), webRelease = deferred();
    let oldCount = 0, webCount = 0;
    const { manager } = await fixture({ applyNative: async (_native, _signal, mode) => {
      if (mode === "herdr" && ++oldCount === 2) { started.resolve(); await release.promise; }
      if (mode === "web" && ++webCount === 2) { webStarted.resolve(); await webRelease.promise; }
    } });
    const initial = desired(), next = desired("2");
    await manager.receive({ ...initial, value: { ...initial.value, agentControlMode: "herdr" } });
    await started.promise;
    await manager.receive({ ...next, value: { ...next.value, agentControlMode: "web" } });
    release.resolve(); await webStarted.promise;
    try { expect(manager.current().effective.projects[0]?.native).toBeNull(); }
    finally { webRelease.resolve(); }
    await manager.settle();
    expect(manager.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ native: initial.value.native }] });
  });

  it("revalidates a matching historical project tuple when returning to its former mode", async () => {
    let web = 0, herdr = 0;
    const { manager } = await fixture({ applyNative: async (_native, _signal, mode) => {
      if (mode === "herdr") herdr++;
      else if (++web === 2) throw new TypeError("project unavailable in web");
    } });
    for (const [revision, agentControlMode] of [["1", "herdr"], ["2", "web"], ["3", "herdr"]] as const) {
      const current = desired(revision);
      await manager.receive({ ...current, value: { ...current.value, agentControlMode } }); await manager.settle();
    }
    expect(herdr).toBe(4);
    expect(manager.current().effective.projects[0]?.native).toEqual(desired().value.native);
  });

  it("publishes mode and global native together and revalidates projects for the new mode", async () => {
    const projectGate = deferred(), projectStarted = deferred();
    let webCalls = 0;
    const { manager } = await fixture({ localControlMode: "herdr", applyNative: async (_native, _signal, mode) => {
      if (mode === "web" && ++webCalls === 2) { projectStarted.resolve(); await projectGate.promise; }
    } });
    await manager.configureProjectAdapters({ prepare: async () => {} });
    const initial = desired();
    await manager.receive({ ...initial, value: { ...initial.value, agentControlMode: "herdr" } }); await manager.settle();
    expect(manager.current().effective.projects[0]?.native).not.toBeNull();
    const next = desired("2");
    await manager.receive({ ...next, value: { ...next.value, agentControlMode: "web" } });
    await projectStarted.promise;
    expect(manager.current().effective).toMatchObject({ agentControlMode: "web", native: initial.value.native, projects: [{ ready: true, native: null }] });
    projectGate.resolve(); await manager.settle();
    expect(manager.current().effective.projects[0]?.native).toEqual(initial.value.native);
    expect(item(manager.current(), "agentControlMode")).toMatchObject({ appliedValue: "web", state: "applied" });
  });

  it("retains the old effective pair when the same native bytes fail in the new mode", async () => {
    const attempts: string[] = [];
    const { manager } = await fixture({ applyNative: async (_native, _signal, mode) => { attempts.push(mode); if (mode === "web") throw new TypeError("Herdr-only argument"); } });
    const initial = desired("1", "original", false), next = desired("2", "original", false);
    await manager.receive({ ...initial, value: { ...initial.value, agentControlMode: "herdr" } }); await manager.settle();
    await manager.receive({ ...next, value: { ...next.value, agentControlMode: "web" } }); await manager.settle();
    expect(attempts).toEqual(["herdr", "web"]);
    expect(manager.current().effective).toMatchObject({ agentControlMode: "herdr", native: initial.value.native });
    expect(item(manager.current(), "agentControlMode")).toMatchObject({ state: "error", appliedValue: "herdr" });
  });

  it("revalidates project history after restarting with a failed mode switch", async () => {
    const { first, global, previous, rejected, validate } = await failedModeSwitchCache();
    const checked: { mode: string; native: WorkerCloudNative }[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async (native, signal, mode) => { checked.push({ mode, native }); await validate(native, signal, mode); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(reopened.current().effective.projects).toEqual([]);
    await reopened.configureProjectAdapters({ prepare: async () => {} });
    await reopened.receive(rejected); await reopened.settle();
    expect(reopened.current().effective).toMatchObject({ agentControlMode: "herdr", native: global, projects: [{ ready: true, native: previous }] });
    expect(checked).toEqual([{ mode: "web", native: global }, { mode: "herdr", native: global }, { mode: "herdr", native: previous }]);
    expect(item(reopened.current(), "agentControlMode")).toMatchObject({ state: "error", appliedValue: "herdr" });
    expect(item(reopened.current(), "projectNative")?.state).not.toBe("applied");
  });

  it("revalidates legacy project history in the local mode after a failed adopted mode switch", async () => {
    const original = desired(), global = { ...original.value.native, args: ["--search"] };
    const initial = { ...original, value: { ...original.value, native: global } }, first = await fixture();
    await first.manager.receive(initial); await first.manager.settle(); await first.manager.stop();
    const legacy = await legacyCache(first.file);
    legacy.schemaVersion = 2; delete legacy.nativeModes;
    await writeFile(first.file, JSON.stringify(legacy));
    const checked: string[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, localControlMode: "herdr", signal: new AbortController().signal,
      applyNative: async (native, _signal, mode) => { checked.push(mode); if (mode === "web") parseProviderArguments(native.agent, native.args); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive({ ...initial, revision: "2", value: { ...initial.value, agentControlMode: "web" } }); await reopened.settle();
    expect(checked).toEqual(["web", "herdr", "herdr"]);
    expect(reopened.current().effective).toMatchObject({ agentControlMode: "herdr", native: global, projects: [{ native: global }] });
    expect(item(reopened.current(), "projectNative")?.state).toBe("error");
  });

  it.each([true, false])("requires current-process global proof before project history: usable=%s", async usable => {
    const { first, global, previous, rejected, validate } = await failedModeSwitchCache();
    const targetStarted = deferred(), targetRelease = deferred(), historyStarted = deferred(), historyRelease = deferred();
    const checked: { mode: string; native: WorkerCloudNative }[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async (native, signal, mode) => {
        checked.push({ mode, native });
        if (mode === "web") { targetStarted.resolve(); await targetRelease.promise; await validate(native, signal, mode); }
        else if (native.model === global.model) { historyStarted.resolve(); await historyRelease.promise; if (!usable) throw new Error("historical provider unavailable"); }
      },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(rejected);
    try {
      await targetStarted.promise;
      expect(reopened.current().effective).toMatchObject({ agentControlMode: null, native: null, projects: [{ native: null }] });
      expect(checked).toEqual([{ mode: "web", native: global }]);
      targetRelease.resolve(); await historyStarted.promise;
      expect(reopened.current().effective).toMatchObject({ agentControlMode: null, native: null, projects: [{ native: null }] });
      expect(checked).toEqual([{ mode: "web", native: global }, { mode: "herdr", native: global }]);
    } finally { targetRelease.resolve(); historyRelease.resolve(); }
    await reopened.settle();
    expect(reopened.current().effective).toMatchObject({ agentControlMode: usable ? "herdr" : null, native: usable ? global : null, projects: [{ native: usable ? previous : null }] });
    expect(checked).toHaveLength(usable ? 3 : 2);
    expect(item(reopened.current(), "projectNative")?.state).toBe(usable ? "error" : "pending");
  });

  it.each(["absent", "different mode"])("does not authorize project history that is %s", async history => {
    const original = desired(), global = { ...original.value.native, args: ["--search"] };
    const first = await fixture({ applyNative: async (native, _signal, mode) => { if (mode === "herdr" && native.model === "project-history") throw new Error("project cannot adopt Herdr"); } });
    if (history === "different mode") {
      await first.manager.receive({ ...original, value: { ...original.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { model: "project-history" } }] } });
      await first.manager.settle();
    }
    const initial: WorkerCloudDesired = { ...original, revision: "2", value: { ...original.value, agentControlMode: "herdr", native: global, projects: history === "absent" ? [] : [{ projectId, nativeOverrides: { model: "project-history" } }] } };
    await first.manager.receive(initial); await first.manager.settle(); await first.manager.stop();
    const checked: { mode: string; native: WorkerCloudNative }[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async (native, _signal, mode) => { checked.push({ mode, native }); if (mode === "web") parseProviderArguments(native.agent, native.args); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive({ ...initial, revision: "3", value: { ...initial.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { model: "project-web-target", args: [] } }] } });
    await reopened.settle();
    expect(checked).toEqual([{ mode: "web", native: global }, { mode: "herdr", native: global }]);
    expect(reopened.current().effective).toMatchObject({ agentControlMode: "herdr", projects: [{ native: null }] });
    expect(item(reopened.current(), "projectNative")?.state).toBe("pending");
  });

  it("backs off failed project history and retries without applying the blocked target", async () => {
    const { first, previous, rejected, validate } = await failedModeSwitchCache();
    let now = Date.parse("2026-11-10T00:00:00Z"), historyAttempts = 0;
    const checked: { mode: string; native: WorkerCloudNative }[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, now: () => now,
      applyNative: async (native, signal, mode) => {
        checked.push({ mode, native }); await validate(native, signal, mode);
        if (native.model === previous.model && ++historyAttempts === 1) throw new Error("historical project unavailable");
      },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(rejected); await reopened.settle();
    expect(reopened.current().effective.projects[0]?.native).toBeNull();
    expect(item(reopened.current(), "projectNative")).toMatchObject({ state: "error", error: item(reopened.current(), "native")?.error, nextAttemptAt: "2026-11-10T00:00:05.000Z" });
    await reopened.configureProjectAdapters({}); await reopened.settle();
    expect(historyAttempts).toBe(1);
    now += 5_000;
    await reopened.configureProjectAdapters({}); await reopened.settle();
    expect(historyAttempts).toBe(2);
    expect(reopened.current().effective.projects[0]?.native).toEqual(previous);
    expect(item(reopened.current(), "projectNative")).toMatchObject({ state: "error", nextAttemptAt: "2026-11-10T00:00:15.000Z" });
    now += 10_000;
    await reopened.configureProjectAdapters({}); await reopened.settle();
    expect(historyAttempts).toBe(2);
    expect(checked.every(entry => entry.native.model !== "project-web-target")).toBe(true);
    const repaired = { ...rejected, revision: "3", value: { ...rejected.value, native: { ...rejected.value.native, args: [] } } };
    await reopened.receive(repaired); await reopened.settle();
    expect(checked.slice(-2)).toEqual([{ mode: "web", native: repaired.value.native }, { mode: "web", native: { ...previous, model: "project-web-target", args: [] } }]);
    expect(reopened.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ native: { model: "project-web-target", args: [] } }] });
    expect(item(reopened.current(), "projectNative")?.state).toBe("applied");
  });

  it.each(["retry", "superseded", "cancelled"] as const)("does not publish late project history after %s", async transition => {
    const { first, previous, rejected, validate } = await failedModeSwitchCache();
    const historyStarted = deferred(), historyRelease = deferred(), webStarted = deferred(), webRelease = deferred(), cancellation = new AbortController();
    let now = Date.parse("2026-11-10T00:00:00Z"), allowWeb = false;
    const published: WorkerConfigurationSnapshot[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: cancellation.signal, now: () => now,
      applyNative: async (native, signal, mode) => {
        if (mode === "web" && !allowWeb) await validate(native, signal, mode);
        if (mode === "herdr" && native.model === previous.model) { historyStarted.resolve(); await historyRelease.promise; }
        if (mode === "web" && native.model === "project-web-target") { webStarted.resolve(); await webRelease.promise; }
      },
      onChange: snapshot => { published.push(snapshot); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(rejected);
    try {
      await historyStarted.promise;
      if (transition === "cancelled") cancellation.abort(new Error("Worker stopped during project history validation."));
      else {
        allowWeb = true;
        if (transition === "retry") { now = Date.parse(item(reopened.current(), "native")!.nextAttemptAt!); await reopened.configureProjectAdapters({}); }
        else await reopened.receive({ ...rejected, revision: "3", value: { ...rejected.value, native: { ...rejected.value.native, args: [] } } });
        await vi.waitFor(() => expect(reopened.current().effective.agentControlMode).toBe("web"));
      }
      historyRelease.resolve();
      if (transition !== "cancelled") {
        await webStarted.promise;
        expect(reopened.current().effective.projects[0]?.native).toBeNull();
      }
    } finally { historyRelease.resolve(); webRelease.resolve(); }
    await reopened.settle();
    expect(published.every(snapshot => snapshot.effective.projects[0]?.native?.model !== previous.model)).toBe(true);
    if (transition !== "cancelled") {
      expect(reopened.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ native: { model: "project-web-target", args: [] } }] });
      expect(item(reopened.current(), "projectNative")?.state).toBe("applied");
    }
  });

  it("uses the local mode for an unadopted target and sends its candidate despite existing desired", async () => {
    const modes: string[] = [];
    const { manager } = await fixture({ localControlMode: "web", applyNative: async (_native, _signal, mode) => { modes.push(mode); } });
    const initial = desired("1", "original", false);
    await manager.receive({ ...initial, value: { ...initial.value, agentControlMode: null } }); await manager.settle();
    expect(manager.current().effective.agentControlMode).toBe("web");
    expect(manager.report()).toMatchObject({ bootstrap: null, controlModeBootstrap: "web" });
    expect(modes).toEqual(["web"]);
    expect(item(manager.current(), "agentControlMode")).toMatchObject({ state: "pending", appliedValue: null });
  });

  it("hot-applies platform preference in both directions and reports false as an applied value", async () => {
    const { manager } = await fixture();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBeNull();
    const first = desired("1", "original", false);
    await manager.receive({ ...first, value: { ...first.value, preferPlatformSpecificTasks: true } });
    await manager.settle();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBe(true);
    await manager.receive(desired("2", "original", false));
    await manager.settle();
    expect(manager.current().effective.preferPlatformSpecificTasks).toBe(false);
    expect(item(manager.current(), "preferPlatformSpecificTasks")).toMatchObject({ state: "applied", appliedValue: false, targetRevision: "2" });
    expect(parseWorkerCloudReport(manager.report(), { controlMode: true, toolPaths: true }).observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "preferPlatformSpecificTasks" }, appliedValue: false }));
  });

  it("atomically migrates a full schema-1 cache without discarding removal or failure ownership", async () => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(target); await first.manager.settle(); await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.schemaVersion = 1;
    delete saved.nativeModes;
    delete saved.desired.value.preferPlatformSpecificTasks;
    saved.items = saved.items.filter((entry: { value: WorkerCloudItem }) => entry.value.key.kind !== "preferPlatformSpecificTasks");
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
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.authority.desired).toEqual({ ...saved.desired, value: { ...saved.desired.value, preferPlatformSpecificTasks: false } });
    expect(migrated.nextFailureId).toBe(saved.nextFailureId);
    expect(migrated.authority.observationRevision).toBe(saved.observationRevision);
    expect(migrated.currentItems.filter(entry => entry.value.key.kind !== "preferPlatformSpecificTasks").map(entry => ({ value: entry.value, attempts: entry.backoffStep, failureId: entry.failureId, started: entry.started }))).toEqual(saved.items);
    expect(item(reopened.current(), "preferPlatformSpecificTasks")).toMatchObject({ state: "pending", appliedValue: null });
    expect(reopened.current().effective.preferPlatformSpecificTasks).toBeNull();
    await reopened.receive(target); await reopened.settle();
    expect(reopened.current().effective.preferPlatformSpecificTasks).toBe(false);
    expect(parseWorkerCloudReport(reopened.report(), { controlMode: true, toolPaths: true }).observation?.items).toHaveLength(1025);
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "error", lastFailure: failure });
  });

  it("rejects a missing preference in a current cache without rewriting it", async () => {
    const first = await fixture();
    await first.manager.receive(desired("1", "original", false)); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8"));
    delete saved.authority.desired.value.preferPlatformSpecificTasks;
    const source = JSON.stringify(saved);
    await writeFile(first.file, source);
    await expect(createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} })).rejects.toThrow();
    expect(await readFile(first.file, "utf8")).toBe(source);
  });
  it.each([false, true])("installs a target above the report item limit while preserving removal ownership (started=%s)", async started => {
    const first = await fixture({ persist: persistLifecycleCache }), target = desired("1", "original", false);
    await first.manager.receive(target); await first.manager.settle(); await first.manager.stop();
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
    await reopened.receive(expanded);
    const remove = vi.fn(async (_projectId: string, _signal: AbortSignal) => {});
    await reopened.configureProjectAdapters({ remove }); await reopened.settle();
    expect(reopened.current().synchronized).toBe(true);
    expect(reopened.current().desired).toEqual(expanded);
    expect(parseWorkerCloudReport(reopened.report(), { controlMode: true, toolPaths: true }).observation!.items.length).toBeLessThanOrEqual(1025);
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
  it("retains an invalid historical target without executing it and resumes with a valid newer target", async () => {
    const invalid = { ...desired("1", "original", false), value: { ...desired("1", "original", false).value, maxConcurrent: 65 } };
    const onInvalidDesired = vi.fn(), applyNative = vi.fn(async () => {});
    const { manager } = await fixture({ onInvalidDesired, applyNative });
    await manager.receive(invalid); await manager.settle();
    expect(manager.current().synchronized).toBe(false);
    expect(manager.current().desired).toBeNull();
    expect(applyNative).not.toHaveBeenCalled();
    const sent = manager.report();
    await manager.acknowledge(sent, { desired: invalid, observationRevision: "0", observationAccepted: false });
    expect(onInvalidDesired).toHaveBeenCalledOnce();
    await manager.receive(desired("2", "original", false)); await manager.settle();
    expect(manager.current().effective.maxConcurrent).toBe(3);
    expect(applyNative).toHaveBeenCalled();
  });
  it("reloads legacy over-limit cache structurally and applies a valid newer target without discarding failures", async () => {
    const first = await fixture(), target = desired("1", "original", false);
    await first.manager.receive(target); await first.manager.settle(); await first.manager.stop();
    const saved = await legacyCache(first.file);
    saved.desired.value.maxConcurrent = 65;
    saved.items.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "maxConcurrent").value.appliedValue = 65;
    const failure = { code: "unavailable", category: "runtime", phase: "stop", occurredAt: "2026-11-04T00:00:00Z" };
    saved.items.push({ value: { key: { kind: "projectRemoval", projectId }, targetRevision: "1", appliedValue: null, state: "error", error: failure, lastFailure: failure, nextAttemptAt: null }, attempts: 1, failureId: 1, started: true });
    saved.nextFailureId = 2;
    await writeFile(first.file, JSON.stringify(saved));
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "original", false)); await reopened.settle();
    expect(reopened.current().effective.maxConcurrent).toBe(3);
    expect(item(reopened.current(), "projectRemoval")).toMatchObject({ state: "pending", lastFailure: failure });
    expect((await readConfigurationCache(first.file, identity, new AbortController().signal)).cache.retainedItems).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ key: { kind: "projectRemoval", projectId }, state: "error", lastFailure: failure }) }));
    expect(reopened.report().observation?.items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId }, lastFailure: failure }));
  });
  it("cancels obsolete preparation and installs a newer target above the report item limit", async () => {
    const first = await fixture({ persist: persistLifecycleCache });
    await first.manager.receive(desired()); await first.manager.settle(); await first.manager.stop();
    const saved = JSON.parse(await readFile(first.file, "utf8")) as WorkerConfigurationCache;
    const pendingRemovals = Array.from({ length: 1018 }, (_, n) => ({ recordId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      origin: { generation: saved.authority.generation, targetRevision: "1", source: "application" as const },
      value: { key: { kind: "projectRemoval" as const, projectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` }, targetRevision: "1", appliedValue: null, state: "pending" as const, error: null, lastFailure: null, nextAttemptAt: null },
      backoffStep: 0, failureId: null, started: false, nativeMode: null, actualSource: null, blockedByRemovalId: null }));
    await writeFile(first.file, JSON.stringify({ ...saved, currentItems: [...saved.currentItems, ...pendingRemovals] }));
    const entered = deferred(), released = deferred(), cancelled = deferred();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {}, persist: persistLifecycleCache });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.configureProjectAdapters({ prepare: async (_id, signal) => { signal.addEventListener("abort", () => cancelled.resolve(), { once: true }); entered.resolve(); await released.promise; } });
    await reopened.receive(desired()); await entered.promise;
    const next = desired("2", "original", false);
    await reopened.receive({ ...next, value: { ...next.value, projects: [{ projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: {} }] } });
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
    await first.manager.receive(target);
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
    await reopened.receive(next); await reopened.settle();
    expect(reopened.current().items.length).toBeGreaterThan(1025);
    expect(reopened.current().synchronized).toBe(true);
    expect(reopened.current().desired?.revision).toBe("2");
    await reopened.ensureProjectRemoval(id(1021));
    const before = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    const originalFailure = before.retainedItems.find(entry => entry.value.key.kind === "projectRemoval" && entry.value.key.projectId === id(1))!;
    expect(originalFailure).toMatchObject({ origin: { targetRevision: "1" }, failureId: 1, value: { state: "error", lastFailure: failure } });
    const unknown = reopened.report();
    expect(unknown.observation!.items.length).toBeLessThanOrEqual(1025);
    await reopened.acknowledge(unknown, { desired: next, observationRevision: "0", observationAccepted: false });
    const unconfirmed = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(unconfirmed.projectionCursor).toBe(before.projectionCursor);
    expect(unconfirmed.retainedItems.find(entry => entry.recordId === originalFailure.recordId)).toEqual(originalFailure);
    const accepted = reopened.report();
    expect(accepted.observation!.items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId: id(1) }, lastFailure: failure }));
    await reopened.acknowledge(accepted, { desired: next, observationRevision: "1", observationAccepted: true });
    const committed = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(committed.projectionCursor).not.toBeNull();
    expect(committed.retainedItems.find(entry => entry.recordId === originalFailure.recordId)).toMatchObject({ value: { state: "error", lastFailure: null }, failureId: null });
    expect(committed.currentItems.some(entry => entry.value.key.kind === "projectRemoval" && entry.value.key.projectId === id(0) && entry.value.state === "pending")).toBe(true);
    await reopened.stop();
    const afterRestart = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: afterRestart, directory: first.directory });
    expect(afterRestart.current().synchronized).toBe(false);
    await afterRestart.receive(next); await afterRestart.settle();
    const resumed = (await readConfigurationCache(first.file, identity, new AbortController().signal)).cache;
    expect(resumed.projectionCursor).toBe(committed.projectionCursor);
    expect(afterRestart.current().items).toContainEqual(expect.objectContaining({ key: { kind: "projectRemoval", projectId: id(1021) }, state: "pending" }));
    await afterRestart.ensureProjectRemoval(id(1022));
    expect(afterRestart.report().observation!.items.length).toBeLessThanOrEqual(1025);
  });
  it("applies independent values while native failure and unprepared projects remain truthful", async () => {
    const { manager, file, wait } = await fixture({ applyNative: async () => { throw new Error("secret native arguments must not be reported"); } });
    await manager.receive(desired());
    await wait(snapshot => item(snapshot, "native")?.state === "error" && snapshot.effective.maxConcurrent === 2 && snapshot.effective.pollIntervalMs === 1200 && snapshot.effective.recoveryLimit === 4);
    expect(manager.current().effective).toMatchObject({ maxConcurrent: 2, pollIntervalMs: 1200, recoveryLimit: 4, preferPlatformSpecificTasks: false, native: null, projects: [{ projectId, ready: false }] });
    expect(item(manager.current(), "projectPreparation")).toMatchObject({ state: "pending", appliedValue: null });
    expect(JSON.stringify(manager.report())).not.toContain("secret native arguments");
    expect(JSON.parse(await readFile(file, "utf8")).authority.desired.revision).toBe("1");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("does not grant readiness from native validation and defers unavailable bindings until reconfigured", async () => {
    const prepare = vi.fn(async () => false as const);
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ prepare });
    await manager.receive(desired());
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
    await manager.receive({ ...current, value: { ...current.value, native: { agent: "codex", model: "global", args: ["--global"] }, projects: [
      { projectId, nativeOverrides: { agent: "claude" } },
      { projectId: "44444444-4444-4444-8444-444444444444", nativeOverrides: { model: null, args: [] } },
    ] } });
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
    await manager.receive(desired("1", "original", false));
    await wait(snapshot => snapshot.effective.maxConcurrent === 2);
    application.resolve();
    await writeEntered.promise;
    const receiving = manager.receive(desired("2", "new", false));
    expect(manager.current().desired?.revision).toBe("1");
    releaseWrite.resolve();
    await receiving;
    await wait(snapshot => snapshot.effective.native?.model === "new");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.authority.desired.revision).toBe("2");
    expect(saved.currentItems.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "native").value.appliedValue.model).toBe("new");
  });

  it("discards a late superseded native result and converges after its cancellation joins", async () => {
    const oldStarted = deferred(), releaseOld = deferred();
    const { manager, wait } = await fixture({ applyNative: async native => { if (native.model === "old") { oldStarted.resolve(); await releaseOld.promise; } } });
    await manager.receive(desired("1", "old", false));
    await oldStarted.promise;
    await manager.receive(desired("2", "latest", false));
    releaseOld.resolve();
    await wait(snapshot => snapshot.effective.native?.model === "latest");
    expect(item(manager.current(), "native")).toMatchObject({ targetRevision: "2", appliedValue: { model: "latest" }, state: "applied" });
    await manager.receive(desired("1", "old", false));
    expect(manager.current().desired?.revision).toBe("2");
  });

  it("retains recovered failures until accepted and cannot clear a new failure with an older ACK", async () => {
    let failed = true;
    const { manager, wait } = await fixture({ now: () => Date.parse("2026-11-04T00:00:00Z"), applyNative: async () => { if (failed) throw new TypeError("bad args"); } });
    await manager.receive(desired("1", "bad", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const firstReport = manager.report();
    failed = false;
    await manager.receive(desired("2", "recovered", false));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    await manager.acknowledge(firstReport, { desired: desired("2", "recovered", false), observationRevision: "1", observationAccepted: false });
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    expect(manager.report().observation?.baseRevision).toBe("1");
    const recoveredReport = manager.report();
    failed = true;
    await manager.receive(desired("3", "bad-again", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const newFailure = item(manager.current(), "native")?.lastFailure;
    await manager.acknowledge(recoveredReport, { desired: desired("3", "bad-again", false), observationRevision: "2", observationAccepted: true });
    expect(item(manager.current(), "native")?.lastFailure).toEqual(newFailure);
    const latestReport = manager.report();
    await manager.acknowledge(latestReport, { desired: desired("3", "bad-again", false), observationRevision: "3", observationAccepted: true });
    expect(item(manager.current(), "native")?.lastFailure).toBeNull();
    expect(item(manager.current(), "native")?.error).not.toBeNull();
  });

  it("retries failed items with bounded backoff and preserves the successful value", async () => {
    const { manager, wait } = await fixture({ applyNative: async native => { if (native.model === "invalid") throw new Error("provider unavailable"); } });
    await manager.receive(desired("1", "good", false));
    await wait(snapshot => item(snapshot, "native")?.state === "applied");
    vi.useFakeTimers();
    await manager.receive(desired("2", "invalid", false));
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
    await manager.receive(desired("1"));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await manager.receive(desired("2", "original", false));
    expect(manager.current().effective.projects).toEqual([]);
    await removing.promise;
    const original = (await readConfigurationCache(file, identity, new AbortController().signal)).cache.currentItems.find(entry => entry.value.key.kind === "projectRemoval")!;
    await manager.receive(desired("3"));
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
    await manager.receive(desired());
    await entered.promise;
    await manager.receive(desired("2", "original", false));
    await cancelled.promise;
    release.resolve();
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await manager.receive(desired("3"));
    expect(manager.current().effective.projects[0]?.ready).toBe(false);
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    expect(calls).toBe(2);
  });

  it("reports and retries stopping a retained project absent from the initial cloud target", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { manager, wait } = await fixture();
    await manager.configureProjectAdapters({ remove: async () => { if (++attempts === 1) throw new Error("stop failed"); } });
    await manager.receive(desired("1", "original", false));
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
    await first.manager.receive(desired());
    await first.wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await first.manager.receive(desired("2", "original", false));
    await first.wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await first.manager.stop();
    const stop = vi.fn(async () => {});
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "original", false));
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
    await manager.receive(desired("1"));
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    await manager.receive(desired("2", "original", false));
    await removing.promise;
    const original = (await readConfigurationCache(file, identity, new AbortController().signal)).cache.currentItems.find(entry => entry.value.key.kind === "projectRemoval")!;
    await manager.receive(desired("3"));
    await manager.receive(desired("4", "original", false));
    await manager.receive(desired("5"));
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
    await manager.receive(desired());
    await wait(snapshot => snapshot.effective.projects[0]?.ready === true);
    const earlier = manager.report();
    await manager.receive(desired("2", "original", false));
    await wait(snapshot => item(snapshot, "projectRemoval")?.state === "applied");
    await manager.acknowledge(earlier, { desired: desired("2", "original", false), observationRevision: "1", observationAccepted: true });
    expect(item(manager.current(), "projectRemoval")).toBeDefined();
    const completed = manager.report();
    await manager.acknowledge(completed, { desired: desired("2", "original", false), observationRevision: "2", observationAccepted: true });
    expect(manager.current().items.every(item => !("projectId" in item.key))).toBe(true);
  });

  it.each(["before acknowledgement", "in acknowledgement"])("revalidates reselected applied project history %s", async selection => {
    const checked: { mode: string; native: WorkerCloudNative }[] = [], published: WorkerConfigurationSnapshot[] = [], reports: WorkerCloudReport[] = [];
    const { manager, file } = await fixture({ applyNative: async (native, _signal, mode) => { checked.push({ mode, native }); }, onChange: snapshot => {
      published.push(snapshot);
      if (snapshot.desired?.revision === "3") reports.push(manager.report());
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), global = original.value.native, projectNative = { ...global, model: "project" };
    const initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { model: projectNative.model } }] } };
    const removed: WorkerCloudDesired = { ...initial, revision: "2", value: { ...initial.value, agentControlMode: "herdr", projects: [] } };
    const reselected = { ...initial, revision: "3" };
    await manager.receive(initial); await manager.settle();
    await manager.receive(removed); await manager.settle();
    expect(item(manager.current(), "projectRemoval")).toMatchObject({ state: "applied", targetRevision: "2" });
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ key: { kind: "projectNative", projectId }, state: "applied", appliedValue: projectNative }) }));
    const report = manager.report();
    let beforeAcknowledgement: WorkerConfigurationSnapshot | undefined;
    if (selection === "before acknowledgement") {
      await manager.receive(reselected); await manager.settle();
      beforeAcknowledgement = manager.current();
    }
    await manager.acknowledge(report, { desired: reselected, observationRevision: "1", observationAccepted: true });
    await manager.settle();
    expect(reports[0]?.observation?.items.find(value => value.key.kind === "projectNative")).toMatchObject({ targetRevision: "3", state: "pending" });
    expect(item(published.find(snapshot => snapshot.desired?.revision === "3")!, "projectNative")).toMatchObject({ state: "pending", appliedValue: projectNative });
    expect(published.filter(snapshot => snapshot.desired?.revision === "3").every(snapshot => item(snapshot, "projectNative")?.state !== "applied" || snapshot.effective.projects[0]?.native !== null)).toBe(true);
    expect(manager.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ ready: true, native: projectNative }] });
    if (beforeAcknowledgement !== undefined) expect(beforeAcknowledgement.effective.projects).toEqual([{ projectId, ready: true, native: projectNative }]);
    expect(item(manager.current(), "projectRemoval")).toBeUndefined();
    expect(checked).toEqual([{ mode: "web", native: global }, { mode: "web", native: projectNative }, { mode: "herdr", native: global }, { mode: "web", native: global }, { mode: "web", native: projectNative }]);
    await manager.receive({ ...reselected, revision: "4", value: { ...reselected.value, maxConcurrent: 8 } }); await manager.settle();
    expect(manager.current().effective.projects[0]?.native).toEqual(projectNative);
    expect(checked).toHaveLength(5);
    await manager.receive({ ...removed, revision: "5" }); await manager.settle();
    await manager.acknowledge(manager.report(), { desired: { ...reselected, revision: "6" }, observationRevision: "2", observationAccepted: true }); await manager.settle();
    expect(manager.current().effective.projects[0]?.native).toEqual(projectNative);
    expect(checked).toHaveLength(8);
  });

  it("reports a reselected project as pending before either native proof completes", async () => {
    const globalStarted = deferred(), globalRelease = deferred(), projectStarted = deferred(), projectRelease = deferred();
    let reselecting = false;
    const { manager, file } = await fixture({ applyNative: async (native, _signal, mode) => {
      if (!reselecting || mode !== "web") return;
      if (native.model === "project") { projectStarted.resolve(); await projectRelease.promise; }
      else { globalStarted.resolve(); await globalRelease.promise; }
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { model: "project" } }] } };
    await manager.receive(initial); await manager.settle();
    await manager.receive({ ...initial, revision: "2", value: { ...initial.value, agentControlMode: "herdr", projects: [] } }); await manager.settle();
    const reselected = { ...initial, revision: "3" }, operation = createOperation();
    reselecting = true;
    try {
      await syncWorkerConfigurationOnce({ operation, report: () => ({ ...workerTelemetry, taskInventory: null }), configuration: {
        prepare: async () => { await manager.receive(reselected); }, capture: () => manager.report(),
        send: async (_report, captured) => {
          expect(captured.observation?.items.find(value => value.key.kind === "projectNative")).toMatchObject({ targetRevision: "3", state: "pending" });
          return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: reselected, observationRevision: "1", observationAccepted: true } };
        }, accept: (sent, receipt) => manager.acknowledge(sent, receipt),
      } });
      await globalStarted.promise;
      expect(manager.current().effective.projects[0]?.native).toBeNull();
      globalRelease.resolve(); await projectStarted.promise;
      expect(manager.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ ready: true, native: null }] });
      expect(manager.report().observation?.items.find(value => value.key.kind === "projectNative")?.state).toBe("applying");
      expect(JSON.parse(await readFile(file, "utf8")).currentItems.find((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "projectNative").value.state).toBe("applying");
    } finally { globalRelease.resolve(); projectRelease.resolve(); operation.dispose(); }
    await manager.settle();
    expect(manager.current().effective.projects[0]?.native?.model).toBe("project");
  });

  it("revalidates cached applied native items when the first synchronization is an acknowledgement", async () => {
    const first = await fixture(), original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "web" } };
    await first.manager.receive(initial); await first.manager.settle(); await first.manager.stop();
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
          return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: initial, observationRevision: "0", observationAccepted: false } };
        }, accept: (sent, receipt) => reopened.acknowledge(sent, receipt),
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

  it.each(["herdr", "web"] as const)("reuses a still-proven applied project when reselected in %s", async agentControlMode => {
    const applyNative = vi.fn(async () => {}), { manager } = await fixture({ applyNative });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial = { ...original, value: { ...original.value, agentControlMode } };
    await manager.receive(initial); await manager.settle();
    await manager.receive({ ...initial, revision: "2", value: { ...initial.value, projects: [] } }); await manager.settle();
    await manager.acknowledge(manager.report(), { desired: { ...initial, revision: "3" }, observationRevision: "1", observationAccepted: true }); await manager.settle();
    expect(manager.current().effective.projects).toEqual([{ projectId, ready: true, native: initial.value.native }]);
    expect(applyNative).toHaveBeenCalledTimes(2);
  });

  it("revokes historical project proof across a mode roundtrip when revalidation fails", async () => {
    let rejectProject = false;
    const published: WorkerConfigurationSnapshot[] = [];
    const { manager, file } = await fixture({ now: () => Date.parse("2026-11-10T00:00:00Z"), onChange: snapshot => { published.push(snapshot); }, applyNative: async native => {
      if (rejectProject && native.model === "project") throw new TypeError("project unavailable");
    } });
    await manager.configureProjectAdapters({ prepare: async () => {} });
    const original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "herdr", projects: [{ projectId, nativeOverrides: { model: "project" } }] } };
    await manager.receive(initial); await manager.settle();
    const first: WorkerConfigurationCache = JSON.parse(await readFile(file, "utf8"));
    const source = first.currentItems.find(entry => entry.value.key.kind === "projectNative")!.actualSource;
    expect(manager.current().effective.projects[0]).toMatchObject({ ready: true, native: { model: "project" } });
    rejectProject = true;
    await manager.receive({ ...initial, revision: "2", value: { ...initial.value, agentControlMode: "web" } }); await manager.settle();
    expect(manager.current().effective).toMatchObject({ agentControlMode: "web", projects: [{ ready: true, native: null }] });
    await manager.receive({ ...initial, revision: "3" }); await manager.settle();
    expect(item(manager.current(), "projectNative")?.state).toBe("error");
    expect(manager.current().effective).toMatchObject({ agentControlMode: "herdr", projects: [{ ready: true, native: null }] });
    expect(published.filter(snapshot => snapshot.desired?.revision === "3").every(snapshot => snapshot.effective.projects[0]?.native === null)).toBe(true);
    const saved: WorkerConfigurationCache = JSON.parse(await readFile(file, "utf8"));
    expect(saved.currentItems.find(entry => entry.value.key.kind === "projectNative")!.actualSource).toEqual(source);
    expect([...saved.currentItems, ...saved.retainedItems].some(entry => entry.recordId === first.currentItems.find(entry => entry.value.key.kind === "projectNative")!.recordId)).toBe(false);
  });

  it("preserves failure history and retry deadlines while revalidating a reselected project", async () => {
    let failProject = true, projectCalls = 0, now = Date.parse("2026-11-10T00:00:00Z");
    const published: WorkerConfigurationSnapshot[] = [];
    const { manager } = await fixture({ now: () => now, onChange: snapshot => { published.push(snapshot); }, applyNative: async native => {
      if (native.model === "project") { projectCalls++; if (failProject) throw new TypeError("project unavailable"); }
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "web", projects: [{ projectId, nativeOverrides: { model: "project" } }] } };
    await manager.receive(initial); await manager.settle();
    const originalFailure = item(manager.current(), "projectNative")!.lastFailure;
    failProject = false;
    await manager.receive({ ...initial, revision: "2" }); await manager.settle();
    await manager.receive({ ...initial, revision: "3", value: { ...initial.value, agentControlMode: "herdr", projects: [] } }); await manager.settle();
    const reselected = { ...initial, revision: "4" };
    failProject = true;
    await manager.receive(reselected); await manager.settle();
    expect(item(published.find(snapshot => snapshot.desired?.revision === "4")!, "projectNative")).toMatchObject({ state: "pending", lastFailure: originalFailure });
    expect(manager.current().effective.projects[0]?.native).toBeNull();
    expect(item(manager.current(), "projectNative")).toMatchObject({ state: "error", nextAttemptAt: "2026-11-10T00:00:05.000Z" });
    expect(projectCalls).toBe(4);
    await manager.receive(reselected); await manager.settle();
    expect(projectCalls).toBe(4);
    now += 5_000; failProject = false;
    await manager.receive(reselected); await manager.settle();
    expect(projectCalls).toBe(5);
    expect(item(manager.current(), "projectNative")).toMatchObject({ state: "applied", error: null, lastFailure: { code: "invalid_configuration" } });
    expect(manager.current().effective.projects[0]?.native?.model).toBe("project");
    await manager.acknowledge(manager.report(), { desired: reselected, observationRevision: "1", observationAccepted: true });
    expect(item(manager.current(), "projectNative")?.lastFailure).toEqual(originalFailure);
    await manager.acknowledge(manager.report(), { desired: reselected, observationRevision: "2", observationAccepted: true });
    expect(item(manager.current(), "projectNative")?.lastFailure).toBeNull();
  });

  it("does not publish reselected project proof when its result cannot be persisted", async () => {
    const disk = new Error("project proof commit failed"), published: WorkerConfigurationSnapshot[] = [];
    const { manager } = await fixture({ onChange: snapshot => { published.push(snapshot); }, persist: async (file, chunks) => {
      const contents = [...chunks()].join("");
      const cache = JSON.parse(contents);
      if (cache.authority.desired?.revision === "3" && cache.currentItems.some((entry: { value: WorkerCloudItem }) => entry.value.key.kind === "projectNative" && entry.value.state === "applied")) throw disk;
      await replaceFileAtomically(file, contents, 0o600);
    } });
    await manager.configureProjectAdapters({ prepare: async () => {}, remove: async () => {} });
    const original = desired(), initial: WorkerCloudDesired = { ...original, value: { ...original.value, agentControlMode: "web" } };
    await manager.receive(initial); await manager.settle();
    await manager.receive({ ...initial, revision: "2", value: { ...initial.value, agentControlMode: "herdr", projects: [] } }); await manager.settle();
    fixtures.find(entry => entry.manager === manager)!.expectedStopError = disk;
    await manager.receive({ ...initial, revision: "3" });
    await expect(manager.settle()).rejects.toBe(disk);
    expect(published.filter(snapshot => snapshot.desired?.revision === "3").every(snapshot => snapshot.effective.projects[0]?.native === null && item(snapshot, "projectNative")?.state !== "applied")).toBe(true);
    expect(manager.current().effective.projects[0]?.native).toBeNull();
    expect(() => manager.report()).toThrow(disk);
  });

  it("rejects an unrelated accepted receipt without erasing unreported failure information", async () => {
    const { manager, wait } = await fixture({ applyNative: async () => { throw new TypeError("invalid"); } });
    await manager.receive(desired("1", "bad", false));
    await wait(snapshot => item(snapshot, "native")?.state === "error");
    const report = manager.report();
    await expect(manager.acknowledge(report, { desired: desired("1", "bad", false), observationRevision: "8", observationAccepted: true })).rejects.toThrow("does not acknowledge");
    expect(item(manager.current(), "native")?.lastFailure).not.toBeNull();
    expect(manager.current().observationRevision).toBe("0");
  });

  it("loads applied values without granting authority, then checks the cloud and repository again", async () => {
    const first = await fixture();
    await first.manager.configureProjectAdapters({ prepare: async () => {} });
    await first.manager.receive(desired());
    await first.wait(snapshot => snapshot.effective.projects[0]?.ready === true && snapshot.effective.native !== null);
    await first.manager.stop();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory: first.directory });
    expect(reopened.current().synchronized).toBe(false);
    expect(reopened.current().effective.native).toBeNull();
    expect(reopened.report().observation).toBeNull();
    await reopened.receive(desired(), "9");
    expect(reopened.current().effective.projects[0]?.ready).toBe(false);
    expect(reopened.report().observation?.baseRevision).toBe("9");
  });

  it("rejects corrupted or foreign caches instead of inventing defaults", async () => {
    const { manager, file, wait } = await fixture();
    await manager.receive(desired("1", "good", false));
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
    await first.manager.receive(desired("1", "previous-mode", false));
    await first.wait(snapshot => snapshot.effective.native?.model === "previous-mode");
    await first.manager.stop();
    const entered = deferred(), release = deferred(), observedFailure = deferred();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async () => { entered.resolve(); await release.promise; },
      onChange: snapshot => { if (item(snapshot, "native")?.state === "error") observedFailure.resolve(); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("1", "previous-mode", false));
    expect(reopened.current().effective.native).toBeNull();
    await entered.promise;
    expect(reopened.current().effective.native).toBeNull();
    release.reject(new TypeError("Arguments are invalid in the current control mode."));
    await observedFailure.promise;
    expect(reopened.current().effective.native).toBeNull();
    expect(item(reopened.current(), "native")?.appliedValue).toMatchObject({ model: "previous-mode" });
    await reopened.receive(desired("2", "previous-mode", false));
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
    await first.manager.receive({ ...previous, value: { ...previous.value, native: { ...previous.value.native, args: ["--search"] } } });
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
    await reopened.receive({ ...current, value: { ...current.value, native } });
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
    await first.manager.receive(desired("1", "previous-good", false));
    await first.wait(snapshot => snapshot.effective.native?.model === "previous-good");
    await first.manager.stop();
    const checked: string[] = [];
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async native => { checked.push(native.model!); if (native.model === "new-invalid") throw new TypeError("invalid current target"); },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "new-invalid", false));
    await reopened.settle();
    expect(checked).toEqual(["new-invalid", "previous-good"]);
    expect(reopened.current().effective.native?.model).toBe("previous-good");
    expect(item(reopened.current(), "native")).toMatchObject({ state: "error", targetRevision: "2", appliedValue: { model: "previous-good" } });
  });

  it("carries current-process historical validation to a new target after restart", async () => {
    const first = await fixture({ applyNative: async native => { if (native.model === "invalid") throw new TypeError("current target unavailable"); } });
    await first.manager.configureProjectAdapters({ prepare: async () => {} });
    await first.manager.receive(desired("1", "previous-good")); await first.manager.settle();
    await first.manager.receive(desired("2", "invalid")); await first.manager.settle();
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
    await reopened.receive(desired("2", "invalid")); await reopened.settle();
    expect(checked.toSorted()).toEqual(["invalid", "invalid", "previous-good", "previous-good"]);
    expect(reopened.current().effective).toMatchObject({ native: { model: "previous-good" }, projects: [{ ready: true, native: { model: "previous-good" } }] });
    try {
      await reopened.receive(desired("3", "next-invalid")); await entered.promise;
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
    await reopened.receive(desired("4", "next-invalid", false)); await reopened.settle();
    await reopened.receive(desired("5", "next-invalid")); await reopened.settle();
    expect(reopened.current().effective.projects[0]).toMatchObject({ ready: true, native: { model: "previous-good" } });
    expect(checked.filter(model => model === "previous-good")).toHaveLength(2);
  });

  it("keeps an already validated live tuple available while applying the current target", async () => {
    const entered = deferred(), release = deferred();
    const { manager } = await fixture({ applyNative: async native => {
      if (native.model === "current-model") { entered.resolve(); await release.promise; }
    } });
    await manager.receive(desired("1", "previous-good"));
    await manager.settle();
    await manager.receive(desired("2", "current-model"));
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
    await first.manager.receive({ ...original, value: { ...original.value, native: previous } });
    await first.manager.settle();
    await first.manager.stop();
    const reopened = await createWorkerConfigurationManager({ file: first.file, identity, signal: new AbortController().signal,
      applyNative: async native => {
        if (native.model === "new-invalid") throw new TypeError("invalid current target");
        if (!usable) throw new Error("historical provider unavailable");
      },
    });
    fixtures.push({ manager: reopened, directory: first.directory });
    await reopened.receive(desired("2", "new-invalid"));
    await reopened.settle();
    expect(reopened.current().effective.native).toEqual(usable ? previous : null);
    expect(reopened.current().effective.projects[0]?.native).toEqual(usable ? previous : null);
    for (const kind of ["native", "projectNative"] as const) {
      expect(item(reopened.current(), kind)).toMatchObject({ state: "error", appliedValue: previous, error: { code: "invalid_configuration" }, lastFailure: { code: "invalid_configuration" } });
    }
  });

  it.each(["superseded", "cancelled"] as const)("does not publish a %s historical validation", async transition => {
    const first = await fixture();
    await first.manager.receive(desired("1", "previous-good", false));
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
    await reopened.receive(desired("2", "new-invalid", false));
    try {
      await entered.promise;
      if (transition === "superseded") await reopened.receive(desired("3", "latest", false));
      else cancellation.abort(new Error("Worker stopped during historical validation."));
    } finally { release.resolve(); }
    await reopened.settle();
    expect(reopened.current().effective.native?.model ?? null).toBe(transition === "superseded" ? "latest" : null);
    expect(published.every(snapshot => snapshot.effective.native?.model !== "previous-good")).toBe(true);
  });

  it("settles immediate application work without waiting for a future retry", async () => {
    const { manager } = await fixture({ applyNative: async () => { throw new TypeError("invalid"); } });
    await manager.receive(desired("1", "invalid", false));
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
    await manager.receive(desired("1", "good", false));
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
    await manager.receive(target); await manager.settle();
    await manager.receive(target, "7");
    await manager.receive(null, "0");
    const persisted = (await readConfigurationCache(file, identity, new AbortController().signal)).cache;
    expect(persisted.authority).toMatchObject({ desired: null, observationRevision: "0" });
    expect(persisted.retainedItems).toContainEqual(expect.objectContaining({ failureId: 1, value: expect.objectContaining({ key: { kind: "native" }, lastFailure: expect.objectContaining({ code: "invalid_configuration" }) }) }));
    await manager.stop();
    const reopened = await createWorkerConfigurationManager({ file, identity, signal: new AbortController().signal, applyNative: async () => {} });
    fixtures.push({ manager: reopened, directory });
    expect(reopened.current().desired).toBeNull();
    expect(reopened.report().observation).toBeNull();
    expect((await readConfigurationCache(file, identity, new AbortController().signal)).cache.retainedItems).toEqual(persisted.retainedItems);
  });

  it("bounds asynchronous application jobs while scalar progress and every stable record remain available", async () => {
    const release = deferred(), prepared = new Set<string>();
    let active = 0, peak = 0, nativeCalls = 0;
    const work = async (): Promise<void> => { active++; peak = Math.max(peak, active); await release.promise; active--; };
    const { manager } = await fixture({ applyNative: async () => { nativeCalls++; await work(); } });
    const target = desired("1", "global", false);
    const projects = Array.from({ length: 40 }, (_, index) => ({ projectId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, nativeOverrides: { model: `project-${index}` } }));
    await manager.configureProjectAdapters({ prepare: async projectId => { await work(); prepared.add(projectId); } });
    try {
      await manager.receive({ ...target, value: { ...target.value, projects } });
      await vi.waitFor(() => expect(active).toBe(16));
      expect(peak).toBe(16);
      expect(manager.current().effective.maxConcurrent).toBe(2);
      expect(prepared.size).toBe(0);
      release.resolve(); await manager.settle();
      expect(peak).toBe(16);
      expect(prepared).toEqual(new Set(projects.map(project => project.projectId)));
      expect(nativeCalls).toBe(41);
      expect(manager.current().effective.projects.every(project => project.ready && project.native !== null)).toBe(true);
    } finally { release.resolve(); }
  });

  it("keeps native application independent of an observer failure", async () => {
    const { manager } = await fixture({ onNativeApplication: () => { throw new Error("observer failed"); } });
    await manager.receive(desired("1", "good", false));
    await manager.settle();
    expect(item(manager.current(), "native")).toMatchObject({ state: "applied", appliedValue: { agent: "codex", model: "good" } });
  });
});
