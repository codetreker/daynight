import type { ArchiveRepairCode } from "../controller/archive-error.js";
import type { AgentControlMode, WorkerAgent } from "../../api/types.js";
import type { ResolvedToolLaunch } from "../../platform/tool-executables.js";

export type ProjectIdentity = { projectId: string };
export type WorkerProject = ProjectIdentity & { repoUrl: string; localPath: string };
export type ClaimIdentity = ProjectIdentity & { taskId: string; claimId: string };
export type LocalTask = ClaimIdentity & {
  status: "pending" | "active" | "done";
  agent: WorkerAgent;
  agentControlMode?: AgentControlMode;
  sessionId: string | null;
};
export type FrozenToolObservation = { version: string; checkedAt: string };
export type ExecutionConfiguration = {
  agent: WorkerAgent;
  agentControlMode?: AgentControlMode;
  model: string | null;
  args: readonly string[];
  recoveryLimit: number;
  validateNativeSelection?: true;
  toolLaunch?: ResolvedToolLaunch;
  toolObservation?: FrozenToolObservation;
  herdrLaunch?: ResolvedToolLaunch;
  herdrObservation?: FrozenToolObservation;
};
export type ResourceOwner = ClaimIdentity & { worktreeId: string };
export type CleanupSchedule = {
  deadline: number;
  failures: number;
  nextAttemptAt: number;
  stage: string;
  lastError: string | null;
  archiveRepairCode?: ArchiveRepairCode | null;
};
export type CleanupScheduleRecord = ResourceOwner & CleanupSchedule;
export type ArchiveBackfillIdentity = ClaimIdentity & { serverOrigin: string; executionId: string; executionGeneration: string; launchId: string };
export type ArchiveBackfillSchedule = { archiveRepairCode: ArchiveRepairCode; nextAttemptAt: number };
export type ArchiveBackfillScheduleRecord = ArchiveBackfillIdentity & ArchiveBackfillSchedule;
export type WorktreeBinding = { repositoryPath: string; commonDirectory: string; worktreePath: string; branch: string };

export type FrozenExecutionConfiguration = ExecutionConfiguration;
