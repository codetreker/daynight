import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { WorkerCloudReceipt, WorkerCloudReport, WorkerCloudReportReceipt } from "../../../src/api/worker-configuration.js";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport, WorkerTaskReference, WorkerTelemetry } from "../../../src/api/types.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import { HerdrCommandCleanupError, runHerdrCommand } from "../../../src/commands/worker/herdr/command.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const timestamp = "2026-10-29T00:00:00.000Z";
const telemetry: WorkerTelemetry = {
  machine: { id: "machine", name: "machine" }, platform: "linux", workingDirectory: "/worker", sampledAt: timestamp,
  os: { state: "ok", checkedAt: timestamp, value: { type: "Linux", release: "6", version: "kernel", arch: "x64" } },
  cpu: { state: "ok", checkedAt: timestamp, value: { model: "CPU", logicalProcessors: 4, usagePercent: 12 } },
  memory: { state: "ok", checkedAt: timestamp, value: { usedBytes: 100, totalBytes: 200 } },
  disk: { state: "ok", checkedAt: timestamp, value: { availableBytes: 300, totalBytes: 400 } },
  versions: { daynight: "0.26.1", herdr: { state: "not_running", checkedAt: timestamp }, codex: { state: "not_installed", checkedAt: timestamp }, copilot: { state: "not_installed", checkedAt: timestamp } },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const fixture = () => {
  vi.useFakeTimers();
  const cancellation = new AbortController();
  const collect = vi.fn(async (_operation: Operation): Promise<WorkerTelemetrySample> => ({ telemetry, issues: [] }));
  const send = vi.fn(async (_report: WorkerReport, _operation: Operation) => ({ observedAt: timestamp, lastReportedAt: timestamp }));
  const emit = vi.fn();
  const start = () => createWorkerReporter({ signal: cancellation.signal, collect, send, emit });
  return { cancellation, collect, send, emit, start };
};
const settle = async () => { await vi.advanceTimersByTimeAsync(0); };
const claim = (taskId = "task", claimId = "claim"): WorkerTaskReference => ({ projectId: "project", taskId, claimId });

const timedOutProbe = async (terminationFailure?: Error) => {
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const child = new ChildProcess();
  // A throwing PID read fails the real termination path on every platform
  // without signaling an OS process owned by another test.
  if (terminationFailure !== undefined) Object.defineProperty(child, "pid", { get: () => { throw terminationFailure; } });
  const spawn = vi.fn(() => child);
  const operation = createOperation({ limits: { totalMs: 100, requestMs: 10 } });
  try {
    const result = runHerdrCommand({ file: "codex", args: ["--version"], environment: {} }, operation, spawn, { cleanupWithinDeadline: true })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    const error = await result;
    expect(error).toBeInstanceOf(HerdrCommandCleanupError);
    return { child, error, spawn };
  } finally { operation.dispose(); }
};

it("reports immediately and every thirty seconds without a task polling loop", async () => {
  const f = fixture(), reporter = f.start();
  await settle(); expect(f.send).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0]![0].taskInventory).toBeNull();
  const operation = f.collect.mock.calls[0]![0];
  expect(operation.limits).toMatchObject({ totalMs: 15_000, requestMs: 10_000 });
  await vi.advanceTimersByTimeAsync(120_000); expect(f.send).toHaveBeenCalledTimes(5);
  await reporter.stop();
  await vi.advanceTimersByTimeAsync(120_000); expect(f.send).toHaveBeenCalledTimes(5);
});

it("coalesces inventory, grants, and timer triggers into one pending fresh attempt", async () => {
  const f = fixture(), blocked = deferred<WorkerTelemetrySample>();
  f.collect.mockImplementationOnce(() => blocked.promise);
  const reporter = f.start();
  reporter.publishInventory({ observedAt: timestamp, claims: [] });
  reporter.recordClaim(claim()); reporter.recordClaim(claim("second"));
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.collect).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  blocked.resolve({ telemetry, issues: [] }); await settle();
  expect(f.collect).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0]![0].taskInventory?.claims).toEqual([claim(), claim("second")]);
  expect(f.collect.mock.calls[0]![0]).not.toBe(f.collect.mock.calls[1]![0]);
  await reporter.stop();
});

it("keeps a claim grant unknown until a complete inventory establishes its observation", async () => {
  const f = fixture(), reporter = f.start(); await settle();
  reporter.recordClaim(claim()); await settle();
  expect(f.send.mock.calls[1]![0].taskInventory).toBeNull();
  reporter.publishInventory({ observedAt: timestamp, claims: [] }); await settle();
  expect(f.send.mock.calls[2]![0].taskInventory).toEqual({ observedAt: timestamp, claims: [] });
  reporter.recordClaim(claim()); await settle();
  reporter.recordClaim(claim("task", "replacement")); await settle();
  expect(f.send.mock.calls[4]![0].taskInventory).toEqual({ observedAt: timestamp, claims: [claim("task", "replacement")] });
  await reporter.stop();
});

it("invalidates a complete observation during partial coverage until coverage is restored", async () => {
  const f = fixture(), reporter = f.start(); await settle();
  reporter.publishInventory({ observedAt: timestamp, claims: [claim("old")] }); await settle();
  reporter.publishInventory(null); await settle();
  reporter.recordClaim(claim("new")); await settle();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.send.mock.calls.slice(2).map(([report]) => report.taskInventory)).toEqual([null, null, null]);
  expect(f.send.mock.calls[4]![0].machine).toEqual(telemetry.machine);
  reporter.publishInventory({ observedAt: timestamp, claims: [claim("new")] }); await settle();
  expect(f.send.mock.calls[5]![0].taskInventory).toEqual({ observedAt: timestamp, claims: [claim("new")] });
  await reporter.stop();
});

it("copies inventory and grant references without changing an in-flight payload", async () => {
  const f = fixture(), blocked = deferred<{ observedAt: string; lastReportedAt: string }>();
  const reporter = f.start(); await settle();
  f.send.mockImplementationOnce(() => blocked.promise);
  const reference = { projectId: "project", taskId: "task", claimId: "claim" };
  const inventory = { observedAt: timestamp, claims: [reference] };
  reporter.publishInventory(inventory); await settle();
  const sent = f.send.mock.calls[1]![0];
  inventory.observedAt = "changed"; reference.claimId = "mutated"; inventory.claims.length = 0;
  const granted = { projectId: "project", taskId: "second", claimId: "new" };
  reporter.recordClaim(granted); granted.claimId = "mutated";
  expect(sent.taskInventory).toEqual({ observedAt: timestamp, claims: [claim()] });
  blocked.resolve({ observedAt: timestamp, lastReportedAt: timestamp }); await settle();
  expect(f.send.mock.calls[2]![0].taskInventory).toEqual({ observedAt: timestamp, claims: [claim(), claim("second", "new")] });
  await reporter.stop();
});

it("waits for the previous request and samples again after an unconfirmed send failure", async () => {
  const f = fixture(), blocked = deferred<{ observedAt: string; lastReportedAt: string }>();
  f.send.mockImplementationOnce(() => blocked.promise);
  const reporter = f.start(); await settle();
  reporter.publishInventory({ observedAt: timestamp, claims: [] });
  expect(f.collect).toHaveBeenCalledOnce();
  blocked.reject(new Error("unconfirmed provider-secret")); await settle();
  expect(f.collect).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[0]![0]).not.toBe(f.send.mock.calls[1]![0]);
  expect(f.emit.mock.calls.map(([event]) => event.kind)).toEqual(["worker_report_failed", "worker_report_recovered"]);
  await reporter.stop();
});

it.each(["codex", "assistantHost_codex", "assistantHost_claude", "assistantHost_copilot"] as const)("deduplicates %s and request categories, logs recovery, and never exposes raw error data", async (component) => {
  const f = fixture();
  const secret = "provider-secret-stdout-command";
  const failure = new ApiError({ operation: secret }, "response", { status: 503, cause: new Error(secret, { cause: new TypeError(secret) }) });
  f.collect.mockResolvedValue({ telemetry, issues: [{ component, code: "command_failed", error: new Error(secret, { cause: new RangeError(secret) }) }] });
  f.send.mockRejectedValue(failure);
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.emit).toHaveBeenCalledTimes(2);
  const events = f.emit.mock.calls.map(([event]) => event);
  expect(events[0].message).toContain(`"subsystem":"${component}"`);
  expect(events[1].message).toContain('"category":"http_response_503"');
  const describe = (error: Error): unknown => ({ name: error.name, message: error.message, ...(error.cause instanceof Error ? { cause: describe(error.cause) } : {}) });
  expect(JSON.stringify(events.map(event => ({ ...event, error: describe(event.error) })))).not.toContain(secret);
  f.collect.mockResolvedValue({ telemetry, issues: [] }); f.send.mockResolvedValue({ observedAt: timestamp, lastReportedAt: timestamp });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.emit.mock.calls.map(([event]) => event.kind)).toEqual(["worker_report_failed", "worker_report_failed", "worker_report_recovered", "worker_report_recovered"]);
  await reporter.stop();
});

it("logs changed failure categories without changing claim state", async () => {
  const f = fixture(); f.collect.mockRejectedValueOnce(new TypeError("private")).mockRejectedValueOnce(new RangeError("private"));
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.emit).toHaveBeenCalledTimes(2); expect(f.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.send.mock.calls[0]![0].taskInventory).toBeNull();
  expect(f.emit.mock.calls[2]![0].kind).toBe("worker_report_recovered");
  await reporter.stop();
});

it("emits safe API correlation fields while deduplicating new request IDs for the same error code", async () => {
  const f = fixture();
  const failure = (code: string, requestId: string) => new ApiError({ operation: "private command" }, "response", {
    status: 503, cause: new Error("private provider stdout"), serverError: { code, requestId, message: "private provider response" },
  });
  f.send.mockRejectedValueOnce(failure("service_unavailable", "request-001"))
    .mockRejectedValueOnce(failure("service_unavailable", "request-002"))
    .mockRejectedValueOnce(failure("upstream_unavailable", "request-003"));
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.emit).toHaveBeenCalledTimes(2);
  const messages = f.emit.mock.calls.map(([event]) => JSON.parse(event.message));
  expect(messages).toEqual([
    expect.objectContaining({ error_code: "service_unavailable", request_id: "request-001" }),
    expect.objectContaining({ error_code: "upstream_unavailable", request_id: "request-003" }),
  ]);
  expect(JSON.stringify(messages)).not.toContain("private");
  await reporter.stop();
});

it("omits API correlation fields outside the bounded server token syntax", async () => {
  const f = fixture();
  f.send.mockRejectedValue(new ApiError({ operation: "private" }, "response", {
    status: 503, cause: new Error("private"), serverError: { code: "private output", requestId: "https://private/token", message: "private" },
  }));
  const reporter = f.start(); await settle();
  expect(JSON.parse(f.emit.mock.calls[0]![0].message)).not.toHaveProperty("request_id");
  expect(JSON.parse(f.emit.mock.calls[0]![0].message)).not.toHaveProperty("error_code");
  await reporter.stop();
});

it("aborts the current operation and joins collection before stop resolves", async () => {
  const f = fixture(), blocked = deferred<WorkerTelemetrySample>();
  f.collect.mockImplementationOnce(() => blocked.promise);
  const reporter = f.start();
  let stopped = false;
  const stopping = reporter.stop().then(() => { stopped = true; });
  await settle();
  expect(f.collect.mock.calls[0]![0].signal.aborted).toBe(true); expect(stopped).toBe(false);
  reporter.publishInventory({ observedAt: timestamp, claims: [] });
  blocked.resolve({ telemetry, issues: [] }); await stopping;
  expect(f.send).not.toHaveBeenCalled(); expect(f.emit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000); expect(f.collect).toHaveBeenCalledOnce();
});

it("stops on root cancellation and cancels an active HTTP request quietly", async () => {
  const f = fixture();
  f.send.mockImplementationOnce((_report, operation) => new Promise((_resolve, reject) => {
    operation.signal.addEventListener("abort", () => { reject(operation.signal.reason); }, { once: true });
  }));
  const reporter = f.start(); await settle(); f.cancellation.abort(); await reporter.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.send).toHaveBeenCalledOnce(); expect(f.emit).not.toHaveBeenCalled();
});

it("keeps cleanup uncertainty visible and prevents replacement attempts after cancellation", async () => {
  const f = fixture(), blocked = deferred<WorkerTelemetrySample>();
  f.collect.mockImplementationOnce(() => blocked.promise);
  const reporter = f.start();
  const uncertainty = new HerdrCommandCleanupError([new Error("private process output")], undefined);
  const stopping = reporter.stop();
  const rejected = expect(stopping).rejects.toBe(uncertainty);
  blocked.reject(uncertainty); await rejected;
  await vi.advanceTimersByTimeAsync(60_000); expect(f.collect).toHaveBeenCalledOnce();
  expect(f.emit.mock.calls[0]![0].kind).toBe("worker_report_failed");
  expect((f.emit.mock.calls[0]![0].error as Error).message).toBe("aggregate");
});

it("keeps reporting partial probe failures while retaining genuine cleanup uncertainty", async () => {
  const f = fixture();
  const uncertainty = new HerdrCommandCleanupError([new Error("private process output")], undefined);
  f.collect.mockResolvedValue({ telemetry, issues: [{ component: "codex", code: "unavailable", error: uncertainty }] });
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.collect).toHaveBeenCalledTimes(3); expect(f.send).toHaveBeenCalledTimes(3);
  expect(f.emit).toHaveBeenCalledOnce();
  await expect(reporter.stop()).rejects.toBe(uncertainty);
});

it("preserves cleanup uncertainty returned as a field issue during cancellation", async () => {
  const f = fixture(), blocked = deferred<WorkerTelemetrySample>();
  f.collect.mockImplementationOnce(() => blocked.promise);
  const reporter = f.start();
  const uncertainty = new HerdrCommandCleanupError([new Error("private process output")], undefined);
  const stopping = reporter.stop(); const rejected = expect(stopping).rejects.toBe(uncertainty);
  blocked.resolve({ telemetry, issues: [{ component: "codex", code: "unavailable", error: uncertainty }] });
  await rejected;
  expect(f.send).not.toHaveBeenCalled();
  expect(f.emit.mock.calls[0]![0].message).toContain('"subsystem":"codex"');
});

it("preserves each distinct cleanup failure without accumulating repeated cached issues", async () => {
  const f = fixture();
  const codex = new HerdrCommandCleanupError([new Error("private codex output")], undefined);
  const copilot = new HerdrCommandCleanupError([new Error("private copilot output")], undefined);
  f.collect.mockResolvedValue({ telemetry, issues: [
    { component: "codex", code: "unavailable", error: codex }, { component: "copilot", code: "unavailable", error: copilot },
  ] });
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(60_000);
  const stopped = reporter.stop();
  await expect(stopped).rejects.toMatchObject({ errors: [codex, copilot] });
});

it.each(["direct", "nested"] as const)("finishes after the original child confirms a retained %s cleanup timeout", async (kind) => {
  const f = fixture(), probe = await timedOutProbe();
  const failure = kind === "direct" ? probe.error : new Error("Version collection failed", {
    cause: new AggregateError([probe.error], "Probe failed", { cause: probe.error }),
  });
  f.collect.mockResolvedValue({ telemetry, issues: [{ component: "codex", code: "unavailable", error: failure }] });
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.send).toHaveBeenCalledTimes(3);
  expect(f.emit).toHaveBeenCalledOnce();
  expect(probe.child.listenerCount("close")).toBe(1);
  probe.child.emit("close", null, "SIGKILL");
  await expect(reporter.stop()).resolves.toBeUndefined();
  reporter.trigger(); reporter.publishInventory({ observedAt: timestamp, claims: [] }); reporter.recordClaim(claim());
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.collect).toHaveBeenCalledTimes(3); expect(f.send).toHaveBeenCalledTimes(3);
  expect(probe.spawn).toHaveBeenCalledOnce();
  expect(probe.child.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["no close", "exit only", "another child", "termination failed", "legacy error"] as const)(
  "refuses to finish when cleanup has %s",
  async (kind) => {
    const f = fixture(), terminationFailure = new Error("Cannot terminate owned process");
    const probe = await timedOutProbe(kind === "termination failed" ? terminationFailure : undefined);
    const failure = kind === "legacy error" ? new HerdrCommandCleanupError([new Error("Cleanup has no acknowledgement")], undefined) : probe.error;
    f.collect.mockResolvedValue({ telemetry, issues: [{ component: "codex", code: "unavailable", error: failure }] });
    const reporter = f.start(); await settle();
    if (kind === "exit only") probe.child.emit("exit", 0, null);
    if (kind === "another child") new ChildProcess().emit("close", 0, null);
    if (kind === "termination failed" || kind === "legacy error") probe.child.emit("close", null, "SIGKILL");
    await expect(reporter.stop()).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.collect).toHaveBeenCalledOnce(); expect(probe.spawn).toHaveBeenCalledOnce();
    if (kind === "termination failed") expect((probe.error as AggregateError).errors).toContain(terminationFailure);
    probe.child.emit("close", null, "SIGKILL");
  },
);

it.each(["unconfirmed sibling", "independent member", "independent cause"] as const)(
  "retains a mixed aggregate with an %s after another cleanup is confirmed",
  async (kind) => {
    const f = fixture(), confirmed = await timedOutProbe(), pending = await timedOutProbe();
    const independent = new Error("Independent collection failure");
    const failure = new AggregateError(
      [new Error("Probe wrapper", { cause: confirmed.error }), ...(kind === "unconfirmed sibling" ? [pending.error] : kind === "independent member" ? [independent] : [])],
      "Collection failed",
      kind === "independent cause" ? { cause: independent } : undefined,
    );
    f.collect.mockRejectedValue(failure);
    const reporter = f.start(); await settle();
    confirmed.child.emit("close", null, "SIGKILL");
    await expect(reporter.stop()).rejects.toBe(failure);
    expect(f.send).not.toHaveBeenCalled();
    pending.child.emit("close", null, "SIGKILL");
  },
);

it("retains a diagnostic failure after the reported cleanup is confirmed", async () => {
  const f = fixture(), probe = await timedOutProbe(), diagnosticFailure = new Error("Diagnostic sink failed");
  f.emit.mockImplementation(() => { throw diagnosticFailure; });
  f.collect.mockResolvedValue({ telemetry, issues: [{ component: "codex", code: "unavailable", error: probe.error }] });
  const reporter = f.start(); await settle();
  probe.child.emit("close", null, "SIGKILL");
  await expect(reporter.stop()).rejects.toBe(diagnosticFailure);
  expect(f.send).toHaveBeenCalledOnce();
});

it.each(["confirmed", "unconfirmed", "independent failure"] as const)(
  "evaluates %s cleanup after joining collection during stop",
  async (kind) => {
    const f = fixture(), probe = await timedOutProbe(), blocked = deferred<WorkerTelemetrySample>();
    f.collect.mockResolvedValueOnce({ telemetry, issues: [{ component: "codex", code: "unavailable", error: probe.error }] })
      .mockImplementationOnce(() => blocked.promise);
    const reporter = f.start(); await settle(); reporter.trigger(); await settle();
    reporter.trigger(); reporter.publishInventory({ observedAt: timestamp, claims: [] });
    let finished = false;
    const stopping = reporter.stop().then(() => { finished = true; return undefined; }, (error: unknown) => { finished = true; return error; });
    await settle(); expect(finished).toBe(false);
    const operation = f.collect.mock.calls[1]![0];
    expect(operation.signal.aborted).toBe(true);
    if (kind !== "unconfirmed") probe.child.emit("close", null, "SIGKILL");
    else probe.child.emit("exit", 0, null);
    const failure = new AggregateError([operation.signal.reason, probe.error,
      ...(kind === "independent failure" ? [new Error("Independent shutdown failure")] : [])], "Collection interrupted");
    blocked.reject(failure);
    const result = await stopping;
    if (kind === "confirmed") expect(result).toBeUndefined();
    else if (kind === "independent failure") expect(result).toBe(failure);
    else expect(result).toMatchObject({ errors: [probe.error, failure] });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.collect).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledOnce();
    expect(probe.spawn).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    probe.child.emit("close", null, "SIGKILL");
  },
);

it("accepts an already confirmed cleanup issue returned while stopping", async () => {
  const f = fixture(), probe = await timedOutProbe(), blocked = deferred<WorkerTelemetrySample>();
  f.collect.mockImplementationOnce(() => blocked.promise);
  const reporter = f.start();
  const stopping = reporter.stop();
  probe.child.emit("close", null, "SIGKILL");
  blocked.resolve({ telemetry, issues: [{ component: "codex", code: "unavailable", error: probe.error }] });
  await expect(stopping).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.collect).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
});

it("retries a fresh collection after an ordinary aggregate failure", async () => {
  const f = fixture();
  f.collect.mockRejectedValueOnce(new AggregateError([new Error("private")], "ordinary collection failure"));
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(30_000);
  expect(f.collect).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledOnce();
  await reporter.stop();
});

it("retains diagnostics callback failures for stop without rejecting inventory notifications", async () => {
  const f = fixture(), logFailure = new Error("log sink unavailable");
  f.emit.mockImplementation(() => { throw logFailure; }); f.send.mockRejectedValue(new Error("network"));
  const reporter = f.start(); await settle();
  expect(() => reporter.publishInventory({ observedAt: timestamp, claims: [] })).not.toThrow();
  await settle(); expect(f.send).toHaveBeenCalledTimes(2);
  await expect(reporter.stop()).rejects.toBe(logFailure);
});

it("starts no work when its root signal is already cancelled", async () => {
  const f = fixture(); f.cancellation.abort(); const reporter = f.start();
  await vi.advanceTimersByTimeAsync(60_000); await reporter.stop();
  expect(f.collect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

const cloudValue = { maxConcurrent: 2, pollIntervalMs: 60_000, recoveryLimit: 3, native: { agent: "codex" as const, model: null, args: [] }, projects: [] };
const cloudDesired = { revision: "1", updatedAt: timestamp, value: cloudValue };

it("uses the latest inventory after a delayed cloud configuration preparation", async () => {
  const f = fixture(), preparation = deferred<void>();
  const prepare = vi.fn().mockImplementationOnce(() => preparation.promise).mockResolvedValue(undefined);
  const capture = () => ({ bootstrap: null, observation: null });
  const receipt = { desired: cloudDesired, observationRevision: "1", observationAccepted: false };
  const send = vi.fn(async (_report: WorkerReport, _configuration: WorkerCloudReport, _operation: Operation) => ({ observedAt: timestamp, lastReportedAt: timestamp, configuration: receipt }));
  const reporter = createWorkerReporter({ signal: f.cancellation.signal, collect: f.collect, send: f.send, emit: f.emit, configuration: { prepare, capture, send, accept: async () => {} } });
  reporter.publishInventory({ observedAt: timestamp, claims: [claim()] });
  await settle();
  reporter.publishInventory(null);
  preparation.resolve(); await settle();
  expect(send.mock.calls[0]![0].taskInventory).toBeNull();
  await reporter.stop();
});

it("keeps partial inventory invalidated while a timed-out probe is confirmed during configuration preparation", async () => {
  const f = fixture(), probe = await timedOutProbe(), preparation = deferred<void>();
  f.collect.mockResolvedValueOnce({ telemetry, issues: [{ component: "codex", code: "unavailable", error: probe.error }] })
    .mockResolvedValue({ telemetry, issues: [] });
  const prepare = vi.fn().mockImplementationOnce(() => preparation.promise).mockResolvedValue(undefined);
  const receipt = { desired: cloudDesired, observationRevision: "1", observationAccepted: false };
  const send = vi.fn(async (_report: WorkerReport, _configuration: WorkerCloudReport, _operation: Operation) => ({ observedAt: timestamp, lastReportedAt: timestamp, configuration: receipt }));
  const reporter = createWorkerReporter({ signal: f.cancellation.signal, collect: f.collect, send: f.send, emit: f.emit,
    configuration: { prepare, capture: () => ({ bootstrap: null, observation: null }), send, accept: async () => {} } });
  reporter.publishInventory({ observedAt: timestamp, claims: [claim("old")] });
  await settle();
  reporter.publishInventory(null);
  reporter.recordClaim(claim("new"));
  probe.child.emit("close", null, "SIGKILL");
  preparation.resolve(); await settle();
  expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(send.mock.calls.map(([report]) => report.taskInventory)).toEqual([null, null]);
  expect(f.emit.mock.calls.map(([event]) => event.kind)).toEqual(["worker_report_failed", "worker_report_recovered"]);
  reporter.publishInventory({ observedAt: timestamp, claims: [claim("new")] }); await settle();
  expect(send.mock.lastCall![0].taskInventory).toEqual({ observedAt: timestamp, claims: [claim("new")] });
  await expect(reporter.stop()).resolves.toBeUndefined();
});

it("exchanges cloud configuration without a task inventory and acknowledges only the sent immutable snapshot", async () => {
  const f = fixture();
  const pending = deferred<WorkerCloudReportReceipt>();
  const failure = { code: "unavailable" as const, category: "agent" as const, phase: "validate" as const, occurredAt: timestamp };
  const captureValue = {
    bootstrap: null,
    observation: { baseRevision: "0", desiredRevision: "1", items: [{ key: { kind: "maxConcurrent" as const }, targetRevision: "1", appliedValue: null, state: "error" as const, error: failure, lastFailure: failure, nextAttemptAt: timestamp }] },
  };
  const capture = vi.fn(() => captureValue);
  const send = vi.fn((_report: WorkerReport, _configuration: WorkerCloudReport, _operation: Operation) => pending.promise);
  const accept = vi.fn(async (_sent: WorkerCloudReport, _receipt: WorkerCloudReceipt) => {});
  const reporter = createWorkerReporter({ signal: f.cancellation.signal, collect: f.collect, send: f.send, emit: f.emit, configuration: { capture, send, accept } });
  await settle();
  expect(f.send).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledOnce();
  const sent = send.mock.calls[0]![1];
  expect(send.mock.calls[0]![0].taskInventory).toBeNull();
  captureValue.observation.baseRevision = "1";
  captureValue.observation.items.length = 0;
  expect(sent.observation?.baseRevision).toBe("0"); expect(sent.observation?.items).toHaveLength(1);
  expect(Object.isFrozen(sent.observation?.items[0]?.lastFailure)).toBe(true);
  const receipt = { desired: cloudDesired, observationRevision: "1", observationAccepted: false };
  pending.resolve({ observedAt: timestamp, lastReportedAt: timestamp, configuration: receipt });
  await settle();
  expect(accept.mock.calls[0]![0]).toBe(captureValue);
  expect(accept).toHaveBeenCalledWith(captureValue, receipt);
  await reporter.stop();
});

it("captures current configuration after an unknown send outcome instead of replaying the old observation", async () => {
  const f = fixture();
  let revision = "1";
  const capture = vi.fn(() => ({ bootstrap: null, observation: { baseRevision: "0", desiredRevision: revision, items: [] } }));
  const receipt = { desired: cloudDesired, observationRevision: "1", observationAccepted: false };
  const send = vi.fn(async (_report: WorkerReport, _configuration: WorkerCloudReport, _operation: Operation) => ({ observedAt: timestamp, lastReportedAt: timestamp, configuration: receipt }));
  send.mockRejectedValueOnce(new Error("unknown cloud mutation outcome"));
  const accept = vi.fn(async (_sent: WorkerCloudReport, _receipt: WorkerCloudReceipt) => {});
  const reporter = createWorkerReporter({ signal: f.cancellation.signal, collect: f.collect, send: f.send, emit: f.emit, configuration: { capture, send, accept } });
  await settle(); expect(accept).not.toHaveBeenCalled();
  revision = "2"; reporter.trigger(); await settle();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(([, sent]) => sent.observation?.desiredRevision)).toEqual(["1", "2"]);
  expect(accept).toHaveBeenCalledOnce();
  expect(accept.mock.calls[0]![0]).toBe(capture.mock.results[1]!.value);
  expect(accept).toHaveBeenCalledWith(capture.mock.results[1]!.value, receipt);
  await reporter.stop();
});

it("keeps bootstrap reporting independent of runtime application and joins receipt commits on shutdown", async () => {
  const f = fixture(), committed = deferred<void>();
  const bootstrap = { maxConcurrent: 1, pollIntervalMs: 60_000, recoveryLimit: 3, native: { agent: "codex" as const, model: null, args: [] }, projects: [] };
  const capture = vi.fn(() => ({ bootstrap, observation: null }));
  const receipt = { desired: { revision: "1", updatedAt: timestamp, value: bootstrap }, observationRevision: "0", observationAccepted: false };
  const send = vi.fn(async () => ({ observedAt: timestamp, lastReportedAt: timestamp, configuration: receipt }));
  const accept = vi.fn(() => committed.promise);
  const reporter = createWorkerReporter({ signal: f.cancellation.signal, collect: f.collect, send: f.send, emit: f.emit, configuration: { capture, send, accept } });
  await settle(); expect(send).toHaveBeenCalledOnce(); expect(accept).toHaveBeenCalledOnce();
  let finished = false;
  const stopping = reporter.stop().then(() => { finished = true; });
  await settle(); expect(finished).toBe(false);
  committed.resolve(); await stopping;
  await vi.advanceTimersByTimeAsync(60_000); expect(send).toHaveBeenCalledOnce();
});

it("reconciles an unknown import before capturing a fresh report within the same heartbeat operation", async () => {
  const f = fixture(), reconciled = deferred<void>();
  let needsReconciliation = false, targetPresent = false;
  const prepare = vi.fn(async (_operation: Operation) => {
    if (!needsReconciliation) return;
    await reconciled.promise;
    targetPresent = true; needsReconciliation = false;
  });
  const capture = vi.fn((): WorkerCloudReport => targetPresent
    ? { bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [] } }
    : { bootstrap: cloudValue, observation: null });
  const receipt = { desired: cloudDesired, observationRevision: "1", observationAccepted: false };
  const send = vi.fn(async (_report: WorkerReport, _configuration: WorkerCloudReport, _operation: Operation) => ({ observedAt: timestamp, lastReportedAt: timestamp, configuration: receipt }));
  send.mockImplementationOnce(async () => { needsReconciliation = true; throw new Error("Import response lost"); });
  const accept = vi.fn(async (_sent: WorkerCloudReport, _receipt: WorkerCloudReceipt) => {});
  const reporter = createWorkerReporter({ signal: f.cancellation.signal, collect: f.collect, send: f.send, emit: f.emit, configuration: { prepare, capture, send, accept } });
  await settle(); expect(send).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled();
  reporter.trigger(); await settle();
  expect(prepare).toHaveBeenCalledTimes(2); expect(capture).toHaveBeenCalledOnce();
  expect(prepare.mock.calls[1]![0]).toBe(f.collect.mock.calls[1]![0]);
  expect(prepare.mock.calls[1]![0].limits).toMatchObject({ totalMs: 15_000, requestMs: 10_000 });
  reconciled.resolve(); await settle();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]![1]).toEqual({ bootstrap: cloudValue, observation: null });
  expect(send.mock.calls[1]![1]).toEqual({ bootstrap: null, observation: { baseRevision: "0", desiredRevision: "1", items: [] } });
  expect(accept.mock.calls[0]![0]).toBe(capture.mock.results[1]!.value);
  await reporter.stop();
});
