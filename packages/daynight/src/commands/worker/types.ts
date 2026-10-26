import type { TaskPlatform, WorkerAgent, WorkerHerdr, WorkerMachine } from "../../api/types.js";

export type ProjectIdentity = { serverOrigin: string; projectId: string };
export type WorkerProject = ProjectIdentity & { repoUrl: string; localPath: string };
export type ClaimIdentity = ProjectIdentity & { taskId: string; claimId: string };
export type PendingClaim = ClaimIdentity & { workerId: string; worktreeId: string };
export type FrozenExecutionConfiguration = {
  agent: WorkerAgent;
  model: string | null;
  args: readonly string[];
  recoveryLimit: number;
};
export type WorktreeBinding = { repositoryPath: string; commonDirectory: string; worktreePath: string; branch: string };
export type NativeSessionReference = { sessionId: string; source: "herdr" | "native-history" };
export type ExecutionResources = { worktree: WorktreeBinding | null; herdr: WorkerHerdr | null; nativeSession: NativeSessionReference | null };
export type RecoveryState = { count: number; pauseReason: string | null; retryAuthorized: boolean };
export type CleanupState = {
  kind: "terminal" | "shutdown";
  startedAt: number;
  deadline: number;
  input: "not-submitted" | "unknown" | "submitted" | "rejected" | "unavailable";
  result: "completed" | "timed-out" | "failed" | "unavailable" | null;
  error: string | null;
  agentStopped: boolean;
  workspaceClosed: boolean;
  worktreeDeleted: boolean;
};
export type TransferTarget = {
  userId: string;
  workerId: string;
  machine: WorkerMachine;
  platform: TaskPlatform;
  agent: WorkerAgent;
  worktreeId: string;
};
export type ControlIntent =
  | { kind: "release"; sourceClaimId: string; version: string }
  | { kind: "transfer"; sourceClaimId: string; version: string; targetClaimId: string; target: TransferTarget };
export type ControlState = {
  intent: ControlIntent;
  requestedAt: number;
  submission: "not-submitted" | "unknown" | "confirmed" | "rejected";
  submittedAt: number | null;
  outcome: "applied" | "ownership-ended" | null;
  resultVersion: string | null;
  error: string | null;
};
export type LocalTask = PendingClaim & {
  status: "pending" | "active" | "done";
  repoUrl: string;
  repositoryPath: string;
  configuration: FrozenExecutionConfiguration | null;
  resources: ExecutionResources;
  recovery: RecoveryState;
  cleanup: CleanupState | null;
  control: ControlState | null;
  createdAt: number;
  updatedAt: number;
};
export type PendingConfiguration =
  | { kind: "new"; configuration: FrozenExecutionConfiguration }
  | { kind: "recovered"; configuration: FrozenExecutionConfiguration | null };
