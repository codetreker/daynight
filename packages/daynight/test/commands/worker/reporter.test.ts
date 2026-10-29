import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import type { Operation } from "../../../src/api/operation.js";
import type { WorkerReport, WorkerTaskReference, WorkerTelemetry } from "../../../src/api/types.js";
import { createWorkerReporter } from "../../../src/commands/worker/reporter.js";
import { HerdrCommandCleanupError } from "../../../src/commands/worker/herdr/command.js";
import type { WorkerTelemetrySample } from "../../../src/commands/worker/telemetry.js";

afterEach(() => { vi.useRealTimers(); });
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

it("deduplicates field and request categories, logs recovery, and never exposes raw error data", async () => {
  const f = fixture();
  const secret = "provider-secret-stdout-command";
  const failure = new ApiError({ operation: secret }, "response", { status: 503, cause: new Error(secret, { cause: new TypeError(secret) }) });
  f.collect.mockResolvedValue({ telemetry, issues: [{ component: "codex", code: "command_failed", error: new Error(secret, { cause: new RangeError(secret) }) }] });
  f.send.mockRejectedValue(failure);
  const reporter = f.start(); await settle(); await vi.advanceTimersByTimeAsync(60_000);
  expect(f.emit).toHaveBeenCalledTimes(2);
  const events = f.emit.mock.calls.map(([event]) => event);
  expect(events[0].message).toContain('"subsystem":"codex"');
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
