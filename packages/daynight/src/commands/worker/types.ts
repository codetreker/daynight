import type { WorkerAgent, WorkerHerdr, WorkerPhase } from "../../api/types.js";
import type { HerdrLaunchEvidence, HerdrStopObservation, HerdrWorkspaceEvidence } from "./herdr/agents.js";

export type ProjectIdentity = { serverOrigin: string; projectId: string };
export type ClaimAttempt = { taskId: string; claimId: string; worktreeId: string; workerId: string; userId: string; expectedVersion: string; configuration: FrozenExecutionConfiguration };
export type WorkerProject = ProjectIdentity & { repoUrl: string; localPath: string };
export type WorkerProjectRecord = WorkerProject & { claimAttempt: ClaimAttempt | null };
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
export type ExecutionSummary = { version: string; herdr: WorkerHerdr | null; nativeSessionId: string | null; phase: WorkerPhase; submission: "unknown" | "confirmed" | "rejected" };
export type NativeExecutionState = {
  terminalId: string | null;
  workspaceSubmission: "not-submitted" | "unknown" | "acknowledged";
  workspaceEvidence: HerdrWorkspaceEvidence | null;
  launchEvidence: HerdrLaunchEvidence | null;
  launchSubmission: "never-submitted" | "unknown" | "acknowledged";
  promptSubmission: "not-submitted" | "unknown" | "submitted";
  stopObservation: HerdrStopObservation | null;
  summary: ExecutionSummary | null;
};
export type RecoveryState = { count: number; pauseReason: string | null; retryAuthorized: boolean };
export type CleanupState = {
  claimEnded: boolean;
  kind: "terminal" | "shutdown";
  startedAt: number;
  deadline: number;
  input: "not-submitted" | "unknown" | "submitted" | "rejected" | "unavailable";
  baseline: { stateChangeSeq: number; completionSeq: number } | null;
  result: "completed" | "timed-out" | "failed" | "unavailable" | null;
  error: string | null;
  agentStopped: boolean;
  workspaceClosed: boolean;
  worktreeDeleted: boolean;
};
export type ControlIntent = { kind: "release"; sourceClaimId: string; version: string };
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
  userId: string | null;
  status: "pending" | "active" | "done";
  repoUrl: string;
  repositoryPath: string;
  configuration: FrozenExecutionConfiguration | null;
  resources: ExecutionResources;
  nativeExecution: NativeExecutionState | null;
  recovery: RecoveryState;
  cleanup: CleanupState | null;
  control: ControlState | null;
  createdAt: number;
  updatedAt: number;
};
export type PendingConfiguration =
  | { kind: "new"; configuration: FrozenExecutionConfiguration }
  | { kind: "recovered"; configuration: FrozenExecutionConfiguration | null };
