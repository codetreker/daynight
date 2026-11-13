import { scanFromList } from "../../helpers/worker-git-scan.js";
import * as durableHerdr from "../../../src/commands/worker/herdr/durable.js";
import { execFileSync } from "node:child_process";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { webExecutionStoreFormat } from "../../../src/commands/worker/backends/web-store-format.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import * as configurationFiles from "../../../src/config/files.js";
import * as configurationSource from "../../../src/commands/worker/configuration-source.js";
import * as cloudConfiguration from "../../../src/commands/worker/configuration.js";
import * as configurationCache from "../../../src/commands/worker/configuration-cache.js";
import { ApiError } from "../../../src/api/client.js";
import { createOperation } from "../../../src/api/operation.js";
import type { WorkerCloudDesired, WorkerCloudResource } from "../../../src/api/worker-configuration.js";
import { runWorker as runWorkerRuntime } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { tryAcquireWorkerInstanceLock } from "../../../src/commands/worker/instance-lock.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import type { WorkerStore } from "../../../src/commands/worker/store.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { WorkerConfigurationCache } from "../../../src/commands/worker/configuration-model.js";
import type { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import { workerTelemetry } from "../../fixtures/worker-telemetry.js";

type ReporterOptions = Parameters<typeof createWorkerReporter>[0];
const reportSample = { ...workerTelemetry, taskInventory: null };
const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), reporter: vi.fn(), probe: vi.fn(), emit: vi.fn(), bots: vi.fn(), hostCollector: vi.fn(), nextUUID: null as (() => string) | null, herdrCandidate: vi.fn() }));
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: (options?: Parameters<typeof actual.randomUUID>[0]) => mocks.nextUUID === null ? actual.randomUUID(options) : mocks.nextUUID() };
});
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => {
  const { createWorkerToolSelectionFixture } = await import("../../helpers/worker-tool-runtime-fixture.js");
  return { createWorkerToolSelectionRuntime: (options: Parameters<typeof createWorkerToolSelectionFixture>[0]) => ({ ...createWorkerToolSelectionFixture(options), prepareHerdrCandidate: mocks.herdrCandidate }) };
});
vi.mock("../../../src/commands/worker/bots/runtime.js", () => ({ createManagedAssistantRuntime: mocks.bots }));
vi.mock("../../../src/commands/worker/bots/host-capabilities.js", () => ({ createAssistantHostCollector: mocks.hostCollector }));
vi.mock("../../../src/commands/worker/reporter.js", () => ({ createWorkerReporter: mocks.reporter }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/herdr/shared.js", () => ({ createSharedWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", async original => ({ ...await original<object>(), createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/diagnostics.js", async original => ({
  ...await original<object>(), createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, close: async () => {}, filename: "worker.jsonl" }),
}));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const origin = "https://daynight.example";
const token = "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const workerId = uuid(4);
const remoteUrl = "https://git.example/team/repo.git";
const roots: string[] = [];
const stores = new Set<WorkerStore>();
const cancellations = new Set<AbortController>();
const executions = new Set<Promise<void>>();
const runWorker: typeof runWorkerRuntime = options => {
  const running = runWorkerRuntime(options); executions.add(running); void running.catch(() => {}); return running;
};
const desired = (projects: readonly string[] = [uuid(1)], maxConcurrent = 1): WorkerCloudDesired => ({
  revision: "1", updatedAt: "2026-11-04T00:00:00Z",
  value: { maxConcurrent, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "cloud-model", args: [] }, projects: projects.map(projectId => ({ projectId, nativeOverrides: {} })) },
});
const resource = (target: WorkerCloudDesired | null): WorkerCloudResource => ({ desired: target, observationRevision: "0", observation: null });
const fixture = async (warm = false, configured = true) => {
  const parent = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-startup-tests");
  await mkdir(parent, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(parent, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(warm ? paths.workerDirectory : paths.stateDirectory, { recursive: true });
  const repository = { remote: remoteUrl, path: path.join(homeDirectory, "repo"), projectId: uuid(1) };
  const document = { serverUrl: origin, serverToken: token, workerId, worker: { repositories: configured ? [repository] : [], maxConcurrent: 7 } };
  const source = stringify(document);
  await writeFile(paths.configFile, source);
  let store: WorkerStore | undefined;
  if (warm) { store = openWorkerStore(paths.databaseFile); stores.add(store); }
  return { homeDirectory, version: "0.41.0", workingDirectory: homeDirectory, packageDirectory: path.resolve("package"), paths, source, document, repository, store };
};
const coordinator = (tick: () => Promise<void>) => ({ tick: vi.fn(tick), archiveYield: () => false, updateConfiguration: vi.fn(), stopProject: vi.fn(async () => {}), shutdown: vi.fn(async () => true) });
const reporter = () => ({ trigger: vi.fn(), publishInventory: vi.fn(), recordClaim: vi.fn(), stop: vi.fn(async () => {}) });
const prepareConfiguration = async (options: ReporterOptions): Promise<ReturnType<NonNullable<ReporterOptions["configuration"]>["capture"]>> => {
  const operation = createOperation();
  try { await options.configuration!.prepare?.(operation); return options.configuration!.capture(reportSample); }
  finally { operation.dispose(); }
};
const observeCommittedConfiguration = () => {
  // Encoding alone is not committed evidence; publication follows the real atomic writer's successful completion.
  let encoded: WorkerConfigurationCache | undefined, published: WorkerConfigurationCache | undefined;
  const chunks = configurationCache.configurationCacheChunks, create = cloudConfiguration.createWorkerConfigurationManager;
  const encoding = vi.spyOn(configurationCache, "configurationCacheChunks").mockImplementation(snapshot => { encoded = snapshot; return chunks(snapshot); });
  const manager = vi.spyOn(cloudConfiguration, "createWorkerConfigurationManager").mockImplementation(options => create({ ...options, onChange: snapshot => {
    options.onChange?.(snapshot);
    published = encoded;
  } }));
  return {
    current: (): WorkerConfigurationCache => {
      if (published === undefined) throw new Error("Worker has not published a configuration checkpoint.");
      expect(Object.isFrozen(published)).toBe(true);
      return published;
    },
    restore: () => { manager.mockRestore(); encoding.mockRestore(); },
  };
};
const start = (f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof runWorker>[0]> = {}) => {
  const cancellation = new AbortController(); cancellations.add(cancellation);
  const running = runWorker({ ...f, signal: cancellation.signal, ...extra }); executions.add(running);
  void running.catch(() => {});
  return { cancellation, running };
};
const finishAtTick = (cancellation: AbortController, check: (options: WorkerCoordinatorOptions) => void = () => {}, canInspect: (options: WorkerCoordinatorOptions) => boolean = () => true) => {
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
    let current = options;
    return {
      archiveYield: () => false, updateConfiguration: vi.fn(value => { current = { ...current, ...value }; }),
      tick: vi.fn(async () => {
        if (!current.readyProjectIds?.includes(uuid(1)) || !canInspect(current)) return;
        try { check(current); } finally { cancellation.abort(); }
      }),
      shutdown: vi.fn(async () => true),
    };
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nextUUID = null;
  mocks.emit.mockReset();
  mocks.herdrCandidate.mockReset().mockResolvedValue(false);
  mocks.bots.mockReturnValue({ run: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) });
  mocks.hostCollector.mockReturnValue({ collect: vi.fn(async () => undefined), close: vi.fn(async () => {}) });
  mocks.reporter.mockImplementation(reporter);
  mocks.remote.mockReturnValue({
    currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => resource(desired())),
    resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
    project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
    reportConfiguration: vi.fn(), report: vi.fn(),
  });
  mocks.git.mockReturnValue(Object.assign({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}), listWorktrees: vi.fn(async () => []) }, { scanWorktrees: scanFromList }));
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockReturnValue("prompt");
  mocks.probe.mockResolvedValue("0.164.0");
  mocks.coordinator.mockReturnValue(coordinator(async () => {}));
});
afterEach(async () => {
  for (const cancellation of cancellations) cancellation.abort(); cancellations.clear();
  await Promise.allSettled(executions); executions.clear();
  for (const store of stores) store.close(); stores.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("worker cloud-first startup", () => {
  it.each(["herdr", "web"] as const)("refreshes only configured Herdr admission and wakes failed reconciliation (%s)", async mode => {
    const f = await fixture(), initial = desired([]), target = { ...initial, value: { ...initial.value, agentControlMode: mode, pollIntervalMs: 60_000 } };
    mocks.remote().configuration.mockResolvedValue(resource(target)); mocks.remote.mockClear();
    let release!: (changed: boolean) => void, entered!: () => void;
    const admission = new Promise<boolean>(resolve => { release = resolve; }), firstTick = new Promise<void>(resolve => { entered = resolve; });
    mocks.herdrCandidate.mockImplementationOnce(() => admission);
    const tick = vi.fn(async () => { if (tick.mock.calls.length === 1) { entered(); await admission; throw new Error("Original shared daemon has exited."); } });
    mocks.coordinator.mockReturnValue(coordinator(tick));
    const { cancellation, running } = start(f);
    try {
      await firstTick;
      if (mode === "herdr") {
        expect(mocks.herdrCandidate).toHaveBeenCalled(); release(true);
        await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThan(1), { timeout: 2000, interval: 10 });
      } else {
        expect(mocks.herdrCandidate).not.toHaveBeenCalled(); release(false);
        await vi.waitFor(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "reconciliation-error" })), { timeout: 2000, interval: 10 });
      }
    } finally { release(false); cancellation.abort(); await running; }
  });

  it("continues retained-project reconciliation with bounded observations and after restart", async () => {
    const f = await fixture(true, false), target = desired([]), ids = [uuid(10_000), uuid(10_001)];
    for (const [n, projectId] of ids.entries()) f.store!.registerProject({ projectId, repoUrl: `https://git.example/team/repo${n}.git`, localPath: path.join(f.homeDirectory, `repo${n}`) });
    const stored = (key: Record<string, string>, appliedValue: unknown) => ({ value: { key, targetRevision: "1", appliedValue, state: "applied", error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started: false });
    const items = [stored({ kind: "maxConcurrent" }, 1), stored({ kind: "pollIntervalMs" }, 1000), stored({ kind: "recoveryLimit" }, 3), stored({ kind: "preferPlatformSpecificTasks" }, false), stored({ kind: "native" }, target.value.native)];
    for (let n = 0; n < 1019; n++) items.push(stored({ kind: "projectRemoval", projectId: uuid(20_000 + n) }, true));
    await writeFile(f.paths.configurationFile, JSON.stringify({ schemaVersion: 2, identity: { serverOrigin: origin, userId: uuid(6), workerId }, desired: target, observationRevision: "0", nextFailureId: 1, items }));
    let revision = 0n, reporterOptions: ReporterOptions | undefined;
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => ({ desired: target, observationRevision: String(revision), observation: null }));
    mocks.reporter.mockImplementation((options: ReporterOptions) => { reporterOptions = options; return reporter(); });
    const stopProject = vi.fn(async (_projectId: string, _signal: AbortSignal) => {}), tick = vi.fn(async () => {});
    mocks.coordinator.mockImplementation(() => ({ stopProject, tick, archiveYield: () => false, updateConfiguration: vi.fn(), shutdown: vi.fn(async () => true) }));
    const observed = observeCommittedConfiguration();
    try {
      for (let pass = 0; pass < 2; pass++) {
        reporterOptions = undefined; stopProject.mockClear(); tick.mockClear();
        const { cancellation, running } = start(f);
        try {
          await vi.waitFor(() => {
            expect(reporterOptions).toBeDefined();
            expect(stopProject).toHaveBeenCalledTimes(2);
            const saved = observed.current();
            expect(saved.schemaVersion).toBe(5);
            expect(saved.authority.desired).toEqual(target);
            if (pass === 0) expect(saved.currentItems).toHaveLength(1026);
            for (const projectId of ids) expect(saved.currentItems.find(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === projectId)?.value.state).toBe("applied");
            expect(reporterOptions!.configuration!.capture(reportSample).observation!.items.length).toBeLessThanOrEqual(1025);
          }, { timeout: 10_000, interval: 50 });
          const acknowledged = new Set<string>();
          let remaining = 0;
          for (let batch = 0; batch < 3; batch++) {
            const sent = reporterOptions!.configuration!.capture(reportSample);
            expect(sent.observation!.items.length).toBeLessThanOrEqual(1025);
            for (const item of sent.observation!.items) if (item.key.kind === "projectRemoval" && item.state === "applied") acknowledged.add(item.key.projectId);
            const operation = createOperation();
            try { await reporterOptions!.configuration!.accept(sent, { desired: target, observationRevision: String(++revision), observationAccepted: true }, operation); }
            finally { operation.dispose(); }
            const saved = observed.current();
            remaining = [...saved.currentItems, ...saved.retainedItems].filter(item => item.value.key.kind === "projectRemoval").length;
            if (remaining === 0) break;
          }
          expect(remaining).toBe(0);
          expect(acknowledged.size).toBe(pass === 0 ? 1021 : 2);
          expect(new Set(ids.filter(id => acknowledged.has(id)))).toEqual(new Set(ids));
          expect(new Set(stopProject.mock.calls.map(([id]) => id))).toEqual(new Set(ids));
          await vi.waitFor(() => expect(tick).toHaveBeenCalled(), { timeout: 10_000, interval: 100 });
        } finally { cancellation.abort(); await running; }
        expect(JSON.parse(await readFile(f.paths.configurationFile, "utf8"))).toEqual(observed.current());
      }
    } finally { observed.restore(); }
  }, 30_000);
  it("installs a valid target over a full cache before reporting and acknowledges its current removal", async () => {
    // Stable IDs put the selected stop at a known point in the bounded job order.
    let nextId = 0;
    mocks.nextUUID = () => `11111111-1111-4111-8111-${String(++nextId).padStart(12, "0")}`;
    const f = await fixture(true, false), cancellation = new AbortController(); cancellations.add(cancellation);
    const old = desired([]), next: WorkerCloudDesired = { ...desired([uuid(10)]), revision: "2" };
    const stored = (key: Record<string, string>, appliedValue: unknown, state = "applied", started = false) => ({ value: { key, targetRevision: "1", appliedValue, state, error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started });
    const items = [stored({ kind: "maxConcurrent" }, 1), stored({ kind: "pollIntervalMs" }, 1000), stored({ kind: "recoveryLimit" }, 3), stored({ kind: "preferPlatformSpecificTasks" }, false), stored({ kind: "native" }, old.value.native)];
    for (let n = 0; n < 1020; n++) items.push(stored({ kind: "projectRemoval", projectId: uuid(10 + n) }, n < 2 ? true : null, n < 2 ? "applied" : "pending", n === 0));
    await writeFile(f.paths.configurationFile, JSON.stringify({ schemaVersion: 2, identity: { serverOrigin: origin, userId: uuid(6), workerId }, desired: old, observationRevision: "0", nextFailureId: 1, items }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(next));
    const observed = observeCommittedConfiguration();
    let assertionFailure: unknown;
    mocks.reporter.mockImplementation((options: ReporterOptions) => {
      queueMicrotask(() => { void (async () => {
        try {
          const installed = observed.current();
          expect(installed.schemaVersion).toBe(5);
          expect(installed.authority.desired).toEqual(next);
          expect(installed.currentItems.length).toBeGreaterThan(1025);
          expect(installed.retainedItems.find(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === uuid(10))).toMatchObject({ origin: { targetRevision: "1", source: "schema4" }, started: true,
            value: { key: { kind: "projectRemoval", projectId: uuid(10) }, targetRevision: "1" } });
          await vi.waitFor(() => {
            const saved = observed.current();
            const removal = saved.currentItems.find(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === uuid(10));
            const blocker = saved.retainedItems.find(item => item.recordId === removal?.blockedByRemovalId);
            expect(removal?.value.state, JSON.stringify({ state: removal?.value.state, started: removal?.started, blocker: removal?.blockedByRemovalId, blockerState: blocker?.value.state,
              completedRemovals: saved.currentItems.filter(item => item.value.key.kind === "projectRemoval" && item.value.state === "applied").length,
              applyingRemovals: saved.currentItems.filter(item => item.value.key.kind === "projectRemoval" && item.value.state === "applying").length,
              failedRemovals: saved.currentItems.filter(item => item.value.key.kind === "projectRemoval" && item.value.state === "error").length })).toBe("applied");
          }, { timeout: 10_000, interval: 50 });
          let removed = false;
          for (let batch = 0; batch < 3; batch++) {
            const sent = options.configuration!.capture(reportSample);
            expect(sent.observation!.items.length).toBeLessThanOrEqual(1025);
            expect(sent.observation?.desiredRevision).toBe("2");
            expect(sent.observation!.items.every(item => BigInt(item.targetRevision) <= 2n)).toBe(true);
            const operation = createOperation();
            try { await options.configuration!.accept(sent, { desired: next, observationRevision: String(BigInt(sent.observation!.baseRevision) + 1n), observationAccepted: true }, operation); }
            finally { operation.dispose(); }
            const saved = observed.current();
            expect(saved.authority.desired).toEqual(next);
            removed = ![...saved.currentItems, ...saved.retainedItems].some(entry => entry.value.key.kind === "projectRemoval" && entry.value.key.projectId === uuid(10));
            if (removed) break;
          }
          expect(removed).toBe(true);
        } catch (error) { assertionFailure = error; }
        finally { cancellation.abort(); }
      })(); });
      return reporter();
    });
    try {
      await runWorker({ ...f, signal: cancellation.signal });
      if (assertionFailure !== undefined) throw assertionFailure;
      expect(mocks.reporter).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(f.paths.configurationFile, "utf8"))).toEqual(observed.current());
    } finally { observed.restore(); }
  }, 30_000);
  it("applies persistent local overrides to registered cloud targets without rewriting desired", async () => {
    const f = await fixture(), cancellation = new AbortController();
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, agentControlMode: "web", agentModel: "local-model", agentReasoningEffort: "high" } }));
    const target = desired();
    Object.assign(target.value.native, { args: ["--effort", "medium"] });
    mocks.remote().configuration.mockResolvedValue(resource(target)); mocks.remote.mockClear();
    finishAtTick(cancellation, current => {
      expect(current.globalConfiguration).toMatchObject({ model: "local-model", args: ["--effort", "high"] });
      expect(current.repositories[0]!.configuration).toMatchObject({ model: "local-model", args: ["--effort", "high"] });
      const report = (mocks.reporter.mock.calls[0]![0] as ReporterOptions).configuration!.capture(reportSample);
      expect(report.bootstrap).toBeNull();
      expect(report.observation!.items.find(item => item.key.kind === "native")!.appliedValue).toEqual(target.value.native);
    });
    await runWorker({ ...f, signal: cancellation.signal });
  });

  it.each([true, false])("retries unavailable bootstrap projects before granting admission with local overrides=%s", async overrides => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    const source = stringify({ ...f.document, worker: { agent: "codex", model: "local-model", args: ["-c", 'model_reasoning_effort="low"'], ...(overrides ? { agentModel: "local-model", agentReasoningEffort: "high" } : {}), repositories: [f.repository, second], maxConcurrent: 2, pollIntervalMs: 1000 } });
    await writeFile(f.paths.configFile, source);
    let available = false;
    const unavailable = new ApiError({ operation: "project.show" }, "response", { status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "unavailable" }, cause: new Error("Unavailable") });
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(null));
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === uuid(1) && !available) throw unavailable;
      return { id: projectId, repoUrl: projectId === uuid(1) ? remoteUrl : second.remote };
    });
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: id === uuid(1) ? remoteUrl : second.remote }));
    let reporterOptions: ReporterOptions | undefined;
    mocks.reporter.mockImplementation((options: ReporterOptions) => { reporterOptions = options; return reporter(); });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => expect(reporterOptions).toBeDefined());
      await expect(prepareConfiguration(reporterOptions!)).rejects.toBe(unavailable);
      expect(mocks.coordinator).not.toHaveBeenCalled();
      expect(mocks.git).not.toHaveBeenCalled();
      expect(reporterOptions!.configuration!.capture(reportSample).bootstrap).toBeNull();
      available = true;
      const sent = await prepareConfiguration(reporterOptions!);
      expect(sent.bootstrap).toMatchObject({ maxConcurrent: 2, native: { model: "local-model", args: ["-c", 'model_reasoning_effort="low"'] }, projects: [{ projectId: uuid(1) }, { projectId: uuid(2) }] });
      expect(sent.observation).toBeNull();
      const operation = createOperation();
      try { await reporterOptions!.configuration!.accept(sent, { desired: { ...desired([uuid(1), uuid(2)], 2), value: sent.bootstrap! }, observationRevision: "0", observationAccepted: false }, operation); }
      finally { operation.dispose(); }
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalled());
      await vi.waitFor(() => {
        const current = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
        expect(current.configurationComplete!()).toBe(true);
      });
      const sampleOperation = createOperation();
      try {
        const sample = await reporterOptions!.collect(sampleOperation);
        const native = { agent: "codex", model: { value: "local-model", source: overrides ? "local" : "cloud" }, reasoningEffort: { value: overrides ? "high" : "low", source: overrides ? "local" : "cloud" } };
        expect(sample.telemetry.runtimeConfiguration).toEqual({ schemaVersion: 1, native, projects: [{ projectId: uuid(1), native }, { projectId: uuid(2), native }] });
      } finally { sampleOperation.dispose(); }
      expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
      expect(remote.resolveProject.mock.calls.every(([repository]: [{ projectId?: string }]) => repository.projectId !== undefined)).toBe(true);
    } finally { cancellation.abort(); await running; }
  });

  it.each(["protocol", "request"] as const)("keeps a %s bootstrap error visible while its configuration channel stays available", async phase => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(null));
    const failure = new ApiError({ operation: "project.show" }, phase, { cause: new Error("Identity or transport failure") });
    remote.resolveProject.mockRejectedValue(failure);
    let options: ReporterOptions | undefined;
    mocks.reporter.mockImplementation((value: ReporterOptions) => { options = value; return reporter(); });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => expect(options).toBeDefined());
      await expect(prepareConfiguration(options!)).rejects.toBe(failure);
      expect(mocks.coordinator).not.toHaveBeenCalled();
      expect(mocks.git).not.toHaveBeenCalled();
      expect(options!.configuration!.capture(reportSample).bootstrap).toBeNull();
      expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    } finally { cancellation.abort(); await running; }
  });

  it("invalidates candidate inventory at a permission refusal before preparing later repositories", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { agent: "codex", repositories: [f.repository, second], maxConcurrent: 2, pollIntervalMs: 1000 } }));
    const unavailable = new ApiError({ operation: "project.show", projectId: uuid(1) }, "response", { status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "unavailable" }, cause: new Error("Unavailable") });
    let release!: () => void, entered = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(null));
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId: string }) => {
      if (projectId === uuid(1)) { entered = true; await blocked; throw unavailable; }
      return { id: projectId, repoUrl: second.remote };
    });
    const reported = reporter(); let options: ReporterOptions | undefined;
    mocks.reporter.mockImplementation((value: ReporterOptions) => { options = value; return reported; });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => expect(options).toBeDefined());
      const preparation = prepareConfiguration(options!);
      const failed = expect(preparation).rejects.toBe(unavailable);
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(remote.resolveProject).toHaveBeenCalledTimes(1);
      expect(mocks.coordinator).not.toHaveBeenCalled();
      release(); await failed;
      expect(reported.publishInventory).toHaveBeenLastCalledWith(null);
      expect(remote.resolveProject).toHaveBeenCalledTimes(1);
      expect(options!.configuration!.capture(reportSample).bootstrap).toBeNull();
    } finally { cancellation.abort(); release(); await running; }
  });

  it("invalidates a cloud project as soon as its asynchronous preparation observes 404", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [f.repository, second] } }));
    const unavailable = new ApiError({ operation: "project.show", projectId: uuid(1) }, "response", { status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "unavailable" }, cause: new Error("Unavailable") });
    let rejectFirst!: (error: unknown) => void, entered = false, preparationEntered = false;
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(1), uuid(2)])));
    remote.project.mockImplementation(async (id: string) => {
      if (id === uuid(1)) { preparationEntered = true; return first; }
      return { id, repoUrl: second.remote };
    });
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId: string }) => ({ id: projectId, repoUrl: projectId === uuid(1) ? remoteUrl : second.remote }));
    const reported = reporter(), invalidateProject = vi.fn();
    mocks.reporter.mockReturnValue(reported);
    mocks.coordinator.mockImplementation(() => ({ archiveYield: () => false, updateConfiguration: vi.fn(), invalidateProject, shutdown: vi.fn(async () => true), tick: vi.fn(async () => { entered = true; }) }));
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => { expect(entered).toBe(true); expect(preparationEntered).toBe(true); }, { timeout: 5000, interval: 10 });
      reported.publishInventory({ observedAt: "2026-11-04T00:00:00Z", claims: [] });
      rejectFirst(unavailable);
      await vi.waitFor(() => expect(invalidateProject).toHaveBeenCalledWith(uuid(1)), { timeout: 5000, interval: 10 });
      expect(reported.publishInventory).toHaveBeenLastCalledWith(null);
    } finally { cancellation.abort(); rejectFirst(unavailable); await running; }
  });

  it.each(["conflict", "io"] as const)("keeps admission incomplete when a local mapping fails with %s", async failure => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const localPath = failure === "io" ? path.join(f.homeDirectory, "ordinary-file", "repo") : f.repository.path;
    if (failure === "io") await writeFile(path.join(f.homeDirectory, "ordinary-file"), "not a directory");
    else f.store!.registerProject({ projectId: uuid(9), repoUrl: "https://git.example/team/retained.git", localPath });
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [{ ...f.repository, path: localPath }, second] } }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(1), uuid(2)])));
    remote.project.mockImplementation(async (id: string) => {
      if (id === uuid(1)) throw new ApiError({ operation: "project.show" }, "response", { status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "unavailable" }, cause: new Error("Unavailable") });
      return { id, repoUrl: second.remote };
    });
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId: string }) => ({ id: projectId, repoUrl: second.remote }));
    let coordinatorOptions: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => { coordinatorOptions = options; return coordinator(async () => {}); });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => expect(mocks.emit.mock.calls.some(([event]) => event.kind === "worker-configuration" && event.message.includes(`\"projectId\":\"${uuid(1)}\"`) && event.message.includes('"state":"error"'))).toBe(true), { timeout: 5000, interval: 10 });
      await vi.waitFor(() => expect(coordinatorOptions).toBeDefined(), { timeout: 5000, interval: 10 });
      expect(coordinatorOptions!.configurationComplete!()).toBe(false);
      expect(f.store!.getProject({ projectId: uuid(1) })).toBeNull();
    } finally { cancellation.abort(); await running; }
  }, 12_000);

  it.each([true, false])("keeps a local mapping in capacity accounting while lookup is blocked (initially selected: %s)", async initiallySelected => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [f.repository, second], agent: "invalid-old-native-settings" } }));
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = configurationSource.workerLocalRepositoryForId;
    const lookup = vi.spyOn(configurationSource, "workerLocalRepositoryForId").mockImplementation(async (local, paths, id) => {
      if (id === uuid(1)) { entered = true; await held; }
      return original(local, paths, id);
    });
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired(initiallySelected ? [uuid(1), uuid(2)] : [uuid(2)])));
    remote.project.mockImplementation(async (id: string) => {
      if (id === uuid(1)) throw new ApiError({ operation: "project.show" }, "response", { status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "unavailable" }, cause: new Error("Unavailable") });
      return { id, repoUrl: second.remote };
    });
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId: string }) => ({ id: projectId, repoUrl: second.remote }));
    let channel!: ReporterOptions["configuration"], options: WorkerCoordinatorOptions | undefined;
    mocks.reporter.mockImplementation((value: ReporterOptions) => { channel = value.configuration!; return reporter(); });
    mocks.coordinator.mockImplementation((value: WorkerCoordinatorOptions) => { options = value; return coordinator(async () => {}); });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => { expect(entered).toBe(true); expect(options).toBeDefined(); }, { timeout: 5000, interval: 10 });
      expect(options!.configurationComplete!()).toBe(false);
      if (initiallySelected) {
        const operation = createOperation();
        try { await channel!.accept(channel!.capture(reportSample), { desired: { ...desired([uuid(2)]), revision: "2" }, observationRevision: "0", observationAccepted: false }, operation); }
        finally { operation.dispose(); }
        expect(options!.configurationComplete!()).toBe(false);
      }
      release();
      await vi.waitFor(() => expect(options!.store.getProject({ projectId: uuid(1) })).toMatchObject({ localPath: f.repository.path }), { timeout: 5000, interval: 10 });
      await vi.waitFor(() => expect(options!.configurationComplete!()).toBe(true), { timeout: 5000, interval: 10 });
    } finally { cancellation.abort(); release(); await running; lookup.mockRestore(); }
  }, 12_000);

  it.each(["retained", "discovered", "unavailable", "absent", "foreign"] as const)("reconciles an unbound local repository against cloud selection: %s", async scenario => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const { projectId: _projectId, ...legacy } = f.repository;
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [legacy, second], agent: "invalid-old-native-settings" } }));
    if (scenario !== "absent") await mkdir(f.repository.path);
    if (scenario === "retained") f.store!.registerProject({ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path });
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(2)])));
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: second.remote }));
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId?: string }) => {
      if (projectId === undefined && scenario === "unavailable") throw new Error("Project does not exist for the configured worker repository.");
      return { id: projectId ?? uuid(1), repoUrl: projectId === undefined ? remoteUrl : second.remote };
    });
    if (scenario === "foreign") mocks.git.mockReturnValue(Object.assign({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}), listWorktrees: vi.fn(async () => [{ owner: { projectId: uuid(9), taskId: uuid(10), claimId: uuid(11), worktreeId: uuid(12) }, binding: {} }]) }, { scanWorktrees: scanFromList }));
    let options: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((value: WorkerCoordinatorOptions) => { options = value; return coordinator(async () => {}); });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => expect(options).toBeDefined(), { timeout: 5000, interval: 10 });
      if (scenario === "unavailable" || scenario === "foreign") {
        await vi.waitFor(() => expect(remote.resolveProject).toHaveBeenCalledWith({ repoUrl: remoteUrl }, expect.any(AbortSignal)), { timeout: 5000, interval: 10 });
        if (scenario === "foreign") await vi.waitFor(() => expect(mocks.git.mock.results[0]!.value.listWorktrees).toHaveBeenCalled(), { timeout: 5000, interval: 10 });
        expect(options!.configurationComplete!()).toBe(false);
        expect(options!.store.getProject({ projectId: uuid(1) })).toBeNull();
      } else {
        await vi.waitFor(() => expect(options!.configurationComplete!()).toBe(true), { timeout: 5000, interval: 10 });
        if (scenario !== "absent") expect(options!.store.getProject({ projectId: uuid(1) })).toMatchObject({ localPath: f.repository.path });
      }
    } finally { cancellation.abort(); await running; }
  }, 12_000);

  it.each([null, "not-a-uuid"])("retains unknown managed resources when the old Project ID is %s", async invalidId => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const second = { projectId: uuid(2), remote: "https://git.example/team/other.git", path: path.join(f.homeDirectory, "other") };
    await mkdir(f.repository.path);
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [{ ...f.repository, projectId: invalidId }, second] } }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(2)])));
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: second.remote }));
    remote.resolveProject.mockImplementation(async ({ projectId }: { projectId?: string }) => ({ id: projectId ?? uuid(1), repoUrl: second.remote }));
    const listWorktrees = vi.fn(async () => [{ owner: { projectId: uuid(9), taskId: uuid(10), claimId: uuid(11), worktreeId: uuid(12) }, binding: {} }]);
    mocks.git.mockReturnValue({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}), listWorktrees });
    let options: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((value: WorkerCoordinatorOptions) => { options = value; return coordinator(async () => {}); });
    const running = runWorker({ ...f, signal: cancellation.signal });
    try {
      await vi.waitFor(() => { expect(options).toBeDefined(); expect(mocks.emit.mock.calls.some(([event]) => event.message.includes("Local resource mapping"))).toBe(true); }, { timeout: 5000, interval: 10 });
      expect(listWorktrees).not.toHaveBeenCalled();
      expect(options!.configurationComplete!()).toBe(false);
      expect(options!.store.getProject({ projectId: uuid(9) })).toBeNull();
      expect(remote.resolveProject).not.toHaveBeenCalledWith({ repoUrl: remoteUrl }, expect.any(AbortSignal));
    } finally { cancellation.abort(); await running; }
  }, 12_000);
  it("keeps pre-cancelled startup before identity, locks, databases and remote requests", async () => {
    const f = await fixture(false, false);
    const before = (await readdir(f.homeDirectory, { recursive: true })).sort();
    const cancellation = new AbortController(); cancellation.abort(new Error("Startup cancelled."));
    await runWorker({ ...f, signal: cancellation.signal });
    expect((await readdir(f.homeDirectory, { recursive: true })).sort()).toEqual(before);
    for (const factory of [mocks.coordinator, mocks.herdr, mocks.git, mocks.remote, mocks.reporter]) expect(factory).not.toHaveBeenCalled();
  });

  it("starts its configuration channel for an empty cloud selection without invoking a picker", async () => {
    const f = await fixture(false, false), cancellation = new AbortController();
    const remote = mocks.remote.mock.results.length === 0 ? mocks.remote() : mocks.remote.mock.results[0]!.value;
    remote.configuration.mockResolvedValue(resource(desired([])));
    mocks.remote.mockClear();
    mocks.reporter.mockImplementation((options: ReporterOptions) => {
      expect(remote.configuration).toHaveBeenCalledExactlyOnceWith(workerId, expect.any(AbortSignal));
      expect(options.configuration!.capture(reportSample).bootstrap).toBeNull();
      cancellation.abort(); return reporter();
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.reporter).toHaveBeenCalledOnce();
    expect(mocks.coordinator).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("rediscovers tool support after a mode-capable server upgrades without restarting the Worker", async () => {
    const f = await fixture(false, false), base = desired([]);
    const initial: WorkerCloudDesired = { ...base, value: { ...base.value, agentControlMode: "web" } };
    const upgraded: WorkerCloudDesired = { ...initial, value: { ...initial.value, toolPaths: { codex: null, copilot: null, herdr: null } } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValueOnce(resource(initial)).mockResolvedValue(resource(upgraded));
    let channel: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration; return reporter(); });
    const { cancellation, running } = start(f);
    const operation = createOperation();
    try {
      await vi.waitFor(() => expect(channel).toBeDefined());
      await channel!.prepare!(operation);
      expect(remote.configuration).toHaveBeenCalledOnce();
      await channel!.accept(channel!.capture(reportSample), { desired: initial, observationRevision: "0", observationAccepted: false }, operation);

      await channel!.prepare!(operation);
      expect(remote.configuration).toHaveBeenCalledTimes(2);
      expect(remote.configuration).toHaveBeenLastCalledWith(workerId, operation.signal, operation);
      expect(JSON.parse(await readFile(f.paths.configurationFile, "utf8")).authority.desired).toEqual(upgraded);
      expect(channel!.capture(reportSample).toolPathsBootstrap).toEqual({ codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } });

      await channel!.accept(channel!.capture(reportSample), { desired: upgraded, observationRevision: "0", observationAccepted: false }, operation);
      await channel!.prepare!(operation);
      expect(remote.configuration).toHaveBeenCalledTimes(2);
      expect(remote.reportConfiguration).not.toHaveBeenCalled();
    } finally { operation.dispose(); cancellation.abort(); await running; }
  });

  it("ignores stale managed YAML when the cloud target already exists", async () => {
    const f = await fixture(false, false), cancellation = new AbortController();
    const source = stringify({ ...f.document, worker: { maxConcurrent: 0, agent: "removed-agent", args: false, repositories: null } });
    await writeFile(f.paths.configFile, source);
    mocks.remote().configuration.mockResolvedValue(resource(desired([], 4)));
    mocks.remote.mockClear();
    mocks.reporter.mockImplementation((options: ReporterOptions) => { expect(options.configuration!.capture(reportSample).bootstrap).toBeNull(); cancellation.abort(); return reporter(); });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.reporter).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(source);
  });

  it("propagates cloud lookup failures before constructing native or task backends", async () => {
    const f = await fixture();
    const failure = new Error("Configuration service unavailable.");
    mocks.remote().configuration.mockRejectedValue(failure); mocks.remote.mockClear();
    await expect(runWorker(f)).rejects.toBe(failure);
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("recovers a transient startup configuration read while retaining the original instance lock", async () => {
    const f = await fixture(), failure = new ApiError({ operation: "worker.configuration" }, "request", { cause: new Error("Temporary connection refusal") });
    const remote = mocks.remote(); mocks.remote.mockClear();
    let recover = false;
    remote.configuration.mockImplementation(async () => { if (!recover) throw failure; return resource(desired()); });
    let channel: ReporterOptions | undefined;
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options; return reporter(); });
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => expect(channel).toBeDefined());
      expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.herdr).not.toHaveBeenCalled();
      const competing = await tryAcquireWorkerInstanceLock(f.paths);
      try { expect(competing).toBeNull(); } finally { await competing?.release(); }
      await expect(prepareConfiguration(channel!)).rejects.toBe(failure);
      expect(channel!.configuration!.capture(reportSample).observation).toBeNull();
      recover = true;
      const sent = await prepareConfiguration(channel!);
      expect(sent.bootstrap).toBeNull(); expect(sent.observation?.desiredRevision).toBe("1");
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalled());
      await vi.waitFor(() => expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).configurationComplete!()).toBe(true));
      expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
    } finally { cancellation.abort(); await running; }
    const next = await tryAcquireWorkerInstanceLock(f.paths);
    try { expect(next).not.toBeNull(); } finally { await next?.release(); }
  });

  it("retries startup identity under the same lock without reading account-bound cache early", async () => {
    const f = await fixture(), failure = new ApiError({ operation: "me.show" }, "request", { cause: new Error("Temporary identity connection refusal") });
    const remote = mocks.remote(); mocks.remote.mockClear();
    let release!: () => void, verified = false;
    const secondIdentity = new Promise<void>(resolve => { release = resolve; });
    remote.currentUserId.mockRejectedValueOnce(failure).mockImplementation(async () => { await secondIdentity; verified = true; return uuid(6); });
    const cacheRead = vi.spyOn(configurationCache, "readConfigurationCache");
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => expect(remote.currentUserId).toHaveBeenCalledOnce());
      expect(cacheRead).not.toHaveBeenCalled(); expect(remote.configuration).not.toHaveBeenCalled();
      expect(mocks.reporter).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
      const competing = await tryAcquireWorkerInstanceLock(f.paths);
      try { expect(competing).toBeNull(); } finally { await competing?.release(); }
      await vi.waitFor(() => expect(remote.currentUserId).toHaveBeenCalledTimes(2), { timeout: 6500, interval: 20 });
      expect(verified).toBe(false); expect(cacheRead).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(mocks.reporter).toHaveBeenCalledOnce());
      expect(verified).toBe(true); expect(remote.configuration).toHaveBeenCalledOnce();
    } finally { release(); cancellation.abort(); await running; cacheRead.mockRestore(); }
  }, 12_000);

  it.each([401, 403])("preserves a definite startup identity refusal with HTTP %s", async status => {
    const f = await fixture();
    const failure = new ApiError({ operation: "me.show" }, "response", { status, serverError: { code: "unauthorized", message: "Identity refused.", requestId: "identity-refused" }, cause: new Error("Identity refused.") });
    const remote = mocks.remote(); mocks.remote.mockClear(); remote.currentUserId.mockRejectedValue(failure);
    await expect(runWorker(f)).rejects.toBe(failure);
    expect(remote.currentUserId).toHaveBeenCalledOnce(); expect(remote.configuration).not.toHaveBeenCalled();
    expect(mocks.reporter).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
  });

  it("passes one raw local bootstrap through the reporter and uses the returned cloud target", async () => {
    const f = await fixture();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockRejectedValue(new ApiError({ operation: "worker.configuration" }, "response", {
      cause: new Error("not found"), status: 404, serverError: { code: "not_found", message: "Not found.", requestId: "bootstrap-test" },
    }));
    const cancellation = new AbortController(); cancellations.add(cancellation);
    let accepted: Promise<void> | undefined, assertionFailure: unknown;
    mocks.reporter.mockImplementation((options: ReporterOptions) => {
      accepted = (async () => {
        const sent = await prepareConfiguration(options);
        expect(sent.bootstrap).toMatchObject({ maxConcurrent: 7, projects: [{ projectId: uuid(1), nativeOverrides: {} }] });
        expect(sent.observation).toBeNull();
        const operation = createOperation();
        try { await options.configuration!.accept(sent, { desired: desired([uuid(1)], 3), observationRevision: "0", observationAccepted: false }, operation); }
        finally { operation.dispose(); }
      })().catch(error => { assertionFailure = error; cancellation.abort(error); });
      return reporter();
    });
    finishAtTick(cancellation, options => { expect(options.maxConcurrent).toBe(3); expect(options.globalConfiguration).not.toBeNull(); expect(options.globalConfiguration!.model).toBe("cloud-model"); }, options => options.globalConfiguration !== null && options.maxConcurrent === 3);
    const { running } = start(f, { signal: cancellation.signal });
    await running; await accepted;
    if (assertionFailure !== undefined) throw assertionFailure;
    expect(remote.reportConfiguration).not.toHaveBeenCalled();
    expect(mocks.reporter).toHaveBeenCalledOnce();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("prepares a selected local binding before making it available for reconciliation", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    finishAtTick(cancellation, options => {
      expect(options.store.listProjects()).toEqual([{ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path }]);
      expect(options.repositories).toHaveLength(1);
      expect(options.repositories[0]!.configuration.model).toBe("cloud-model");
      expect(options.maxConcurrent).toBe(1);
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledExactlyOnceWith(
      { projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path }, expect.anything(),
    );
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("prepares a cloud project without a local mapping under the configured repository root", async () => {
    const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
    const root = path.join(f.homeDirectory, "cloud-repositories");
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [], repositoryRoot: root } }));
    const expected = { projectId: uuid(1), repoUrl: remoteUrl, localPath: path.join(root, "git.example", "team", "repo") };
    finishAtTick(cancellation, options => {
      expect(options.store.getProject({ projectId: uuid(1) })).toEqual(expected);
      expect(options.repositories[0]!.project).toEqual(expected);
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository).toHaveBeenCalledExactlyOnceWith(expected, expect.anything());
  });

  it("keeps configuration exchange live without publishing incomplete inventory and publishes after mapping recovers", async () => {
    const f = await fixture(false, false), controller = new AbortController(); cancellations.add(controller);
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.project.mockRejectedValue(new Error("Project lookup unavailable"));
    const reported = reporter();
    let channel!: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration!; return reported; });
    const inventory = { observedAt: "2026-11-04T00:00:00Z", claims: [] };
    let assertionFailure: unknown;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      const operation = createOperation();
      try {
        expect(options.store.getProject({ projectId: uuid(1) })).toBeNull();
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(null);
        const captured = channel!.capture(reportSample);
        expect(captured.observation).not.toBeNull();
        remote.project.mockResolvedValue({ id: uuid(1), repoUrl: remoteUrl });
        await channel!.accept(captured, { desired: { ...desired(), revision: "2" }, observationRevision: "0", observationAccepted: false }, operation);
        await vi.waitFor(() => expect(options.store.getProject({ projectId: uuid(1) })).not.toBeNull(), { timeout: 5000, interval: 10 });
        await vi.waitFor(() => expect(options.configurationComplete!()).toBe(true), { timeout: 5000, interval: 10 });
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(inventory);
      } catch (error) { assertionFailure = error; } finally { operation.dispose(); controller.abort(); }
    }));
    await runWorker({ ...f, signal: controller.signal });
    if (assertionFailure !== undefined) throw assertionFailure;
  });

  it("does not publish an in-flight inventory after the cloud target adds an unmapped project", async () => {
    const f = await fixture(), controller = new AbortController(); cancellations.add(controller);
    const second = { projectId: uuid(2), remote: "https://git.example/team/second.git", path: path.join(f.homeDirectory, "second") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, repositories: [f.repository] } }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    let secondAvailable = false;
    remote.project.mockImplementation(async (id: string) => {
      if (id === uuid(2) && !secondAvailable) throw new Error("Project lookup unavailable");
      return { id, repoUrl: id === uuid(1) ? remoteUrl : second.remote };
    });
    const reported = reporter(); let channel!: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration!; return reported; });
    const inventory = { observedAt: "2026-11-04T00:00:00Z", claims: [] };
    let assertionFailure: unknown;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      const operation = createOperation();
      try {
        await vi.waitFor(() => expect(options.store.getProject({ projectId: uuid(1) })).not.toBeNull(), { timeout: 5000, interval: 10 });
        const captured = channel!.capture(reportSample);
        await channel!.accept(captured, { desired: { ...desired([uuid(1), uuid(2)]), revision: "2" }, observationRevision: "0", observationAccepted: false }, operation);
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(null);
        await vi.waitFor(() => expect(mocks.emit.mock.calls.some(([event]) => event.kind === "worker-configuration" && event.message.includes(`\"projectId\":\"${uuid(2)}\"`) && event.message.includes('"state":"error"'))).toBe(true), { timeout: 5000, interval: 10 });
        secondAvailable = true;
        await channel!.accept(channel!.capture(reportSample), { desired: { ...desired([uuid(1), uuid(2)]), revision: "3" }, observationRevision: "0", observationAccepted: false }, operation);
        await vi.waitFor(() => expect(options.store.getProject({ projectId: uuid(2) })).not.toBeNull(), { timeout: 5000, interval: 10 });
        await vi.waitFor(() => expect(options.configurationComplete!()).toBe(true), { timeout: 5000, interval: 10 });
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(inventory);
      } catch (error) { assertionFailure = error; } finally { operation.dispose(); controller.abort(); }
    }));
    await runWorker({ ...f, signal: controller.signal });
    if (assertionFailure !== undefined) throw assertionFailure;
  }, 12_000);

  it("registers every successfully prepared cloud project mapping on an empty database", async () => {
    const f = await fixture(), controller = new AbortController(); cancellations.add(controller);
    const second = { projectId: uuid(2), remote: "https://git.example/team/second.git", path: path.join(f.homeDirectory, "second") };
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, repositories: [f.repository, second] } }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(1), uuid(2)])));
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: id === uuid(1) ? remoteUrl : second.remote }));
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      try {
        await vi.waitFor(() => expect(options.store.listProjects()).toEqual(expect.arrayContaining([
          { projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path },
          { projectId: uuid(2), repoUrl: second.remote, localPath: second.path },
        ])), { timeout: 5000, interval: 10 });
        expect(options.store.listProjects()).toHaveLength(2);
      } finally { controller.abort(); }
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(mocks.coordinator).toHaveBeenCalledOnce();
  });

  it("checks the cloud again before reusing a previously applied restart cache", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    finishAtTick(cancellation);
    await runWorker({ ...f, signal: cancellation.signal });
    expect(await readFile(path.join(f.paths.workerDirectory, "configuration.json"), "utf8")).toContain("cloud-model");
    const probes = mocks.probe.mock.calls.length;
    const failure = new Error("Cloud lookup unavailable on restart.");
    mocks.remote.mock.results[0]!.value.configuration.mockRejectedValue(failure);
    mocks.coordinator.mockClear();
    await expect(runWorker(f)).rejects.toBe(failure);
    expect(mocks.coordinator).not.toHaveBeenCalled(); expect(mocks.probe).toHaveBeenCalledTimes(probes);
  });

  it("retains an existing SSH path mapping and task record while applying cloud runtime settings", async () => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const ssh = "git@git.example:team/repo.git";
    const binding = { projectId: uuid(1), repoUrl: ssh, localPath: f.repository.path };
    f.store!.registerProject(binding);
    const original = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", sessionId: uuid(5) });
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [{ ...f.repository, remote: ssh }], maxConcurrent: 9, model: "stale-local-model" } }));
    finishAtTick(cancellation, options => { expect(options.globalConfiguration).not.toBeNull(); expect(options.globalConfiguration!.model).toBe("cloud-model"); });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.git.mock.results[0]!.value.prepareRepository.mock.calls[0]![0]).toEqual(binding);
    expect(f.store!.getProject(binding)).toEqual(binding); expect(f.store!.getTask(original)).toEqual(original);
  });

  it("starts a valid project native override while the independent global native tuple fails", async () => {
    const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, agentControlMode: "web" } }));
    const target = desired();
    mocks.remote().configuration.mockResolvedValue(resource({ ...target, value: {
      ...target.value, native: { ...target.value.native, args: ["--search"] },
      projects: [{ projectId: uuid(1), nativeOverrides: { args: [] } }],
    } })); mocks.remote.mockClear();
    finishAtTick(cancellation, options => {
      expect(options.globalConfiguration).toBeNull();
      expect(options.repositories).toEqual([{ project: { projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path }, configuration: { agent: "codex", agentControlMode: "web", model: "cloud-model", args: [], recoveryLimit: 3 } }]);
      const report = (mocks.reporter.mock.calls[0]![0] as ReporterOptions).configuration!.capture(reportSample);
      expect(report.observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "native" }, state: "error", appliedValue: null }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "applied", appliedValue: { agent: "codex", model: "cloud-model", args: [] } }),
      ]));
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.coordinator).toHaveBeenCalledOnce();
  });

  it("keeps Herdr-only defaults observable while reporting unsupported assistant arguments", async () => {
    const f = await fixture(), target = desired();
    mocks.remote().configuration.mockResolvedValue(resource({ ...target, value: { ...target.value, native: { ...target.value.native, args: ["--search"] } } }));
    mocks.remote.mockClear();
    const actual = await vi.importActual<typeof import("../../../src/commands/worker/bots/host-capabilities.js")>("../../../src/commands/worker/bots/host-capabilities.js");
    mocks.hostCollector.mockImplementation((options: Parameters<typeof actual.createAssistantHostCollector>[0]) => actual.createAssistantHostCollector({ ...options,
      resolveExecutable: () => { throw Object.assign(new Error("Fixture has no native assistant executable."), { code: "ENOENT" }); },
    }));
    let latest: WorkerCoordinatorOptions | undefined;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      let current = options;
      latest = current;
      return { ...coordinator(async () => {}), updateConfiguration: vi.fn((configuration: Partial<WorkerCoordinatorOptions>) => { current = { ...current, ...configuration }; latest = current; }) };
    });
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => {
        expect(mocks.coordinator).toHaveBeenCalledOnce();
        expect(latest?.globalConfiguration).toMatchObject({ agentControlMode: "herdr", args: ["--search"] });
      });
      const operation = createOperation();
      try {
        const sample = await (mocks.reporter.mock.calls[0]![0] as ReporterOptions).collect(operation);
        expect(sample.telemetry.versions.daynight).toBe(f.version);
        expect(sample.telemetry.assistantHost?.providers.find(provider => provider.provider === "codex")).toEqual({ provider: "codex", available: false, reason: "unsupported_arguments", model: null, args: [] });
        expect(sample.issues).toEqual(expect.arrayContaining([expect.objectContaining({ component: "assistantHost_codex", code: "unavailable" })]));
      } finally { operation.dispose(); }
    } finally { cancellation.abort(); await running; }
  });

  it("keeps a prepared project's frozen Web recovery available when its new native defaults fail", async () => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { ...f.document.worker, agentControlMode: "web" } }));
    const project = f.store!.registerProject({ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path });
    const localTask = f.store!.activateTask(f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", agentControlMode: "web" }));
    const frozen = { agent: "codex" as const, agentControlMode: "web" as const, model: "frozen-before-change", args: [] as string[], recoveryLimit: 2 };
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"));
    web.register({ ...localTask, worktreeId: uuid(9), project, serverOrigin: origin, workerId, userId: uuid(6), configuration: frozen }, Date.now()); web.close();
    const target = desired();
    mocks.remote().configuration.mockResolvedValue(resource({ ...target, value: { ...target.value, native: { ...target.value.native, args: ["--search"] } } })); mocks.remote.mockClear();
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      let current = options;
      return {
        archiveYield: () => false, updateConfiguration: vi.fn(value => { current = { ...options, ...value }; }),
        tick: vi.fn(async () => {
          if (!current.readyProjectIds?.includes(uuid(1))) return;
          expect(current.globalConfiguration).toBeNull(); expect(current.repositories).toEqual([]);
          expect(options.webStore!.getTask(localTask)!.configuration).toEqual(frozen);
          cancellation.abort();
        }),
        shutdown: vi.fn(async () => true),
      };
    });
    await runWorker({ ...f, signal: cancellation.signal });
    expect(mocks.coordinator).toHaveBeenCalledOnce(); expect(f.store!.getTask(localTask)).toEqual(localTask);
  });

  it.each([false, true])("starts an empty cloud selection without repository discovery or interactive preparation (warm: %s)", async warm => {
    const f = await fixture(warm, false), controller = new AbortController();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([])));
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.repositories).toEqual([]);
      expect(options.store.listProjects()).toEqual([]);
      expect(options.store.listTasks()).toEqual([]);
      expect(options.store.listCleanupSchedules()).toEqual([]);
      controller.abort();
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(remote.resolveProject).not.toHaveBeenCalled();
    expect(mocks.git.mock.results[0]!.value.prepareRepository).not.toHaveBeenCalled();
    expect(await readFile(f.paths.configFile, "utf8")).toBe(f.source);
  });

  it("captures service credentials and worker settings from one configuration source", async () => {
    const f = await fixture(false, true); const controller = new AbortController();
    const replacement = stringify({ ...f.document, serverUrl: "https://other.example", worker: { repositories: [], maxConcurrent: 7 } });
    const originalRead = configurationFiles.readConfigurationSource;
    let replaced = false;
    const read = vi.spyOn(configurationFiles, "readConfigurationSource").mockImplementation(async (...args) => {
      const source = await originalRead(...args);
      if (!replaced) { await writeFile(`${f.paths.configFile}.next`, replacement); await rename(`${f.paths.configFile}.next`, f.paths.configFile); replaced = true; }
      return source;
    });
    cancellations.add(controller);
    finishAtTick(controller, options => {
      expect(options.serverOrigin).toBe(origin);
      expect(options.maxConcurrent).toBe(1);
      expect(options.repositories).toHaveLength(1);
    });
    try {
      await runWorker({ ...f, signal: controller.signal });
      expect(mocks.remote.mock.calls[0]![0]).toEqual({ serverUrl: origin, serverToken: token });
    } finally { read.mockRestore(); }
  });

  it("rejects a second zero-repository runner under the same worker lock", async () => {
    const f = await fixture(false, false); const controller = new AbortController();
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.coordinator.mockReturnValue(coordinator(async () => { entered(); }));
    const first = runWorker({ ...f, signal: controller.signal });
    try {
      await started;
      await expect(runWorker(f)).rejects.toThrow(/already running|lock/i);
      expect(mocks.coordinator).toHaveBeenCalledOnce();
    } finally { controller.abort(); await first; }
  });

  it("keeps original task and cleanup responsibility with no configured repositories", async () => {
    const f = await fixture(true, false); const controller = new AbortController();
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    const binding = { projectId: uuid(1), repoUrl: f.repository.remote, localPath: f.repository.path };
    f.store!.registerProject(binding);
    const pending = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex" });
    f.store!.activateTask(pending);
    const cleanup = f.store!.saveCleanupSchedule({ ...pending, worktreeId: uuid(7) }, { deadline: 100, failures: 2, nextAttemptAt: 50, stage: "stop", lastError: "unconfirmed" });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      expect(options.repositories).toEqual([]);
      expect(options.store.getTask(pending)?.status).toBe("active");
      expect(options.store.getCleanupSchedule(pending)).toEqual(cleanup);
      expect(options.maxConcurrent).toBe(1);
      controller.abort(new Error("Original inventory observed."));
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(f.store!.getTask(pending)?.status).toBe("active");
    expect(f.store!.getCleanupSchedule(pending)).toEqual(cleanup);
  });

  it("reestablishes removal responsibility for an excluded retained project on restart", async () => {
    const f = await fixture(true, false), controller = new AbortController(); cancellations.add(controller);
    f.store!.registerProject({ projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path });
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    let channel!: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration!; return reporter(); });
    const stopped = vi.fn(async () => {});
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({
      ...coordinator(async () => {
        await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 5000, interval: 10 });
        expect(channel!.capture(reportSample).observation!.items).toEqual(expect.arrayContaining([
          expect.objectContaining({ key: { kind: "projectRemoval", projectId: uuid(1) }, targetRevision: "1" }),
        ]));
        expect(options.readyProjectIds).toEqual([]);
        controller.abort();
      }),
      stopProject: stopped,
    }));
    await runWorker({ ...f, signal: controller.signal });
    expect(stopped).toHaveBeenCalledWith(uuid(1), expect.any(AbortSignal));
    expect(f.store!.getProject({ projectId: uuid(1) })).not.toBeNull();
  });

});

it.skipIf(process.platform === "win32")("binds an explicit Agent CLI alias only in the worker's native environment", async () => {
  const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
  const target = path.join(f.homeDirectory, "development-cli");
  await writeFile(target, "#!/bin/sh\nprintf dev\n", { mode: 0o700 });
  await writeFile(f.paths.configFile, stringify({ ...f.document, agentCliAliases: { daynight: target } }));
  const originalPath = process.env.PATH;
  finishAtTick(cancellation, options => { void options.herdr.attachment; });
  await runWorker({ ...f, signal: cancellation.signal });
  const options = mocks.herdr.mock.calls[0]![0];
  expect(options.agentEnvironment.PATH).toContain(path.join(f.paths.stateDirectory, "agent-cli-aliases"));
  expect(options.agentEnvironment).toEqual({ PATH: options.agentEnvironment.PATH, DN_CONFIG_DIR: f.paths.stateDirectory });
  expect(process.env.PATH).toBe(originalPath); expect(options.environment).toBeUndefined();
});

it("retains committed Worker state while a Web state failure leaves the configuration channel available", async () => {
  const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
  await mkdir(f.paths.workerDirectory, { recursive: true });
  const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  const invalid = new Database(webFile);
  invalid.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('original'); PRAGMA user_version=999"); invalid.close();
  mocks.emit.mockImplementation((event: { error?: unknown }) => { if (event.error !== undefined) cancellation.abort(); });
  await runWorker({ ...f, signal: cancellation.signal });
  expect(mocks.reporter).toHaveBeenCalledOnce(); expect(mocks.coordinator).not.toHaveBeenCalled();
  expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "reconciliation-error", error: expect.objectContaining({ message: expect.stringContaining("unsupported-version") }) }));
  expect(mocks.reporter.mock.results[0]!.value.stop).toHaveBeenCalledOnce();
  const worker = new Database(f.paths.databaseFile); expect(worker.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
  expect(worker.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 }); worker.close();
  const web = new Database(webFile);
  expect(web.pragma("user_version", { simple: true })).toBe(999);
  expect(web.prepare("SELECT value FROM retained").get()).toEqual({ value: "original" });
  web.exec("DROP TABLE retained; CREATE TABLE executions (identity TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT; PRAGMA user_version=1"); web.close();
  mocks.emit.mockImplementation(() => {});
  const repaired = new AbortController(); cancellations.add(repaired); finishAtTick(repaired);
  await runWorker({ ...f, signal: repaired.signal });
  expect(mocks.coordinator).toHaveBeenCalledOnce();
  const upgradedWeb = new Database(webFile);
  expect(upgradedWeb.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(webExecutionStoreFormat));
  upgradedWeb.close();
  const unchangedWorker = new Database(f.paths.databaseFile);
  expect(unchangedWorker.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(workerStoreFormat));
  unchangedWorker.close();
});

it("rebuilds unknown zero-version Web state before starting its coordinator", async () => {
  const f = await fixture(), cancellation = new AbortController(); cancellations.add(cancellation);
  await mkdir(f.paths.workerDirectory, { recursive: true });
  const webFile = path.join(f.paths.workerDirectory, "web-executions.sqlite");
  const original = new Database(webFile); original.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('discarded')"); original.close();
  finishAtTick(cancellation);
  await runWorker({ ...f, signal: cancellation.signal });
  const web = new Database(webFile);
  expect(web.pragma("user_version", { simple: true })).toBe(currentSqliteVersion(webExecutionStoreFormat));
  expect(web.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).toEqual([{ name: "executions" }, { name: "orchestration_blockers" }]);
  expect(web.prepare("SELECT * FROM executions").all()).toEqual([]); web.close();
});

it("starts Bot management with no projects and preserves the Worker lock through Bot shutdown", async () => {
  const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  let botOptions: any;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    return { run: vi.fn(async (signal: AbortSignal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    }), shutdown: vi.fn(async () => {
      expect(await readFile(f.paths.lockFile, "utf8")).toContain(String(process.pid));
      expect(options.store.list(options.owner)).toEqual([]);
    }) };
  });
  mocks.coordinator.mockImplementation(() => coordinator(async () => cancellation.abort()));
  await runWorker({ ...f, signal: cancellation.signal });
  expect(mocks.bots).toHaveBeenCalledOnce();
  expect(botOptions.owner).toEqual({ serverOrigin: origin, ownerUserId: uuid(6), workerId });
  expect(mocks.bots.mock.results[0]!.value.run).toHaveBeenCalledOnce();
  expect(mocks.bots.mock.results[0]!.value.shutdown).toHaveBeenCalledOnce();
  expect(() => botOptions.store.list(botOptions.owner)).toThrow();
  expect((await readdir(f.paths.workerDirectory))).not.toContain("instance.lock");
});

it("attempts Task shutdown and releases stores and the lock when Bot shutdown fails", async () => {
  const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  const failure = new Error("Bot writer stop remains unconfirmed");
  let botOptions: any;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    return { run: async () => {}, shutdown: async () => { throw failure; } };
  });
  const tasks = coordinator(async () => cancellation.abort()); mocks.coordinator.mockReturnValue(tasks);
  await expect(runWorker({ ...f, signal: cancellation.signal })).rejects.toBe(failure);
  expect(tasks.shutdown).toHaveBeenCalledOnce();
  expect(() => botOptions.store.list(botOptions.owner)).toThrow();
  expect((await readdir(f.paths.workerDirectory))).not.toContain("instance.lock");
});


describe("real runtime resource isolation", () => {
  it.each(["known", "unproven", "foreign", "invalid"])("reconciles an unbound mapping and its damaged registration: %s", async scenario => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const { projectId: _projectId, ...legacy } = f.repository;
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [{ ...legacy, ...(scenario === "invalid" ? { projectId: "invalid" } : {}) }] } }));
    const { createWorkerGitManager } = await vi.importActual<typeof import("../../../src/commands/worker/worktrees.js")>("../../../src/commands/worker/worktrees.js");
    const { createWorkerCoordinator } = await vi.importActual<typeof import("../../../src/commands/worker/coordinator.js")>("../../../src/commands/worker/coordinator.js");
    const { migrateLegacyWorktrees } = await import("../../../src/commands/worker/worktrees/migration.js");
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.homeDirectory, "git-temp"), prepareFormat: async (_project, repo, operation) => {
      await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation,
        sources: { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] } });
    } });
    await mkdir(f.repository.path);
    const run = (args: string[]) => execFileSync("git", args, { cwd: f.repository.path, stdio: "pipe", timeout: 10000 });
    run(["init", "--initial-branch=main"]); run(["-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "seed"]); run(["remote", "add", "origin", remoteUrl]);
    const owner = { projectId: scenario === "foreign" ? uuid(9) : uuid(1), taskId: uuid(20), claimId: uuid(21), worktreeId: uuid(22) };
    run(["branch", `daynight/${owner.taskId}`]);
    const op = createOperation();
    try {
      const project = { projectId: owner.projectId, repoUrl: remoteUrl, localPath: f.repository.path };
      await git.prepareRepository(project, op);
      const binding = await git.prepareWorktree(project, owner, op);
      execFileSync("git", ["checkout", "-b", "changed-branch"], { cwd: binding.worktreePath, stdio: "pipe", timeout: 10000 });
    } finally { op.dispose(); }
    mocks.git.mockReturnValue(git);
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(desired([uuid(1)], 2)));
    const base = { type: "task", parentId: null, projectId: uuid(1), id: uuid(30), title: "healthy", status: "todo", ready: true, allowAgents: true, requiredPlatform: null, assignedTo: uuid(6), version: 1n, properties: {}, dependsOn: [], externalDependsOn: [], blockedBy: [], createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
    const current = { ...base, id: owner.taskId, status: "in_progress", ready: false, properties: { worker: { workerId, userId: uuid(6), claimId: owner.claimId, worktreeId: owner.worktreeId, machine: { id: uuid(7), name: "fixture" }, platform: "macos", agent: "codex", agentControlMode: "herdr", state: "active", phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-10T00:00:00Z" } } };
    remote.ownInventory = vi.fn(async () => ({ tasks: scenario === "known" ? [current] : [], coveredProjectIds: [uuid(1)], unavailableProjectIds: [] }));
    remote.candidates = vi.fn(async function* () { yield base; });
    remote.claim = vi.fn(async () => { cancellation.abort(); throw new Error("Grant deliberately unconfirmed"); });
    const tasks = { pendingStops: () => [], listResources: async () => [] };
    const native = { tasks, ensureInstance: async () => {}, stopInstance: async () => ({ stopped: true }), attachment: {} };
    mocks.herdr.mockReturnValue(native);
    const durable = vi.spyOn(durableHerdr, "createDurableWorkerHerdr").mockReturnValue(native as unknown as ReturnType<typeof durableHerdr.createDurableWorkerHerdr>);
    let configurationComplete = false, cycles = 0;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      const actual = createWorkerCoordinator({ ...options, hasHerdrJournal: false });
      const tick = actual.tick;
      actual.tick = async () => {
        await tick(); cycles++;
        configurationComplete = options.configurationComplete!();
        if (configurationComplete && scenario !== "known") cancellation.abort();
      };
      return actual;
    });
    const { running } = start(f, { signal: cancellation.signal });
    try {
      if (scenario === "known") await vi.waitFor(() => expect(remote.claim).toHaveBeenCalledOnce(), { timeout: 6000 });
      else if (scenario === "unproven") await vi.waitFor(() => expect(configurationComplete).toBe(true), { timeout: 6000 });
      else await vi.waitFor(() => { expect(cycles).toBeGreaterThan(0); expect(mocks.emit.mock.calls.some(([event]) => event.message.includes("Local resource mapping"))).toBe(true); }, { timeout: 6000 });
      if (scenario !== "known") expect(remote.claim).not.toHaveBeenCalled();
      if (scenario === "foreign" || scenario === "invalid") expect(configurationComplete).toBe(false);
      expect(await readFile(path.join(f.repository.path, ".worktrees", "daynight", owner.worktreeId, ".git"), "utf8")).toContain("gitdir:");
    } finally { cancellation.abort(); await running; durable.mockRestore(); await git.dispose(); }
  }, 12000);
});
