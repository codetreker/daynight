import type { WorkerAgent } from "../../api/types.js";

export type ProjectIdentity = { projectId: string };
export type WorkerProject = ProjectIdentity & { repoUrl: string; localPath: string };
export type ClaimIdentity = ProjectIdentity & { taskId: string; claimId: string };
export type LocalTask = ClaimIdentity & {
  status: "pending" | "active" | "done";
  agent: WorkerAgent;
  sessionId: string | null;
};
export type ExecutionConfiguration = {
  agent: WorkerAgent;
  model: string | null;
  args: readonly string[];
  recoveryLimit: number;
};
export type ResourceOwner = ClaimIdentity & { serverOrigin: string; worktreeId: string };
export type WorktreeBinding = { repositoryPath: string; commonDirectory: string; worktreePath: string; branch: string };
