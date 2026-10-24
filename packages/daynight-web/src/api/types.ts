export type ExecutionPlatform = "windows" | "linux" | "macos";

export type TaskStatus = "todo" | "in_progress" | "done";

export type Project = {
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
  readonly titlePreview: string;
  readonly titleTruncated: boolean;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly externalDependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
  readonly allowAgents: boolean;
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
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

export type PullRequestProperty = {
  readonly url: string;
  readonly title: string;
};

export type TaskProperties = {
  readonly pullRequests: readonly PullRequestProperty[];
};

export type TaskDetail = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description: string;
  readonly properties: TaskProperties;
  readonly status: TaskStatus;
  readonly version: bigint;
  readonly dependsOn: readonly string[];
  readonly externalDependsOn: readonly string[];
  readonly blockedBy: readonly string[];
  readonly ready: boolean;
  readonly allowAgents: boolean;
  readonly requiredPlatform: ExecutionPlatform | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type GraphLimitDetails = {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
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
};

export type TaskSync = {
  readonly mode: "snapshot" | "delta";
  readonly epoch: string;
  readonly project: Project;
  readonly observedAt: string;
  readonly tasks: readonly TaskSummary[];
};
