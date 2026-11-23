import { randomUUID } from "node:crypto";
import { ApiError } from "../../../api/client.js";
import { createOperation } from "../../../api/operation.js";
import { OperationError, type Operation } from "../../../api/operation.js";
import type { DirectReceipt } from "../../../api/worker-monitoring.js";
import type { WorkerDiagnostic } from "../diagnostics.js";
import type { DeliveryPhase, DirectObservation } from "./types.js";
import { classifyFailure } from "./diagnostics.js";

const PERIOD = 30_000;

export type MonitoringSenderOptions = {
  capture(): DirectObservation;
  write(observation: DirectObservation, operation: Operation, requestId: string): Promise<DirectReceipt>;
  deliverySuccess(): void;
  deliveryFailure(phase: DeliveryPhase, error: unknown, requestId: string | null): void;
  emit(event: WorkerDiagnostic): void;
};

// Each attempt captures the current state; failed or uncertain writes are never replayed.
export const createMonitoringSender = (options: MonitoringSenderOptions): { trigger(): void; finish(signal?: AbortSignal): Promise<void> } => {
  const cancellation = new AbortController();
  let finishing = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | null = null;
  let finishPromise: Promise<void> | undefined;
  let lastFailure: string | null = null;
  let triggered = false;

  const failure = (phase: DeliveryPhase, error: unknown, requestId: string | null): void => {
    try { options.deliveryFailure(phase, error, requestId); } catch { /* Monitoring callbacks must not affect worker execution. */ }
    const safe = classifyFailure(error);
    const signature = `${phase}:${safe.code}`;
    if (signature !== lastFailure) {
      lastFailure = signature;
      try { options.emit({ kind: "worker_monitoring_failed", message: JSON.stringify({ component: "monitoring", phase, request_id: requestId, type: safe.type, code: safe.code, cause: safe.cause }) }); } catch { /* Local logging is independent of monitoring. */ }
    }
  };
  const attempt = async (final: boolean): Promise<boolean> => {
    if (cancellation.signal.aborted) return false;
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 5_000, requestMs: 5_000, responseBytes: 512 * 1024, totalBytes: 1024 * 1024 } });
    const phase: DeliveryPhase = final ? "shutdown" : "write";
    let requestId: string | null = null;
    try {
      const observation = options.capture();
      requestId = randomUUID();
      await options.write(observation, operation, requestId);
      operation.check();
      failures = 0; lastFailure = null;
      try { options.deliverySuccess(); } catch { /* Observer failure cannot stop the worker. */ }
      return true;
    } catch (error) {
      if (cancellation.signal.aborted) return false;
      // Only a received response proves that our request identity was used.
      const observedRequestId = error instanceof ApiError && (error.phase === "response" || error.phase === "protocol") ? requestId : null;
      failure(phase, error, observedRequestId);
      failures++;
      return false;
    } finally { operation.dispose(); }
  };
  const schedule = (delay: number): void => {
    if (finishing || cancellation.signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; start(); }, delay);
    timer.unref();
  };
  const start = (): void => {
    if (running !== null || finishing || cancellation.signal.aborted) return;
    const current = attempt(false);
    running = current;
    void current.then(() => {
      if (running === current) running = null;
      if (triggered) { triggered = false; start(); }
      else schedule(failures > 1 ? 2 * PERIOD : PERIOD);
    });
  };
  start();
  return {
    trigger: () => {
      if (finishing || cancellation.signal.aborted) return;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      if (running !== null) triggered = true;
      else start();
    },
    finish: (signal) => {
      if (finishPromise !== undefined) return finishPromise;
      finishing = true;
      if (timer !== undefined) clearTimeout(timer);
      finishPromise = (async () => {
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(() => deadline.abort(), 5_000);
        deadlineTimer.unref();
        const finishSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
        const cancel = (): void => cancellation.abort(finishSignal.reason);
        finishSignal.addEventListener("abort", cancel, { once: true });
        if (finishSignal.aborted) cancel();
        // Bound shutdown even if a transport fails to settle after cancellation.
        let resolveAbort!: () => void;
        const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
        if (finishSignal.aborted) resolveAbort();
        else finishSignal.addEventListener("abort", resolveAbort, { once: true });
        try {
          let interrupted = false;
          if (running !== null) interrupted = await Promise.race([running.then(() => false), aborted.then(() => true)]);
          if (!finishSignal.aborted) {
            running = attempt(true);
            interrupted = await Promise.race([running.then(() => false), aborted.then(() => true)]);
          }
          if (interrupted) {
            // Cancellation cannot establish whether the in-flight write committed.
            failure("shutdown", new ApiError({ operation: "worker monitoring" }, "request", {
              cause: new OperationError(deadline.signal.aborted ? "deadline" : "cancelled"), outcomeUnconfirmed: true,
            }), null);
          }
        } finally {
          finishSignal.removeEventListener("abort", resolveAbort);
          cancellation.abort();
          clearTimeout(deadlineTimer);
          finishSignal.removeEventListener("abort", cancel);
        }
      })();
      return finishPromise;
    },
  };
};
