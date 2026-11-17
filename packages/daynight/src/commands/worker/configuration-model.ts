import { isDeepStrictEqual } from "node:util";
import { ProtocolError } from "../../api/validation.js";
import { receiveWorkerDesired, parseWorkerCloudDesired } from "../../api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerRawDesired, WorkerCloudItem, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudReport, WorkerCloudValue } from "../../api/worker-configuration.js";
import type { WorkerReport } from "../../api/types.js";
import type { Tool, ToolPathChoice, ToolPaths } from "../../platform/tool-path-choice.js";

export type WorkerConfigurationIdentity = { readonly serverOrigin: string; readonly userId: string; readonly workerId: string };
export type WorkerConfigurationToolTargets = { readonly source: "local" | "cloud"; readonly revision: string | null; readonly choices: ToolPaths };
export type WorkerNativeProof = { readonly native: WorkerCloudNative; readonly tools: readonly { readonly tool: Tool; readonly choice: ToolPathChoice | null; readonly selectionKey: string | null }[] };
export type TrackedConfigurationItem = {
  readonly recordId: string;
  readonly origin: { readonly generation: string; readonly targetRevision: string; readonly source: "application" | "schema4" };
  readonly value: WorkerCloudItem;
  readonly backoffStep: number;
  readonly failureId: number | null;
  readonly started: boolean;
  readonly actualSource:
    | { readonly kind: "observed"; readonly recordId: string; readonly generation: string; readonly targetRevision: string }
    | { readonly kind: "schema4"; readonly successRevision: null }
    | null;
  readonly blockedByRemovalId: string | null;
};
export type WorkerConfigurationCache = {
  readonly schemaVersion: 6;
  readonly format: "web";
  readonly identity: WorkerConfigurationIdentity;
  readonly authority: { readonly generation: string; readonly desiredJson: string | null; readonly applicationRevision: string | null; readonly observationRevision: string };
  readonly remoteObservation: { readonly observationRevision: string; readonly json: string } | null;
  readonly hiddenCapabilitySources?: Readonly<Partial<Record<"agentControlMode" | "toolPaths", { readonly revision: string; readonly json: string }>>>;
  readonly nextFailureId: number;
  readonly projectionCursor: string | null;
  readonly currentItems: readonly TrackedConfigurationItem[];
  readonly retainedItems: readonly TrackedConfigurationItem[];
};
export type WorkerConfigurationSnapshot = {
  readonly generation: string;
  readonly synchronized: boolean;
  readonly desired: WorkerRawDesired | null;
  readonly validatedDesired: WorkerCloudDesired | null;
  readonly applicationRevision: string | null;
  readonly observationRevision: string;
  readonly retainedRecoveryLimit: number | null;
  readonly projects: { readonly selected: readonly string[] | null; readonly tracked: readonly string[] };
  readonly items: readonly WorkerCloudItem[];
  readonly toolTargets: WorkerConfigurationToolTargets | null;
  readonly effective: {
    readonly maxConcurrent: number | null;
    readonly pollIntervalMs: number | null;
    readonly recoveryLimit: number | null;
    readonly preferPlatformSpecificTasks: boolean | null;
    readonly native: WorkerCloudNative | null;
    readonly projects: readonly { readonly projectId: string; readonly native: WorkerCloudNative | null; readonly ready: boolean }[];
  };
};
export type ConfigurationFailureToken = { readonly sourceRecordId: string; readonly failureId: number };
export type WorkerConfigurationSource = {
  readonly state: "unread" | "initialized" | "uninitialized";
  readonly generation: string;
  readonly desiredRevision: string | null;
  readonly observationRevision: string;
};
export type WorkerConfigurationReportContext = {
  readonly reportId: string;
  readonly generation: string;
  readonly baseRevision: string;
  readonly recordIds: readonly string[];
  readonly failures: readonly ConfigurationFailureToken[];
  readonly items: readonly { readonly key: WorkerCloudItemKey; readonly recordId: string; readonly targetRevision: string }[];
};
export type ConfigurationProjection = {
  readonly reportId: string;
  readonly report: WorkerCloudReport;
  readonly generation: string;
  readonly baseRevision: string;
  readonly recordIds: readonly string[];
  readonly failures: readonly ConfigurationFailureToken[];
  readonly nextCursor: string | null;
};
export type ConfigurationProjectionOptions = {
  readonly synchronized: boolean;
  readonly localTools: ToolPaths;
  readonly bootstrap: WorkerCloudValue | null;
  readonly telemetry?: WorkerReport;
};

export const configurationRetryDelays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const configurationKey = (key: WorkerCloudItemKey): string => `${key.kind}:${"projectId" in key ? key.projectId : ""}`;
export const sameConfigurationValue = (first: unknown, second: unknown): boolean => isDeepStrictEqual(first, second);
export const parseConfigurationDesired = (value: WorkerRawDesired, limits = true): WorkerCloudDesired => parseWorkerCloudDesired(value, limits);
export const freezeConfiguration = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeConfiguration(item);
    Object.freeze(value);
  }
  return value;
};

const derivedDesired = new WeakMap<WorkerConfigurationCache["authority"], WorkerRawDesired | null>();
export const configurationDesired = (cache: WorkerConfigurationCache): WorkerRawDesired | null => {
  if (!derivedDesired.has(cache.authority)) derivedDesired.set(cache.authority, cache.authority.desiredJson === null ? null : freezeConfiguration(receiveWorkerDesired(cache.authority.desiredJson).known));
  return derivedDesired.get(cache.authority)!;
};

const derivedActiveDesired = new WeakMap<WorkerConfigurationCache["authority"], WorkerCloudDesired | null>();
export const configurationActiveDesired = (cache: WorkerConfigurationCache): WorkerCloudDesired | null => {
  if (!derivedActiveDesired.has(cache.authority)) {
    const desired = configurationDesired(cache);
    let active: WorkerCloudDesired | null = null;
    if (desired !== null) try { active = freezeConfiguration(parseConfigurationDesired(desired)); } catch (error) { if (!(error instanceof ProtocolError)) throw error; }
    derivedActiveDesired.set(cache.authority, active);
  }
  return derivedActiveDesired.get(cache.authority)!;
};
