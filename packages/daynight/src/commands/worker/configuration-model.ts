import { isDeepStrictEqual } from "node:util";
import type { WorkerTaskTagFilter } from "../../api/task-tag-filter.js";
import { receiveWorkerDesired, parseWorkerCloudDesired, desiredCapabilitySources } from "../../api/worker-configuration.js";
import { ProtocolError } from "../../api/validation.js";
import type { ReceivedWorkerDesired, WorkerCloudDesired, WorkerCloudItem, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudProject, WorkerCloudReport, WorkerCloudValue } from "../../api/worker-configuration.js";
import type { AgentControlMode, WorkerReport } from "../../api/types.js";
import type { Tool, ToolPathChoice, ToolPaths } from "../../platform/tool-path-choice.js";
import type { ToolSelectionTargets } from "./tool-selection.js";

export type WorkerConfigurationIdentity = { readonly serverOrigin: string; readonly userId: string; readonly workerId: string };
export type WorkerConfigurationToolTargets = ToolSelectionTargets;
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
  readonly schemaVersion: 11;
  readonly identity: WorkerConfigurationIdentity;
  readonly authority: { readonly generation: string; readonly desiredJson: string | null; readonly applicationRevision: string | null; readonly observationRevision: string; readonly pendingApplication: boolean };
  readonly remoteObservation: { readonly observationRevision: string; readonly json: string } | null;
  readonly hiddenCapabilitySources?: Readonly<Partial<Record<"agentControlMode" | "toolPaths" | "archiveSessions", { readonly revision: string; readonly json: string }>>>;
  readonly nextFailureId: number;
  readonly projectionCursor: string | null;
  readonly currentItems: readonly TrackedConfigurationItem[];
  readonly retainedItems: readonly TrackedConfigurationItem[];
};
export type WorkerConfigurationSnapshot = {
  readonly generation: string;
  readonly synchronized: boolean;
  readonly desired: WorkerCloudDesired | null;
  readonly desiredRevision: string | null;
  readonly selectedProjects: readonly WorkerCloudProject[] | null;
  readonly applicationRevision: string | null;
  readonly observationRevision: string;
  readonly retainedRecoveryLimit: number | null;
  readonly retainedArchiveSessions: boolean | null;
  readonly items: readonly WorkerCloudItem[];
  readonly toolTargets: WorkerConfigurationToolTargets | null;
  readonly effective: {
    readonly agentControlMode: AgentControlMode | null;
    readonly maxConcurrent: number | null;
    readonly pollIntervalMs: number | null;
    readonly recoveryLimit: number | null;
    readonly preferPlatformSpecificTasks: boolean | null;
    readonly archiveSessions: boolean | null;
    readonly taskTagFilter: WorkerTaskTagFilter | null | undefined;
    readonly taskTagFilterKey: string | null | undefined;
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
export const configurationSupportsMode = (desired: WorkerCloudDesired | null): boolean => desired !== null && Object.hasOwn(desired.value, "agentControlMode");
export const configurationCapabilities = (value: WorkerCloudValue | undefined) => ({ controlMode: value !== undefined && Object.hasOwn(value, "agentControlMode"), toolPaths: value !== undefined && Object.hasOwn(value, "toolPaths"), archiveSessions: value !== undefined && Object.hasOwn(value, "archiveSessions") });
export const parseConfigurationDesired = (value: WorkerCloudDesired, limits = true): WorkerCloudDesired => parseWorkerCloudDesired(value, limits, configurationCapabilities(value.value));
export const freezeConfiguration = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeConfiguration(item);
    Object.freeze(value);
  }
  return value;
};

const derivedDesired = new WeakMap<WorkerConfigurationCache["authority"], ReceivedWorkerDesired | null>();
export const configurationAuthority = (cache: WorkerConfigurationCache): ReceivedWorkerDesired | null => {
  if (!derivedDesired.has(cache.authority)) {
    const json = cache.authority.desiredJson;
    derivedDesired.set(cache.authority, json === null ? null : freezeConfiguration(receiveWorkerDesired(json, { controlMode: false, toolPaths: true, archiveSessions: desiredCapabilitySources(json).has("archiveSessions") })));
  }
  return derivedDesired.get(cache.authority)!;
};
export const configurationDesired = (cache: WorkerConfigurationCache): WorkerCloudDesired | null => configurationAuthority(cache)?.known ?? null;
export const configurationDesiredRevision = (cache: WorkerConfigurationCache): string | null => configurationAuthority(cache)?.revision ?? null;

// Raw authority remains readable even when this binary cannot apply it.
const applicableDesired = new WeakMap<WorkerCloudDesired, WorkerCloudDesired | null>();
export const applicableConfigurationDesired = (desired: WorkerCloudDesired | null): WorkerCloudDesired | null => {
  if (desired === null || Object.hasOwn(desired.value, "agentControlMode")) return null;
  if (!applicableDesired.has(desired)) {
    try { applicableDesired.set(desired, parseConfigurationDesired(desired)); }
    catch (error) { if (!(error instanceof ProtocolError)) throw error; applicableDesired.set(desired, null); }
  }
  return applicableDesired.get(desired)!;
};
