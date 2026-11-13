import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerCloudDesired, WorkerCloudReceipt, WorkerCloudReport, WorkerCloudReportReceipt, WorkerCloudResource } from "../../../src/api/worker-configuration.js";
import { createWorkerConfigurationExchange, syncWorkerConfigurationOnce, workerConfigurationDiagnosticFailures } from "../../../src/commands/worker/configuration-exchange.js";
import type { WorkerConfigurationExchangeEvent } from "../../../src/commands/worker/configuration-exchange.js";
import { createWorkerPromptSource } from "../../../src/commands/worker/prompt-source.js";
import { workerTelemetry, workerTelemetryTime } from "../../fixtures/worker-telemetry.js";

const target = (revision = "1"): WorkerCloudDesired => ({ revision, updatedAt: workerTelemetryTime, value: {
  agentControlMode: "web", toolPaths: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } },
  maxConcurrent: 1, pollIntervalMs: 30_000, recoveryLimit: 2, preferPlatformSpecificTasks: false,
  native: { agent: "codex", model: null, args: [] }, projects: [],
} });
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
};
const operations: Operation[] = [];
const operation = (): Operation => { const current = createOperation({ limits: { totalMs: 10_000 } }); operations.push(current); return current; };
afterEach(() => { for (const current of operations.splice(0)) current.dispose(); });

const fixture = () => {
  const order: string[] = [];
  let state = { generation: "original", desired: target() as WorkerCloudDesired | null, observationRevision: "5", synchronized: true };
  const captures = new WeakMap<WorkerCloudReport, string>();
  const contexts = new WeakMap<WorkerCloudReport, { reportId: string; generation: string; baseRevision: string; recordIds: readonly string[]; failures: readonly { sourceRecordId: string; failureId: number }[]; items: readonly [] }>();
  let authorityRead = true, nextReportId = 0;
  const manager = {
    current: () => state,
    hasAuthority: () => authorityRead,
    waitReady: vi.fn(async () => { order.push("ready"); }),
    receive: vi.fn(async (desired: WorkerCloudDesired | null, revision = "0") => { authorityRead = true; state = { generation: `read-${state.generation}`, desired, observationRevision: revision, synchronized: true }; order.push("install"); }),
    report: vi.fn((bootstrap: WorkerCloudReport["bootstrap"] = null): WorkerCloudReport => {
      order.push("capture");
      const report: WorkerCloudReport = { controlModeBootstrap: "web", toolPathsBootstrap: { codex: { kind: "auto" }, copilot: { kind: "auto" }, herdr: { kind: "auto" } }, ...(state.desired === null ? { bootstrap, observation: null } : { bootstrap: null, observation: { baseRevision: state.observationRevision, desiredRevision: state.desired.revision, items: [] } }) };
      captures.set(report, state.generation);
      contexts.set(report, { reportId: `report-${++nextReportId}`, generation: state.generation, baseRevision: state.observationRevision, recordIds: [], failures: [], items: [] });
      return report;
    }),
    isCurrentReport: (report: WorkerCloudReport) => captures.get(report) === state.generation,
    reportContext: (report: WorkerCloudReport) => contexts.get(report),
    acknowledge: vi.fn(async (sent: WorkerCloudReport, receipt: WorkerCloudReceipt): Promise<"persisted" | "ignored"> => { if (captures.get(sent) !== state.generation) return "ignored"; state = { generation: state.generation, desired: receipt.desired, observationRevision: receipt.observationRevision, synchronized: true }; order.push("accept"); return "persisted"; }),
  };
  const read = vi.fn(async (_operation: Operation): Promise<WorkerCloudResource> => { order.push("read"); return { desired: state.desired, observationRevision: state.observationRevision, observation: null }; });
  const send = vi.fn(async (): Promise<WorkerCloudReportReceipt> => { order.push("send"); return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: state.desired, observationRevision: String(Number(state.observationRevision) + 1), observationAccepted: state.desired !== null } }; });
  const collect = vi.fn(async () => { order.push("collect"); return { ...workerTelemetry, taskInventory: null }; });
  return { manager, read, send, collect, order, setAuthority: (read: boolean) => { authorityRead = read; }, replace: (value: Partial<typeof state>) => { state = { ...state, ...value }; } };
};

it("prepares authority before collecting a fresh sample and avoids reads on a synchronized normal cycle", async () => {
  const f = fixture(), readEntered = deferred(), releaseRead = deferred();
  f.read.mockImplementationOnce(async () => { f.order.push("read"); readEntered.resolve(); await releaseRead.promise; return { desired: target("2"), observationRevision: "1", observation: null }; });
  const exchange = createWorkerConfigurationExchange(f);
  const first = syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  await readEntered.promise;
  expect(f.collect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  releaseRead.resolve(); await first;
  expect(f.order).toEqual(["ready", "read", "install", "collect", "capture", "send", "accept"]);
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(f.read).toHaveBeenCalledOnce(); expect(f.collect).toHaveBeenCalledTimes(2);
});

it("discards a sample when authority changes during collection without consuming its prompt batch", async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const promptSource = createWorkerPromptSource({ serverOrigin: "https://daynight.example", userId: "22222222-2222-4222-8222-222222222222", workerId: "33333333-3333-4333-8333-333333333333" });
  const captureBatch = vi.fn(promptSource.captureBatch);
  const prompts = { ...promptSource, captureBatch };
  prompts.beginCycle();
  f.collect.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ...workerTelemetry, taskInventory: null }; });
  const exchange = createWorkerConfigurationExchange({ ...f, prompts, needsRead: false });
  const first = syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  await entered.promise;
  f.replace({ generation: "new-authority", desired: target("2") });
  release.resolve();
  expect(await first).toMatchObject({ dropped: true });
  expect(f.manager.report).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(captureBatch).not.toHaveBeenCalled();
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(f.collect).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledOnce(); expect(captureBatch).toHaveBeenCalledOnce();
  prompts.close();
});

it("checks the exact capture immediately before sending", async () => {
  const f = fixture();
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, onStage: event => { if (event.phase === "report-send" && event.status === "started") f.replace({ generation: "late-authority" }); } });
  expect(await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).toMatchObject({ dropped: true });
  expect(f.manager.report).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(f.manager.acknowledge).not.toHaveBeenCalled();
});

it("cancels a bootstrap-drain waiter while the shared cleanup remains owned", async () => {
  const f = fixture(), entered = deferred(), release = deferred(), cancellation = new AbortController();
  let drained = false;
  const bootstrap = { prepare: vi.fn(async () => null), invalidate: vi.fn(), clear: vi.fn(async () => { entered.resolve(); await release.promise; drained = true; }) };
  const exchange = createWorkerConfigurationExchange({ ...f, bootstrap, needsRead: false });
  const current = createOperation({ signal: cancellation.signal }); operations.push(current);
  const syncing = syncWorkerConfigurationOnce({ configuration: exchange, operation: current, report: f.collect });
  await entered.promise;
  const reason = new Error("cycle cancelled"); cancellation.abort(reason);
  await expect(syncing).rejects.toMatchObject({ kind: "cancelled", cause: reason });
  expect(drained).toBe(false); expect(f.collect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  release.resolve(); await exchange.close();
  expect(drained).toBe(true);
});

it.each([
  new ApiError({ operation: "worker.configuration.report" }, "request", { cause: new Error("response lost"), outcomeUnconfirmed: true }),
  new ApiError({ operation: "worker.configuration.report" }, "response", { cause: new Error("invalid"), status: 400 }),
  new ApiError({ operation: "worker.configuration.report" }, "protocol", { cause: new Error("malformed") }),
])("reads authority before the next sample after an unknown or invalid report", async error => {
  const f = fixture();
  f.send.mockRejectedValueOnce(error);
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(error);
  f.order.length = 0;
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(f.order).toEqual(["ready", "read", "install", "collect", "capture", "send", "accept"]);
  expect(f.manager.acknowledge).toHaveBeenCalledOnce();
});

it("keeps null observation rejection normal and lets a current service target cancel bootstrap", async () => {
  const f = fixture(); f.replace({ desired: null, observationRevision: "0" });
  const bootstrap = { prepare: vi.fn(async () => target().value), invalidate: vi.fn(), clear: vi.fn(async () => {}) };
  f.send.mockResolvedValueOnce({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: null, observationRevision: "0", observationAccepted: false } });
  const exchange = createWorkerConfigurationExchange({ ...f, bootstrap });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).resolves.toMatchObject({ promptError: false });
  expect(bootstrap.prepare).toHaveBeenCalledOnce(); expect(bootstrap.invalidate).not.toHaveBeenCalled();
  f.read.mockResolvedValueOnce({ desired: target("2"), observationRevision: "1", observation: null });
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(f.read).toHaveBeenCalledTimes(2); expect(bootstrap.prepare).toHaveBeenCalledOnce(); expect(bootstrap.clear).toHaveBeenCalled();
  expect(f.manager.report.mock.calls[1]![0]).toBeNull();
});

it("uses a rejected observation's canonical receipt for a new report without replay or an extra read", async () => {
  const f = fixture();
  f.send.mockResolvedValueOnce({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target("2"), observationRevision: "1", observationAccepted: false } });
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false });
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(f.read).not.toHaveBeenCalled(); expect(f.collect).toHaveBeenCalledTimes(2);
  expect(f.manager.report.mock.results.map(result => result.value.observation)).toEqual([
    { baseRevision: "5", desiredRevision: "1", items: [] },
    { baseRevision: "1", desiredRevision: "2", items: [] },
  ]);
  expect(f.manager.acknowledge).toHaveBeenCalledTimes(2);
});

it.each([false, true])("invalidates a refused bootstrap only when its rejection is certain (unknown: %s)", async unknown => {
  const f = fixture(); f.replace({ desired: null, observationRevision: "0" });
  const bootstrap = { prepare: vi.fn(async () => target().value), invalidate: vi.fn(), clear: vi.fn(async () => {}) };
  const failure = new ApiError({ operation: "worker.configuration.report" }, unknown ? "request" : "response", { cause: new Error("import refused"), ...(unknown ? { outcomeUnconfirmed: true } : { status: 404 }) });
  f.send.mockRejectedValueOnce(failure);
  const exchange = createWorkerConfigurationExchange({ ...f, bootstrap });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(bootstrap.invalidate).toHaveBeenCalledTimes(unknown ? 0 : 1);
  expect(f.manager.acknowledge).not.toHaveBeenCalled();
});

it("separates a successful remote receipt from its still-pending local acceptance", async () => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [], failure = new Error("waiter cancelled");
  f.manager.acknowledge.mockRejectedValueOnce(failure);
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, onStage: event => events.push(event) });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(events.at(-1)).toMatchObject({ phase: "receipt-accept", status: "failed", remoteOutcome: "success", localOutcome: "pending", error: failure, source: { generation: "original", desiredRevision: "1", observationRevision: "5" } });
  expect(new Set(events.map(event => event.syncId)).size).toBe(1);
  expect(events.filter(event => event.phase === "receipt-accept" && event.status === "succeeded")).toHaveLength(0);
});


it("distinguishes unread cached authority from an authenticated null target and its valid zero baseline", async () => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [];
  f.setAuthority(false);
  f.read.mockResolvedValueOnce({ desired: null, observationRevision: "0", observation: null });
  const exchange = createWorkerConfigurationExchange({ ...f, onStage: event => events.push(event) });
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(events.find(event => event.phase === "authority-read" && event.status === "started")).toMatchObject({
    source: { state: "unread", desiredRevision: "1", observationRevision: "5" },
  });
  expect(events.find(event => event.phase === "authority-read" && event.status === "succeeded")).toMatchObject({
    source: { state: "uninitialized", desiredRevision: null, observationRevision: "0" },
    remoteOutcome: "success", localOutcome: "persisted",
    previousSource: { state: "unread", desiredRevision: "1", observationRevision: "5" },
    received: { desiredRevision: null, observationRevision: "0" },
  });
  expect(events.find(event => event.phase === "report-send" && event.status === "succeeded")).toMatchObject({
    remoteOutcome: "success", observationAccepted: false, report: { reportId: "report-1", baseRevision: "0" },
  });
  await exchange.close();
});

it("retains the captured token and reports an ignored stale receipt without claiming a local update", async () => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [];
  f.send.mockImplementationOnce(async () => {
    f.replace({ generation: "replacement", desired: target("2"), observationRevision: "9" });
    return { observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime, configuration: { desired: target(), observationRevision: "6", observationAccepted: true } };
  });
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, onStage: event => events.push(event) });
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(f.manager.current()).toMatchObject({ generation: "replacement", observationRevision: "9" });
  expect(events.at(-1)).toMatchObject({ phase: "receipt-accept", status: "succeeded", remoteOutcome: "success", localOutcome: "ignored",
    source: { generation: "original", observationRevision: "5" }, report: { reportId: "report-1", generation: "original", baseRevision: "5" } });
  await exchange.close();
});

it("preserves successful send and acceptance when diagnostic callbacks fail and exposes their original errors at close", async () => {
  const f = fixture(), sentFailure = new Error("send formatter failed"), acceptFailure = new Error("accept formatter failed");
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, onStage: event => {
    if (event.status === "succeeded" && event.phase === "report-send") throw sentFailure;
    if (event.status === "succeeded" && event.phase === "receipt-accept") throw acceptFailure;
  } });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).resolves.toMatchObject({ promptError: false });
  expect(f.send).toHaveBeenCalledOnce(); expect(f.manager.acknowledge).toHaveBeenCalledOnce();
  expect(f.manager.current().observationRevision).toBe("6");
  expect(workerConfigurationDiagnosticFailures(exchange)).toEqual([sentFailure, acceptFailure]);
  await expect(exchange.close()).rejects.toMatchObject({ errors: [sentFailure, acceptFailure], cause: sentFailure });
});

it("keeps authority preparation outcomes independent of its failing diagnostic notification", async () => {
  const f = fixture(), notification = new Error("authority formatter failed");
  const exchange = createWorkerConfigurationExchange({ ...f, onStage: event => { if (event.phase === "authority-read") throw notification; } });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).resolves.toMatchObject({ promptError: false });
  expect(f.read).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce(); expect(f.manager.acknowledge).toHaveBeenCalledOnce();
  await expect(exchange.close()).rejects.toBe(notification);
});


it("retains known local persistence when later bootstrap cleanup fails", async () => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [], failure = new Error("bootstrap cleanup failed");
  const bootstrap = { prepare: vi.fn(async () => null), invalidate: vi.fn(), clear: vi.fn(async () => {}) };
  bootstrap.clear.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, bootstrap, onStage: event => events.push(event) });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(f.manager.current().observationRevision).toBe("6");
  expect(f.manager.acknowledge).toHaveBeenCalledOnce();
  expect(events.at(-1)).toMatchObject({ phase: "receipt-accept", status: "failed", remoteOutcome: "success", localOutcome: "persisted", error: failure });
  await exchange.close();
});


it.each(["authority-read", "bootstrap-prepare", "telemetry-collect", "observation-capture"] as const)("records a failure at its actual %s phase before dispatch", async phase => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [], failure = phase === "authority-read"
    ? new ApiError({ operation: "worker.configuration" }, "prepare", { cause: new Error("controlled preparation failure") }) : new Error("controlled failure");
  const bootstrap = { prepare: vi.fn(async () => null), invalidate: vi.fn(), clear: vi.fn(async () => {}) };
  if (phase === "authority-read") f.read.mockRejectedValueOnce(failure);
  else if (phase === "bootstrap-prepare") { f.replace({ desired: null, observationRevision: "0" }); bootstrap.prepare.mockRejectedValueOnce(failure); }
  else if (phase === "telemetry-collect") f.collect.mockRejectedValueOnce(failure);
  else f.manager.report.mockImplementationOnce(() => { throw failure; });
  const exchange = createWorkerConfigurationExchange({ ...f, bootstrap, onStage: event => events.push(event) });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(events.at(-1)).toMatchObject({ phase, status: "failed", remoteOutcome: "not_sent", localOutcome: "not_attempted", error: failure });
  expect(f.send).not.toHaveBeenCalled(); expect(f.manager.acknowledge).not.toHaveBeenCalled();
  await exchange.close();
});

it.each([
  [new ApiError({ operation: "worker.configuration.report" }, "prepare", { cause: new Error("not dispatched") }), "not_sent"],
  [new ApiError({ operation: "worker.configuration.report" }, "request", { cause: new Error("lost response"), outcomeUnconfirmed: true }), "unknown"],
  [new ApiError({ operation: "worker.configuration.report" }, "protocol", { cause: new Error("invalid response"), outcomeUnconfirmed: true }), "unknown"],
  [new ApiError({ operation: "worker.configuration.report" }, "protocol", { cause: new Error("invalid response") }), "unknown"],
  [new ApiError({ operation: "worker.configuration.report" }, "request", { cause: new Error("request failure without a trusted reply") }), "unknown"],
  [new ApiError({ operation: "worker.configuration.report" }, "response", { cause: new Error("refused"), status: 403, confirmedRefusal: true,
    serverError: { code: "forbidden", requestId: "request-correlated", message: "private response" } }), "rejected"],
] as const)("retains report dispatch certainty and available request identity (%s)", async (failure, outcome) => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [];
  f.send.mockRejectedValueOnce(failure);
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, onStage: event => events.push(event) });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(events.at(-1)).toMatchObject({ phase: "report-send", status: "failed", remoteOutcome: outcome, localOutcome: "not_attempted", report: { reportId: "report-1", baseRevision: "5" } });
  if (outcome === "rejected") expect(events.at(-1)?.requestId).toBe("request-correlated");
  expect(f.manager.acknowledge).not.toHaveBeenCalled();
  await exchange.close();
});

it("records a rejected nonempty observation as a confirmed report before canonical local persistence", async () => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [];
  f.send.mockResolvedValueOnce({ observedAt: workerTelemetryTime, lastReportedAt: workerTelemetryTime,
    configuration: { desired: target("2"), observationRevision: "1", observationAccepted: false } });
  const exchange = createWorkerConfigurationExchange({ ...f, needsRead: false, onStage: event => events.push(event) });
  await syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect });
  expect(events.find(event => event.phase === "report-send" && event.status === "succeeded")).toMatchObject({ remoteOutcome: "success", observationAccepted: false, localOutcome: "not_attempted" });
  expect(events.at(-1)).toMatchObject({ phase: "receipt-accept", status: "succeeded", remoteOutcome: "success", observationAccepted: false, localOutcome: "persisted", received: { desiredRevision: "2", observationRevision: "1" } });
  expect(f.manager.current()).toMatchObject({ desired: target("2"), observationRevision: "1" });
  await exchange.close();
});


it("retains received canonical authority while its local installation is still pending", async () => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [], failure = new Error("local acceptance pending");
  f.read.mockResolvedValueOnce({ desired: target("2"), observationRevision: "1", observation: null });
  f.manager.receive.mockRejectedValueOnce(failure);
  const exchange = createWorkerConfigurationExchange({ ...f, onStage: event => events.push(event) });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(events.at(-1)).toMatchObject({ phase: "authority-read", status: "failed", remoteOutcome: "success", localOutcome: "pending", received: { desiredRevision: "2", observationRevision: "1" },
    previousSource: { generation: "original", desiredRevision: "1", observationRevision: "5" }, source: { generation: "original", desiredRevision: "1", observationRevision: "5" } });
  expect(f.collect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  await exchange.close();
});


it.each([
  [new ApiError({ operation: "worker.configuration" }, "prepare", { cause: new Error("preparation failed") }), "not_sent"],
  [new ApiError({ operation: "worker.configuration" }, "request", { cause: new Error("request failed") }), "unknown"],
  [new ApiError({ operation: "worker.configuration" }, "protocol", { cause: new Error("untrusted response") }), "unknown"],
  [new ApiError({ operation: "worker.configuration" }, "response", { cause: new Error("refused"), status: 403, confirmedRefusal: true }), "rejected"],
  [new ApiError({ operation: "worker.configuration" }, "response", { cause: new Error("unavailable"), status: 503 }), "rejected"],
  [new ApiError({ operation: "worker.configuration" }, "response", { cause: new Error("unconfirmed"), status: 503, outcomeUnconfirmed: true }), "unknown"],
] as const)("records failed authority-read request certainty (%s)", async (failure, outcome) => {
  const f = fixture(), events: WorkerConfigurationExchangeEvent[] = [];
  f.read.mockRejectedValueOnce(failure);
  const exchange = createWorkerConfigurationExchange({ ...f, onStage: event => events.push(event) });
  await expect(syncWorkerConfigurationOnce({ configuration: exchange, operation: operation(), report: f.collect })).rejects.toBe(failure);
  expect(events.at(-1)).toMatchObject({ phase: "authority-read", status: "failed", remoteOutcome: outcome, localOutcome: "not_attempted" });
  expect(events.at(-1)).not.toHaveProperty("received");
  expect(f.manager.receive).not.toHaveBeenCalled(); expect(f.collect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  await exchange.close();
});
