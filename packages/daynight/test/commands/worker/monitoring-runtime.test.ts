import { scanFromList } from "../../helpers/worker-git-scan.js";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ApiError } from "../../../src/api/client.js";
import { ProtocolError } from "../../../src/api/parse.js";
import { OperationError } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport } from "../../../src/api/types.js";
import type { WorkerCloudDesired, WorkerCloudReport, WorkerCloudReportReceipt } from "../../../src/api/worker-configuration.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { WorkerConfigurationManager } from "../../../src/commands/worker/configuration.js";
import type { Observation } from "../../../src/commands/worker/monitoring/types.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

// These Task/configuration fixtures do not own a Bot service or native execution.
vi.mock("../../../src/commands/worker/tool-selection-runtime.js", async () => ({
  createWorkerToolSelectionRuntime: (await import("../../helpers/worker-tool-runtime-fixture.js")).createWorkerToolSelectionFixture,
}));
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: () => ({
  run: async () => {}, shutdown: async () => {}, collect: async () => undefined, requiresCopilot: () => false, activeToolSelections: () => [], close: () => {},
}) }));

const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), telemetry: vi.fn(), webOpen: vi.fn(), webClose: vi.fn(), emit: vi.fn(), completed: vi.fn(), archive: vi.fn(), ticket: vi.fn(), delay: vi.fn(), probe: vi.fn(), persist: vi.fn(), configuration: vi.fn() }));
vi.mock("node:timers/promises", async original => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: (...args: Parameters<typeof actual.setTimeout>) => mocks.delay(...args) };
});
vi.mock("../../../src/commands/controller/archive-upload.js", () => ({ uploadStoppedControllerArchive: mocks.archive, probeStoppedControllerArchive: vi.fn().mockResolvedValue({ kind: "attempt" }) }));
vi.mock("../../../src/commands/controller/launch-ticket.js", async original => ({ ...await original<object>(), readLaunchTicket: mocks.ticket }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/configuration.js", async original => {
  const actual = await original<typeof import("../../../src/commands/worker/configuration.js")>();
  return { ...actual, createWorkerConfigurationManager: async (options: Parameters<typeof actual.createWorkerConfigurationManager>[0]) => {
    const manager = await actual.createWorkerConfigurationManager({ ...options, ...(mocks.persist.getMockImplementation() === undefined ? {} : { persist: mocks.persist }) });
    mocks.configuration(manager); return manager;
  } };
});
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ buildWorkerPrompt: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", async original => ({ ...await original<object>(), probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/backends/web-store.js", () => ({ openWebExecutionStore: mocks.webOpen }));
vi.mock("../../../src/commands/worker/backends/web.js", () => ({ createWebExecutionBackend: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", () => ({ createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, close: async () => {}, filename: "worker.jsonl" }) }));

const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const remoteUrl = "https://git.example/team/repo.git";
const roots: string[] = [];
const runs = new Set<{ signal: AbortController; running: Promise<void> }>();
const settlements = new Set<() => void>();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  settlements.add(() => resolve(undefined as T));
  return { promise, resolve };
};

// Retry deadlines advance only at explicit test boundaries; vi.waitFor advances fake timers while polling.
const eventuallyWithoutAdvancingTime = async (check: () => void): Promise<void> => {
  const timers = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
  const deadline = performance.now() + 3500;
  for (;;) {
    try { check(); return; }
    catch (error) { if (performance.now() >= deadline) throw error; }
    await timers.setTimeout(10);
  }
};
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/monitoring-runtime-tests");
  await mkdir(base, { recursive: true });
  const homeDirectory = await mkdtemp(path.join(base, "w-")); roots.push(homeDirectory);
  const paths = resolveWorkerPaths(homeDirectory);
  await mkdir(paths.stateDirectory, { recursive: true });
  await writeFile(paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: [{ remote: remoteUrl, path: path.join(homeDirectory, "repo"), projectId: uuid(1) }], maxConcurrent: 9 } }));
  return { homeDirectory, paths, packageDirectory: path.resolve("package"), version: "9.8.7", workingDirectory: path.join(homeDirectory, "startup"), signal: new AbortController() };
};
const start = (f: Awaited<ReturnType<typeof fixture>>) => {
  const running = runWorker({ ...f, signal: f.signal.signal });
  runs.add({ signal: f.signal, running }); void running.catch(() => {}); return running;
};
const configurationManager = (): WorkerConfigurationManager => mocks.configuration.mock.calls[0]![0] as WorkerConfigurationManager;
let target: WorkerCloudDesired;
let observationRevision: bigint;
let collect: ReturnType<typeof vi.fn<(operation: Operation) => Promise<WorkerTelemetrySample>>>;
let report: ReturnType<typeof vi.fn<(workerId: string, value: WorkerReport, configuration: WorkerCloudReport, operation: Operation) => Promise<WorkerCloudReportReceipt>>>;
let prepare: ReturnType<typeof vi.fn>;
let shutdown: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
let update: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.persist.mockReset();
  mocks.delay.mockImplementation((milliseconds: number, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(value); }, milliseconds);
    const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", cancel, { once: true });
  }));
  mocks.completed.mockReturnValue([]); mocks.webClose.mockImplementation(() => {}); mocks.emit.mockImplementation(() => {});
  mocks.webOpen.mockImplementation(() => ({ close: mocks.webClose, listCompletedTasks: mocks.completed }));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  target = { revision: "1", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 60_000, recoveryLimit: 3, preferPlatformSpecificTasks: false, native: { agent: "codex", model: null, args: [] }, projects: [{ projectId: uuid(1), nativeOverrides: {} }] } };
  observationRevision = 0n;
  collect = vi.fn(async () => ({ telemetry: workerTelemetry, issues: [] }));
  report = vi.fn(async (_workerId, _body, configuration) => {
    const observationAccepted = configuration.observation !== null && configuration.observation.baseRevision === String(observationRevision);
    if (observationAccepted) observationRevision++;
    return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: String(observationRevision), observationAccepted } };
  });
  prepare = vi.fn(async () => {}); shutdown = vi.fn(async () => true); dispose = vi.fn(async () => {}); update = vi.fn();
  mocks.telemetry.mockReturnValue({ collect }); mocks.probe.mockResolvedValue("0.164.0");
  mocks.remote.mockReturnValue({ currentUserId: vi.fn(async () => uuid(6)), configuration: vi.fn(async () => ({ desired: target, observationRevision: "0", observation: null })), resolveProject: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), project: vi.fn(async () => ({ id: uuid(1), repoUrl: remoteUrl })), reportConfiguration: report, report: vi.fn() });
  mocks.git.mockReturnValue(Object.assign({ prepareRepository: prepare, dispose, listWorktrees: vi.fn(async () => []) }, { scanWorktrees: scanFromList }));
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockReturnValue("prompt");
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({ tick: vi.fn(async () => { if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); }), archiveYield: () => false, updateConfiguration: update, shutdown }));
});
afterEach(async () => {
  for (const { signal } of runs) signal.abort();
  for (const settle of settlements) settle(); settlements.clear();
  await Promise.allSettled([...runs].map(({ running }) => running)); runs.clear();
  vi.restoreAllMocks(); vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});


describe("worker runtime monitoring isolation", () => {
  it.each(["worker", "project"] as const)("reports and recovers actual %s native application failures", async kind => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>();
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "claude" } }] } };
    let attempts = 0;
    mocks.probe.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent !== (kind === "worker" ? "codex" : "claude")) return "1.2.3";
      if (++attempts === 1) throw new OperationError("request_timeout", { cause: new Error("secret prompt and command output") });
      retryStarted.resolve(); await retryRelease.promise; return "1.2.3";
    });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      const scope = kind === "worker" ? { kind: "worker" } : { kind: "project", projectId: uuid(1) };
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "configuration", phase: "configuration", scope, retryState: "scheduled" })));
      const failed = monitor.capture("1"), failure = failed.currentFailures.find(item => item.component === "configuration" && item.scope.kind === kind)!;
      expect(failure).toMatchObject({ error: { code: "timeout", cause: "The operation timed out." }, occurrencesInRun: 1, nextAttemptAt: new Date(Date.now() + 5_000).toISOString() });
      expect(failed.admission).toMatchObject({ coverage: "partial" });
      expect(failed.admission.reasons).toContainEqual(expect.objectContaining({ code: "configuration-incomplete", scope, nextAttemptAt: failure.nextAttemptAt }));
      expect(JSON.stringify(failed)).not.toContain("secret prompt");
      monitor.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date().toISOString(), nextAttemptAt: null }]);
      expect(monitor.capture("2").admission.reasons.some(item => item.code === "no-ready-tasks")).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running", occurrencesInRun: 1 }));
      expect(monitor.capture("3").activities).toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "configuration", scope }));
      retryRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("4").lastRecovery).toMatchObject({ operationId: failure.operationId, scope }));
      expect(monitor.capture("4").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it("keeps canonical project native failure separate from repository preparation", async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>();
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "claude" } }] } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    let attempts = 0;
    mocks.probe.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent !== "claude") return "1.2.3";
      if (++attempts === 1) throw new OperationError("request_timeout", { cause: new Error("private native output") });
      retryStarted.resolve(); await retryRelease.promise; return "1.2.3";
    });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => { expect(prepare).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "configuration", scope: { kind: "project", projectId: uuid(1) }, retryState: "scheduled" })));
      const failed = monitor.capture("1"), failure = failed.currentFailures.find(item => item.component === "configuration" && item.scope.kind === "project")!;
      expect(failure).toMatchObject({ scope: { kind: "project", projectId: uuid(1) }, error: { code: "timeout" }, occurrencesInRun: 1 });
      expect(failed.currentFailures.some(item => item.component === "project")).toBe(false);
      expect(failed.admission.reasons).toContainEqual(expect.objectContaining({ code: "configuration-incomplete", scope: { kind: "project", projectId: uuid(1) } }));
      expect(JSON.stringify(failed)).not.toContain("private native output");
      await configurationManager().settle();
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running", occurrencesInRun: 1 }));
      retryRelease.resolve(); await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failure.operationId }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
      expect(prepare).toHaveBeenCalledOnce();
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it.each([true, false])("handles canonical native target realignment matching=%s", async matches => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>();
    target = { ...target, revision: "10", value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "claude" } }] } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    let attempts = 0;
    mocks.probe.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent !== "claude") return "1.2.3";
      if (++attempts === 1) throw new OperationError("request_timeout");
      retryStarted.resolve(); await retryRelease.promise; return "1.2.3";
    });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "configuration", scope: { kind: "project", projectId: uuid(1) }, retryState: "scheduled" })));
      expect(mocks.probe.mock.calls.find(([input]) => input.agent === "claude")![0]).toMatchObject({ agent: "claude" });
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "configuration" && item.scope.kind === "project")!;
      expect(failure).toMatchObject({ scope: { kind: "project", projectId: uuid(1) }, error: { code: "timeout" } });
      await configurationManager().settle();
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      const generation = configurationManager().current().generation;
      target = { ...target, revision: "5", value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: matches ? "claude" : "copilot" } }] } };
      await configurationManager().receive(target, "0");
      expect(configurationManager().current().desired).toEqual(target);
      expect(configurationManager().current().generation).not.toBe(generation);
      if (!matches) {
        expect(monitor.capture("2").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
        expect(monitor.capture("2").lastRecovery?.operationId).not.toBe(failure.operationId);
      }
      retryRelease.resolve();
      if (matches) await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("2").lastRecovery).toMatchObject({ operationId: failure.operationId, scope: { kind: "project", projectId: uuid(1) } }));
      else expect(monitor.capture("2").lastRecovery?.operationId).not.toBe(failure.operationId);
      expect(monitor.capture("2").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it.each(["worker", "project"] as const)("keeps the %s native failure after a cancelled retry returns", async kind => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>(), writes: Observation[] = [];
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "claude" } }] } };
    let attempts = 0;
    mocks.probe.mockImplementation(async ({ agent }: { agent: string }) => {
      if (agent !== (kind === "worker" ? "codex" : "claude")) return "1.2.3";
      if (++attempts === 1) throw new OperationError("request_timeout");
      retryStarted.resolve(); await retryRelease.promise; return "1.2.3";
    });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => { writes.push(observation); return { revision: uuid(8), runId: observation.runId, sequence: observation.sequence }; }) });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "configuration", retryState: "scheduled" })));
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "configuration")!;
      await configurationManager().settle();
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      f.signal.abort(); retryRelease.resolve(); await running;
      const final = writes.at(-1)!;
      expect(final.lifecycle).toBe("stopped");
      expect(final.currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "none", nextAttemptAt: null, occurrencesInRun: 1 }));
      expect(final.activities).not.toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "configuration" }));
      expect(final.lastRecovery).toBeNull();
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it("discards an old project native failure on target change without claiming recovery", async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>();
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "claude" } }] } };
    let attempts = 0;
    mocks.probe.mockImplementation(async ({ agent }: { agent: string }, operation: Operation) => {
      if (agent !== "claude") return "1.2.3";
      if (++attempts === 1) throw new OperationError("request_timeout");
      retryStarted.resolve();
      return await new Promise<string>((_resolve, reject) => { if (operation.signal.aborted) reject(operation.signal.reason); else operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true }); });
    });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "configuration", scope: { kind: "project", projectId: uuid(1) }, retryState: "scheduled" })));
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "configuration" && item.scope.kind === "project")!;
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      target = { ...target, revision: "2", value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: { agent: "copilot" } }] } };
      await vi.advanceTimersByTimeAsync(30_000);
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("2").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId })));
      expect(monitor.capture("2").lastRecovery?.operationId).not.toBe(failure.operationId);
      expect(monitor.capture("2").admission.reasons).not.toContainEqual(expect.objectContaining({ code: "configuration-incomplete", scope: { kind: "project", projectId: uuid(1) } }));
    } finally { f.signal.abort(); await running; }
  });

  it("keeps scheduler coverage partial while a selected project is still being prepared", async () => {
    const f = await fixture(), started = deferred<void>(), release = deferred<void>(), scan = deferred<void>(), scanned = deferred<void>();
    prepare.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({ tick: vi.fn(async () => {
      await scan.promise;
      const monitor = options.monitoring!;
      monitor.startCycle("claim-search"); monitor.markCycleSuccessful(); monitor.endCycle("completed", "complete");
      monitor.setAdmission("complete", [{ code: "no-projects-selected", scope: { kind: "worker" }, observedAt: new Date().toISOString(), nextAttemptAt: null }]);
      scanned.resolve();
      if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    }), archiveYield: () => false, updateConfiguration: update, shutdown }));
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    const running = start(f);
    try {
      await started.promise;
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").activities).toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "project-preparation" })));
      // A later native maintenance operation would invalidate the completed admission proof.
      await eventuallyWithoutAdvancingTime(() => {
        expect(mocks.probe).toHaveBeenCalledTimes(2);
        expect(monitor.capture("1").activities.some(activity => activity.phase === "configuration")).toBe(false);
      });
      scan.resolve(); await scanned.promise;
      expect(monitor.capture("1")).toMatchObject({ scheduler: { coverage: "partial", lastSuccessfulAt: null }, admission: { coverage: "partial", reasons: [] } });
      release.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(update.mock.calls.some(([value]) => value.readyProjectIds?.includes(uuid(1)))).toBe(true));
      expect(monitor.capture("2")).toMatchObject({ scheduler: { coverage: "partial", lastSuccessfulAt: null }, admission: { coverage: "partial", reasons: [] } });
    } finally { scan.resolve(); release.resolve(); f.signal.abort(); await running; }
  });

  it("reports the real project preparation failure and its retry until the same preparation succeeds", async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>();
    const failure = new ApiError({ operation: "project.prepare" }, "response", { status: 403, cause: new Error("secret path and command output") });
    prepare.mockRejectedValueOnce(failure).mockImplementationOnce(async () => { retryStarted.resolve(); await retryRelease.promise; });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => { expect(prepare).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "project", retryState: "scheduled" })));
      const failed = monitor.capture("1"), item = failed.currentFailures.find(value => value.component === "project")!;
      const nextAttemptAt = new Date(Date.now() + 5_000).toISOString();
      expect(item).toMatchObject({ phase: "project-preparation", scope: { kind: "project", projectId: uuid(1) }, error: { code: "permission-denied", cause: "Permission was denied." }, occurrencesInRun: 1, nextAttemptAt });
      expect(failed.admission.coverage).toBe("partial");
      expect(failed.admission.reasons).toContainEqual(expect.objectContaining({ code: "project-preparation-failed", scope: { kind: "project", projectId: uuid(1) }, nextAttemptAt }));
      expect(JSON.stringify(failed)).not.toContain("secret path");
      monitor.setAdmission("complete", [{ code: "no-ready-tasks", scope: { kind: "worker" }, observedAt: new Date().toISOString(), nextAttemptAt: null }]);
      expect(monitor.capture("2").admission).toMatchObject({ coverage: "partial", reasons: [expect.objectContaining({ code: "project-preparation-failed" })] });
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: item.operationId, retryState: "running", nextAttemptAt: null, occurrencesInRun: 1 }));
      expect(monitor.capture("3").activities).toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "project-preparation", status: "running", scope: { kind: "project", projectId: uuid(1) } }));
      retryRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("4").lastRecovery).toMatchObject({ operationId: item.operationId, component: "project" }));
      expect(monitor.capture("4").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: item.operationId }));
      expect(monitor.capture("4").activities).not.toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "project-preparation" }));
      expect(monitor.capture("4").admission.reasons).not.toContainEqual(expect.objectContaining({ code: "project-preparation-failed" }));
      expect(prepare).toHaveBeenCalledTimes(2);
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it("retains successful preparation evidence across another project's concurrent commit", async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), firstRetry = deferred<void>(), firstRelease = deferred<void>(), secondStarted = deferred<void>(), secondRelease = deferred<void>(), secondPersisting = deferred<void>(), persistRelease = deferred<void>();
    const secondUrl = "https://git.example/team/other.git";
    await writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: [{ remote: remoteUrl, path: path.join(f.homeDirectory, "repo"), projectId: uuid(1) }, { remote: secondUrl, path: path.join(f.homeDirectory, "other"), projectId: uuid(2) }], maxConcurrent: 2 } }));
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: {} }, { projectId: uuid(2), nativeOverrides: {} }] } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote,
      resolveProject: vi.fn(async ({ projectId }: { projectId: string }) => ({ id: projectId, repoUrl: projectId === uuid(1) ? remoteUrl : secondUrl })),
      project: vi.fn(async (id: string) => ({ id, repoUrl: id === uuid(1) ? remoteUrl : secondUrl })),
      readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })),
    });
    let firstAttempts = 0;
    prepare.mockImplementation(async (binding: { projectId: string }) => {
      if (binding.projectId === uuid(2)) { secondStarted.resolve(); await secondRelease.promise; return; }
      if (++firstAttempts === 1) throw new Error("first project failed");
      firstRetry.resolve(); await firstRelease.promise;
    });
    const files = await vi.importActual<typeof import("../../../src/platform/files.js")>("../../../src/platform/files.js");
    let held = false;
    mocks.persist.mockImplementation(async (file: string, chunks: () => Iterable<string>) => {
      const state = JSON.parse([...chunks()].join("")) as { currentItems: { value: { key: { kind: string; projectId?: string }; state: string } }[] };
      const projectState = (id: string): string | undefined => state.currentItems.find(item => item.value.key.kind === "projectPreparation" && item.value.key.projectId === id)?.value.state;
      if (!held && projectState(uuid(1)) === "applying" && projectState(uuid(2)) === "applied") { held = true; secondPersisting.resolve(); await persistRelease.promise; }
      await files.replaceFileAtomicallyFromChunks(file, chunks(), 0o600);
    });
    const running = start(f);
    try {
      await secondStarted.promise;
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "project", retryState: "scheduled" })));
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "project")!;
      await vi.advanceTimersByTimeAsync(5_000); await firstRetry.promise;
      secondRelease.resolve(); await secondPersisting.promise;
      firstRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("2").activities.some(activity => activity.kind === "maintenance" && activity.scope.kind === "project" && activity.scope.projectId === uuid(1))).toBe(false));
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running" }));
      persistRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failure.operationId }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
      expect(held).toBe(true);
    } finally { firstRelease.resolve(); secondRelease.resolve(); persistRelease.resolve(); f.signal.abort(); await running; }
  });

  it("reports canonical preparation failure and recovers after complete project preparation", async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>();
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    prepare.mockRejectedValueOnce(new Error("private preparation output")).mockImplementationOnce(async () => { retryStarted.resolve(); await retryRelease.promise; });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => { expect(prepare).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "project", retryState: "scheduled" })));
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "project")!;
      expect(failure).toMatchObject({ phase: "project-preparation", scope: { kind: "project", projectId: uuid(1) }, error: { code: "unknown" }, occurrencesInRun: 1 });
      expect(monitor.capture("1").admission.reasons).toContainEqual(expect.objectContaining({ code: "project-preparation-failed", scope: { kind: "project", projectId: uuid(1) } }));
      expect(JSON.stringify(monitor.capture("1"))).not.toContain("private preparation output");
      await configurationManager().settle();
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running", occurrencesInRun: 1 }));
      expect(monitor.capture("2").activities).toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "project-preparation", scope: { kind: "project", projectId: uuid(1) } }));
      retryRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("3").lastRecovery).toMatchObject({ operationId: failure.operationId }));
      expect(monitor.capture("3").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it("retains preparation failure through canonical realignment until actual preparation succeeds", async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), realignedStarted = deferred<void>(), realignedRelease = deferred<void>(), successStarted = deferred<void>(), successRelease = deferred<void>();
    target = { ...target, revision: "10" };
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => ({ revision: uuid(8), runId: observation.runId, sequence: observation.sequence })) });
    prepare.mockRejectedValueOnce(new Error("original preparation failed")).mockImplementationOnce(async () => { realignedStarted.resolve(); await realignedRelease.promise; throw new Error("realigned preparation failed"); }).mockImplementationOnce(async () => { successStarted.resolve(); await successRelease.promise; });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => { expect(prepare).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "project", retryState: "scheduled" })));
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "project")!;
      expect(failure).toMatchObject({ scope: { kind: "project", projectId: uuid(1) }, occurrencesInRun: 1 });
      await configurationManager().settle();
      const generation = configurationManager().current().generation;
      target = { ...target, revision: "5" };
      await configurationManager().receive(target, "0");
      expect(configurationManager().current().desired).toEqual(target);
      expect(configurationManager().current().generation).not.toBe(generation);
      await vi.advanceTimersByTimeAsync(5_000); await realignedStarted.promise;
      const pending = monitor.capture("2");
      expect(pending.currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running", occurrencesInRun: 1 }));
      expect(pending.admission.reasons).toContainEqual(expect.objectContaining({ code: "project-preparation-failed", scope: { kind: "project", projectId: uuid(1) } }));
      expect(pending.lastRecovery).toBeNull();
      realignedRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("3").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "scheduled", occurrencesInRun: 2 })));
      expect(monitor.capture("3").currentFailures.filter(item => item.component === "project")).toHaveLength(1);
      expect(monitor.capture("3").lastRecovery).toBeNull();
      await configurationManager().settle();
      await vi.advanceTimersByTimeAsync(5_000); await successStarted.promise;
      expect(monitor.capture("4").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running", occurrencesInRun: 2 }));
      successRelease.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("5").lastRecovery).toMatchObject({ operationId: failure.operationId, component: "project" }));
      expect(monitor.capture("5").currentFailures).not.toContainEqual(expect.objectContaining({ operationId: failure.operationId }));
      expect(monitor.capture("5").admission.reasons).not.toContainEqual(expect.objectContaining({ code: "project-preparation-failed" }));
    } finally { realignedRelease.resolve(); successRelease.resolve(); f.signal.abort(); await running; }
  });

  it.each([false, true])("keeps preparation failure without a running retry after cancellation (realigned: %s)", async realigned => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const f = await fixture(), retryStarted = deferred<void>(), retryRelease = deferred<void>(), writes: Observation[] = [];
    if (realigned) target = { ...target, revision: "10" };
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote,
      readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => { writes.push(observation); return { revision: uuid(8), runId: observation.runId, sequence: observation.sequence }; }),
    });
    prepare.mockRejectedValueOnce(new Error("prepare failed")).mockImplementationOnce(async () => { retryStarted.resolve(); await retryRelease.promise; });
    const running = start(f);
    try {
      await eventuallyWithoutAdvancingTime(() => { expect(prepare).toHaveBeenCalledOnce(); expect(mocks.coordinator).toHaveBeenCalledOnce(); });
      const monitor = (mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).monitoring!;
      await eventuallyWithoutAdvancingTime(() => expect(monitor.capture("1").currentFailures).toContainEqual(expect.objectContaining({ component: "project", retryState: "scheduled" })));
      const failure = monitor.capture("1").currentFailures.find(item => item.component === "project")!;
      await configurationManager().settle();
      if (realigned) { target = { ...target, revision: "5" }; await configurationManager().receive(target, "0"); }
      await vi.advanceTimersByTimeAsync(5_000); await retryStarted.promise;
      expect(monitor.capture("2").currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "running" }));
      f.signal.abort(); retryRelease.resolve(); await running;
      const final = writes.at(-1)!;
      expect(final.lifecycle).toBe("stopped");
      expect(final.currentFailures).toContainEqual(expect.objectContaining({ operationId: failure.operationId, retryState: "none", nextAttemptAt: null, occurrencesInRun: 1 }));
      expect(final.activities).not.toContainEqual(expect.objectContaining({ kind: "maintenance", phase: "project-preparation" }));
      expect(final.lastRecovery).toBeNull();
    } finally { retryRelease.resolve(); f.signal.abort(); await running; }
  });

  it.each([401, 403])("reports an initial HTTP %s configuration refusal in the stopped snapshot while preserving the original error", async status => {
    const f = await fixture();
    const original = new ApiError({ operation: "worker.configuration" }, "response", { status, cause: new Error("private configuration payload") });
    const writes: Observation[] = [];
    const remote = mocks.remote(); mocks.remote.mockClear();
    const readConfiguration = vi.fn().mockRejectedValue(original);
    mocks.remote.mockReturnValue({ ...remote, configuration: readConfiguration, readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => {
      writes.push(observation);
      return { revision: uuid(8), runId: observation.runId, sequence: observation.sequence };
    }) });
    await expect(start(f)).rejects.toBe(original);
    expect(readConfiguration).toHaveBeenCalledOnce();
    expect(writes.length).toBeGreaterThan(0);
    const final = writes.at(-1)!;
    expect(final.lifecycle).toBe("stopped");
    expect(final.admission).toMatchObject({ coverage: "partial", reasons: [{ code: "configuration-unavailable", scope: { kind: "worker" } }] });
    expect(final.currentFailures).toMatchObject([{ component: "configuration", phase: "configuration", scope: { kind: "worker" }, error: { type: "operation", code: status === 401 ? "authentication-required" : "permission-denied", cause: status === 401 ? "Authentication is required." : "Permission was denied.", causeTruncated: false } }]);
    expect(JSON.stringify(final)).not.toContain("private configuration payload");
  });

  it("keeps an initial HTTP 500 configuration failure live until an automatic authenticated read recovers", async () => {
    const f = await fixture(), recover = deferred<void>(), reading = deferred<void>(), writes: Observation[] = [];
    const original = new ApiError({ operation: "worker.configuration" }, "response", { status: 500, cause: new Error("private configuration payload") });
    const remote = mocks.remote(); mocks.remote.mockClear();
    const readConfiguration = vi.fn().mockRejectedValueOnce(original).mockImplementation(async () => { reading.resolve(); await recover.promise; return { desired: target, observationRevision: "0", observation: null }; });
    mocks.remote.mockReturnValue({ ...remote, configuration: readConfiguration, readMonitoring: vi.fn(async () => { await reading.promise; return { state: "absent" }; }), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => {
      writes.push(observation); return { revision: uuid(8), runId: observation.runId, sequence: observation.sequence };
    }) });
    const running = start(f);
    try {
      await reading.promise;
      expect(mocks.coordinator).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled();
      await eventuallyWithoutAdvancingTime(() => expect(writes.some(observation => observation.currentFailures.some(failure => failure.component === "configuration"))).toBe(true));
      const unread = writes.find(observation => observation.currentFailures.some(failure => failure.component === "configuration"))!;
      expect(unread.admission).toMatchObject({ coverage: "partial", reasons: [{ code: "configuration-unavailable", scope: { kind: "worker" } }] });
      expect(unread.currentFailures).toContainEqual(expect.objectContaining({ component: "configuration", phase: "configuration", scope: { kind: "worker" }, occurrencesInRun: 1, error: expect.objectContaining({ type: "operation", causeTruncated: false }) }));
      expect(writes.every(observation => observation.lifecycle !== "stopped")).toBe(true);
      expect(JSON.stringify(writes)).not.toContain("private configuration payload");
      recover.resolve();
      await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
      await eventuallyWithoutAdvancingTime(() => expect((mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions).configurationComplete!()).toBe(true));
      await eventuallyWithoutAdvancingTime(() => expect(report).toHaveBeenCalled());
      expect(readConfiguration.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally { recover.resolve(); f.signal.abort(); await running; }
    expect(writes.at(-1)!.lifecycle).toBe("stopped");
  });

  it("keeps reporting and a long coordinator operation alive through monitoring refusal and timeout", async () => {
    const f = await fixture();
    const readStarted = deferred<void>();
    const readMonitoring = vi.fn()
      .mockRejectedValueOnce(new ApiError({ operation: "monitoring.read" }, "response", { status: 503, cause: new Error("private server response") }))
      .mockImplementationOnce(async (_worker: string, operation: Operation) => {
        readStarted.resolve();
        return await new Promise((_resolve, reject) => operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true }));
      });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring, writeMonitoring: vi.fn() });
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const coordinator = mocks.coordinator.mock.results[0]!.value;
    await eventuallyWithoutAdvancingTime(() => { expect(coordinator.tick).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalled(); expect(readMonitoring).toHaveBeenCalledOnce(); });
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_monitoring_failed" })));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); await readStarted.promise;
    await eventuallyWithoutAdvancingTime(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    expect(coordinator.tick).toHaveBeenCalledOnce(); expect(shutdown).not.toHaveBeenCalled();
    const after = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit.mock.calls.some(([event]) => event.kind === "worker_monitoring_failed" && event.message.includes('"timeout"'))).toBe(true));
    expect(report.mock.calls.length).toBeGreaterThanOrEqual(after);
    expect(coordinator.tick).toHaveBeenCalledOnce();
    f.signal.abort(); await running;
  });

  it.each([
    ["invalid-response", () => new ProtocolError("private response")],
    ["limit-exceeded", () => new OperationError("request_limit")],
  ])("keeps reporting and shutdown progressing during monitoring %s", async (code, failure) => {
    const f = await fixture(), stopping = deferred<void>();
    const readMonitoring = vi.fn(async () => { throw failure(); });
    shutdown.mockImplementation(async () => { await stopping.promise; return true; });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring, writeMonitoring: vi.fn() });
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => { expect(report).toHaveBeenCalled(); expect(mocks.coordinator).toHaveBeenCalledOnce(); expect(readMonitoring).toHaveBeenCalledOnce(); });
    await eventuallyWithoutAdvancingTime(() => expect(mocks.emit.mock.calls.some(([event]) => event.kind === "worker_monitoring_failed" && event.message.includes(`"${code}"`))).toBe(true));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventuallyWithoutAdvancingTime(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.coordinator.mock.results[0]!.value.tick).toHaveBeenCalledOnce();
    f.signal.abort(); await eventuallyWithoutAdvancingTime(() => expect(shutdown).toHaveBeenCalledOnce());
    expect(shutdown.mock.results[0]!.value).toBeInstanceOf(Promise);
    stopping.resolve(); await running;
  });

  it("sends stopping while shutdown is pending, then sends stopped before joining resources", async () => {
    const f = await fixture();
    const stopping = deferred<void>(); const writes: string[] = []; const order: string[] = [];
    shutdown.mockImplementation(async () => { order.push("shutdown-started"); await stopping.promise; order.push("shutdown-complete"); return true; });
    dispose.mockImplementation(async () => { order.push("git-disposed"); });
    const readMonitoring = vi.fn(async () => ({ state: "absent" }));
    const writeMonitoring = vi.fn(async (_worker: string, _revision: string | null, observation: { lifecycle: string; runId: string; sequence: string }) => {
      writes.push(observation.lifecycle); order.push(`write-${observation.lifecycle}`);
      return { revision: uuid(8), runId: observation.runId, sequence: observation.sequence };
    });
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, readMonitoring, writeMonitoring });
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => { expect(mocks.coordinator).toHaveBeenCalledOnce(); expect(writeMonitoring).toHaveBeenCalledOnce(); });
    f.signal.abort();
    await eventuallyWithoutAdvancingTime(() => expect(shutdown).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    await eventuallyWithoutAdvancingTime(() => expect(writes).toContain("stopping"));
    expect(order).not.toContain("shutdown-complete");
    stopping.resolve(); await running;
    expect(writes.at(-1)).toBe("stopped");
    expect(order.indexOf("shutdown-complete")).toBeLessThan(order.indexOf("write-stopped"));
    expect(order.indexOf("write-stopped")).toBeLessThan(order.indexOf("git-disposed"));
    const count = writes.length; await vi.advanceTimersByTimeAsync(60_000); expect(writes).toHaveLength(count);
  });
});
