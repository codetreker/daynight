import { ApiError } from "../../api/client.js";
import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import { ProtocolError } from "../../api/parse.js";
import type { WorkerReport, WorkerReportReceipt, WorkerTaskInventory, WorkerTaskReference } from "../../api/types.js";
import type { WorkerDiagnostic } from "./diagnostics.js";
import { hasHerdrCommandCleanupFailure, hasUnconfirmedHerdrCommandCleanup, HerdrCommandCleanupError } from "./herdr/command.js";
import type { WorkerTelemetryIssue, WorkerTelemetrySample } from "./telemetry.js";
import { syncWorkerConfigurationOnce } from "./configuration-exchange.js";
import type { WorkerConfigurationExchange } from "./configuration-exchange.js";
export { syncWorkerConfigurationOnce } from "./configuration-exchange.js";
export type { WorkerConfigurationExchange } from "./configuration-exchange.js";

type SafeFailure = { category: string; cause?: SafeFailure; errors?: readonly SafeFailure[] };
type FailureState = { signature: string; repetitions: number };

const describeFailure = (error: unknown, seen = new Set<unknown>(), depth = 0): SafeFailure => {
  if (depth >= 6 || seen.has(error)) return { category: "truncated" };
  seen.add(error);
  const category = error instanceof AggregateError ? "aggregate"
    : error instanceof OperationError ? `operation_${error.kind}`
    : error instanceof ApiError && error.operation === "worker.configuration.report" && error.status === 413 ? `configuration_report_capacity_413${error.outcomeUnconfirmed ? "_outcome_unconfirmed" : ""}`
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
  configuration?: WorkerConfigurationExchange;
}): { trigger(): void; demandChanged(): void; publishInventory(inventory: WorkerTaskInventory | null): void; recordClaim(reference: WorkerTaskReference): void; stop(): Promise<void> } => {
  const cancellation = new AbortController();
  const failures = new Map<string, FailureState>();
  const cleanupFailures = new Set<unknown>();
  let inventory: WorkerTaskInventory | null = null;
  let stopped = false;
  let pending = false;
  let pendingPrompt = false;
  let deferPromptCycle = false;
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
    pendingPrompt = false;
    if (timer !== undefined) clearInterval(timer);
    cancellation.abort();
    options.signal.removeEventListener("abort", halt);
  };
  const retainCleanupFailure = (error: unknown): void => {
    cleanupFailures.add(error);
  };
  const isCancellation = (error: unknown): boolean => error === cancellation.signal.reason ||
    (error instanceof OperationError && error.kind === "cancelled" && isCancellation(error.cause));
  const requiresCleanupFailure = (error: unknown, seen = new Set<unknown>()): boolean => {
    if (seen.has(error)) return true;
    if (error instanceof HerdrCommandCleanupError) return hasUnconfirmedHerdrCommandCleanup(error);
    if (isCancellation(error)) return false;
    // Keep mixed aggregates intact when any independent failure remains. A cause
    // wrapper alone does not turn an acknowledged cleanup timeout into a new failure.
    const ancestors = new Set(seen).add(error);
    if (error instanceof AggregateError) return error.errors.some((item: unknown) => requiresCleanupFailure(item, ancestors)) ||
      (error.cause !== undefined && requiresCleanupFailure(error.cause, ancestors));
    if (error instanceof Error && error.cause !== undefined) return requiresCleanupFailure(error.cause, ancestors);
    return true;
  };
  const attempt = async (): Promise<void> => {
    const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 15_000, requestMs: 10_000 } });
    let phase = "collect";
    try {
      const collect = async (): Promise<WorkerReport> => {
        phase = "collect";
        const sample = await options.collect(operation);
        for (const issue of sample.issues) {
          if (hasHerdrCommandCleanupFailure(issue.error)) {
            retainCleanupFailure(issue.error);
            if (stopped) fail(issue.component, "collect", issue.error, issue.code);
          }
        }
        operation.check();
        const unavailable = new Set(sample.issues.map(issue => issue.component));
        for (const component of ["os", "cpu", "memory", "disk", "herdr", "codex", "copilot", "assistantHost_codex", "assistantHost_claude", "assistantHost_copilot"] as const) {
          if (!unavailable.has(component)) recover(component, "collect");
        }
        for (const issue of sample.issues) fail(issue.component, "collect", issue.error, issue.code);
        operation.check();
        phase = options.configuration === undefined ? "send" : "configuration";
        return Object.freeze({ ...sample.telemetry, taskInventory: inventory });
      };
      if (options.configuration === undefined) {
        const report = await collect();
        phase = "send";
        await options.send(report, operation);
      } else {
        phase = "configuration-read";
        const result = await syncWorkerConfigurationOnce({ configuration: options.configuration, operation, report: collect });
        phase = "configuration";
        if (result.promptError) fail("prompts", phase, new ProtocolError("Invalid prompt results."));
        else recover("prompts", phase);
        if (result.stopCatchup) { pendingPrompt = false; deferPromptCycle = true; }
        if (result.more) pendingPrompt = true;
      }
      operation.check();
      recover("report", phase);
    } catch (error) {
      options.configuration?.prompts?.failCycle();
      pendingPrompt = false;
      if (options.configuration?.prompts !== undefined) deferPromptCycle = true;
      if (hasHerdrCommandCleanupFailure(error)) {
        fail("report", phase, error);
        retainCleanupFailure(error);
      } else if (!stopped) fail("report", phase, error);
    } finally { operation.dispose(); }
  };
  const run = async (): Promise<void> => {
    while ((pending || pendingPrompt) && !stopped) { pending = false; pendingPrompt = false; await attempt(); }
  };
  const schedule = (): void => {
    if (stopped) return;
    if (running !== null) return;
    running = run().then(() => { running = null; if ((pending || pendingPrompt) && !stopped) schedule(); });
  };
  const trigger = (): void => { if (!stopped) { pending = true; schedule(); } };
  const cycle = (): void => { deferPromptCycle = false; options.configuration?.prompts?.beginCycle(); trigger(); };
  options.signal.addEventListener("abort", halt, { once: true });
  if (options.signal.aborted) halt();
  else { timer = setInterval(cycle, 30_000); timer.unref(); cycle(); }

  return {
    trigger,
    demandChanged: () => { if (!stopped && !deferPromptCycle) { options.configuration?.prompts?.beginCycle(); pendingPrompt = true; schedule(); } },
    publishInventory: (value) => {
      if (stopped) return;
      if (value !== null && value.claims.length > 256) {
        inventory = null;
        fail("inventory", "collect", new RangeError("Worker claim inventory exceeds 256 items."));
      } else {
        inventory = value === null ? null : copyInventory(value);
        if (value !== null) recover("inventory", "collect");
      }
      trigger();
    },
    recordClaim: (reference) => {
      if (stopped) return;
      if (inventory !== null) {
        const replacing = inventory.claims.some(claim => claim.taskId === reference.taskId);
        if (!replacing && inventory.claims.length >= 256) {
          inventory = null;
          fail("inventory", "collect", new RangeError("Worker claim inventory exceeds 256 items."));
        } else inventory = Object.freeze({
          observedAt: inventory.observedAt,
          claims: Object.freeze([...inventory.claims.filter(claim => claim.taskId !== reference.taskId), copyReference(reference)]),
        });
      }
      trigger();
    },
    stop: async () => {
      halt();
      await running;
      const errors = [...[...cleanupFailures].filter(error => requiresCleanupFailure(error)), diagnosticFailure].filter(error => error !== undefined);
      if (errors.length === 1) throw errors[0];
      if (errors.length !== 0) throw new AggregateError(errors, "Worker reporter could not finish safely.");
    },
  };
};
