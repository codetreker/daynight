export type WorkerCleanupStage = "observation" | "agent-stop" | "backend-close" | "archive" | "worktree-removal";

export class WorkerCleanupError extends Error {
  constructor(readonly stage: WorkerCleanupStage, cause: unknown) {
    super(`Worker cleanup ${stage} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WorkerCleanupError";
  }
}
