import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { ApiError } from "../../../src/api/client.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport } from "../../../src/api/types.js";
import type { WorkerCloudDesired, WorkerCloudReport, WorkerCloudReportReceipt } from "../../../src/api/worker-configuration.js";
import type { WorkerCoordinatorOptions } from "../../../src/commands/worker/coordinator.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import { runWorker } from "../../../src/commands/worker/runtime.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

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
  target = { revision: "1", updatedAt: workerTelemetryTime, value: { maxConcurrent: 1, pollIntervalMs: 60_000, recoveryLimit: 3, native: { agent: "codex", model: null, args: [] }, projects: [{ projectId: uuid(1), nativeOverrides: {} }] } };
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
    const f = await fixture(), order: string[] = [];
    const remote = mocks.remote(); mocks.remote.mockClear();
    remote.configuration.mockImplementation(async () => {
      order.push("GET");
      throw new ApiError({ operation: "worker.configuration" }, "response", { cause: new Error("Worker missing."), status: 404, serverError: { code: "not_found", message: "Worker missing.", requestId: "missing-worker" } });
    });
    collect.mockResolvedValueOnce({ telemetry: workerTelemetry, issues: [] });
    collect.mockResolvedValue({ telemetry: { ...workerTelemetry, sampledAt: "2026-10-29T00:00:30.000Z" }, issues: [] });
    let reports = 0;
    report.mockImplementation(async (_workerId, _body, configuration) => {
      order.push("POST"); reports++;
      if (reports === 1) throw new ApiError({ operation: "worker.reportConfiguration" }, "request", { cause: new Error("Report outcome unknown."), outcomeUnconfirmed: true });
      return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: { ...target, value: configuration.bootstrap! }, observationRevision: "0", observationAccepted: false } };
    });
    const running = start(f);
    await eventually(() => expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({ kind: "worker_report_failed" })));
    expect(report).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => expect(report).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["GET", "POST", "GET", "POST"]);
    expect(report.mock.calls[0]![1].sampledAt).toBe(workerTelemetryTime);
    expect(report.mock.calls[1]![1].sampledAt).toBe("2026-10-29T00:00:30.000Z");
    for (const [, , configuration] of report.mock.calls) { expect(configuration.bootstrap!.maxConcurrent).toBe(9); expect(configuration.observation).toBeNull(); }
    expect(report.mock.calls[1]![2]).not.toBe(report.mock.calls[0]![2]);
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
    target = { revision: "2", updatedAt: workerTelemetryTime, value: { ...target.value, maxConcurrent: 3, pollIntervalMs: 250, recoveryLimit: 8, native: { agent: "codex", model: "new-model", args: [] } } };
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

  it("wakes an existing long polling wait when readiness or the applied interval changes", async () => {
    const f = await fixture(), prepared = deferred<void>();
    const longInterval = 2_000_000_000;
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
    target = { ...target, revision: "2", value: { ...target.value, pollIntervalMs: 25 } };
    await vi.advanceTimersByTimeAsync(30_000);
    await eventually(() => { expect(previousWait.aborted).toBe(true); expect(tick.mock.calls.length).toBeGreaterThan(ticksBeforeAcknowledgment); expect(mocks.delay.mock.calls.some(([milliseconds]) => milliseconds === 25)).toBe(true); });
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
    const f = await fixture();
    target = { ...target, value: { ...target.value, maxConcurrent: 4 } };
    mocks.probe.mockRejectedValue(new Error("private-native-probe-output"));
    const running = start(f);
    await eventually(() => expect(mocks.probe).toHaveBeenCalled());
    await eventually(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(report.mock.calls.at(-1)![2].observation!.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { kind: "maxConcurrent" }, appliedValue: 4, state: "applied" }),
        expect.objectContaining({ key: { kind: "native" }, appliedValue: null, state: "error", error: expect.any(Object), lastFailure: expect.any(Object) }),
      ]));
    });
    expect(JSON.stringify(report.mock.calls.at(-1)![2])).not.toContain("private-native-probe-output");
    expect(mocks.coordinator).toHaveBeenCalledOnce();
    expect(mocks.coordinator.mock.calls[0]![0]).toMatchObject({ globalConfiguration: null, repositories: [], maxConcurrent: 4 });
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
