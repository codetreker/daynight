import type { Operation } from "../../api/operation.js";
import type { ClaimIdentity, ResourceOwner } from "./types.js";

/** The observed source contradicts the execution previously identified for this owner. */
export class ExecutionSourceConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ExecutionSourceConflictError"; }
}

export type CleanupTarget = ClaimIdentity & { worktreeId?: string };
export type ExecutionRef = { owner: ResourceOwner; backend: "web" | "herdr-legacy" | "herdr-native"; runKey: string };
export type StopObservation =
  | { kind: "stopped"; execution: ExecutionRef; observedAt: number }
  | { kind: "running"; execution: ExecutionRef; observedAt: number }
  | { kind: "not-started"; owner: ResourceOwner; observedAt: number }
  | { kind: "unknown"; target: CleanupTarget; error: unknown; observedAt: number };
export type CleanupAttempt = { attemptId: string; owner: ResourceOwner };
export type ExecutionStoppedNotice = {
  attempt: CleanupAttempt;
  observation: Extract<StopObservation, { kind: "stopped" | "not-started" }>;
};
export type TerminalCleanupContext = { attempt: CleanupAttempt; onExecutionStopped(notice: ExecutionStoppedNotice): void };
export type CleanupRequest =
  | { kind: "terminal"; deadline: number; immediateStop: boolean; scope: TerminalCleanupContext; signal?: AbortSignal }
  | { kind: "shutdown"; deadline: number; immediateStop: true; signal?: AbortSignal };
export type ExecutionStopObserver = (target: CleanupTarget, operation: Operation) => Promise<StopObservation>;
