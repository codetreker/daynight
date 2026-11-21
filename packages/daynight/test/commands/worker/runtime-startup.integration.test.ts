import { receivedReceipt, receivedResource } from "../../helpers/worker-received-configuration.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { execFileSync } from "node:child_process";
import * as childProcesses from "node:child_process";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { webExecutionStoreFormat } from "../../../src/commands/worker/backends/web-store-format.js";
import { workerStoreFormat } from "../../../src/commands/worker/store-format.js";
import path from "node:path";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import Database from "better-sqlite3";
import * as configurationFiles from "../../../src/config/files.js";
import * as configurationSource from "../../../src/commands/worker/configuration-source.js";
import * as cloudConfiguration from "../../../src/commands/worker/configuration.js";
import * as configurationCache from "../../../src/commands/worker/configuration-cache.js";
import * as workerIdentity from "../../../src/commands/worker/identity.js";
import * as atomicFiles from "../../../src/platform/files.js";
import { hasUnconfirmedOwnedCommandCleanup, runOwnedCommand } from "../../../src/commands/worker/owned-command.js";
import { currentOwnedCommandLifecycle, retainedOwnedCommandBoundaries, withOwnedCommandLifecycle, type OwnedCommandLifecycleSink } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { withinExecutionDeadline } from "../../../src/commands/worker/execution-scope.js";
import * as reviewerHost from "../../../src/commands/worker/reviewer-host.js";
import * as botReconciliation from "../../../src/commands/worker/bots/reconciliation.js";
import * as directoryBrowsing from "../../../src/commands/worker/read-only/directory.js";
import * as webStores from "../../../src/commands/worker/backends/web-store.js";
import * as monitoringObservers from "../../../src/commands/worker/monitoring/observer.js";
import * as workerDiagnostics from "../../../src/commands/worker/diagnostics.js";
import * as reconcileWake from "../../../src/commands/worker/reconcile-wake.js";
import * as grantRenewal from "../../../src/commands/worker/backends/grant-renewal.js";
import { createNativeSelectionVerifier } from "../../../src/commands/worker/native-selection.js";
import { BotCliProbeCleanupError, createBotCliProbe, retainedBotCliProbes } from "../../../src/commands/worker/bots/cli-probe.js";
import { ApiError } from "../../../src/api/client.js";
import { createOperation } from "../../../src/api/operation.js";
import type { WorkerCloudDesired, ReceivedWorkerConfigurationResource } from "../../../src/api/worker-configuration.js";
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
const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), reporter: vi.fn(), probe: vi.fn(), emit: vi.fn(), bots: vi.fn(), hostCollector: vi.fn(), reviewer: vi.fn<(options: { signal: AbortSignal }) => Promise<void>>(), reviewerStopped: vi.fn(), nextUUID: null as (() => string) | null }));
// The startup fixture controls Task dependencies; the independent reviewer host has its own tests.
vi.mock("../../../src/commands/worker/reviewer-host.js", async original => ({ ...await original<object>(), runReviewerHost: mocks.reviewer }));
vi.mock("node:timers/promises", async original => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: (options?: Parameters<typeof actual.randomUUID>[0]) => mocks.nextUUID === null ? actual.randomUUID(options) : mocks.nextUUID() };
});
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => {
  const { createWorkerToolSelectionFixture } = await import("../../helpers/worker-tool-runtime-fixture.js");
  return { createWorkerToolSelectionRuntime: createWorkerToolSelectionFixture };
});
vi.mock("../../../src/commands/worker/bots/runtime.js", () => ({ createManagedAssistantRuntime: mocks.bots }));
vi.mock("../../../src/commands/worker/bots/host-capabilities.js", () => ({ createAssistantHostCollector: mocks.hostCollector }));
vi.mock("../../../src/commands/worker/reporter.js", () => ({ createWorkerReporter: mocks.reporter }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", async original => ({ ...await original<object>(), createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/native-version.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
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
  value: { toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" } }, maxConcurrent, pollIntervalMs: 1000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "cloud-model", args: [] }, projects: projects.map(projectId => ({ projectId, nativeOverrides: {} })) },
});
const resource = (target: WorkerCloudDesired | null): ReceivedWorkerConfigurationResource => (receivedResource({ desired: target, observationRevision: "0", observation: null }));
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
// Poll real I/O without advancing the configuration manager's retry clock.
const eventuallyWithoutAdvancingTime = async (check: () => void): Promise<void> => {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try { check(); return; }
    catch (error) { if (performance.now() >= deadline) throw error; }
    await delay(10);
  }
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
  mocks.reviewer.mockImplementation(async ({ signal }) => {
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    mocks.reviewerStopped();
  });
  mocks.nextUUID = null;
  mocks.emit.mockReset();
  mocks.bots.mockReturnValue({ closeAdmission: () => {}, snapshot: () => ({}), run: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) });
  mocks.hostCollector.mockReturnValue({ collect: vi.fn(async () => undefined), close: vi.fn(async () => {}) });
  mocks.reporter.mockImplementation(reporter);
  mocks.remote.mockReturnValue({
    currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => resource(desired())),
    resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
    project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })),
    reportConfiguration: vi.fn(), report: vi.fn(),
  });
  mocks.git.mockReturnValue(Object.assign({ prepareRepository: vi.fn(async () => {}), dispose: vi.fn(async () => {}), listWorktrees: vi.fn(async () => []) }, { scanWorktrees: scanFromList }));
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
  it("does not implicitly rebuild after an ordinary run settles its original journal boundary", async () => {
    const f = await fixture();
    mocks.reviewer.mockImplementationOnce(async () => {
      const sink = currentOwnedCommandLifecycle()!;
      await sink({ resourceId: uuid(90), sequence: 1, stage: "prepared", proof: null });
      await sink({ resourceId: uuid(90), sequence: 2, stage: "unknown", proof: null });
      await sink({ resourceId: uuid(90), sequence: 3, stage: "stopped", proof: null });
    });
    const { cancellation, running } = start(f);
    let joined = false;
    void running.then(() => { joined = true; }, () => { joined = true; });
    try {
      await vi.waitFor(() => expect(joined).toBe(true));
      await running;
      expect(cancellation.signal.aborted).toBe(false);
      expect(mocks.reviewer).toHaveBeenCalledOnce();
      const files = await readdir(path.join(f.paths.workerDirectory, "execution-resources"));
      const records = await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(f.paths.workerDirectory, "execution-resources", file), "utf8"))));
      expect(records).toEqual([expect.objectContaining({ generation: "1", event: { resourceId: uuid(90), sequence: 3, stage: "stopped", proof: null } })]);
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally { cancellation.abort(); await Promise.allSettled([running]); }
  });

  it("joins a Bot's ordinary cancellation without recording it as a background failure", async () => {
    const f = await fixture(false, false);
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    const run = vi.fn(async (signal: AbortSignal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason;
    });
    mocks.bots.mockReturnValue({ closeAdmission: () => {}, snapshot: () => ({}), run, shutdown: async () => {} });
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      cancellation.abort();
      await running;
      expect(mocks.emit.mock.calls.some(([event]) => event.message.includes("stopped after an owner failure"))).toBe(false);
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally { cancellation.abort(); await Promise.allSettled([running]); }
  });

  it("preserves the original journal save failure when a joined Bot rejects with the scope cancellation reason", async () => {
    const f = await fixture(false, false), failure = new Error("The original Bot reservation write failed.");
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    const directory = path.join(f.paths.workerDirectory, "execution-resources"), replace = atomicFiles.replaceFileAtomically;
    let failed = false, sameReason = false;
    const saving = vi.spyOn(atomicFiles, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
      if (path.dirname(file) === directory && !failed) { failed = true; throw failure; }
      await replace(file, text, ...rest);
    });
    mocks.bots.mockReturnValue({ closeAdmission: () => {}, snapshot: () => ({}), run: async (signal: AbortSignal) => {
      const sink = currentOwnedCommandLifecycle()!;
      const prepared = { resourceId: uuid(91), sequence: 1, stage: "prepared" as const, proof: null };
      try { await sink(prepared); }
      catch (error) {
        sameReason = signal.aborted && signal.reason === error;
        await sink(prepared);
        await sink({ ...prepared, sequence: 2, stage: "stopped" });
        throw error;
      }
    }, shutdown: async () => {} });
    const { cancellation, running } = start(f);
    try {
      await expect(running).rejects.toBe(failure);
      expect(sameReason).toBe(true);
      expect(mocks.bots).toHaveBeenCalledOnce();
      const files = await readdir(directory);
      const records = await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
      expect(records).toEqual([expect.objectContaining({ generation: "1", event: { resourceId: uuid(91), sequence: 2, stage: "stopped", proof: null } })]);
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally { cancellation.abort(); await Promise.allSettled([running]); saving.mockRestore(); }
  });

  it.each([false, true])("preserves a real grant inventory failure and rebuilds only when explicitly requested (rebuild: %s)", async rebuild => {
    const f = await fixture(), failure = new Error("The original Controller grant inventory could not be read.");
    const maintain = grantRenewal.maintainWorkerControllerGrants;
    const renewal = vi.spyOn(grantRenewal, "maintainWorkerControllerGrants").mockImplementationOnce(options => maintain({
      ...options, store: { listUnfinishedTasks: () => { throw failure; } },
    }));
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { cancellation, running } = start(f, rebuild ? { onExecutionScope: control => { controls.push(control); } } : {});
    let result: { error: unknown } | { completed: true } | undefined;
    void running.then(() => { result = { completed: true }; }, error => { result = { error }; });
    try {
      if (rebuild) {
        await vi.waitFor(() => expect(controls[0]?.snapshot().stopped).toBe(true));
        expect(result).toBeUndefined();
        expect(renewal).toHaveBeenCalledOnce();
        expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
        const lock = await readFile(f.paths.lockFile, "utf8");
        controls[0]!.rebuild();
        await vi.waitFor(() => { expect(controls).toHaveLength(2); expect(renewal).toHaveBeenCalledTimes(2); });
        expect(controls[1]!.generation).toBe("2");
        expect(renewal.mock.calls[1]![0].signal).not.toBe(renewal.mock.calls[0]![0].signal);
        expect(await readFile(f.paths.lockFile, "utf8")).toBe(lock);
        cancellation.abort();
      }
      await vi.waitFor(() => expect(result).toEqual({ error: failure }));
      expect(renewal).toHaveBeenCalledTimes(rebuild ? 2 : 1);
      await expect(running).rejects.toBe(failure);
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally { cancellation.abort(); await Promise.allSettled([running]); renewal.mockRestore(); }
  });

  it("rebuilds after a joined initialization failure while retaining the lock and the original exit error", async () => {
    const f = await fixture(), failure = new Error("Worker identity read was temporarily unavailable.");
    let originalSignal: AbortSignal | undefined, originalLock: string | undefined;
    const identity = vi.spyOn(workerIdentity, "ensureWorkerIdentity").mockImplementationOnce(async (paths, signal) => {
      originalSignal = signal;
      originalLock = await readFile(resolveWorkerPaths(f.homeDirectory).lockFile, "utf8");
      throw failure;
    });
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { cancellation, running } = start(f, { onExecutionScope: control => { controls.push(control); } });
    try {
      await vi.waitFor(() => expect(controls[0]?.snapshot().stopped).toBe(true));
      expect(originalSignal?.aborted).toBe(true);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(mocks.coordinator).not.toHaveBeenCalled();
      controls[0]!.rebuild();
      await vi.waitFor(() => { expect(controls).toHaveLength(2); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const next = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      expect(controls[1]!.generation).toBe("2");
      expect(next.signal).not.toBe(originalSignal);
      expect(next.signal!.aborted).toBe(false);
      expect(await readFile(f.paths.lockFile, "utf8")).toBe(originalLock);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
    } finally {
      cancellation.abort();
      try { await expect(running).rejects.toBe(failure); } finally { identity.mockRestore(); }
    }
    const released = await tryAcquireWorkerInstanceLock(f.paths);
    expect(released).not.toBeNull(); await released!.release();
  });

  it.each(["failure", "success"] as const)("joins a pending startup lock after waiter cancellation and retains its original %s", async outcome => {
    const f = await fixture(), failure = Object.assign(new Error("Worker lock write failed."), { code: "EIO" });
    const locks = await import("../../../src/commands/worker/instance-lock.js"), acquire = locks.acquireWorkerInstanceLock;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const acquiring = vi.spyOn(locks, "acquireWorkerInstanceLock").mockImplementationOnce(async paths => {
      entered.resolve();
      await release.promise;
      if (outcome === "failure") throw failure;
      return acquire(paths);
    });
    let control: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl | undefined;
    let joined = false;
    const { cancellation, running } = start(f, { onExecutionScope: value => { control = value; } });
    void running.then(() => { joined = true; }, () => { joined = true; });
    try {
      await entered.promise;
      cancellation.abort();
      await vi.waitFor(() => expect(control?.snapshot().admission).toBe("closed"));
      expect(control!.snapshot().resources.find(resource => resource.resourceId === "startup"))
        .toMatchObject({ result: null, detail: { settled: false } });
      expect(joined).toBe(false);
      release.resolve();
      if (outcome === "failure") await expect(running).rejects.toBe(failure);
      else await running;
      expect(control!.snapshot().stopped).toBe(true);
      expect(acquiring).toHaveBeenCalledOnce();
      expect(mocks.remote).not.toHaveBeenCalled();
      expect(mocks.coordinator).not.toHaveBeenCalled();
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally { release.resolve(); cancellation.abort(); await Promise.allSettled([running]); acquiring.mockRestore(); }
  });

  it("reports an initialization failure on ordinary exit after releasing its original lock", async () => {
    const f = await fixture(), failure = new Error("Worker identity read failed.");
    const identity = vi.spyOn(workerIdentity, "ensureWorkerIdentity").mockImplementationOnce(async () => {
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      throw failure;
    });
    try { await expect(runWorker(f)).rejects.toBe(failure); } finally { identity.mockRestore(); }
    const released = await tryAcquireWorkerInstanceLock(f.paths);
    expect(released).not.toBeNull(); await released!.release();
  });

  it("retains the management lock after a close deadline until the original reporter joins", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const stop = vi.fn(async () => { entered.resolve(); await release.promise; });
    mocks.reporter.mockImplementation(() => ({ ...reporter(), stop }));
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { cancellation, running } = start(f, { onExecutionScope: control => { controls.push(control); } });
    try {
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      expect((await controls[0]!.stop()).every(result => result.stop === "confirmed")).toBe(true);
      controls[0]!.rebuild(); await entered.promise;
      await expect(running).rejects.toThrow("owner stop deadline elapsed");
      expect(controls).toHaveLength(1);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(stop).toHaveBeenCalledOnce();
      release.resolve();
      let released: Awaited<ReturnType<typeof tryAcquireWorkerInstanceLock>>;
      await vi.waitFor(async () => { released = await tryAcquireWorkerInstanceLock(f.paths); expect(released).not.toBeNull(); });
      await released!.release();
      expect(stop).toHaveBeenCalledOnce();
    } finally { release.resolve(); cancellation.abort(); await Promise.allSettled([running]); }
  }, 20_000);

  it.each([false, true])("reports historical diagnostic output failure after releasing the original root (rebuild: %s)", async rebuild => {
    const f = await fixture(), failure = new Error("Foreground diagnostic output failed.");
    const actual = await vi.importActual<typeof import("../../../src/commands/worker/diagnostics.js")>("../../../src/commands/worker/diagnostics.js");
    const sinks: Awaited<ReturnType<typeof actual.createWorkerDiagnostics>>[] = [];
    const creating = vi.spyOn(workerDiagnostics, "createWorkerDiagnostics").mockImplementation(async options => {
      const sink = await actual.createWorkerDiagnostics(options); sinks.push(sink); return sink;
    });
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    let outputFailed = false;
    const { cancellation, running } = start(f, { onExecutionScope: value => { controls.push(value); }, log: message => {
      if (!outputFailed && message.includes("Controlled foreground failure.")) { outputFailed = true; throw failure; }
    } });
    try {
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      sinks[0]!.emit({ kind: "foreground-failure", message: "Controlled foreground failure." });
      const original = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      const lockText = await readFile(f.paths.lockFile, "utf8");
      expect(outputFailed).toBe(true); expect(sinks[0]!.isClosed()).toBe(false);
      if (rebuild) {
        expect((await controls[0]!.stop()).every(result => result.stop === "confirmed")).toBe(true);
        controls[0]!.rebuild();
        await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalledTimes(2));
        expect(controls[1]!.generation).toBe("2");
        expect(sinks[0]!.isClosed()).toBe(true);
        expect((mocks.coordinator.mock.calls[1]![0] as WorkerCoordinatorOptions).signal).not.toBe(original.signal);
        expect(await readFile(f.paths.lockFile, "utf8")).toBe(lockText);
        expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      }
      cancellation.abort(); await expect(running).rejects.toBe(failure);
      expect(sinks.every(sink => sink.isClosed())).toBe(true);
      expect(() => original.store.listTasks()).toThrow();
      const released = await tryAcquireWorkerInstanceLock(f.paths);
      expect(released).not.toBeNull(); await released!.release();
    } finally { cancellation.abort(); await Promise.allSettled([running]); creating.mockRestore(); }
  });

  it("retains the root through the diagnostic close deadline until its original file handle joins", async () => {
    const f = await fixture(), release = Promise.withResolvers<void>();
    const createWake = reconcileWake.createReconcileWake;
    let polling = false, appending = false;
    const waking = vi.spyOn(reconcileWake, "createReconcileWake").mockImplementation(() => {
      const wake = createWake();
      return { ...wake, waitAfter: async (revision, _delayMs, signal) => {
        const waiting = wake.waitAfter(revision, 60_000, signal);
        if (revision === wake.snapshot() && !signal.aborted) polling = true;
        try { await waiting; } finally { polling = false; }
      } };
    });
    const actual = await vi.importActual<typeof import("../../../src/commands/worker/diagnostics.js")>("../../../src/commands/worker/diagnostics.js");
    let sink: Awaited<ReturnType<typeof actual.createWorkerDiagnostics>> | undefined;
    let handleClosed = false, close: ReturnType<typeof vi.spyOn> | undefined;
    const creating = vi.spyOn(workerDiagnostics, "createWorkerDiagnostics").mockImplementation(async options => {
      sink = await actual.createWorkerDiagnostics({ ...options, files: {
        ensureDirectory: async directory => { await mkdir(directory, { recursive: true }); },
        createSegment: async filename => { await writeFile(filename, "", { flag: "wx" }); },
        appendRecord: async (filename, line) => {
          const handle = await open(filename, "a");
          const held = line.includes('"kind":"held-close"');
          try {
            if (held) { appending = true; await release.promise; }
            await handle.writeFile(line);
          }
          finally { await handle.close(); if (held) handleClosed = true; }
        },
      } });
      close = vi.spyOn(sink, "close"); return sink;
    });
    let control: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl | undefined;
    const { cancellation, running } = start(f, { onExecutionScope: value => { control = value; } });
    let joined = false;
    void running.then(() => { joined = true; }, () => { joined = true; });
    try {
      // The held append must belong to management close, after the running
      // loop's ordinary flush has joined and its real poll wait has started.
      await vi.waitFor(() => expect(polling).toBe(true));
      handleClosed = false;
      sink!.emit({ kind: "held-close", message: "Hold the original diagnostic append." });
      const stopping = control!.stop();
      await vi.waitFor(() => expect(appending).toBe(true));
      expect((await stopping).every(result => result.stop === "confirmed")).toBe(true);
      control!.rebuild();
      await vi.waitFor(() => expect(joined).toBe(true), { timeout: 15_000 });
      await expect(running).rejects.toThrow("owner stop deadline elapsed");
      expect(sink!.isClosed()).toBe(false); expect(handleClosed).toBe(false);
      expect(close).toHaveBeenCalledOnce();
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(mocks.coordinator).toHaveBeenCalledOnce();
      release.resolve();
      let released: Awaited<ReturnType<typeof tryAcquireWorkerInstanceLock>>;
      await vi.waitFor(async () => { released = await tryAcquireWorkerInstanceLock(f.paths); expect(released).not.toBeNull(); });
      await released!.release();
      expect(sink!.isClosed()).toBe(true); expect(handleClosed).toBe(true);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      release.resolve(); cancellation.abort();
      try {
        await vi.waitFor(() => expect(joined).toBe(true), { timeout: 5000 });
        await Promise.allSettled([running]);
        const closingSink = sink;
        if (closingSink !== undefined) await vi.waitFor(() => expect(closingSink.isClosed()).toBe(true), { timeout: 5000 });
      }
      finally { creating.mockRestore(); waking.mockRestore(); }
    }
  }, 20_000);

  it("retains management handles when a rejected diagnostic close has no completed closure receipt", async () => {
    const f = await fixture(), failure = new Error("Diagnostic writer closure remains unknown.");
    const close = vi.fn(async () => { throw failure; });
    const creating = vi.spyOn(workerDiagnostics, "createWorkerDiagnostics").mockResolvedValue({
      emit: mocks.emit, flush: async () => {}, close, isClosed: () => false, filename: "unconfirmed.jsonl",
    });
    const locks = await import("../../../src/commands/worker/instance-lock.js"), acquire = locks.acquireWorkerInstanceLock;
    let originalLock: Awaited<ReturnType<typeof acquire>> | undefined;
    const acquiring = vi.spyOn(locks, "acquireWorkerInstanceLock").mockImplementation(async paths => originalLock = await acquire(paths));
    const { cancellation, running } = start(f);
    let store: WorkerStore | undefined;
    try {
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      store = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).store;
      cancellation.abort(); await expect(running).rejects.toBe(failure);
      expect(close).toHaveBeenCalledOnce(); expect(store.listTasks()).toEqual([]);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
    } finally {
      cancellation.abort(); await Promise.allSettled([running]);
      // The synthetic owner has no close proof; only this fixture releases its
      // captured handles, after asserting that production retained them.
      store?.close(); await originalLock?.release(); creating.mockRestore(); acquiring.mockRestore();
    }
  });

  it("reconciles the original non-Git command through management control before rebuilding", async () => {
    const f = await fixture(), marker = path.join(f.homeDirectory, "command-runs");
    const saveFailure = new Error("Original command stop receipt could not be saved.");
    const directory = path.join(f.paths.workerDirectory, "execution-resources"), replace = atomicFiles.replaceFileAtomically;
    let rejectStop = true;
    let originalSink: OwnedCommandLifecycleSink | undefined;
    const reviewerClosure = vi.spyOn(reviewerHost, "reconcileReviewerHostFailure").mockImplementation(async error => {
      // This fixture owns only its real command; production Reviewer closure
      // separately proves its coordinator, database and instance lock.
      if (hasUnconfirmedOwnedCommandCleanup(error)) throw error;
    });
    const saving = vi.spyOn(atomicFiles, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
      if (path.dirname(file) === directory && JSON.parse(String(text)).event.stage === "stopped" && rejectStop) throw saveFailure;
      return replace(file, text, ...rest);
    });
    mocks.reviewer.mockImplementationOnce(async ({ signal }) => {
      originalSink = currentOwnedCommandLifecycle();
      const operation = createOperation({ signal, limits: { totalMs: 20_000, requestMs: 20_000 } });
      try {
        await runOwnedCommand({ file: process.execPath, args: ["--input-type=module", "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'once\\n');`], environment: process.env }, operation);
      } finally { operation.dispose(); }
    });
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { cancellation, running } = start(f, { onExecutionScope: control => { controls.push(control); } });
    try {
      await vi.waitFor(() => expect(controls[0]?.snapshot().resources.find(entry => entry.resourceId === "native-inventory")?.result?.stop).toBe("unknown"), { timeout: 10_000 });
      expect(controls[0]!.snapshot().stopped).toBe(false);
      expect(() => controls[0]!.rebuild()).toThrow("original resources");
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      const refused = createOperation();
      try {
        await expect(withOwnedCommandLifecycle(originalSink!, () => runOwnedCommand({ file: process.execPath,
          args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)},'unexpected');`], environment: process.env }, refused))).rejects.toThrow();
      } finally { refused.dispose(); }
      rejectStop = false;
      await controls[0]!.reconcile();
      // A sibling owner may have observed its old rejection before the native
      // owner confirmed the same boundary during the first reconciliation.
      if (!controls[0]!.snapshot().stopped) await controls[0]!.reconcile();
      expect(controls[0]!.snapshot().stopped).toBe(true);
      const saved = await Promise.all((await readdir(directory)).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ generation: "1", identity: { serverOrigin: origin, workerId }, event: { stage: "stopped" } });
      controls[0]!.rebuild();
      await vi.waitFor(() => { expect(controls).toHaveLength(2); expect(mocks.reviewer).toHaveBeenCalledTimes(2); });
      expect(await readFile(marker, "utf8")).toBe("once\n");
    } finally {
      rejectStop = false; cancellation.abort();
      try { await expect(running).rejects.toMatchObject({ errors: expect.arrayContaining([saveFailure, expect.objectContaining({ name: "OwnedCommandCleanupError" })]) }); }
      finally { saving.mockRestore(); reviewerClosure.mockRestore(); }
    }
  }, 30_000);

  it("reconciles a probe's original prepared reservation after scope admission closes", async () => {
    const f = await fixture(), verifier = createNativeSelectionVerifier();
    const saveFailure = new Error("Original probe reservation could not be saved.");
    const directory = path.join(f.paths.workerDirectory, "execution-resources"), replace = atomicFiles.replaceFileAtomically;
    let failPrepared = true, originalFailure: unknown, originalSink: OwnedCommandLifecycleSink | undefined;
    const saving = vi.spyOn(atomicFiles, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
      if (path.dirname(file) === directory && JSON.parse(String(text)).event.stage === "prepared" && failPrepared) throw saveFailure;
      await replace(file, text, ...rest);
    });
    const reviewerClosure = vi.spyOn(reviewerHost, "reconcileReviewerHostFailure").mockImplementation(async () => {
      // This fixture's reviewer owns the real selection verifier only.
      await verifier.close();
    });
    mocks.reviewer.mockImplementationOnce(async ({ signal }) => {
      originalSink = currentOwnedCommandLifecycle();
      const operation = createOperation({ signal });
      try {
        await verifier.verify({ native: { agent: "codex", model: "model", args: [] }, cwd: f.homeDirectory, environment: process.env }, operation);
      } catch (error) { originalFailure = error; throw error; }
      finally { operation.dispose(); }
    });
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { cancellation, running } = start(f, { onExecutionScope: value => { controls.push(value); } });
    try {
      await vi.waitFor(() => expect(controls[0]?.snapshot().resources.find(entry => entry.resourceId === "reviewer")?.result?.stop).toBe("unknown"));
      const [probe] = retainedBotCliProbes();
      expect(probe).toMatchObject({ pid: null, process: null, targetStarted: false });
      expect(controls[0]!.snapshot().stopped).toBe(false);
      expect(() => controls[0]!.rebuild()).toThrow("original resources");
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      failPrepared = false;
      await controls[0]!.reconcile();
      if (!controls[0]!.snapshot().stopped) await controls[0]!.reconcile();
      expect(controls[0]!.snapshot().stopped).toBe(true);
      expect(retainedBotCliProbes()).toEqual([]);
      const saved = await Promise.all((await readdir(directory)).filter(file => file.endsWith(".json")).map(async file => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ generation: "1", event: { resourceId: probe!.launchId, stage: "stopped", proof: null } });
      const refused = createOperation();
      try {
        const error = await withOwnedCommandLifecycle(originalSink!, () => createBotCliProbe({ cwd: f.homeDirectory, environment: process.env }, refused)).catch(error => error);
        expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(BotCliProbeCleanupError);
        expect(retainedBotCliProbes()).toEqual([]);
      } finally { refused.dispose(); }
      controls[0]!.rebuild();
      await vi.waitFor(() => expect(controls).toHaveLength(2));
      expect(controls[1]!.generation).toBe("2");
    } finally {
      failPrepared = false; cancellation.abort();
      try { await expect(running).rejects.toMatchObject({ errors: expect.arrayContaining([saveFailure, originalFailure]) }); }
      finally { await verifier.close(); saving.mockRestore(); reviewerClosure.mockRestore(); }
    }
  });

  it("retains a pending startup constructor and cleans its late result before rebuilding", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const createManager = cloudConfiguration.createWorkerConfigurationManager;
    let stopManager: ReturnType<typeof vi.fn<() => Promise<void>>> | undefined;
    const constructing = vi.spyOn(cloudConfiguration, "createWorkerConfigurationManager").mockImplementationOnce(async options => {
      const manager = await createManager(options), stop = manager.stop;
      stopManager = vi.fn(stop); manager.stop = stopManager;
      entered.resolve(); await release.promise;
      return manager;
    });
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { cancellation, running } = start(f, { onExecutionScope: control => { controls.push(control); } });
    try {
      await entered.promise;
      expect(controls).toHaveLength(1);
      const originalLock = await readFile(f.paths.lockFile, "utf8");
      const results = await controls[0]!.stop({ deadline: Date.now() + 50 });
      expect(results).toContainEqual(expect.objectContaining({ resourceId: "startup", stop: "unknown", save: "failed" }));
      expect(stopManager).not.toHaveBeenCalled();
      expect(mocks.bots).not.toHaveBeenCalled();
      expect(controls[0]!.snapshot().stopped).toBe(false);
      expect(() => controls[0]!.rebuild()).toThrow("original resources");
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      release.resolve();
      await vi.waitFor(() => expect(stopManager).toHaveBeenCalledOnce());
      expect((await controls[0]!.reconcile()).every(result => result.stop === "confirmed")).toBe(true);
      expect(mocks.bots).not.toHaveBeenCalled();
      controls[0]!.rebuild();
      await vi.waitFor(() => { expect(controls).toHaveLength(2); expect(mocks.coordinator).toHaveBeenCalled(); });
      expect(await readFile(f.paths.lockFile, "utf8")).toBe(originalLock);
      expect((await controls[1]!.stop()).every(result => result.stop === "confirmed")).toBe(true);
    } finally { release.resolve(); cancellation.abort(); await running; constructing.mockRestore(); }
  });

  it("stops Tasks while directory work is joining and retains Controller storage until configuration joins", async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const createBrowser = directoryBrowsing.createWorkerDirectoryBrowser;
    const browser = createBrowser(), joinDirectory = browser.join;
    vi.spyOn(browser, "join").mockImplementation(async () => { entered.resolve(); await gate.promise; await joinDirectory(); });
    const browsing = vi.spyOn(directoryBrowsing, "createWorkerDirectoryBrowser").mockReturnValue(browser);
    const openWeb = webStores.openWebExecutionStore;
    let closeWeb: ReturnType<typeof vi.fn<() => void>> | undefined;
    const webStorage = vi.spyOn(webStores, "openWebExecutionStore").mockImplementation((...args) => {
      const store = openWeb(...args), close = store.close;
      closeWeb = vi.fn(close); store.close = closeWeb;
      return store;
    });
    let control: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl | undefined;
    const tasks = coordinator(async () => {}); mocks.coordinator.mockReturnValue(tasks);
    const { cancellation, running } = start(f, { onExecutionScope: value => { control = value; } });
    try {
      await vi.waitFor(() => { expect(control).toBeDefined(); expect(mocks.coordinator).toHaveBeenCalled(); });
      const stopping = control!.stop();
      await entered.promise;
      await vi.waitFor(() => expect(tasks.shutdown).toHaveBeenCalledOnce());
      expect(closeWeb).toBeDefined(); expect(closeWeb).not.toHaveBeenCalled();
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).store.listTasks()).toEqual([]);
      gate.resolve();
      expect((await stopping).every(result => result.stop === "confirmed")).toBe(true);
      expect(closeWeb).toHaveBeenCalledOnce();
      cancellation.abort(); await running;
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally { gate.resolve(); cancellation.abort(); await running; browsing.mockRestore(); webStorage.mockRestore(); }
  });

  it("keeps management reporting and the original lock while a stopped scope is blocked", async () => {
    const f = await fixture(false, false);
    mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
    let known = false;
    const runFailures: Error[] = [];
    const createObserver = monitoringObservers.createMonitoringObserver;
    const lifecycle = vi.fn();
    const observation = vi.spyOn(monitoringObservers, "createMonitoringObserver").mockImplementation((...args) => {
      const observer = createObserver(...args), setLifecycle = observer.setLifecycle;
      observer.setLifecycle = state => { lifecycle(state); setLifecycle(state); };
      return observer;
    });
    mocks.bots.mockReturnValue({ closeAdmission: () => {}, snapshot: () => ({}), run: async (signal: AbortSignal) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      const failure = new Error("Bot run joined after a failed stop observation.");
      runFailures.push(failure); throw failure;
    }, shutdown: async () => { if (!known) throw new Error("Original Bot boundary is unknown."); } });
    let control: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl | undefined;
    const { cancellation, running } = start(f, { onExecutionScope: value => { control = value; } });
    try {
      await vi.waitFor(() => { expect(control).toBeDefined(); expect(mocks.reporter).toHaveBeenCalled(); });
      expect((await control!.stop()).some(result => result.stop === "unknown")).toBe(true);
      expect(lifecycle).not.toHaveBeenCalledWith("stopped");
      const reportOptions = mocks.reporter.mock.calls[0]![0] as ReporterOptions;
      expect(reportOptions.signal.aborted).toBe(false);
      expect(reportOptions.executionActive!()).toBe(false);
      expect(mocks.reporter.mock.results[0]!.value.stop).not.toHaveBeenCalled();
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect(() => control!.rebuild()).toThrow("original resources");
      known = true;
      expect((await control!.reconcile()).every(result => result.stop === "confirmed")).toBe(true);
      control!.rebuild();
      await vi.waitFor(() => expect(control!.generation).toBe("2"));
    } finally {
      known = true; cancellation.abort();
      try {
        const failure = await running.catch(error => error);
        expect(runFailures.length).toBeGreaterThan(0);
        expect(failure instanceof AggregateError ? failure.errors : [failure]).toEqual(runFailures);
      } finally { observation.mockRestore(); }
    }
  });

  it("rebuilds execution scopes twice under the original management lock and database", async () => {
    const f = await fixture();
    const cancellation = new AbortController(); cancellations.add(cancellation);
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { running } = start(f, { signal: cancellation.signal, onExecutionScope: control => { controls.push(control); } });
    try {
      await vi.waitFor(() => expect(controls).toHaveLength(1));
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalled());
      const firstOptions = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
      // The coordinator can recover existing work while repository admission is still pending.
      await vi.waitFor(() => expect(firstOptions.store.getProject({ projectId: uuid(1) })).toMatchObject({
        projectId: uuid(1), repoUrl: remoteUrl, localPath: f.repository.path,
      }), { timeout: 5000, interval: 10 });
      const originalTask = firstOptions.store.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", agentControlMode: "web" });
      expect((await controls[0]!.stop()).every(result => result.stop === "confirmed")).toBe(true);
      expect(cancellation.signal.aborted).toBe(false);
      expect(firstOptions.signal!.aborted).toBe(true);
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      const lockBefore = await readFile(f.paths.lockFile, "utf8");
      controls[0]!.rebuild();
      await vi.waitFor(() => expect(controls).toHaveLength(2));
      await vi.waitFor(() => expect(mocks.coordinator).toHaveBeenCalledTimes(2));
      const secondOptions = mocks.coordinator.mock.calls[1]![0] as WorkerCoordinatorOptions;
      expect(secondOptions.signal).not.toBe(firstOptions.signal);
      expect(secondOptions.signal!.aborted).toBe(false);
      expect(secondOptions.store).toBe(firstOptions.store);
      expect(mocks.reviewer).toHaveBeenCalledTimes(2);
      expect(mocks.reviewer.mock.calls[0]![0].signal).toBe(firstOptions.signal);
      expect(mocks.reviewer.mock.calls[1]![0].signal).toBe(secondOptions.signal);
      expect(mocks.reviewerStopped).toHaveBeenCalledOnce();
      expect(await readFile(f.paths.lockFile, "utf8")).toBe(lockBefore);
      expect(secondOptions.store.getTask(originalTask)).toEqual(originalTask);
      expect((await controls[1]!.stop()).every(result => result.stop === "confirmed")).toBe(true);
      expect(cancellation.signal.aborted).toBe(false);
      controls[1]!.rebuild();
      await vi.waitFor(() => { expect(controls).toHaveLength(3); expect(mocks.coordinator).toHaveBeenCalledTimes(3); });
      const thirdOptions = mocks.coordinator.mock.calls[2]![0] as WorkerCoordinatorOptions;
      expect(thirdOptions.signal).not.toBe(secondOptions.signal);
      expect(thirdOptions.signal!.aborted).toBe(false);
      expect(thirdOptions.store).toBe(firstOptions.store);
      expect(thirdOptions.store.getTask(originalTask)).toEqual(originalTask);
      expect(await readFile(f.paths.lockFile, "utf8")).toBe(lockBefore);
      expect(mocks.reviewer).toHaveBeenCalledTimes(3);
      expect(mocks.reviewer.mock.calls[2]![0].signal).toBe(thirdOptions.signal);
      expect((await controls[2]!.stop()).every(result => result.stop === "confirmed")).toBe(true);
    } finally { cancellation.abort(); await running; }
  });

  it("retains the management lock and blocks rebuilding until a timed-out reviewer joins", async () => {
    const f = await fixture();
    const held = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>();
    mocks.reviewer.mockImplementation(async ({ signal }) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted.resolve();
      await held.promise;
      mocks.reviewerStopped();
    });
    let control: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl | undefined;
    const { cancellation, running } = start(f, { onExecutionScope: value => { control = value; } });
    try {
      await vi.waitFor(() => { expect(control).toBeDefined(); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const stopping = control!.stop({ deadline: Date.now() + 100 });
      await aborted.promise;
      expect(await stopping).toEqual(expect.arrayContaining([
        expect.objectContaining({ resourceId: "reviewer", ownerKind: "assistant", stop: "unknown", save: "failed" }),
      ]));
      expect(control!.snapshot().stopped).toBe(false);
      expect(() => control!.rebuild()).toThrow("original resources");
      expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
      expect((mocks.reporter.mock.calls[0]![0] as ReporterOptions).signal.aborted).toBe(false);
      expect(mocks.reviewer).toHaveBeenCalledOnce();
      held.resolve();
      expect((await control!.reconcile()).every(result => result.stop === "confirmed")).toBe(true);
      control!.rebuild();
      await vi.waitFor(() => { expect(control!.generation).toBe("2"); expect(mocks.reviewer).toHaveBeenCalledTimes(2); });
    } finally { held.resolve(); cancellation.abort(); await running; }
  });

  it("starts the reviewer with the Worker identity and waits for its shutdown", async () => {
    const f = await fixture();
    let release!: () => void, observedAbort!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const aborted = new Promise<void>(resolve => { observedAbort = resolve; });
    mocks.reviewer.mockImplementation(async ({ signal }) => {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      observedAbort();
      await held;
      mocks.reviewerStopped();
    });
    const { cancellation, running } = start(f);
    let finished = false;
    void running.then(() => { finished = true; }, () => { finished = true; });
    try {
      await vi.waitFor(() => expect(mocks.reviewer).toHaveBeenCalledOnce());
      expect(mocks.reviewer.mock.calls[0]![0]).toMatchObject({ homeDirectory: f.homeDirectory, packageDirectory: f.packageDirectory,
        serverOrigin: origin, userId: uuid(6), workerId, signal: expect.any(AbortSignal) });
      cancellation.abort();
      await aborted;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(mocks.reviewerStopped).not.toHaveBeenCalled();
      expect(finished).toBe(false);
      release();
      await running;
      expect(mocks.reviewerStopped).toHaveBeenCalledOnce();
    } finally { release(); cancellation.abort(); await Promise.allSettled([running]); }
  });
  it.each(["configuration", "telemetry"] as const)("keeps Bot recovery closed until a matching machine %s report is confirmed", async channel => {
    const f = await fixture(), remote = mocks.remote(); mocks.remote.mockClear();
    let options: ReporterOptions | undefined, canSubmit: (() => boolean) | undefined;
    const createReconciliation = botReconciliation.createBotReconciliation;
    const observation = vi.spyOn(botReconciliation, "createBotReconciliation").mockImplementation(value => {
      canSubmit = value.canSubmit; return createReconciliation(value);
    });
    mocks.reporter.mockImplementation((value: ReporterOptions) => { options = value; return reporter(); });
    const { cancellation, running } = start(f);
    const operation = createOperation();
    try {
      await vi.waitFor(() => { expect(options).toBeDefined(); expect(mocks.coordinator).toHaveBeenCalled(); });
      expect(mocks.bots.mock.results[0]!.value.run).toHaveBeenCalled();
      expect(canSubmit?.()).toBe(false);
      const machine = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).machine;
      const report = { ...reportSample, machine };
      const captured = await prepareConfiguration(options!);
      const receipt = { observedAt: report.sampledAt, lastReportedAt: report.sampledAt,
        configuration: receivedReceipt({ desired: desired(), observationRevision: "0", observationAccepted: false }) };
      const send = channel === "configuration" ? remote.reportConfiguration : remote.report;
      const submit = (input = report) => channel === "configuration"
        ? options!.configuration!.send(input, captured, operation)
        : options!.send(input, operation);
      send.mockResolvedValueOnce(receipt);
      await submit({ ...report, machine: { ...machine, id: uuid(999) } });
      expect(canSubmit?.()).toBe(false);
      const unknown = new ApiError({ operation: "worker.configuration.report" }, "request", { cause: new Error("Report acknowledgement was lost") });
      send.mockRejectedValueOnce(unknown);
      await expect(submit()).rejects.toBe(unknown);
      expect(canSubmit?.()).toBe(false);
      const acknowledgement = Promise.withResolvers<typeof receipt>();
      send.mockImplementationOnce(() => acknowledgement.promise);
      const pending = submit();
      expect(canSubmit?.()).toBe(false);
      acknowledgement.resolve(receipt);
      await pending;
      // The remote acknowledgement suffices before any local configuration accept.
      expect(canSubmit?.()).toBe(true);
    } finally { operation.dispose(); cancellation.abort(); try { await running; } finally { observation.mockRestore(); } }
  });

  it("continues retained-project reconciliation with bounded observations and after restart", async () => {
    const f = await fixture(true, false), target = { ...desired([]), revision: "2" }, ids = [uuid(10_000), uuid(10_001)];
    for (const [n, projectId] of ids.entries()) f.store!.registerProject({ projectId, repoUrl: `https://git.example/team/repo${n}.git`, localPath: path.join(f.homeDirectory, `repo${n}`) });
    const stored = (key: Record<string, string>, appliedValue: unknown) => ({ value: { key, targetRevision: "1", appliedValue, state: "applied", error: null, lastFailure: null, nextAttemptAt: null }, attempts: 0, failureId: null, started: false });
    const items = [stored({ kind: "maxConcurrent" }, 1), stored({ kind: "pollIntervalMs" }, 1000), stored({ kind: "recoveryLimit" }, 3), stored({ kind: "preferPlatformSpecificTasks" }, false), stored({ kind: "native" }, target.value.native)];
    for (let n = 0; n < 1019; n++) items.push(stored({ kind: "projectRemoval", projectId: uuid(20_000 + n) }, true));
    const { agentControlMode: _mode, toolPaths: _tools, ...historicalValue } = target.value;
    await writeFile(f.paths.configurationFile, JSON.stringify({ schemaVersion: 2, identity: { serverOrigin: origin, userId: uuid(6), workerId }, desired: { ...target, revision: "1", value: historicalValue }, observationRevision: "0", nextFailureId: 1, items }));
    let revision = 0n, reporterOptions: ReporterOptions | undefined;
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => (receivedResource({ desired: target, observationRevision: String(revision), observation: null })));
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
            expect(saved.schemaVersion).toBe(11);
            expect(JSON.parse(saved.authority.desiredJson!)).toEqual(target);
            if (pass === 0) expect(saved.currentItems).toHaveLength(1026);
            for (const projectId of ids) expect(saved.currentItems.find(item => item.value.key.kind === "projectRemoval" && item.value.key.projectId === projectId)?.value.state).toBe("applied");
            const items = reporterOptions!.configuration!.capture(reportSample).observation!.items;
            expect(items.length).toBeLessThanOrEqual(1026);
            expect(items.filter(item => item.key.kind !== "agentControlMode").length).toBeLessThanOrEqual(1025);
          }, { timeout: 10_000, interval: 50 });
          const acknowledged = new Set<string>();
          let remaining = 0;
          for (let batch = 0; batch < 3; batch++) {
            const sent = reporterOptions!.configuration!.capture(reportSample);
            expect(sent.observation!.items.length).toBeLessThanOrEqual(1026);
            expect(sent.observation!.items.filter(item => item.key.kind !== "agentControlMode").length).toBeLessThanOrEqual(1025);
            for (const item of sent.observation!.items) if (item.key.kind === "projectRemoval" && item.state === "applied") acknowledged.add(item.key.projectId);
            const operation = createOperation();
            try { await reporterOptions!.configuration!.accept(sent, receivedReceipt({ desired: target, observationRevision: String(++revision), observationAccepted: true }), operation); }
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
    const { agentControlMode: _mode, toolPaths: _tools, ...historicalValue } = old.value;
    await writeFile(f.paths.configurationFile, JSON.stringify({ schemaVersion: 2, identity: { serverOrigin: origin, userId: uuid(6), workerId }, desired: { ...old, value: historicalValue }, observationRevision: "0", nextFailureId: 1, items }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockResolvedValue(resource(next));
    const observed = observeCommittedConfiguration();
    let assertionFailure: unknown;
    mocks.reporter.mockImplementation((options: ReporterOptions) => {
      queueMicrotask(() => { void (async () => {
        try {
          const installed = observed.current();
          expect(installed.schemaVersion).toBe(11);
          expect(JSON.parse(installed.authority.desiredJson!)).toEqual(next);
          expect(installed.currentItems.length).toBeGreaterThanOrEqual(1025);
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
            expect(sent.observation!.items.length).toBeLessThanOrEqual(1026);
            expect(sent.observation!.items.filter(item => item.key.kind !== "agentControlMode").length).toBeLessThanOrEqual(1025);
            expect(sent.observation?.desiredRevision).toBe("2");
            expect(sent.observation!.items.every(item => BigInt(item.targetRevision) <= 2n)).toBe(true);
            const operation = createOperation();
            try { await options.configuration!.accept(sent, receivedReceipt({ desired: next, observationRevision: String(BigInt(sent.observation!.baseRevision) + 1n), observationAccepted: true }), operation); }
            finally { operation.dispose(); }
            const saved = observed.current();
            expect(JSON.parse(saved.authority.desiredJson!)).toEqual(next);
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
      try { await reporterOptions!.configuration!.accept(sent, receivedReceipt({ desired: { ...desired([uuid(1), uuid(2)], 2), value: { ...sent.bootstrap! } }, observationRevision: "0", observationAccepted: false }), operation); }
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
        try { await channel!.accept(channel!.capture(reportSample), receivedReceipt({ desired: { ...desired([uuid(2)]), revision: "2" }, observationRevision: "0", observationAccepted: false }), operation); }
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
    for (const factory of [mocks.coordinator, mocks.git, mocks.remote, mocks.reporter]) expect(factory).not.toHaveBeenCalled();
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

  it("retains an invalid current native target without preparing or admitting it", async () => {
    const f = await fixture(false, false), base = desired();
    const target: WorkerCloudDesired = { ...base, value: { ...base.value, native: { ...base.value.native, model: " " } } };
    mocks.remote().configuration.mockResolvedValue(resource(target)); mocks.remote.mockClear();
    let channel: ReporterOptions["configuration"];
    mocks.reporter.mockImplementation((options: ReporterOptions) => { channel = options.configuration; return reporter(); });
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => expect(channel).toBeDefined());
      const cache = JSON.parse(await readFile(f.paths.configurationFile, "utf8"));
      expect(JSON.parse(cache.authority.desiredJson)).toEqual(target);
      expect(channel!.capture(reportSample).observation).toBeNull();
      expect(mocks.coordinator).not.toHaveBeenCalled();

      expect(mocks.probe).not.toHaveBeenCalled();
      expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "warning", message: expect.stringContaining("missing required settings or contains unsupported current values") }));
    } finally { cancellation.abort(); await running; }
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
    expect(mocks.coordinator).not.toHaveBeenCalled();
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
      expect(mocks.coordinator).not.toHaveBeenCalled();
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
    const backoff = Promise.withResolvers<void>();
    const retryArmed = vi.fn();
    vi.mocked(delay).mockImplementationOnce(async (milliseconds, value, options) => {
      expect(milliseconds).toBe(5_000);
      const signal = options?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      const abort = () => backoff.reject(signal!.reason);
      signal!.throwIfAborted();
      signal!.addEventListener("abort", abort, { once: true });
      retryArmed();
      try { await backoff.promise; signal!.throwIfAborted(); return value; }
      finally { signal!.removeEventListener("abort", abort); }
    });
    const cacheRead = vi.spyOn(configurationCache, "readConfigurationCache");
    const { cancellation, running } = start(f);
    try {
      await vi.waitFor(() => expect(retryArmed).toHaveBeenCalledOnce());
      expect(cacheRead).not.toHaveBeenCalled(); expect(remote.configuration).not.toHaveBeenCalled();
      expect(mocks.reporter).not.toHaveBeenCalled(); expect(mocks.coordinator).not.toHaveBeenCalled();
      const competing = await tryAcquireWorkerInstanceLock(f.paths);
      try { expect(competing).toBeNull(); } finally { await competing?.release(); }
      expect(remote.currentUserId).toHaveBeenCalledOnce();
      backoff.resolve();
      await vi.waitFor(() => expect(remote.currentUserId).toHaveBeenCalledTimes(2));
      expect(verified).toBe(false); expect(cacheRead).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(mocks.reporter).toHaveBeenCalledOnce());
      expect(verified).toBe(true); expect(remote.configuration).toHaveBeenCalledOnce();
    } finally {
      release(); cancellation.abort(); backoff.resolve();
      try { await running; }
      finally { cacheRead.mockRestore(); vi.mocked(delay).mockReset(); }
    }
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
        try { await options.configuration!.accept(sent, receivedReceipt({ desired: desired([uuid(1)], 3), observationRevision: "0", observationAccepted: false }), operation); }
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
        await channel!.accept(captured, receivedReceipt({ desired: { ...desired(), revision: "2" }, observationRevision: "0", observationAccepted: false }), operation);
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
    const lookupCount = () => remote.project.mock.calls.filter(([id]: [string]) => id === uuid(2)).length;
    const preparation = () => channel!.capture(reportSample).observation?.items.find(item => item.key.kind === "projectPreparation" && item.key.projectId === uuid(2));
    let assertionFailure: unknown;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => coordinator(async () => {
      const operation = createOperation();
      try {
        await eventuallyWithoutAdvancingTime(() => expect(options.store.getProject({ projectId: uuid(1) })).not.toBeNull());
        const captured = channel!.capture(reportSample);
        await channel!.accept(captured, receivedReceipt({ desired: { ...desired([uuid(1), uuid(2)]), revision: "2" }, observationRevision: "0", observationAccepted: false }), operation);
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(null);
        await eventuallyWithoutAdvancingTime(() => {
          expect(preparation()?.state).toBe("error");
          expect(mocks.emit.mock.calls.some(([event]) => event.kind === "worker-configuration" && event.message.includes(`\"projectId\":\"${uuid(2)}\"`) && event.message.includes('"state":"error"'))).toBe(true);
        });
        const failed = preparation()!;
        const retryAt = Date.parse(failed.nextAttemptAt!);
        expect(retryAt - Date.parse(failed.error!.occurredAt)).toBe(5_000);
        expect(lookupCount()).toBe(1);
        secondAvailable = true;
        await channel!.accept(channel!.capture(reportSample), receivedReceipt({ desired: { ...desired([uuid(1), uuid(2)]), revision: "3" }, observationRevision: "0", observationAccepted: false }), operation);
        expect(preparation()?.nextAttemptAt).toBe(failed.nextAttemptAt);
        await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
        expect(lookupCount()).toBe(1);
        expect(options.store.getProject({ projectId: uuid(2) })).toBeNull();
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(null);
        await vi.advanceTimersByTimeAsync(1);
        await eventuallyWithoutAdvancingTime(() => expect(options.store.getProject({ projectId: uuid(2) })).not.toBeNull());
        expect(lookupCount()).toBe(2);
        await eventuallyWithoutAdvancingTime(() => expect(options.configurationComplete!()).toBe(true));
        options.onInventory!(inventory);
        expect(reported.publishInventory).toHaveBeenLastCalledWith(inventory);
      } catch (error) { assertionFailure = error; } finally { operation.dispose(); controller.abort(); }
    }));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try { await runWorker({ ...f, signal: controller.signal }); }
    finally { vi.useRealTimers(); }
    if (assertionFailure !== undefined) throw assertionFailure;
  }, 16_000);

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
    const original = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", agentControlMode: "web", sessionId: uuid(5) });
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
    const pending = f.store!.registerPending({ projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), agent: "codex", agentControlMode: "web" });
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

it("blocks Bot and Task admission while Web adoption is pending despite ready native settings", async () => {
  const f = await fixture(false, false);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  let botOptions: { canAdmitNewExecution(): boolean } | undefined;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    return { closeAdmission: () => {}, snapshot: () => ({}), run: vi.fn(async () => {}), shutdown: vi.fn(async () => {}) };
  });
  let manager: cloudConfiguration.WorkerConfigurationManager | undefined;
  const create = cloudConfiguration.createWorkerConfigurationManager;
  const created = vi.spyOn(cloudConfiguration, "createWorkerConfigurationManager").mockImplementation(async options => {
    manager = await create(options); return manager;
  });
  const { cancellation, running } = start(f);
  let current: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await vi.waitFor(() => {
      expect(botOptions?.canAdmitNewExecution()).toBe(true);
      expect(mocks.coordinator).toHaveBeenCalledOnce();
      expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).configurationComplete!()).toBe(true);
    }, { timeout: 5000, interval: 10 });
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    const ready = manager!.current();
    expect(ready.effective.native).not.toBeNull();
    expect(ready.effective.recoveryLimit).not.toBeNull();
    expect(ready.selectedProjects).toEqual([]);
    // The manager owns mode adoption and can retain ready native values during a new checkpoint.
    current = vi.spyOn(manager!, "current").mockReturnValue({ ...ready,
      items: ready.items.map(item => item.key.kind === "agentControlMode" ? { ...item, state: "pending", appliedValue: null } : item),
      effective: { ...ready.effective, agentControlMode: null },
    });
    expect(manager!.isReady()).toBe(true);
    expect([botOptions!.canAdmitNewExecution(), options.configurationComplete!()]).toEqual([false, false]);
    current.mockRestore(); current = undefined;
    expect(botOptions!.canAdmitNewExecution()).toBe(true);
    expect(options.configurationComplete!()).toBe(true);
  } finally { current?.mockRestore(); cancellation.abort(); await running; created.mockRestore(); }
});

it("starts Bot management with no projects and preserves the Worker lock through Bot shutdown", async () => {
  const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  let botOptions: any;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    return { closeAdmission: () => {}, snapshot: () => ({}), run: vi.fn(async (signal: AbortSignal) => {
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

it("attempts Task shutdown but retains Bot storage and its lock when Bot shutdown is unconfirmed", async () => {
  const f = await fixture(false, false), cancellation = new AbortController(); cancellations.add(cancellation);
  mocks.remote().configuration.mockResolvedValue(resource(desired([]))); mocks.remote.mockClear();
  const failure = new Error("Bot writer stop remains unconfirmed");
  const shutdown = vi.fn(async () => { throw failure; });
  const { bot } = await import("./bot-store.fixtures.js");
  const definition = bot();
  if (definition.deletion !== null) throw new Error("Expected an active Bot fixture.");
  const retained = { ...definition, ownerUserId: uuid(6), workerId,
    resolvedConfiguration: { ...definition.resolvedConfiguration, workerId } };
  let botOptions: any;
  mocks.bots.mockImplementation(options => {
    botOptions = options;
    options.store.observe(options.owner, retained, 1);
    return { closeAdmission: () => {}, snapshot: () => ({}), run: async () => {}, shutdown };
  });
  const tasks = coordinator(async () => cancellation.abort()); mocks.coordinator.mockReturnValue(tasks);
  try {
    await expect(runWorker({ ...f, signal: cancellation.signal })).rejects.toBe(failure);
    expect(tasks.shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(botOptions.store.get(botOptions.owner, retained.id)?.observed).toEqual(retained);
    expect(await readFile(path.join(f.paths.stateDirectory, "bots", retained.id, "instance.lock"), "utf8")).toContain(String(process.pid));
    expect(await tryAcquireWorkerInstanceLock(f.paths)).toBeNull();
  } finally {
    // The controlled runtime never started a writer; release its retained test handle.
    botOptions?.store.close();
    (mocks.coordinator.mock.calls[0]?.[0] as WorkerCoordinatorOptions | undefined)?.store.close();
  }
});


describe("real runtime resource isolation", () => {
  it.skipIf(process.platform === "win32")("closes the original Git boundary when Worker cancellation precedes its launcher birth message", async () => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const { createWorkerGitManager } = await vi.importActual<typeof import("../../../src/commands/worker/worktrees.js")>("../../../src/commands/worker/worktrees.js");
    // A missing configured repository enters the real owned clone path. The
    // target command must never be dispatched after its launcher's spawn.
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.homeDirectory, "git-temp"), prepareFormat: async () => { throw new Error("Cancelled cloning must not prepare a repository format."); } });
    mocks.git.mockReturnValue(git);
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let original: { resourceId: string; pid: number } | undefined;
    let sending: ReturnType<typeof vi.spyOn> | undefined;
    let birthMessageReceived = false, cancelledBeforeBirth = false;
    const spawning = vi.spyOn(childProcesses, "spawn").mockImplementation((...args) => {
      const child = Reflect.apply(spawn, childProcesses, args) as ReturnType<typeof spawn>;
      const command = args[1];
      if (Array.isArray(command) && typeof command[0] === "string" && command[0].endsWith("owned-command-helper.js")) {
        child.on("message", () => { birthMessageReceived = true; });
        child.once("spawn", () => {
          if (original !== undefined || child.pid === undefined) return;
          original = { resourceId: command[1]!, pid: child.pid };
          sending = vi.spyOn(child, "send");
          cancelledBeforeBirth = !birthMessageReceived && retainedOwnedCommandBoundaries().some(boundary => boundary.resourceId === original!.resourceId && boundary.proof === null);
          cancellation.abort();
        });
      }
      return child;
    });
    const controls: import("../../../src/commands/worker/runtime.js").WorkerExecutionControl[] = [];
    const { running } = start(f, { signal: cancellation.signal, onExecutionScope: control => { controls.push(control); } });
    try {
      try { await vi.waitFor(() => expect(original).toBeDefined(), { timeout: 5000 }); }
      catch (cause) {
        throw new Error(`Runtime Git launcher was not observed: ${JSON.stringify({ generation: controls[0]?.generation, spawns: spawning.mock.calls.length,
          executables: [...new Set(spawning.mock.calls.map(([file]) => file))], lastError: String(mocks.emit.mock.calls.filter(([event]) => event.error !== undefined).at(-1)?.[0].error) })}`, { cause });
      }
      await running;
      expect(cancelledBeforeBirth).toBe(true);
      expect(original).toBeDefined();
      expect(sending).not.toHaveBeenCalled();
      expect(controls).toHaveLength(1); expect(controls[0]!.snapshot().stopped).toBe(true);
      expect(retainedOwnedCommandBoundaries()).toEqual([]);
      const record = JSON.parse(await readFile(path.join(f.paths.workerDirectory, "execution-resources", `${original!.resourceId}.json`), "utf8"));
      expect(record).toMatchObject({ generation: "1", event: { resourceId: original!.resourceId, stage: "stopped", proof: { pid: original!.pid } } });
      const lock = await tryAcquireWorkerInstanceLock(f.paths);
      expect(lock).not.toBeNull(); await lock?.release();
    } finally {
      cancellation.abort(); await Promise.allSettled([running]);
      try { await withinExecutionDeadline(git.dispose(), Date.now() + 10_000); }
      finally { sending?.mockRestore(); spawning.mockRestore(); }
    }
  }, 35_000);

  it.each(["unproven", "foreign", "invalid"])("reconciles an unbound mapping and its damaged registration: %s", async scenario => {
    const f = await fixture(true), cancellation = new AbortController(); cancellations.add(cancellation);
    const { projectId: _projectId, ...legacy } = f.repository;
    await writeFile(f.paths.configFile, stringify({ ...f.document, worker: { repositories: [{ ...legacy, ...(scenario === "invalid" ? { projectId: "invalid" } : {}) }] } }));
    const { createWorkerGitManager } = await vi.importActual<typeof import("../../../src/commands/worker/worktrees.js")>("../../../src/commands/worker/worktrees.js");
    const { createWorkerCoordinator } = await vi.importActual<typeof import("../../../src/commands/worker/coordinator.js")>("../../../src/commands/worker/coordinator.js");
    const { migrateLegacyWorktrees } = await import("../../../src/commands/worker/worktrees/migration.js");
    const git = createWorkerGitManager({ temporaryDirectory: path.join(f.homeDirectory, "git-temp"), prepareFormat: async (_project, repo, operation) => {
      await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation,
        sources: { listSchedules: () => [], listWebTasks: () => [] } });
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
    remote.ownInventory = vi.fn(async () => ({ tasks: [], coveredProjectIds: [uuid(1)], unavailableProjectIds: [] }));
    remote.candidates = vi.fn(async function* () { yield base; });
    remote.claim = vi.fn(async () => { throw new Error("Grant deliberately unconfirmed"); });
    let configurationComplete = false, cycles = 0;
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => {
      const actual = createWorkerCoordinator({ ...options, verifyWebServer: async () => {} });
      const tick = actual.tick;
      actual.tick = async () => {
        await tick(); cycles++;
        configurationComplete = options.configurationComplete!();
        if (scenario === "unproven" && configurationComplete && remote.claim.mock.calls.length > 0) cancellation.abort();
      };
      return actual;
    });
    const { running } = start(f, { signal: cancellation.signal });
    try {
      if (scenario === "unproven") {
        await vi.waitFor(() => { expect(configurationComplete).toBe(true); expect(remote.claim).toHaveBeenCalled(); }, { timeout: 10000 });
        expect(remote.claim.mock.calls.every(([candidate]: [{ id: string }, ...unknown[]]) => candidate.id === base.id)).toBe(true);
      } else {
        await vi.waitFor(() => { expect(cycles).toBeGreaterThan(0); expect(mocks.emit.mock.calls.some(([event]) => event.message.includes("Local resource mapping"))).toBe(true); }, { timeout: 10000 });
        expect(remote.claim).not.toHaveBeenCalled();
        expect(configurationComplete).toBe(false);
      }
      const worktree = path.join(f.repository.path, ".worktrees", "daynight", owner.worktreeId);
      expect(await readFile(path.join(worktree, ".git"), "utf8")).toContain("gitdir:");
      expect(execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8", timeout: 10000 }).trim()).toBe("changed-branch");
    } finally { cancellation.abort(); await running; await git.dispose(); }
  }, 25000);
});
