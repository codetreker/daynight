import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../src/api/client.js";
import type { MonitoringRead, MonitoringReceipt } from "../../../../src/api/worker-monitoring.js";
import { createMonitoringSender } from "../../../../src/commands/worker/monitoring/sender.js";
import type { Observation } from "../../../../src/commands/worker/monitoring/types.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const runId = uuid(1), predecessor = uuid(2), revision = uuid(3);
const now = "2026-01-01T00:00:00Z";
const snapshot = (sequence: string): Observation => ({
  runId, sequence, capturedAt: now, lifecycle: "running", scheduler: { phase: "initializing", coverage: "unknown", cycleId: null, lastCompletedAt: null, lastSuccessfulAt: null, lastOutcome: null, nextPollAt: null }, capacity: null,
  admission: { observedAt: now, coverage: "unknown", reasons: [] }, reservations: [], activities: [], currentFailures: [], lastRecovery: null, detailCoverage: "complete", delivery: { lastSucceededAt: null, lastFailure: null },
});
const absent: MonitoringRead = { state: "absent" };
const available = (id: string, rev = revision, seq = "1"): MonitoringRead => ({ state: "available", revision: rev, runId: id, sequence: seq });
const receipt = (o: Observation): MonitoringReceipt => ({ revision, runId: o.runId, sequence: o.sequence, receivedAt: now, expiresAt: "2026-01-01T01:00:00Z" });
const conflict = (code = "monitoring_revision_conflict"): ApiError => new ApiError({ operation: "test" }, "response", { cause: new Error(), status: 409, serverError: { code, message: "conflict", requestId: uuid(4) }, confirmedRefusal: true });
const flush = async (): Promise<void> => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("worker monitoring sender", () => {
  it("keeps one request in flight, coalesces changes and captures fresh state at the next period", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const capture = vi.fn(snapshot), read = vi.fn(async () => absent);
    const write = vi.fn(async (_revision: string | null, o: Observation) => { if (o.sequence === "1") await gate; return receipt(o); });
    const sender = createMonitoringSender({ runId, capture, read, write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); expect(write).toHaveBeenCalledTimes(1); sender.markDirty(); sender.markDirty();
    await vi.advanceTimersByTimeAsync(29_000); expect(write).toHaveBeenCalledTimes(1);
    release(); await flush(); await vi.advanceTimersByTimeAsync(29_999); expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(capture.mock.calls.map(args => args[0])).toEqual(["1", "2"]); expect(write).toHaveBeenCalledTimes(2);
    await sender.finish();
  });
  it("binds a late predecessor after an initially absent key and never replays the rejected sample", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(available(predecessor));
    const write = vi.fn().mockRejectedValueOnce(conflict()).mockImplementation(async (_r: string | null, o: Observation) => receipt(o));
    const capture = vi.fn(snapshot), fail = vi.fn();
    const sender = createMonitoringSender({ runId, capture, read, write, deliverySuccess: vi.fn(), deliveryFailure: fail, emit: vi.fn() });
    await flush(); expect(write.mock.calls[0]![0]).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2); expect(write.mock.calls[1]![0]).toBe(revision); expect(capture.mock.calls.map(args => args[0])).toEqual(["1", "2"]);
    await sender.finish();
  });
  it("accepts a later revision from the initially observed predecessor", async () => {
    vi.useFakeTimers();
    const later = uuid(8), read = vi.fn().mockResolvedValueOnce(available(predecessor)).mockResolvedValueOnce(available(predecessor, later));
    const write = vi.fn().mockRejectedValueOnce(conflict()).mockImplementation(async (_r: string | null, o: Observation) => receipt(o));
    const capture = vi.fn(snapshot), sender = createMonitoringSender({ runId, capture, read, write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); expect(write.mock.calls[0]![0]).toBe(revision);
    await vi.advanceTimersByTimeAsync(30_000); expect(write.mock.calls[1]![0]).toBe(later); expect(capture.mock.calls.map(args => args[0])).toEqual(["1", "2"]); await sender.finish();
  });
  it("does not replace a third run before this run has been established", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(available(predecessor)).mockResolvedValueOnce(available(uuid(9)));
    const write = vi.fn().mockRejectedValue(conflict());
    const fail = vi.fn(), sender = createMonitoringSender({ runId, capture: snapshot, read, write, deliverySuccess: vi.fn(), deliveryFailure: fail, emit: vi.fn() });
    await flush(); await vi.advanceTimersByTimeAsync(30_000); expect(write).toHaveBeenCalledTimes(1); expect(fail.mock.calls.at(-1)?.[0]).toBe("reconcile"); await sender.finish();
  });
  it("refreshes the revision and sequence after a same-run conflict", async () => {
    vi.useFakeTimers();
    const later = uuid(8), read = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(available(runId, later, "2"));
    const write = vi.fn().mockImplementationOnce(async (_r: string | null, o: Observation) => receipt(o)).mockRejectedValueOnce(conflict()).mockImplementation(async (_r: string | null, o: Observation) => receipt(o));
    const capture = vi.fn(snapshot), sender = createMonitoringSender({ runId, capture, read, write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); await vi.advanceTimersByTimeAsync(60_000); expect(write.mock.calls[2]![0]).toBe(later); expect(capture.mock.calls.map(args => args[0])).toEqual(["1", "2", "3"]); await sender.finish();
  });
  it("stops after another run replaces the established run", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(available(predecessor));
    const write = vi.fn().mockImplementationOnce(async (_r: string | null, o: Observation) => receipt(o)).mockRejectedValueOnce(conflict());
    const fail = vi.fn();
    const sender = createMonitoringSender({ runId, capture: snapshot, read, write, deliverySuccess: vi.fn(), deliveryFailure: fail, emit: vi.fn() });
    await flush(); await vi.advanceTimersByTimeAsync(30_000); await vi.advanceTimersByTimeAsync(30_000); expect(fail.mock.calls.at(-1)?.[0]).toBe("reconcile");
    await vi.advanceTimersByTimeAsync(120_000); expect(write).toHaveBeenCalledTimes(2); await sender.finish();
  });
  it("reconciles an unknown outcome and cache loss with new sequences", async () => {
    vi.useFakeTimers();
    const unknown = new ApiError({ operation: "test" }, "request", { cause: new Error(), outcomeUnconfirmed: true });
    const read = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(available(runId, revision, "1")).mockResolvedValueOnce(absent);
    const write = vi.fn().mockRejectedValueOnce(unknown).mockRejectedValueOnce(conflict("monitoring_state_lost")).mockImplementation(async (_r: string | null, o: Observation) => receipt(o));
    const capture = vi.fn(snapshot), sender = createMonitoringSender({ runId, capture, read, write, deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); await vi.advanceTimersByTimeAsync(30_000); expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999); expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(write.mock.calls[2]![0]).toBeNull(); expect(capture.mock.calls.map(args => args[0])).toEqual(["1", "2", "3"]); await sender.finish();
  });
  it("bounds final shutdown while an HTTP request is pending", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async (operation: { signal: AbortSignal }) => await new Promise<MonitoringRead>((_resolve, reject) => operation.signal.addEventListener("abort", () => reject(operation.signal.reason), { once: true })));
    const sender = createMonitoringSender({ runId, capture: snapshot, read, write: vi.fn(), deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); const done = sender.finish(); await vi.advanceTimersByTimeAsync(5_000); await done; expect(read.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("backs off consecutive failures by 30 then 60 seconds", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("unavailable"));
    const sender = createMonitoringSender({ runId, capture: snapshot, read, write: vi.fn(), deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit: vi.fn() });
    await flush(); await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(3); await sender.finish();
  });
  it("keeps remote response text out of monitoring diagnostics", async () => {
    vi.useFakeTimers();
    const secret = "private prompt and /secret/path";
    const error = new ApiError({ operation: "test" }, "response", { cause: new Error(secret), status: 503, serverError: { code: "monitoring_unavailable", message: secret, requestId: uuid(4) } });
    const emit = vi.fn(), sender = createMonitoringSender({ runId, capture: snapshot, read: vi.fn().mockRejectedValue(error), write: vi.fn(), deliverySuccess: vi.fn(), deliveryFailure: vi.fn(), emit });
    await flush(); expect(JSON.stringify(emit.mock.calls)).not.toContain(secret); expect(JSON.stringify(emit.mock.calls)).toContain("unavailable"); await sender.finish();
  });
});
