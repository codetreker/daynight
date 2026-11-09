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
import type { Observation } from "../../../src/commands/worker/monitoring/types.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

// These Task/configuration fixtures do not own a Bot service or native execution.
vi.mock("../../../src/commands/worker/bots/host.js", () => ({ createWorkerBotHost: () => ({
  run: async () => {}, shutdown: async () => {}, collect: async () => undefined, close: () => {},
}) }));

const mocks = vi.hoisted(() => ({ coordinator: vi.fn(), herdr: vi.fn(), git: vi.fn(), prompt: vi.fn(), remote: vi.fn(), telemetry: vi.fn(), webOpen: vi.fn(), webClose: vi.fn(), emit: vi.fn(), completed: vi.fn(), archive: vi.fn(), ticket: vi.fn(), delay: vi.fn(), probe: vi.fn() }));
vi.mock("node:timers/promises", async original => {
  const actual = await original<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: (...args: Parameters<typeof actual.setTimeout>) => mocks.delay(...args) };
});
vi.mock("../../../src/commands/controller/archive-upload.js", () => ({ uploadStoppedControllerArchive: mocks.archive }));
vi.mock("../../../src/commands/controller/launch-ticket.js", async original => ({ ...await original<object>(), readLaunchTicket: mocks.ticket }));
vi.mock("../../../src/commands/worker/coordinator.js", () => ({ createWorkerCoordinator: mocks.coordinator }));
vi.mock("../../../src/commands/worker/herdr.js", () => ({ createWorkerHerdr: mocks.herdr }));
vi.mock("../../../src/commands/worker/worktrees.js", async original => ({ ...await original<object>(), createWorkerGitManager: mocks.git }));
vi.mock("../../../src/commands/worker/prompts.js", () => ({ createWorkerPromptBuilder: mocks.prompt }));
vi.mock("../../../src/commands/worker/remote.js", () => ({ createWorkerRemote: mocks.remote }));
vi.mock("../../../src/commands/worker/telemetry.js", () => ({ createWorkerTelemetryCollector: mocks.telemetry }));
vi.mock("../../../src/commands/worker/herdr/version-probe.js", () => ({ probeNativeAgentVersion: mocks.probe }));
vi.mock("../../../src/commands/worker/backends/web-store.js", () => ({ openWebExecutionStore: mocks.webOpen }));
vi.mock("../../../src/commands/worker/backends/web.js", () => ({ createWebExecutionBackend: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/web-process.js", () => ({ createWebControllerLauncher: () => ({}) }));
vi.mock("../../../src/commands/worker/backends/grant-renewal.js", () => ({ maintainWorkerControllerGrants: async () => {} }));
vi.mock("../../../src/commands/worker/diagnostics.js", () => ({ createWorkerDiagnostics: async () => ({ emit: mocks.emit, flush: async () => {}, filename: "worker.jsonl" }) }));

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
  mocks.delay.mockImplementation((await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises")).setTimeout);
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
  mocks.git.mockReturnValue({ prepareRepository: prepare, dispose, listWorktrees: vi.fn(async () => []) });
  mocks.herdr.mockReturnValue({ stopInstance: vi.fn(async () => ({ stopped: true })), attachment: {} });
  mocks.prompt.mockResolvedValue(() => "prompt");
  mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({ tick: vi.fn(async () => { if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); }), updateConfiguration: update, shutdown }));
});
afterEach(async () => {
  for (const { signal } of runs) signal.abort();
  for (const settle of settlements) settle(); settlements.clear();
  await Promise.allSettled([...runs].map(({ running }) => running)); runs.clear();
  vi.restoreAllMocks(); vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});


describe("worker runtime monitoring isolation", () => {
  it("reports an initial configuration refusal in the stopped snapshot while preserving the original error", async () => {
    const f = await fixture();
    const original = new ApiError({ operation: "worker.configuration" }, "response", { status: 503, cause: new Error("private configuration payload") });
    const writes: Observation[] = [];
    const remote = mocks.remote(); mocks.remote.mockClear();
    mocks.remote.mockReturnValue({ ...remote, configuration: vi.fn().mockRejectedValue(original), readMonitoring: vi.fn(async () => ({ state: "absent" })), writeMonitoring: vi.fn(async (_worker: string, _revision: string | null, observation: Observation) => {
      writes.push(observation);
      return { revision: uuid(8), runId: observation.runId, sequence: observation.sequence };
    }) });
    await expect(start(f)).rejects.toBe(original);
    expect(writes.length).toBeGreaterThan(0);
    const final = writes.at(-1)!;
    expect(final.lifecycle).toBe("stopped");
    expect(final.admission).toMatchObject({ coverage: "partial", reasons: [{ code: "configuration-unavailable", scope: { kind: "worker" } }] });
    expect(final.currentFailures).toMatchObject([{ component: "configuration", phase: "configuration", scope: { kind: "worker" }, error: { type: "operation", code: "unavailable", cause: "A required service or resource is unavailable.", causeTruncated: false } }]);
    expect(JSON.stringify(final)).not.toContain("private configuration payload");
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
