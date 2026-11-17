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
