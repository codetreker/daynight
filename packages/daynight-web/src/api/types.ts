import type { ProjectAccess, ProjectOwnership, ProjectPersonVersion } from "./auth-types";

export type ExecutionPlatform = "windows" | "linux" | "macos";

export type TaskStatus = "proposed" | "todo" | "in_progress" | "done" | "cancelled";
export type TaskType = "task" | "goal";

export type Project = {
  readonly ownership: ProjectOwnership;
  readonly id: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly settings: ProjectSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectSettings = {
  readonly version: bigint;
  readonly executionWarningMinutes: number;
};

export type ProjectPage = {
  readonly items: readonly Project[];
  readonly nextCursor: string | null;
};

export type GraphTask = {
  readonly id: string;
  readonly type: TaskType;
  readonly parentId: string | null;
  readonly titlePreview: string;
  readonly titleTruncated: boolean;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly externalDependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
  readonly allowAgents: boolean;
  readonly assignedTo: string | null;
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TaskGraphSummary = {
  readonly total: number;
  readonly proposed: number;
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
  readonly cancelled: number;
  readonly ready: number;
  readonly blocked: number;
};

export type TaskGraph = {
  readonly observedAt: string;
  readonly project: Project;
  readonly summary: TaskGraphSummary;
  readonly tasks: readonly GraphTask[];
};

export type PullRequestProperty = {
  readonly url: string;
  readonly title: string;
};

export type WorkerState = "active" | "completed";
export type WorkerAgent = "codex" | "copilot" | "claude";
export type WorkerAgentControlMode = "herdr" | "web";
export type WorkerPhase = "preparing" | "executing" | "verifying" | "completing" | "waiting" | "paused";
export type WorkerClaim = {
  readonly claimId: string;
  readonly state: WorkerState;
  readonly userId: string;
  readonly workerId: string;
  readonly machine: { readonly id: string; readonly name: string };
  readonly platform: ExecutionPlatform;
  readonly agent: WorkerAgent;
  readonly agentControlMode: WorkerAgentControlMode;
  readonly worktreeId: string;
  readonly phase: WorkerPhase;
  readonly herdr: { readonly session: string; readonly workspaceId: string; readonly paneId: string } | null;
  readonly nativeSessionId: string | null;
  readonly claimedAt: string;
};

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type TaskProperties = Readonly<Record<string, JsonValue>>;
export type WritableTaskProperties = TaskProperties;

export type TaskTag = { readonly id: string; readonly name: string };

export type TaskDetail = {
  readonly id: string;
  readonly type: TaskType;
  readonly parentId: string | null;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly properties: TaskProperties;
  readonly tags: readonly TaskTag[];
  readonly status: TaskStatus;
  readonly version: bigint;
  readonly dependsOn: readonly string[];
  readonly externalDependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
  readonly allowAgents: boolean;
  readonly assignedTo: string | null;
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Attachment = {
  readonly path: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type AttachmentPage = {
  readonly items: readonly Attachment[];
  readonly nextCursor: string | null;
};

export type TaskSummary = Omit<GraphTask, "blockedBy" | "ready"> & {
  readonly version: bigint;
  readonly properties: TaskProperties;
  readonly tags: readonly TaskTag[];
};

export type TaskListSessionState = "working" | "notice" | "warning" | "pending";

export type TaskDependencyState = {
  readonly taskVersion: bigint;
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
};

export type TaskSync = {
  readonly assigneeVersions: readonly ProjectPersonVersion[];
  readonly actorAccess: ProjectAccess;
  readonly mode: "snapshot" | "delta";
  readonly epoch: string;
  readonly project: Project;
  readonly observedAt: string;
  readonly tasks: readonly TaskSummary[];
  readonly dependencyStates: Readonly<Record<string, TaskDependencyState>>;
  readonly sessions: Readonly<Record<string, TaskListSessionState>>;
};

export type TaskSyncRead = {
  readonly sync: TaskSync;
  readonly receivedMonotonic: number;
};

export type {
  SessionProvider, SessionFence, ControllerFence, InitialInputState, SessionSnapshot,
  SessionCapabilities, SessionOperations, MessagePart, SessionCommand, SessionOperation,
  SessionResource, SessionInteraction, InteractionResponse, TimelineEntry, SessionEvent,
} from "../../../daynight/src/session/protocol.js";
