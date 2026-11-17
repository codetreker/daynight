import type { Operation } from "../../../api/operation.js";
import type { SessionV2StopProof } from "../../../session/v2/types.js";
import type { ResourceOwner } from "../types.js";

export type HerdrRetainedResource = {
  owner: ResourceOwner;
  sessionId: string;
  stopped: boolean;
  stoppedLedgerPending: boolean;
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
  /** A persisted content-only deletion decision, including interrupted deletion. */
  discardRecording?: boolean;
};
export type HerdrResourceTarget = ResourceOwner & { sessionId: string };
export type HerdrDisposalRequest = HerdrResourceTarget & { operationId: string; action: "abandon" | "delete"; confirmed: true };
export type HerdrArchiveResources = {
  resources(): HerdrRetainedResource[];
  /** Returns true only after a durable matching ready/unavailable receipt. */
  advance(owner: ResourceOwner, operation: Operation, shouldArchive?: () => boolean): Promise<boolean>;
  /** Commit only after the original worktree is independently observed absent. */
  cleaned(owner: ResourceOwner): void;
  retry(target: HerdrResourceTarget, operation: Operation): Promise<HerdrRetainedResource>;
  /** The owner persists the choice before deleting; the callback preserves Git deletion checks. */
  dispose(request: HerdrDisposalRequest, operation: Operation, removeWorktree: () => Promise<void | boolean>, options?: { signal?: AbortSignal }): Promise<HerdrRetainedResource>;
  /** Persist the content-only decision before local execution settlement. */
  selectDiscard(owner: ResourceOwner, operation: Operation, shouldDiscard?: () => boolean): Promise<boolean>;
  /** Called after the original local settlement and cleanup job have exited. */
  discard(owner: ResourceOwner, operation: Operation): Promise<void>;
};
