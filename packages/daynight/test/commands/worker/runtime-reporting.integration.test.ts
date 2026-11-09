import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ApiError } from "../../../src/api/client.js";
import { OperationError } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport } from "../../../src/api/types.js";
import type { WorkerCloudDesired, WorkerCloudReport, WorkerCloudReportReceipt } from "../../../src/api/worker-configuration.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
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
vi.mock("../../../src/commands/worker/worktrees.js", () => ({ createWorkerGitManager: mocks.git }));
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
const eventually = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 3500, interval: 10 });
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
const configurationTransitions = () => mocks.emit.mock.calls.filter(([event]) => event.kind === "worker-configuration").map(([event]) => JSON.parse(event.message));
const fixture = async () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/runtime-reporting-tests");
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
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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

describe("worker runtime configuration reporting", () => {
  it("hot-loads platform preference into the coordinator in both directions", async () => {
    const f = await fixture(), running = start(f);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.preferPlatformSpecificTasks === false && configuration.repositories.length === 1)).toBe(true));
    update.mockClear();
    target = { ...target, revision: "2", value: { ...target.value, preferPlatformSpecificTasks: true } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.preferPlatformSpecificTasks === true && configuration.repositories.length === 1)).toBe(true));
    update.mockClear();
    target = { ...target, revision: "3", value: { ...target.value, preferPlatformSpecificTasks: false } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.some(([configuration]) => configuration.preferPlatformSpecificTasks === false && configuration.repositories.length === 1)).toBe(true));
    f.signal.abort(); await running;
  });
  it("rechecks the cloud target after a locally oversized report", async () => {
    const f = await fixture(), remote = mocks.remote(); mocks.remote.mockClear();
    report.mockImplementationOnce(async () => { throw new ApiError({ operation: "worker.reportConfiguration" }, "prepare", { cause: new OperationError("request_limit") }); });
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(remote.configuration).toHaveBeenCalledOnce();
    target = { ...target, revision: "2", value: { ...target.value, maxConcurrent: 2 } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(remote.configuration).toHaveBeenCalledTimes(2));
    await eventually(() => expect(report.mock.calls.at(-1)![2].observation?.desiredRevision).toBe("2"));
    f.signal.abort(); await running;
  });
  it("reports effective local sources separately and restores cloud sources after restart", async () => {
    const f = await fixture();
    const writeConfiguration = (overrides: object) => writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { agentControlMode: "web", ...overrides } }));
    target = { ...target, value: { ...target.value, native: { agent: "codex", model: "cloud-model", args: ["--effort", "medium"] }, projects: [] } };
    await writeConfiguration({ agentModel: "local-model", agentReasoningEffort: "high" });
    const running = start(f);
    await eventually(() => expect(configurationTransitions().some(item => item.key.kind === "native" && item.state === "applied")).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.some(([, body]) => body.runtimeConfiguration?.native?.model.value === "local-model")).toBe(true));
    const localReport = report.mock.calls.find(([, body]) => body.runtimeConfiguration?.native?.model.value === "local-model")!;
    expect(localReport[1].runtimeConfiguration!.native).toEqual({ agent: "codex", model: { value: "local-model", source: "local" }, reasoningEffort: { value: "high", source: "local" } });
    expect(localReport[2].observation!.items.find(item => item.key.kind === "native")!.appliedValue).toEqual(target.value.native);
    f.signal.abort(); await running;
    await writeConfiguration({});
    report.mockClear(); mocks.emit.mockClear();
    const restart = { ...f, signal: new AbortController() };
    const restarted = start(restart);
    await eventually(() => expect(configurationTransitions().some(item => item.key.kind === "native" && item.state === "applied")).toBe(true));
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.some(([, body]) => body.runtimeConfiguration?.native?.model.source === "cloud")).toBe(true));
    const restored = report.mock.calls.find(([, body]) => body.runtimeConfiguration?.native?.model.source === "cloud")![1];
    expect(restored.runtimeConfiguration!.native).toEqual({ agent: "codex", model: { value: "cloud-model", source: "cloud" }, reasoningEffort: { value: "medium", source: "cloud" } });
    restart.signal.abort(); await restarted;
  });

  it("reconciles an imported target after a lost bootstrap receipt before capturing another report", async () => {
    const f = await fixture(), order: string[] = [];
    target = { ...target, revision: "2", value: { ...target.value, maxConcurrent: 4, native: { ...target.value.native, model: "cloud-after-lost-receipt" } } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    let imported = false;
    remote.configuration.mockImplementation(async () => {
      order.push("GET");
      if (!imported) return { desired: null, observationRevision: "0", observation: null };
      return { desired: target, observationRevision: "5", observation: { baseRevision: "4", desiredRevision: "2", items: [], reportedAt: workerTelemetryTime } };
    });
    report.mockImplementation(async (_workerId, _body, _configuration) => {
      order.push("POST");
      if (!imported) {
        imported = true;
        throw new ApiError({ operation: "worker.reportConfiguration" }, "request", { cause: new Error("Bootstrap receipt lost."), outcomeUnconfirmed: true });
      }
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: "6", observationAccepted: true } };
    });
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(report).toHaveBeenCalledOnce(); expect(remote.configuration).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["GET", "POST", "GET", "POST"]);
    expect(report.mock.calls[0]![2].bootstrap!.maxConcurrent).toBe(9);
    expect(report.mock.calls[0]![2].observation).toBeNull();
    expect(report.mock.calls[1]![2].bootstrap).toBeNull();
    expect(report.mock.calls[1]![2].observation).toMatchObject({ baseRevision: "5", desiredRevision: "2" });
    expect(report.mock.calls[1]![2].observation!.items).toEqual(expect.arrayContaining([expect.objectContaining({ key: { kind: "maxConcurrent" }, targetRevision: "2" })]));
    expect(report.mock.calls[1]![2].observation!.items.every(item => item.targetRevision === "2")).toBe(true);
    f.signal.abort(); await running;
  });

  it("captures a fresh bootstrap after an unknown report is confirmed not to have created the Worker", async () => {
    const f = await fixture(), order: string[] = [], secondEntered = deferred<void>(), releaseSecond = deferred<void>();
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => {
      order.push("GET");
      throw new ApiError({ operation: "worker.configuration" }, "response", { cause: new Error("Worker missing."), status: 404, serverError: { code: "not_found", message: "Worker missing.", requestId: "missing-worker" } });
    });
    collect.mockResolvedValueOnce({ telemetry: workerTelemetry, issues: [] });
    collect.mockResolvedValue({ telemetry: { ...workerTelemetry, sampledAt: "2026-10-29T00:00:30.000Z" }, issues: [] });
    let reports = 0, imported: WorkerCloudDesired | undefined;
    report.mockImplementation(async (_workerId, _body, configuration) => {
      order.push("POST"); reports++;
      if (reports === 1) throw new ApiError({ operation: "worker.reportConfiguration" }, "request", { cause: new Error("Report outcome unknown."), outcomeUnconfirmed: true });
      if (reports === 2) { imported = { ...target, value: configuration.bootstrap! }; secondEntered.resolve(); await releaseSecond.promise; }
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: imported!, observationRevision: "0", observationAccepted: false } };
    });
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await secondEntered.promise;
    expect(report).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["GET", "POST", "GET", "POST"]);
    expect(report.mock.calls[0]![1].sampledAt).toBe(workerTelemetryTime);
    expect(report.mock.calls[1]![1].sampledAt).toBe("2026-10-29T00:00:30.000Z");
    for (const [, , configuration] of report.mock.calls) { expect(configuration.bootstrap!.maxConcurrent).toBe(9); expect(configuration.observation).toBeNull(); }
    expect(report.mock.calls[1]![2]).not.toBe(report.mock.calls[0]![2]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["GET", "POST", "GET", "POST"]);
    releaseSecond.resolve();
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_recovered" })));
    f.signal.abort(); await running;
  });

  it.each([60_000, 5_000])("backfills completed sessions fairly using the applied cloud polling interval %s", async pollIntervalMs => {
    const f = await fixture();
    target = { ...target, value: { ...target.value, pollIntervalMs } };
    let now = Date.parse(workerTelemetryTime), rounds = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const labels = new Map([[uuid(11), "broken"], [uuid(12), "second"], [uuid(13), "third"]]);
    mocks.completed.mockReturnValue([...labels.keys()].map(executionId => ({ serverOrigin: "https://daynight.example", webExecution: { executionId, launchId: executionId, sessionId: executionId, launchSubmission: "submitted" } })));
    mocks.ticket.mockImplementation(async (_home, launchId) => ({ serverOrigin: "https://daynight.example", executionId: launchId }));
    const attempts: { label: string; at: number; round: number }[] = [];
    mocks.archive.mockImplementation(async ({ ticket }) => { attempts.push({ label: labels.get(ticket.executionId)!, at: now, round: rounds }); if (ticket.executionId === uuid(11)) throw new Error("Original archive source is missing."); return { state: "ready" }; });
    const appliedDelays: number[] = [];
    const nativeTimer = await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    mocks.delay.mockImplementation(async (milliseconds, _value, options) => {
      await nativeTimer.setTimeout(0, undefined, options);
      if (mocks.coordinator.mock.calls.length !== 0) { now += milliseconds; appliedDelays.push(milliseconds); }
    });
    mocks.coordinator.mockImplementation(() => ({ tick: async () => { rounds++; if (appliedDelays.length === 4) f.signal.abort(); }, updateConfiguration: update, shutdown }));
    await start(f);
    expect(attempts.slice(0, 3).map(attempt => attempt.label)).toEqual(["broken", "second", "third"]);
    const retryTimes = attempts.filter(attempt => attempt.label === "broken").map(attempt => attempt.at);
    if (pollIntervalMs === 60_000) expect(retryTimes.length).toBeGreaterThanOrEqual(2);
    else expect(retryTimes).toHaveLength(1);
    for (let index = 1; index < retryTimes.length; index++) expect(retryTimes[index]! - retryTimes[index - 1]!).toBeGreaterThanOrEqual(60_000);
    for (let round = 1; round <= rounds; round++) expect(attempts.filter(attempt => attempt.round === round).length).toBeLessThanOrEqual(1);
    expect(appliedDelays).toEqual([pollIntervalMs, pollIntervalMs, pollIntervalMs, pollIntervalMs]);
    expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-ready")).toHaveLength(2);
    expect(mocks.emit.mock.calls.filter(([event]) => event.kind === "session-archive-retry")).toHaveLength(retryTimes.length);
  });

  it("keeps cloud reports independent of slow repository preparation and blocked reconciliation", async () => {
    const f = await fixture(), prepared = deferred<void>(); prepare.mockImplementation(() => prepared.promise);
    const running = start(f);
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());
    await eventually(() => expect(report).toHaveBeenCalled());
    const before = report.mock.calls.length;
    expect(report.mock.calls[0]![0]).toBe(uuid(4)); expect(report.mock.calls[0]![1].taskInventory).toBeNull();
    expect(mocks.telemetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ paths: f.paths, homeDirectory: f.homeDirectory, version: "9.8.7", workingDirectory: f.workingDirectory, workerId: uuid(4), serverOrigin: "https://daynight.example" }));
    await vi.advanceTimersByTimeAsync(30_000); await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    const coordinator = mocks.coordinator.mock.results[0]!.value;
    expect(options).toMatchObject({ repositories: [], readyProjectIds: [] });
    await eventually(() => expect(coordinator.tick).toHaveBeenCalledOnce());
    expect(update.mock.calls.every(([view]) => view.repositories.length === 0 && view.readyProjectIds.length === 0)).toBe(true);
    prepared.resolve();
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1)] })));
    const inReconciliation = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(inReconciliation));
    expect(coordinator.tick).toHaveBeenCalledOnce(); expect(shutdown).not.toHaveBeenCalled();
    options.onInventory!({ observedAt: workerTelemetryTime, claims: [] });
    await eventually(() => expect(report.mock.calls.at(-1)![1].taskInventory).toEqual({ observedAt: workerTelemetryTime, claims: [] }));
    const claim = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3) }; options.onClaim!(claim);
    await eventually(() => expect(report.mock.calls.at(-1)![1].taskInventory).toEqual({ observedAt: workerTelemetryTime, claims: [claim] }));
    expect(mocks.herdr).not.toHaveBeenCalled();
    f.signal.abort(); await running;
    const stoppedCount = report.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000); expect(report).toHaveBeenCalledTimes(stoppedCount);
  });

  it("publishes a newer cloud configuration into the same coordinator while its tick is blocked", async () => {
    const f = await fixture(); const running = start(f);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    const original = mocks.coordinator.mock.results[0]!.value;
    target = { revision: "2", updatedAt: workerTelemetryTime, value: { ...target.value, maxConcurrent: 3, pollIntervalMs: 1000, recoveryLimit: 8, preferPlatformSpecificTasks: false, native: { agent: "codex", model: "new-model", args: [] } } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 3, globalConfiguration: expect.objectContaining({ model: "new-model", recoveryLimit: 8 }) })));
    expect(mocks.coordinator).toHaveBeenCalledOnce(); expect(original.tick).toHaveBeenCalledOnce(); expect(shutdown).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "maxConcurrent" }, targetRevision: "2", appliedValue: 3, state: "applied" }),
      expect.objectContaining({ key: { kind: "native" }, targetRevision: "2", appliedValue: { agent: "codex", model: "new-model", args: [] }, state: "applied" }),
    ])));
    f.signal.abort(); await running;
  });

  it("excludes a removed project before stopping it and reports stop failures while heartbeats continue", async () => {
    const f = await fixture(), stopping = deferred<void>();
    const stopProject = vi.fn(async () => { await stopping.promise; throw new Error("private stop output"); });
    mocks.coordinator.mockImplementation((options: WorkerCoordinatorOptions) => ({
      tick: vi.fn(async () => { if (!options.signal!.aborted) await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true })); }),
      updateConfiguration: update, stopProject, shutdown,
    }));
    const running = start(f);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1)] })));
    target = { ...target, revision: "2", value: { ...target.value, projects: [] } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(stopProject).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ targetProjectIds: [], readyProjectIds: [] }));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    stopping.resolve();
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "projectRemoval", projectId: uuid(1) }, targetRevision: "2", state: "error" }),
      ]));
    });
    expect(JSON.stringify(report.mock.calls.at(-1)![2])).not.toContain("private stop output");
    f.signal.abort(); await running;
  });

  it("retains an unprepared local mapping while another project becomes ready", async () => {
    const f = await fixture(), secondRemote = "https://git.example/team/healthy.git";
    target = { ...target, value: { ...target.value, projects: [{ projectId: uuid(1), nativeOverrides: {} }, { projectId: uuid(2), nativeOverrides: {} }] } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: id === uuid(1) ? remoteUrl : secondRemote }));
    prepare.mockImplementation(async (binding: { projectId: string }) => { if (binding.projectId === uuid(1)) throw new Error("clone failed"); });
    const running = start(f);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(2)] })));
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    expect(options.store.getProject({ projectId: uuid(1) })).toMatchObject({ localPath: path.join(f.homeDirectory, "repo") });
    expect(options.store.getProject({ projectId: uuid(2) })).not.toBeNull();
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "projectPreparation", projectId: uuid(1) }, state: "error" }),
        expect.objectContaining({ key: { kind: "projectPreparation", projectId: uuid(2) }, state: "applied" }),
      ]));
    });
    f.signal.abort(); await running;
  });

  it("reserves overlapping paths during slow preparation without blocking an unrelated project", async () => {
    const f = await fixture(), slow = deferred<void>();
    const remotes = [remoteUrl, "https://git.example/team/nested.git", "https://git.example/team/healthy.git"];
    const locations = [path.join(f.homeDirectory, "repo"), path.join(f.homeDirectory, "repo", "nested"), path.join(f.homeDirectory, "healthy")];
    await writeFile(f.paths.configFile, stringify({ serverUrl: "https://daynight.example", serverToken: "dn_pat_abcdefghijklmnopqrstuvwxyz1234567890", workerId: uuid(4), worker: { repositories: remotes.map((remote, index) => ({ projectId: uuid(index + 1), remote, path: locations[index] })) } }));
    await mkdir(f.paths.workerDirectory, { recursive: true });
    const retained = openWorkerStore(f.paths.databaseFile);
    try { retained.registerProject({ projectId: uuid(1), repoUrl: remotes[0]!, localPath: locations[0]! }); }
    finally { retained.close(); }
    target = { ...target, value: { ...target.value, projects: remotes.map((_, index) => ({ projectId: uuid(index + 1), nativeOverrides: {} })) } };
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.project.mockImplementation(async (id: string) => ({ id, repoUrl: remotes[[uuid(1), uuid(2), uuid(3)].indexOf(id)] }));
    prepare.mockImplementation(async (binding: { projectId: string }) => { if (binding.projectId === uuid(1)) await slow.promise; });
    const running = start(f);
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(3)] })));
    expect(prepare.mock.calls.map(([binding]) => binding.projectId)).toEqual(expect.arrayContaining([uuid(1), uuid(3)]));
    expect(prepare.mock.calls.map(([binding]) => binding.projectId)).not.toContain(uuid(2));
    const options = mocks.coordinator.mock.calls[0]![0] as WorkerCoordinatorOptions;
    expect(options.store.getProject({ projectId: uuid(1) })).toMatchObject({ localPath: locations[0] });
    expect(options.store.getProject({ projectId: uuid(2) })).toBeNull();
    slow.resolve();
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1), uuid(3)] })));
    f.signal.abort(); await running;
  });

  it("wakes an existing long polling wait when readiness or the applied interval changes", async () => {
    const f = await fixture(), prepared = deferred<void>();
    const longInterval = 60_000;
    target = { ...target, value: { ...target.value, pollIntervalMs: longInterval } };
    prepare.mockImplementation(() => prepared.promise);
    const tick = vi.fn(async () => {});
    mocks.coordinator.mockImplementation(() => ({ tick, updateConfiguration: update, shutdown }));
    const waitingSignal = (): AbortSignal | undefined => mocks.delay.mock.calls.filter(([milliseconds]) => milliseconds === longInterval).at(-1)?.[2]?.signal;
    const running = start(f);
    await eventually(() => expect(prepare).toHaveBeenCalledOnce());
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "native" }, state: "applied" }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "applied" }),
      ]));
      expect(waitingSignal()).toBeDefined(); expect(waitingSignal()!.aborted).toBe(false);
    });
    const preparationWait = waitingSignal()!;
    if (mocks.coordinator.mock.calls.length > 0) expect(mocks.coordinator.mock.calls[0]![0]).toMatchObject({ repositories: [], readyProjectIds: [] });
    prepared.resolve();
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    await eventually(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ readyProjectIds: [uuid(1)] })));
    expect(preparationWait.aborted).toBe(true);
    await eventually(() => { expect(tick).toHaveBeenCalled(); expect(waitingSignal()).not.toBe(preparationWait); expect(waitingSignal()!.aborted).toBe(false); });
    const previousWait = waitingSignal()!, ticksBeforeAcknowledgment = tick.mock.calls.length, updatesBeforeAcknowledgment = update.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(update.mock.calls.length).toBeGreaterThan(updatesBeforeAcknowledgment));
    expect(previousWait.aborted).toBe(false); expect(tick).toHaveBeenCalledTimes(ticksBeforeAcknowledgment);
    target = { ...target, revision: "2", value: { ...target.value, pollIntervalMs: 1000 } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => { expect(previousWait.aborted).toBe(true); expect(tick.mock.calls.length).toBeGreaterThan(ticksBeforeAcknowledgment); expect(mocks.delay.mock.calls.some(([milliseconds]) => milliseconds === 1000)).toBe(true); });
    f.signal.abort(); await running;
  });

  it("keeps heartbeats alive through task backend initialization failure", async () => {
    const f = await fixture();
    const failure = new Error("Task backend state unavailable."); mocks.webOpen.mockImplementation(() => { throw failure; });
    const running = start(f);
    await eventually(() => expect(mocks.webOpen).toHaveBeenCalled());
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ error: failure })));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.coordinator).not.toHaveBeenCalled();
    f.signal.abort(); await running;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("reports an unavailable native tuple while independent scalar settings remain applied", async () => {
    const f = await fixture(), backend = deferred<() => string>();
    target = { ...target, value: { ...target.value, maxConcurrent: 4, pollIntervalMs: 1000, recoveryLimit: 8 } };
    mocks.prompt.mockImplementation(() => backend.promise);
    mocks.probe.mockRejectedValue(new Error("private-native-probe-output"));
    const running = start(f);
    await eventually(() => expect(mocks.prompt).toHaveBeenCalledOnce());
    await eventually(() => expect(configurationTransitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "maxConcurrent" }, state: "applied" }),
      expect.objectContaining({ key: { kind: "pollIntervalMs" }, state: "applied" }),
      expect.objectContaining({ key: { kind: "recoveryLimit" }, state: "applied" }),
      expect.objectContaining({ key: { kind: "native" }, state: "error" }),
      expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "error" }),
    ])));
    const before = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => {
      expect(report.mock.calls.length).toBeGreaterThan(before);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "maxConcurrent" }, appliedValue: 4, state: "applied" }),
        expect.objectContaining({ key: { kind: "pollIntervalMs" }, appliedValue: 1000, state: "applied" }),
        expect.objectContaining({ key: { kind: "recoveryLimit" }, appliedValue: 8, state: "applied" }),
        expect.objectContaining({ key: { kind: "native" }, appliedValue: null, state: "error", error: expect.any(Object), lastFailure: expect.any(Object) }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, appliedValue: null, state: "error", error: expect.any(Object), lastFailure: expect.any(Object) }),
      ]));
    });
    expect(JSON.stringify(report.mock.calls.map(([, , configuration]) => configuration))).not.toContain("private-native-probe-output");
    expect(JSON.stringify(configurationTransitions())).not.toContain("private-native-probe-output");
    expect(mocks.coordinator).not.toHaveBeenCalled();
    backend.resolve(() => "prompt");
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    expect(mocks.coordinator.mock.calls[0]![0]).toMatchObject({ globalConfiguration: null, repositories: [], maxConcurrent: 4 });
    await eventually(() => expect(mocks.coordinator.mock.results[0]!.value.tick).toHaveBeenCalledOnce());
    f.signal.abort(); await running;
  });

  it("applies a recovered native tuple on its scheduled retry through the existing coordinator", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const f = await fixture();
    target = { ...target, value: { ...target.value, maxConcurrent: 4, recoveryLimit: 8, preferPlatformSpecificTasks: false, native: { ...target.value.native, model: "recovered-model" } } };
    mocks.probe.mockRejectedValue(new Error("private-native-probe-output"));
    const running = start(f);
    await eventuallyWithoutAdvancingTime(() => expect(mocks.coordinator).toHaveBeenCalledOnce());
    await eventuallyWithoutAdvancingTime(() => expect(configurationTransitions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { kind: "native" }, state: "error" }),
      expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, state: "error" }),
    ])));
    const coordinator = mocks.coordinator.mock.results[0]!.value;
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ globalConfiguration: null, repositories: [], maxConcurrent: 4 }));
    const failedNative = configurationTransitions().filter(event => (event.key.kind === "native" || event.key.kind === "projectNative") && event.state === "error");
    const retryAt = Math.min(...failedNative.map(event => Date.parse(event.error.occurredAt) + 5_000));
    const attempts = mocks.probe.mock.calls.length;
    mocks.probe.mockResolvedValue("0.164.0");
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(mocks.probe).toHaveBeenCalledTimes(attempts);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ globalConfiguration: null, repositories: [], maxConcurrent: 4 }));
    await vi.advanceTimersByTimeAsync(1);
    await eventuallyWithoutAdvancingTime(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
      maxConcurrent: 4,
      globalConfiguration: expect.objectContaining({ agent: "codex", model: "recovered-model", args: [], recoveryLimit: 8 }),
      repositories: [expect.objectContaining({ configuration: expect.objectContaining({ agent: "codex", model: "recovered-model", args: [], recoveryLimit: 8 }) })],
    })));
    expect(mocks.probe).toHaveBeenCalledTimes(attempts + 2);
    expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(mocks.coordinator.mock.results[0]!.value).toBe(coordinator);
    expect(shutdown).not.toHaveBeenCalled();
    const reportsBeforeRecovery = report.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await eventuallyWithoutAdvancingTime(() => {
      expect(report.mock.calls.length).toBeGreaterThan(reportsBeforeRecovery);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "maxConcurrent" }, appliedValue: 4, state: "applied" }),
        expect.objectContaining({ key: { kind: "recoveryLimit" }, appliedValue: 8, state: "applied" }),
        expect.objectContaining({ key: { kind: "native" }, targetRevision: "1", appliedValue: target.value.native, state: "applied", error: null }),
        expect.objectContaining({ key: { kind: "projectNative", projectId: uuid(1) }, targetRevision: "1", appliedValue: target.value.native, state: "applied", error: null }),
      ]));
    });
    f.signal.abort(); await running;
  });

  it("joins the aborted in-flight configuration report before coordinator and backend teardown", async () => {
    const f = await fixture(), joined = deferred<void>(), cancelled = deferred<void>(), order: string[] = [];
    report.mockImplementation(async (_workerId, _body, _configuration, operation) => {
      operation.signal.addEventListener("abort", () => { order.push("report-aborted"); cancelled.resolve(); }, { once: true });
      await joined.promise; order.push("report-joined"); operation.check();
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target, observationRevision: "0", observationAccepted: false } };
    });
    shutdown.mockImplementation(async () => { order.push("coordinator"); return true; });
    dispose.mockImplementation(async () => { order.push("git"); }); mocks.webClose.mockImplementation(() => { order.push("web-store"); });
    const running = start(f);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce()); await eventually(() => expect(report).toHaveBeenCalledOnce());
    f.signal.abort(); await cancelled.promise;
    expect(shutdown).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled(); expect(mocks.webClose).not.toHaveBeenCalled();
    joined.resolve(); await running;
    expect(order).toEqual(["report-aborted", "report-joined", "coordinator", "git", "web-store"]);
  });

  it("preserves reporter cleanup uncertainty as the runtime result while completing resource teardown", async () => {
    const f = await fixture();
    const failure = new HerdrCommandCleanupError([new Error("unjoined process")], new Error("probe failed"));
    collect.mockResolvedValue({ telemetry: workerTelemetry, issues: [{ component: "codex", code: "command_failed", error: failure }] });
    const running = start(f); const rejected = expect(running).rejects.toBe(failure);
    await eventually(() => expect(mocks.coordinator).toHaveBeenCalledOnce()); await eventually(() => expect(report).toHaveBeenCalled());
    f.signal.abort(); await rejected;
    expect(shutdown).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce(); expect(mocks.webClose).toHaveBeenCalledOnce();
  });
});
