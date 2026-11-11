import type { Operation } from "../../api/operation.js";
import type { ClaimIdentity, ResourceOwner } from "./types.js";

export type CleanupTarget = ClaimIdentity & { worktreeId?: string };
export type ExecutionRef = { owner: ResourceOwner; backend: "web" | "herdr-legacy" | "herdr-native"; runKey: string };
export type StopObservation =
  | { kind: "stopped"; execution: ExecutionRef; observedAt: number }
  | { kind: "running"; execution: ExecutionRef; observedAt: number }
  | { kind: "not-started"; owner: ResourceOwner; observedAt: number }
  | { kind: "unknown"; target: CleanupTarget; error: unknown; observedAt: number };
export type CleanupAttempt = { attemptId: string; owner: ResourceOwner };
export type ExecutionStoppedNotice = { attempt: CleanupAttempt; observation: Extract<StopObservation, { kind: "stopped" | "not-started" }> };
export type ExecutionStopObserver = (target: CleanupTarget, operation: Operation) => Promise<StopObservation>;
export type TerminalCleanupContext = { attempt: CleanupAttempt; onExecutionStopped(notice: ExecutionStoppedNotice): void };
export type CleanupRequest =
  | { kind: "terminal"; deadline: number; immediateStop: boolean; scope: TerminalCleanupContext; signal?: AbortSignal }
  | { kind: "shutdown"; deadline: number; immediateStop: true; signal?: AbortSignal };

/** A verified execution source no longer identifies the original instance. */
export class ExecutionSourceConflictError extends Error {
  override readonly name = "ExecutionSourceConflictError";
}
