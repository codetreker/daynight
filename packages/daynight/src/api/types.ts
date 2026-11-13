import type { ToolPathTelemetry } from "./worker-tool-paths.js";
import type { TaskStatus } from "../task/status.js";
export type { TaskStatus } from "../task/status.js";

export type TaskStepStatus = "todo" | "in_progress" | "done" | "skipped";
export type TaskStep = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStepStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type StepsResource = {
  readonly projectId: string;
  readonly taskId: string;
  readonly version: bigint;
  readonly steps: readonly TaskStep[];
};
export type StepResource = {
  readonly projectId: string;
  readonly taskId: string;
  readonly version: bigint;
  readonly step: TaskStep;
};

export type AddTaskStepInput = {
  readonly version: bigint;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status?: TaskStepStatus;
  readonly before?: string;
  readonly after?: string;
};
export type DeleteTaskStepInput = { readonly version: bigint };
export type TaskStepsReadOptions = { readonly requestId: string };
export type TaskStepWriteOptions = TaskStepsReadOptions & { readonly previous?: StepsResource };
export type AddTaskStepOptions = TaskStepWriteOptions;
export type UpdateTaskStepInput = {
  readonly version: bigint;
  readonly title?: string;
  readonly description?: string;
};
export type SetTaskStepStatusInput = { readonly version: bigint; readonly status: TaskStepStatus };
export type MoveTaskStepInput = {
  readonly version: bigint;
  readonly before?: string;
  readonly after?: string;
  readonly position?: "first" | "last";
};
export type MoveTaskStepOptions = TaskStepWriteOptions;

export type TaskPlatform = "windows" | "linux" | "macos";

export type User = {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly personalTeam: TeamRef;
};

export type TaskAttachment = {
  readonly path: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PutTaskAttachmentInput = {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
};

export type AttachmentConsumer = (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;

export type ProjectSettings = {
  readonly version: bigint;
  readonly executionWarningMinutes: number;
};

export type TeamRef = {
  readonly id: string;
  readonly kind: "personal" | "ordinary";
  readonly name: string | null;
};

export type TeamRole = "member" | "admin";
export type TeamMember = {
  readonly teamId: string;
  readonly userId: string;
  readonly role: TeamRole;
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type TeamMemberWithProfile = TeamMember & {
  readonly profile: { readonly name: string | null; readonly email: string | null; readonly avatarUrl: string | null };
};
export type TeamMemberRoleReceipt = { readonly membership: TeamMember; readonly actorRole: TeamRole };
export type RemoveTeamMemberReceipt = { readonly teamId: string; readonly userId: string; readonly removed: true; readonly actorRole: TeamRole | null };

export type Team = TeamRef & {
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly membership: TeamMember;
};

export type TeamInvitation = {
  readonly id: string;
  readonly teamId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedBy: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
};
export type CreatedTeamInvitation = TeamInvitation & { readonly link: string };
export type TeamInvitationRevokeReceipt = { readonly teamId: string; readonly invitationId: string; readonly changed: boolean };

export type ProjectOwnership = {
  readonly teamId: string;
  readonly version: bigint;
};

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly settings: ProjectSettings;
  readonly ownership: ProjectOwnership;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectGrant = {
  readonly projectId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectAccess = {
  readonly projectId: string;
  readonly ownerTeam: TeamRef;
  readonly ownership: ProjectOwnership;
  readonly teamRole: "admin" | "member" | null;
  readonly canTransfer: boolean;
  readonly effectiveRole: "admin" | "member";
  readonly directGrant: ProjectGrant | null;
};

export type InvitationScope = "project" | "team";
export type TeamInvitationMember = Team["membership"];
export type ProjectInvitationInspection = { readonly projectId: string; readonly projectName: string; readonly directGrant: ProjectGrant | null; readonly access: ProjectAccess | null };
export type ProjectInvitationAcceptance = { readonly projectId: string; readonly directGrant: ProjectGrant; readonly access: ProjectAccess; readonly joined: boolean; readonly consumed: boolean };
export type TeamInvitationInspection = { readonly team: TeamRef; readonly membership: TeamInvitationMember | null };
export type TeamInvitationAcceptance = { readonly team: TeamRef; readonly membership: TeamInvitationMember; readonly joined: boolean; readonly consumed: boolean };
export type InvitationInspection = ProjectInvitationInspection | TeamInvitationInspection;
export type InvitationAcceptance = ProjectInvitationAcceptance | TeamInvitationAcceptance;

export type ProjectDeletionClaim = {
  readonly taskId: string;
  readonly title: string;
  readonly worker: { readonly machineName: string; readonly platform: TaskPlatform; readonly phase: WorkerPhase; readonly paused: boolean; readonly connectivity: "online" | "offline" | "unknown" };
};
export type ProjectDeletionPreview = {
  readonly observedAt: string;
  readonly project: { readonly id: string; readonly name: string; readonly repoUrl: string; readonly ownerTeam: TeamRef };
  readonly summary: { readonly taskCount: number; readonly unfinishedTaskCount: number; readonly attachmentCount: number };
  readonly activeClaims: readonly ProjectDeletionClaim[];
  readonly nextCursor: string | null;
};
export type ProjectDeletionReceipt = { readonly projectId: string; readonly deleted: true };

export type ProjectTransferPreview = {
  readonly sourceTeam: TeamRef;
  readonly targetTeam: TeamRef & { readonly version: bigint };
  readonly ownership: ProjectOwnership;
  readonly actorRole: "admin" | "member" | null;
};

export type ProjectTransferReceipt = {
  readonly projectId: string;
  readonly changed: boolean;
  readonly sourceTeam: TeamRef;
  readonly ownerTeam: TeamRef;
  readonly ownership: ProjectOwnership;
  readonly actorAccess: ProjectAccess | null;
};

export type ProjectParticipant = {
  readonly inheritedFrom: { readonly team: TeamRef; readonly role: "admin" | "member" } | null;
  readonly userId: string;
  readonly profile: {
    readonly name: string | null;
    readonly email: string | null;
    readonly avatarUrl: string | null;
  };
  readonly effectiveRole: "admin" | "member";
  readonly directGrant: ProjectGrant | null;
};

export type PullRequestProperty = {
  readonly url: string;
  readonly title: string;
};

export type WorkerState = "active" | "completed";
export type WorkerAgent = "codex" | "copilot" | "claude";
export type ThreadReadQuery = { readonly beforeId?: string; readonly afterId?: string; readonly count: number; readonly details: boolean };
export type PostThreadMessageInput = { readonly body: string; readonly replyTo?: string; readonly claimId?: string };
export type ThreadExecution = { readonly claimId: string; readonly workerId: string; readonly provider: WorkerAgent };
export type ThreadAuthor = { readonly userId: string; readonly displayName: string | null; readonly Agent: boolean; readonly execution?: ThreadExecution };
export type ThreadMessage = { readonly id: string; readonly author: ThreadAuthor; readonly body: string; readonly createdAt: string; readonly replyTo?: string };
export type ThreadPage = { readonly items: readonly ThreadMessage[]; readonly hasMoreBefore: boolean; readonly hasMoreAfter: boolean };
export type AgentControlMode = "herdr" | "web";
export type WorkerPhase = "preparing" | "executing" | "verifying" | "completing" | "waiting" | "paused";
export type WorkerMachine = { readonly id: string; readonly name: string };
export type WorkerProbeCode = "not_found" | "permission_denied" | "timeout" | "command_failed" | "invalid_output" | "invalid_sample" | "out_of_range" | "io_error" | "unavailable";
export type WorkerProbe<T> =
  | { readonly state: "ok"; readonly checkedAt: string; readonly value: T }
  | { readonly state: "error"; readonly checkedAt: string; readonly code: WorkerProbeCode };
export type WorkerExecutableProbe = WorkerProbe<string> | { readonly state: "not_installed"; readonly checkedAt: string };
export type WorkerHerdrProbe = WorkerProbe<string> | { readonly state: "not_running"; readonly checkedAt: string };
export type WorkerOS = { readonly type: string; readonly release: string; readonly version: string; readonly arch: string };
export type WorkerCPU = { readonly model: string; readonly logicalProcessors: number; readonly usagePercent: number };
export type WorkerMemory = { readonly usedBytes: number; readonly totalBytes: number };
export type WorkerDisk = { readonly availableBytes: number; readonly totalBytes: number };
export type WorkerVersions = {
  readonly daynight: string;
  readonly herdr: WorkerHerdrProbe;
  readonly codex: WorkerExecutableProbe;
  readonly copilot: WorkerExecutableProbe;
};
export type WorkerAssistantHostReason = "unsupported_arguments" | "invalid_cwd" | "not_found" | "permission_denied" | "timeout" | "command_failed" | "invalid_output" | "unavailable";
export type WorkerAssistantProvider = {
  readonly provider: WorkerAgent;
  readonly available: boolean;
  readonly reason: WorkerAssistantHostReason | null;
  readonly model: string | null;
  readonly args: readonly string[];
};
export type WorkerAssistantHost = {
  readonly protocolVersion: 1;
  readonly creationConfigurationVersion?: 1;
  readonly observedAt: string;
  readonly defaultCwd: string;
  readonly defaultProvider: WorkerAgent;
  readonly providers: readonly WorkerAssistantProvider[];
};
export type WorkerConfigurationValue = { readonly value: string; readonly source: "local" | "cloud" } | { readonly value: null; readonly source: "native" };
export type WorkerRuntimeNative = { readonly agent: WorkerAgent; readonly model: WorkerConfigurationValue; readonly reasoningEffort: WorkerConfigurationValue };
export type WorkerRuntimeConfiguration = {
  readonly schemaVersion: 1;
  readonly native: WorkerRuntimeNative | null;
  readonly projects: readonly { readonly projectId: string; readonly native: WorkerRuntimeNative | null }[];
};
export type WorkerTelemetry = {
  readonly toolPaths?: ToolPathTelemetry;
  readonly runtimeConfiguration?: WorkerRuntimeConfiguration;
  readonly machine: WorkerMachine;
  readonly platform: TaskPlatform;
  readonly workingDirectory: string;
  readonly sampledAt: string;
  readonly os: WorkerProbe<WorkerOS>;
  readonly cpu: WorkerProbe<WorkerCPU>;
  readonly memory: WorkerProbe<WorkerMemory>;
  readonly disk: WorkerProbe<WorkerDisk>;
  readonly versions: WorkerVersions;
  readonly assistantHost?: WorkerAssistantHost;
};
export type WorkerTaskReference = { readonly projectId: string; readonly taskId: string; readonly claimId: string };
export type WorkerTaskInventory = { readonly observedAt: string; readonly claims: readonly WorkerTaskReference[] };
export type WorkerReport = WorkerTelemetry & { readonly taskInventory: WorkerTaskInventory | null };
export type WorkerReportReceipt = { readonly observedAt: string; readonly lastReportedAt: string };
export type WorkerHerdr = { readonly session: string; readonly workspaceId: string; readonly paneId: string };
export type WorkerClaim = {
  readonly claimId: string;
  readonly state: WorkerState;
  readonly userId: string;
  readonly workerId: string;
  readonly machine: WorkerMachine;
  readonly platform: TaskPlatform;
  readonly agent: WorkerAgent;
  readonly agentControlMode: AgentControlMode;
  readonly worktreeId: string;
  readonly phase: WorkerPhase;
  readonly herdr: WorkerHerdr | null;
  readonly nativeSessionId: string | null;
  readonly claimedAt: string;
};
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type TaskProperties = Readonly<Record<string, JsonValue>>;
export type WritableTaskProperties = TaskProperties;

export type TaskPropertyResource = {
  readonly projectId: string;
  readonly taskId: string;
  readonly version: bigint;
  readonly properties: TaskProperties;
};
export type SetTaskPropertyInput = { readonly version: bigint; readonly valueText: string };
export type RemoveTaskPropertyInput = { readonly version: bigint };
export type TaskPropertyDefinition = {
  readonly description: string;
  readonly readOnly: boolean;
  readonly schema: Readonly<Record<string, JsonValue>>;
};
export type TaskPropertySchema = { readonly properties: Readonly<Record<string, TaskPropertyDefinition>> };

export type TagReference = { readonly id: string; readonly name: string };

export type Task = {
  readonly id: string;
  readonly type: "task" | "goal";
  readonly parentId: string | null;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly TagReference[];
  readonly status: TaskStatus;
  readonly allowAgents: boolean;
  readonly requiredPlatform: TaskPlatform | null;
  readonly assignedTo: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly version: bigint;
  readonly properties: TaskProperties;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependsOn: readonly string[];
  readonly externalDependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
  readonly progress?: GoalProgress;
};

export type GoalProgress = { readonly total: number; readonly done: number; readonly cancelled: number; readonly unfinished: number };

export type GraphTask = Omit<Task, "projectId" | "title" | "description" | "tags" | "version" | "properties" | "progress" | "type"> & {
  readonly type: "task";
  readonly titlePreview: string;
  readonly titleTruncated: boolean;
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

/** A complete ordinary chain with direct external prerequisites, whose own dependency references may lie outside the returned tasks. */
export type TaskGraph = {
  readonly observedAt: string;
  readonly project: Project;
  readonly summary: TaskGraphSummary;
  readonly tasks: readonly GraphTask[];
};

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };
export type CreateProjectInput = { readonly name: string; readonly repoUrl: string; readonly expectedUserId: string; readonly teamId?: string };
export type CreateTaskInput = {
  readonly title: string;
  readonly type?: "task" | "goal";
  readonly parentId?: string | null;
  readonly status?: TaskStatus;
  readonly requiredPlatform?: TaskPlatform | null;
  readonly assignedTo?: string | null;
  readonly description?: string;
  readonly properties?: WritableTaskProperties;
  readonly dependsOn?: readonly string[];
  readonly externalDependsOn?: readonly string[];
  readonly tagIds?: readonly string[];
};
export type UpdateTaskInput = {
  readonly version: bigint;
  readonly parentId?: string | null;
  readonly allowAgents?: boolean;
  readonly requiredPlatform?: TaskPlatform | null;
  readonly assignedTo?: string | null;
  readonly title?: string;
  readonly description?: string;
  readonly properties?: WritableTaskProperties;
  readonly dependsOn?: readonly string[];
  readonly externalDependsOn?: readonly string[];
  readonly tagIds?: readonly string[];
};
export type DeleteTaskInput = { readonly version: bigint; readonly removeDepends?: boolean };
export type SetTaskStatusInput = { readonly version: bigint; readonly status: TaskStatus };
export type WorkerClaimDescriptor = {
  readonly claimId: string;
  readonly workerId: string;
  readonly machine: WorkerMachine;
  readonly platform: TaskPlatform;
  readonly agent: WorkerAgent;
  readonly agentControlMode?: AgentControlMode;
  readonly worktreeId: string;
};
export type ClaimWorkerTaskInput = WorkerClaimDescriptor & { readonly version: bigint };
export type UpdateWorkerClaimInput = {
  readonly version: bigint;
  readonly claimId: string;
  readonly phase?: WorkerPhase;
  readonly herdr?: WorkerHerdr | null;
  readonly nativeSessionId?: string | null;
  readonly startupReport?: import("../session/startup.js").SessionStartupReport;
};
export type CompleteWorkerTaskInput = { readonly version: bigint; readonly claimId: string };
export type ReleaseWorkerClaimInput = CompleteWorkerTaskInput & { readonly stoppedConfirmed: true };
export type WithdrawWorkerClaimInput = CompleteWorkerTaskInput;
export type TaskFilters = {
  readonly tagIds?: readonly string[];
  readonly tagMatch?: "all" | "any";
  readonly untagged?: boolean;
  readonly type?: "task" | "goal";
  readonly parentId?: string | null;
  readonly assignedTo?: string;
  readonly status?: TaskStatus;
  readonly ready?: boolean;
  readonly allowAgents?: boolean;
  readonly compatiblePlatform?: TaskPlatform;
  readonly platformSpecific?: boolean;
  readonly automaticCandidate?: boolean;
  readonly workerId?: string;
};
export type TaskSearchInput = Omit<TaskFilters, "workerId" | "platformSpecific" | "automaticCandidate"> & { readonly query: string };
export type TaskSearchField = "id" | "title" | "description";
export type TaskSearchItem = {
  readonly id: string;
  readonly type: "task" | "goal";
  readonly parentId: string | null;
  readonly projectId: string;
  readonly title: string;
  readonly tags: readonly TagReference[];
  readonly status: TaskStatus;
  readonly cancelledAt: string | null;
  readonly context: { readonly taskId: string; readonly title: string } | null;
  readonly match: { readonly fields: readonly TaskSearchField[]; readonly descriptionSnippet: string | null };
};
export type TaskSearchPage = { readonly projectId: string; readonly total: number; readonly items: readonly TaskSearchItem[]; readonly nextCursor: string | null };
export type TaskPageQuery = TaskFilters & { readonly limit: number; readonly cursor?: string };
export type ReadyTaskFilters = Pick<TaskFilters, "parentId" | "allowAgents" | "compatiblePlatform" | "tagIds" | "tagMatch" | "untagged">;
export type ErrorDetails = {
  readonly writeOutcome?: "not_committed";
  readonly reason?: string;
  readonly position?: number;
  readonly length?: number;
  readonly encodedBytes?: number;
  readonly maxEncodedBytes?: number;
  readonly taskIds?: readonly string[];
};
export type ServerError = {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: ErrorDetails;
};
