import { ApiError } from "../../api/client.js";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { ProtocolError } from "../../api/parse.js";
import type { WorkerReport, WorkerReportReceipt, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
import type { WorkerDiagnostic } from "./diagnostics.js";
import { hasHerdrCommandCleanupFailure } from "./herdr/command.js";
import type { WorkerTelemetryIssue, WorkerTelemetrySample } from "./telemetry.js";

type SafeFailure = { category: string; cause?: SafeFailure; errors?: readonly SafeFailure[] };
type FailureState = { signature: string; repetitions: number };

const describeFailure = (error: unknown, seen = new Set<unknown>(), depth = 0): SafeFailure => {
  if (depth >= 6 || seen.has(error)) return { category: "truncated" };
  seen.add(error);
  const category = error instanceof AggregateError ? "aggregate"
    : error instanceof OperationError ? `operation_${error.kind}`
    : error instanceof ApiError ? `http_${error.phase}${error.status === undefined ? "" : `_${error.status}`}`
    : error instanceof ProtocolError ? "protocol"
    : error instanceof TypeError ? "type"
    : error instanceof RangeError ? "range"
    : error instanceof SyntaxError ? "syntax"
    : error instanceof Error ? "error" : "unknown";
  return {
    category,
    ...(error instanceof Error && error.cause !== undefined ? { cause: describeFailure(error.cause, seen, depth + 1) } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map((cause: unknown) => describeFailure(cause, seen, depth + 1)) } : {}),
  };
};

const safeError = (failure: SafeFailure): Error => {
  const options = failure.cause === undefined ? undefined : { cause: safeError(failure.cause) };
  return failure.errors === undefined ? new Error(failure.category, options)
    : new AggregateError(failure.errors.map(safeError), failure.category, options);
};

const copyReference = (reference: WorkerTaskReference): WorkerTaskReference => Object.freeze({
  projectId: reference.projectId, taskId: reference.taskId, claimId: reference.claimId,
});

const copyInventory = (inventory: WorkerTaskInventory): WorkerTaskInventory => Object.freeze({
  observedAt: inventory.observedAt, claims: Object.freeze(inventory.claims.map(copyReference)),
});

export const createWorkerReporter = (options: {
  signal: AbortSignal;
  collect: (operation: Operation) => Promise<WorkerTelemetrySample>;
  send: (report: WorkerReport, operation: Operation) => Promise<WorkerReportReceipt>;
  emit: (event: WorkerDiagnostic) => void;
}): { publishInventory(inventory: WorkerTaskInventory): void; recordClaim(reference: WorkerTaskReference): void; stop(): Promise<void> } => {
  const cancellation = new AbortController();
  const failures = new Map<string, FailureState>();
  const cleanupFailures = new Set<unknown>();
  let inventory: WorkerTaskInventory | null = null;
  let stopped = false;
  let pending = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let diagnosticFailure: unknown;

  const emit = (event: WorkerDiagnostic): void => {
    try { options.emit(event); }
    catch (error) { if (diagnosticFailure === undefined) diagnosticFailure = error; }
  };
  const fail = (subsystem: string, phase: string, error: unknown, code?: WorkerTelemetryIssue["code"]): void => {
    const failure = describeFailure(error);
    const errorCode = error instanceof ApiError && error.code !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
    const requestId = error instanceof ApiError && error.requestId !== undefined && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(error.requestId) ? error.requestId : undefined;
    const signature = JSON.stringify({ phase, code, errorCode, failure });
    const previous = failures.get(subsystem);
    if (previous?.signature === signature) { previous.repetitions++; return; }
    failures.set(subsystem, { signature, repetitions: 1 });
    emit({ kind: "worker_report_failed", message: JSON.stringify({ component: "worker_report", phase, subsystem, ...(code === undefined ? {} : { code }), ...(errorCode === undefined ? {} : { error_code: errorCode }), ...(requestId === undefined ? {} : { request_id: requestId }), category: failure.category }), error: safeError(failure) });
  };
  const recover = (subsystem: string, phase: string): void => {
    const failure = failures.get(subsystem);
    if (failure === undefined) return;
    failures.delete(subsystem);
    emit({ kind: "worker_report_recovered", message: JSON.stringify({ component: "worker_report", phase, subsystem, failures: failure.repetitions }) });
  };
  const halt = (): void => {
    stopped = true;
    pending = false;
    if (timer !== undefined) clearInterval(timer);
    cancellation.abort();
    options.signal.removeEventListener("abort", halt);
  };
  const retainCleanupFailure = (error: unknown): void => {
    cleanupFailures.add(error);
  };
  const attempt = async (): Promise<void> => {
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 15_000, requestMs: 10_000 } });
    let phase = "collect";
    try {
      const sample = await options.collect(operation);
      for (const issue of sample.issues) {
        if (hasHerdrCommandCleanupFailure(issue.error)) {
          retainCleanupFailure(issue.error);
          if (stopped) fail(issue.component, "collect", issue.error, issue.code);
        }
      }
      operation.check();
      const unavailable = new Set(sample.issues.map(issue => issue.component));
      for (const component of ["os", "cpu", "memory", "disk", "herdr", "codex", "copilot"] as const) {
        if (!unavailable.has(component)) recover(component, "collect");
      }
      for (const issue of sample.issues) {
        fail(issue.component, "collect", issue.error, issue.code);
      }
      operation.check();
      phase = "send";
      await options.send(Object.freeze({ ...sample.telemetry, taskInventory: inventory }), operation);
      operation.check();
      recover("report", phase);
    } catch (error) {
      if (hasHerdrCommandCleanupFailure(error)) {
        fail("report", phase, error);
        retainCleanupFailure(error);
      } else if (!stopped) fail("report", phase, error);
    } finally { operation.dispose(); }
  };
  const run = async (): Promise<void> => {
    while (pending && !stopped) { pending = false; await attempt(); }
  };
  const trigger = (): void => {
    if (stopped) return;
    pending = true;
    if (running !== null) return;
    running = run().then(() => { running = null; if (pending && !stopped) trigger(); });
  };
  options.signal.addEventListener("abort", halt, { once: true });
  if (options.signal.aborted) halt();
  else { timer = setInterval(trigger, 30_000); timer.unref(); trigger(); }

  return {
    publishInventory: (value) => {
      if (stopped) return;
      inventory = copyInventory(value);
      trigger();
    },
    recordClaim: (reference) => {
      if (stopped) return;
      if (inventory !== null) inventory = Object.freeze({
        observedAt: inventory.observedAt,
        claims: Object.freeze([...inventory.claims.filter(claim => claim.taskId !== reference.taskId), copyReference(reference)]),
      });
      trigger();
    },
    stop: async () => {
      halt();
      await running;
      const errors = [...cleanupFailures, diagnosticFailure].filter(error => error !== undefined);
      if (errors.length === 1) throw errors[0];
      if (errors.length !== 0) throw new AggregateError(errors, "Worker reporter could not finish safely.");
    },
  };
};
