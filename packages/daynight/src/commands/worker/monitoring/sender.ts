import { randomUUID } from "node:crypto";
import { ApiError } from "../../../api/client.js";
import { createOperation } from "../../../api/operation.js";
import type { Operation } from "../../../api/operation.js";
import type { MonitoringRead, MonitoringReceipt } from "../../../api/worker-monitoring.js";
import type { WorkerDiagnostic } from "../diagnostics.js";
import type { DeliveryPhase, Observation } from "./types.js";
import { classifyFailure } from "./diagnostics.js";

const PERIOD = 30_000;
const MAX_SEQUENCE = 9_223_372_036_854_775_807n;

export type MonitoringSenderOptions = {
  runId: string;
  capture(sequence: string): Observation;
  read(operation: Operation, requestId: string): Promise<MonitoringRead>;
  write(revision: string | null, observation: Observation, operation: Operation, requestId: string): Promise<MonitoringReceipt>;
  deliverySuccess(): void;
  deliveryFailure(phase: DeliveryPhase, error: unknown, requestId: string | null): void;
  emit(event: WorkerDiagnostic): void;
};

// A revision is learned only from an actual read or accepted receipt. Each write
// captures a new sequence; no request payload survives an attempt for replay.
export const createMonitoringSender = (options: MonitoringSenderOptions): { markDirty(): void; finish(signal?: AbortSignal): Promise<void> } => {
  const cancellation = new AbortController();
  let revision: string | null = null;
  let initialized = false, established = false, needRead = true, disabled = false, finishing = false;
  let predecessor: string | null = null;
  let sequence = 0n, failures = 0;
  let unconfirmed: bigint | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | null = null;
  let lastFailure: string | null = null;

  const failure = (phase: DeliveryPhase, error: unknown, requestId: string | null): void => {
    try { options.deliveryFailure(phase, error, requestId); } catch { /* Monitoring callbacks must not affect worker execution. */ }
    const safe = classifyFailure(error);
    const signature = `${phase}:${safe.code}`;
    if (signature !== lastFailure) {
      lastFailure = signature;
      try { options.emit({ kind: "worker_monitoring_failed", message: JSON.stringify({ component: "monitoring", phase, request_id: requestId, type: safe.type, code: safe.code, cause: safe.cause }) }); } catch { /* Local logging is independent of monitoring. */ }
    }
  };
  const success = (): void => {
    failures = 0; lastFailure = null;
    try { options.deliverySuccess(); } catch { /* Observer failure cannot stop the worker. */ }
  };
  const reconcile = (state: MonitoringRead): boolean => {
    initialized = true; needRead = false;
    if (state.state === "absent") { revision = null; return true; }
    revision = state.revision;
    if (state.runId === options.runId) {
      established = true;
      const accepted = BigInt(state.sequence);
      if (accepted > sequence) sequence = accepted;
      if (unconfirmed !== null && accepted >= unconfirmed) success();
      unconfirmed = null;
      return true;
    }
    if (established || predecessor !== null && predecessor !== state.runId) {
      disabled = true;
      failure("reconcile", new Error("A different worker monitoring run replaced this run."), null);
      return false;
    }
    predecessor ??= state.runId;
    return true;
  };
  const attempt = async (final: boolean): Promise<boolean> => {
    if (disabled || cancellation.signal.aborted) return false;
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 5_000, requestMs: 5_000, responseBytes: 512 * 1024, totalBytes: 1024 * 1024 } });
    let phase: DeliveryPhase = final ? "shutdown" : "read";
    let requestId: string | null = null;
    let writing = false;
    try {
      if (needRead || !initialized) {
        requestId = randomUUID();
        const state = await options.read(operation, requestId);
        operation.check();
        if (!reconcile(state)) return false;
      }
      phase = final ? "shutdown" : "write";
      requestId = null;
      if (sequence >= MAX_SEQUENCE) throw new RangeError("Worker monitoring sequence exhausted.");
      const next = (++sequence).toString();
      const observation = options.capture(next);
      if (observation.runId !== options.runId || observation.sequence !== next) throw new Error("Monitoring capture identity mismatch.");
      requestId = randomUUID();
      writing = true;
      const receipt = await options.write(revision, observation, operation, requestId);
      operation.check();
      if (receipt.runId !== options.runId || receipt.sequence !== next) throw new Error("Monitoring receipt identity mismatch.");
      revision = receipt.revision; established = true; needRead = false; success();
      return true;
    } catch (error) {
      if (cancellation.signal.aborted) return false;
      // Only a received response proves that our request identity was used.
      const observedRequestId = error instanceof ApiError && (error.phase === "response" || error.phase === "protocol") ? requestId : null;
      failure(phase, error, observedRequestId);
      failures++;
      if (writing) {
        // A failure after dispatch, including a deadline checked after receiving
        // the response, cannot authorize a new write using the old revision.
        needRead = true;
        if (!(error instanceof ApiError) || error.outcomeUnconfirmed) unconfirmed = sequence;
      }
      return false;
    } finally { operation.dispose(); }
  };
  const schedule = (delay: number): void => {
    if (disabled || finishing || cancellation.signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; start(); }, delay);
    timer.unref();
  };
  const start = (): void => {
    if (running !== null || disabled || finishing || cancellation.signal.aborted) return;
    running = attempt(false);
    void running.then(() => {
      running = null;
      schedule(failures > 1 ? 2 * PERIOD : PERIOD);
    });
  };
  start();
  return {
    // Periodic captures are unconditional. Dirty changes are coalesced until the
    // next allowed send, and do not produce a second request while one is active.
    markDirty: () => {},
    finish: async (signal) => {
      if (finishing) { await running; return; }
      finishing = true;
      if (timer !== undefined) clearTimeout(timer);
      const deadline = new AbortController();
      const deadlineTimer = setTimeout(() => deadline.abort(), 5_000);
      deadlineTimer.unref();
      const finishSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
      const cancel = (): void => cancellation.abort(finishSignal.reason);
      finishSignal.addEventListener("abort", cancel, { once: true });
      if (finishSignal.aborted) cancel();
      try {
        await running;
        if (!finishSignal.aborted && !disabled) {
          running = attempt(true);
          await running;
          running = null;
        }
      } finally {
        cancellation.abort();
        clearTimeout(deadlineTimer);
        finishSignal.removeEventListener("abort", cancel);
      }
    },
  };
};
