export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPlatform = "windows" | "linux" | "macos";

export type User = {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
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

export type Project = {
  readonly id: string;
  readonly name: string;
  readonly repoUrl: string;
  readonly settings: ProjectSettings;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectMember = {
  readonly projectId: string;
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly role: "admin" | "member";
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PullRequestProperty = {
  readonly url: string;
  readonly title: string;
};

export type WorkerState = "active" | "released" | "completed";
export type WorkerAgent = "codex" | "copilot";
export type WorkerPhase = "preparing" | "executing" | "verifying" | "completing" | "waiting" | "paused";
export type WorkerMachine = { readonly id: string; readonly name: string };
export type WorkerHerdr = { readonly session: string; readonly workspaceId: string; readonly paneId: string };
export type WorkerClaim = {
  readonly claimId: string;
  readonly state: WorkerState;
  readonly userId: string;
  readonly workerId: string;
  readonly machine: WorkerMachine;
  readonly platform: TaskPlatform;
  readonly agent: WorkerAgent;
  readonly worktreeId: string;
  readonly phase: WorkerPhase;
  readonly herdr: WorkerHerdr | null;
  readonly nativeSessionId: string | null;
  readonly claimedAt: string;
};
export type WritableTaskProperties = { readonly pullRequests: readonly PullRequestProperty[]; readonly worker?: never };
export type TaskProperties = { readonly pullRequests: readonly PullRequestProperty[]; readonly worker: WorkerClaim | null };

export type Task = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly allowAgents: boolean;
  readonly requiredPlatform: TaskPlatform | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly version: bigint;
  readonly properties: TaskProperties;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dependsOn: readonly string[];
  readonly externalDependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
};

export type GraphTask = Omit<Task, "projectId" | "title" | "description" | "version" | "properties"> & {
  readonly titlePreview: string;
  readonly titleTruncated: boolean;
};

export type TaskGraphSummary = {
  readonly total: number;
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
  readonly ready: number;
  readonly blocked: number;
};

export type TaskGraph = {
  readonly observedAt: string;
  readonly project: Project;
  readonly summary: TaskGraphSummary;
  readonly tasks: readonly GraphTask[];
};

export type Page<T> = { readonly items: readonly T[]; readonly nextCursor: string | null };
export type CreateProjectInput = { readonly name: string; readonly repoUrl: string };
export type CreateTaskInput = {
  readonly title: string;
  readonly requiredPlatform?: TaskPlatform | null;
  readonly description?: string;
  readonly properties?: WritableTaskProperties;
  readonly dependsOn?: readonly string[];
  readonly externalDependsOn?: readonly string[];
};
export type UpdateTaskInput = {
  readonly version: bigint;
  readonly allowAgents?: boolean;
  readonly requiredPlatform?: TaskPlatform | null;
  readonly title?: string;
  readonly description?: string;
  readonly properties?: WritableTaskProperties;
  readonly dependsOn?: readonly string[];
  readonly externalDependsOn?: readonly string[];
};
export type DeleteTaskInput = { readonly version: bigint; readonly removeDepends?: boolean };
export type SetTaskStatusInput = { readonly version: bigint; readonly status: TaskStatus };
export type WorkerClaimDescriptor = {
  readonly claimId: string;
  readonly workerId: string;
  readonly machine: WorkerMachine;
  readonly platform: TaskPlatform;
  readonly agent: WorkerAgent;
  readonly worktreeId: string;
};
export type ClaimWorkerTaskInput = WorkerClaimDescriptor & { readonly version: bigint };
export type UpdateWorkerClaimInput = {
  readonly version: bigint;
  readonly claimId: string;
  readonly phase?: WorkerPhase;
  readonly herdr?: WorkerHerdr | null;
  readonly nativeSessionId?: string | null;
};
export type CompleteWorkerTaskInput = { readonly version: bigint; readonly claimId: string };
export type ReleaseWorkerClaimInput = CompleteWorkerTaskInput & { readonly stoppedConfirmed: true };
export type TransferWorkerClaimInput = CompleteWorkerTaskInput & {
  readonly newClaimId: string;
  readonly target: Omit<WorkerClaimDescriptor, "claimId" | "worktreeId"> & { readonly userId: string };
  readonly worktreeId: string;
  readonly stoppedConfirmed: true;
};
export type ResumeWorkerTaskInput = WorkerClaimDescriptor & {
  readonly version: bigint;
  readonly previousClaimId: string;
};
export type TaskFilters = {
  readonly status?: TaskStatus;
  readonly ready?: boolean;
  readonly allowAgents?: boolean;
  readonly compatiblePlatform?: TaskPlatform;
  readonly workerId?: string;
};
export type TaskPageQuery = TaskFilters & { readonly limit: number; readonly cursor?: string };
export type ReadyTaskFilters = Pick<TaskFilters, "allowAgents" | "compatiblePlatform">;
export type ErrorDetails = {
  readonly taskIds?: readonly string[];
  readonly nodeCount?: number;
  readonly edgeCount?: number;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
};
export type ServerError = {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: ErrorDetails;
};
