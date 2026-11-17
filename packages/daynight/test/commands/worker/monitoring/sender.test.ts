import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../src/api/client.js";
import type { Operation } from "../../../../src/api/operation.js";
import { createMonitoringSender } from "../../../../src/commands/worker/monitoring/sender.js";
import type { DirectObservation } from "../../../../src/commands/worker/monitoring/types.js";

const now = "2026-01-01T00:00:00Z";
const snapshot = (lifecycle: DirectObservation["lifecycle"] = "running"): DirectObservation => ({
  capturedAt: now, lifecycle, scheduler: { phase: "initializing", coverage: "unknown", cycleId: null, lastCompletedAt: null, lastSuccessfulAt: null, lastOutcome: null, nextPollAt: null }, capacity: null,
  admission: { observedAt: now, coverage: "unknown", reasons: [] }, reservations: [], activities: [], currentFailures: [], lastRecovery: null, detailCoverage: "complete", delivery: { lastSucceededAt: null, lastFailure: null },
});
const receipt = { receivedAt: now, expiresAt: "2026-01-01T01:00:00Z" };
const flush = async (): Promise<void> => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("worker monitoring sender", () => {
  it("starts immediately, keeps one request in flight and captures current state after completion", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let lifecycle: DirectObservation["lifecycle"] = "running";
    const capture = vi.fn(() => snapshot(lifecycle));
    const write = vi.fn().mockImplementationOnce(async () => { await gate; return receipt; }).mockResolvedValue(receipt);
    const sender = createMonitoringSender({ capture, write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(write).toHaveBeenCalledTimes(1);
    lifecycle = "stopping"; release(); await flush();
    await vi.advanceTimersByTimeAsync(29_999); expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map(args => args[0].lifecycle)).toEqual(["running", "stopping"]);
    expect(write.mock.calls[0]![2]).not.toBe(write.mock.calls[1]![2]);
    await sender.finish();
  });
  it("captures anew after unknown outcomes and backs off consecutive failures, resetting after success", async () => {
    vi.useFakeTimers();
    const unknown = new ApiError({ operation: "test" }, "request", { cause: new Error(), outcomeUnconfirmed: true });
    const failure = vi.fn(), success = vi.fn();
    let lifecycle: DirectObservation["lifecycle"] = "running";
    const write = vi.fn().mockRejectedValueOnce(unknown).mockRejectedValueOnce(unknown).mockResolvedValueOnce(receipt).mockRejectedValueOnce(unknown).mockResolvedValue(receipt);
    const sender = createMonitoringSender({ capture: () => snapshot(lifecycle), write, deliverySuccess: success, deliveryFailure: failure, emit: vi.fn() });
    await flush(); expect(failure.mock.calls[0]![0]).toBe("write");
    lifecycle = "stopping";
    await vi.advanceTimersByTimeAsync(30_000); expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].lifecycle).toBe("stopping");
    await vi.advanceTimersByTimeAsync(59_999); expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(write).toHaveBeenCalledTimes(3); expect(success).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(write).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000); expect(write).toHaveBeenCalledTimes(5);
    await sender.finish();
  });
  it("waits for the in-flight attempt before at most one final fresh capture", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let lifecycle: DirectObservation["lifecycle"] = "running";
    const write = vi.fn().mockImplementationOnce(async () => { await gate; return receipt; }).mockResolvedValue(receipt);
    const sender = createMonitoringSender({ capture: () => snapshot(lifecycle), write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    lifecycle = "stopped";
    const done = sender.finish(); expect(sender.finish()).toBe(done);
    await flush(); expect(write).toHaveBeenCalledTimes(1);
    release(); await done;
    expect(write).toHaveBeenCalledTimes(2); expect(write.mock.calls[1]![0].lifecycle).toBe("stopped");
    await vi.advanceTimersByTimeAsync(60_000); expect(write).toHaveBeenCalledTimes(2);
  });
  it("bounds the entire shutdown and cancels an unresponsive in-flight request without starting a second", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_observation: DirectObservation, operation: Operation) => {
      await new Promise<void>(() => {});
      return { ...receipt, aborted: operation.signal.aborted };
    });
    const failure = vi.fn(), emit = vi.fn();
    const sender = createMonitoringSender({ capture: snapshot, write, deliverySuccess: vi.fn(), deliveryFailure: failure, emit });
    await flush(); const done = sender.finish();
    await vi.advanceTimersByTimeAsync(5_000); await done;
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(failure.mock.calls[0]![0]).toBe("shutdown"); expect(JSON.stringify(emit.mock.calls)).toContain("outcome-unknown");
  });
  it("uses the remaining shutdown budget for the final request", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = vi.fn().mockImplementationOnce(async () => { await gate; return receipt; }).mockImplementation(async () => await new Promise(() => {}));
    const sender = createMonitoringSender({ capture: snapshot, write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    const done = sender.finish(); await vi.advanceTimersByTimeAsync(4_000); release(); await flush();
    expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); let completed = false; void done.then(() => { completed = true; }); await flush(); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await done; expect(write.mock.calls[1]![1].signal.aborted).toBe(true);
  });
  it("distinguishes confirmed storage unavailability from an unknown write outcome", async () => {
    vi.useFakeTimers();
    const requestId = "00000000-0000-4000-8000-000000000004";
    const unavailable = new ApiError({ operation: "test" }, "response", { cause: new Error(), status: 503, serverError: { code: "monitoring_unavailable", message: "unavailable", requestId }, confirmedRefusal: true });
    const unknown = new ApiError({ operation: "test" }, "response", { cause: new Error(), status: 503, serverError: { code: "monitoring_write_outcome_unknown", message: "unknown", requestId }, outcomeUnconfirmed: true });
    const emit = vi.fn(), failure = vi.fn();
    const sender = createMonitoringSender({ capture: snapshot, write: vi.fn().mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unknown).mockResolvedValue(receipt), deliverySuccess: vi.fn(), deliveryFailure: failure, emit });
    await flush();
    expect(emit.mock.calls[0]![0].message).toContain('"code":"unavailable"');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.stringify(emit.mock.calls[1])).toContain("outcome-unknown");
    expect(failure.mock.calls.map(args => args[0])).toEqual(["write", "write"]);
    await sender.finish();
  });
  it("keeps remote response text out of diagnostics", async () => {
    vi.useFakeTimers();
    const secret = "private prompt and /secret/path";
    const error = new ApiError({ operation: "test" }, "response", { cause: new Error(secret), status: 503, serverError: { code: "monitoring_unavailable", message: secret, requestId: "00000000-0000-4000-8000-000000000004" } });
    const emit = vi.fn(), sender = createMonitoringSender({ capture: snapshot, write: vi.fn().mockRejectedValue(error), deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit });
    await flush(); expect(JSON.stringify(emit.mock.calls)).not.toContain(secret); expect(JSON.stringify(emit.mock.calls)).toContain("unavailable"); await sender.finish();
  });
});
