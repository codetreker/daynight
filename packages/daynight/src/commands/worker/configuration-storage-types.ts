// Frozen wire types for deployed Worker configuration checkpoints.
export type AgentControlMode = "herdr" | "web";
export type ToolPathChoice = { readonly kind: "auto" } | { readonly kind: "path"; readonly path: string };
export type WorkerCloudToolPaths = Readonly<Record<"codex" | "copilot" | "herdr", ToolPathChoice | null>>;
export type WorkerCloudNative = { readonly agent: "codex" | "copilot" | "claude"; readonly model: string | null; readonly args: readonly string[] };
export type WorkerCloudProject = { readonly projectId: string; readonly nativeOverrides: Readonly<Partial<WorkerCloudNative>> };
export type WorkerCloudValue = { readonly enableSudoCleanup?: boolean; readonly toolPaths?: WorkerCloudToolPaths; readonly archiveSessions?: boolean; readonly agentControlMode?: AgentControlMode | null; readonly maxConcurrent: number; readonly pollIntervalMs: number; readonly recoveryLimit: number; readonly preferPlatformSpecificTasks: boolean; readonly native: WorkerCloudNative; readonly projects: readonly WorkerCloudProject[] };
export type WorkerCloudDesired = { readonly revision: string; readonly updatedAt: string; readonly value: WorkerCloudValue };
export type WorkerCloudFailure = {
  readonly code: "not_found" | "permission_denied" | "timeout" | "command_failed" | "invalid_output" | "invalid_configuration" | "io_error" | "unavailable";
  readonly category: "validation" | "repository" | "agent" | "runtime" | "storage";
  readonly phase: "validate" | "prepare" | "apply" | "stop" | "persist";
  readonly occurredAt: string;
};
export type WorkerCloudItemKey = { readonly kind: "maxConcurrent" | "pollIntervalMs" | "recoveryLimit" | "preferPlatformSpecificTasks" | "enableSudoCleanup" | "archiveSessions" | "agentControlMode" | "native" }
  | { readonly kind: "projectPreparation" | "projectRemoval" | "projectNative"; readonly projectId: string };
export type WorkerCloudItem = {
  readonly key: WorkerCloudItemKey;
  readonly targetRevision: string;
  readonly appliedValue: number | WorkerCloudNative | boolean | AgentControlMode | null;
  readonly state: "pending" | "applying" | "applied" | "error";
  readonly error: WorkerCloudFailure | null;
  readonly lastFailure: WorkerCloudFailure | null;
  readonly nextAttemptAt: string | null;
};
export type WorkerCloudObservation = { readonly baseRevision: string; readonly desiredRevision: string; readonly items: readonly WorkerCloudItem[] };

export type WorkerConfigurationIdentity = { readonly serverOrigin: string; readonly userId: string; readonly workerId: string };
export type TrackedConfigurationItem = {
  readonly recordId: string;
  readonly origin: { readonly generation: string; readonly targetRevision: string; readonly source: "application" | "schema4" };
  readonly value: WorkerCloudItem;
  readonly backoffStep: number;
  readonly failureId: number | null;
  readonly started: boolean;
  readonly nativeMode: AgentControlMode | null;
  readonly actualSource:
    | { readonly kind: "observed"; readonly recordId: string; readonly generation: string; readonly targetRevision: string }
    | { readonly kind: "schema4"; readonly successRevision: null }
    | null;
  readonly blockedByRemovalId: string | null;
};
export type WorkerConfigurationCache = {
  readonly schemaVersion: 8;
  readonly identity: WorkerConfigurationIdentity;
  readonly authority: { readonly generation: string; readonly desiredJson: string | null; readonly applicationRevision: string | null; readonly observationRevision: string };
  readonly remoteObservation: { readonly observationRevision: string; readonly json: string } | null;
  readonly hiddenCapabilitySources?: Readonly<Partial<Record<"agentControlMode" | "toolPaths" | "archiveSessions", { readonly revision: string; readonly json: string }>>>;
  readonly nextFailureId: number;
  readonly projectionCursor: string | null;
  readonly currentItems: readonly TrackedConfigurationItem[];
  readonly retainedItems: readonly TrackedConfigurationItem[];
};
