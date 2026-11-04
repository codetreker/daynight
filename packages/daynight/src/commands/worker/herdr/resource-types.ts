import type { Operation } from "../../../api/operation.js";
import type { SessionV2StopProof } from "../../../session/v2/types.js";
import type { ResourceOwner } from "../types.js";

export type HerdrRetainedResource = {
  owner: ResourceOwner;
  sessionId: string;
  stopped: boolean;
  stopEvidence: readonly SessionV2StopProof[];
  terminal: boolean;
  worktreePath: string;
  sourcePath: string;
  sourceBytes: string;
  state: "pending" | "ready" | "unavailable" | "failed" | "permission_denied" | "abandoned";
  error: string | null;
  nextAttemptAt: number | null;
  worktreeDeleted: boolean;
  disposition: { operationId: string; action: "abandon" | "delete"; completed: boolean } | null;
};
export type HerdrResourceTarget = ResourceOwner & { sessionId: string };
export type HerdrDisposalRequest = HerdrResourceTarget & { operationId: string; action: "abandon" | "delete"; confirmed: true };
export type HerdrArchiveResources = {
  resources(): HerdrRetainedResource[];
  /** Returns true only after a durable matching ready/unavailable receipt. */
  advance(owner: ResourceOwner, operation: Operation): Promise<boolean>;
  /** Commit only after the original worktree is independently observed absent. */
  cleaned(owner: ResourceOwner): void;
  retry(target: HerdrResourceTarget, operation: Operation): Promise<HerdrRetainedResource>;
  /** The owner persists the choice before deleting; the callback preserves Git deletion checks. */
  dispose(request: HerdrDisposalRequest, operation: Operation, removeWorktree: () => Promise<void>): Promise<HerdrRetainedResource>;
};
