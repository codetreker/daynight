import { createOperation, OperationError } from "../../api/operation.js";
import type { Operation } from "../../api/operation.js";
import type { ClaimIdentity, LocalTask } from "./types.js";
import type { CleanupTarget } from "./execution-stop.js";
import type { createWorkerGitManager } from "./worktrees.js";

export type WorkerEvent = { kind: string; message: string; projectId?: string; task?: LocalTask; identity?: CleanupTarget; component?: string; phase?: string; attemptId?: string; runKey?: string; error?: unknown };
export type WorkerGitManager = ReturnType<typeof createWorkerGitManager>;
export type WorkerObservedPhase =
  | { kind: "execution"; phase: "observation" | "worktree-preparation" | "agent-start" | "agent-observation" | "input-submission" | "preparing" | "executing" | "verifying" | "completing" | "waiting" | "paused" }
  | { kind: "cleanup"; phase: "observation" | "agent-stop" | "backend-close" | "archive" | "worktree-removal" };
export type WorkerPhaseObserver = (identity: ClaimIdentity, phase: WorkerObservedPhase, progressed: boolean, deadlineAt?: number, operationKey?: string) => void;
export const observeWorkerPhase = (observer: WorkerPhaseObserver | undefined, identity: ClaimIdentity, phase: WorkerObservedPhase, progressed: boolean, deadlineAt?: number, operationKey?: string): void => {
  // Monitoring must not change the result, cancellation or resource ownership of the original operation.
  try { if (operationKey === undefined) observer?.(identity, phase, progressed, deadlineAt); else observer?.(identity, phase, progressed, deadlineAt, operationKey); } catch { /* The owning operation continues independently. */ }
};
export const isWorkerCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every((failure) => isWorkerCancellation(failure, signal))
    && (error.cause === undefined || isWorkerCancellation(error.cause, signal));
  return error === signal.reason || (error instanceof OperationError && error.kind === "cancelled" && error.cause === signal.reason)
    || (error instanceof Error && error.cause !== undefined && isWorkerCancellation(error.cause, signal));
};
export const workerOperation = async <T>(action: (operation: Operation) => Promise<T>, signal?: AbortSignal, totalMs = 120_000): Promise<T> => {
  const operation = createOperation({ ...(signal === undefined ? {} : { signal }), limits: { totalMs } });
  try { return await action(operation); } finally { operation.dispose(); }
};
export const sameClaim = (left: { projectId: string; taskId: string; claimId: string }, right: { projectId: string; taskId: string; claimId: string }): boolean =>
  left.projectId === right.projectId && left.taskId === right.taskId && left.claimId === right.claimId;
