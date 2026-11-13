import { isDeepStrictEqual } from "node:util";
import { parseWorkerCloudDesired } from "../../api/worker-configuration.js";
import type { WorkerCloudDesired, WorkerCloudItem, WorkerCloudItemKey, WorkerCloudNative, WorkerCloudReport, WorkerCloudValue } from "../../api/worker-configuration.js";
import type { AgentControlMode, WorkerReport } from "../../api/types.js";
import type { Tool, ToolPathChoice, ToolPaths } from "../../platform/tool-path-choice.js";

export type WorkerConfigurationIdentity = { readonly serverOrigin: string; readonly userId: string; readonly workerId: string };
export type WorkerConfigurationToolTargets = { readonly source: "local" | "cloud"; readonly revision: string | null; readonly choices: ToolPaths };
export type WorkerNativeProof = { readonly mode: AgentControlMode; readonly native: WorkerCloudNative; readonly tools: readonly { readonly tool: Tool; readonly choice: ToolPathChoice | null; readonly selectionKey: string | null }[] };
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
  readonly schemaVersion: 5;
  readonly identity: WorkerConfigurationIdentity;
  readonly authority: { readonly generation: string; readonly desired: WorkerCloudDesired | null; readonly observationRevision: string };
  readonly nextFailureId: number;
  readonly projectionCursor: string | null;
  readonly currentItems: readonly TrackedConfigurationItem[];
  readonly retainedItems: readonly TrackedConfigurationItem[];
};
export type WorkerConfigurationSnapshot = {
  readonly generation: string;
  readonly synchronized: boolean;
  readonly desired: WorkerCloudDesired | null;
  readonly observationRevision: string;
  readonly items: readonly WorkerCloudItem[];
  readonly toolTargets: WorkerConfigurationToolTargets | null;
  readonly effective: {
    readonly agentControlMode: AgentControlMode | null;
    readonly maxConcurrent: number | null;
    readonly pollIntervalMs: number | null;
    readonly recoveryLimit: number | null;
    readonly preferPlatformSpecificTasks: boolean | null;
    readonly native: WorkerCloudNative | null;
    readonly projects: readonly { readonly projectId: string; readonly native: WorkerCloudNative | null; readonly ready: boolean }[];
  };
};
export type ConfigurationFailureToken = { readonly sourceRecordId: string; readonly failureId: number };
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
  readonly localMode: AgentControlMode;
  readonly localTools: ToolPaths;
  readonly bootstrap: WorkerCloudValue | null;
  readonly telemetry?: WorkerReport;
};

export const configurationRetryDelays = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const configurationKey = (key: WorkerCloudItemKey): string => `${key.kind}:${"projectId" in key ? key.projectId : ""}`;
export const sameConfigurationValue = (first: unknown, second: unknown): boolean => isDeepStrictEqual(first, second);
export const configurationSupportsMode = (desired: WorkerCloudDesired | null): boolean => desired !== null && Object.hasOwn(desired.value, "agentControlMode");
export const configurationCapabilities = (value: WorkerCloudValue | undefined) => ({ controlMode: value !== undefined && Object.hasOwn(value, "agentControlMode"), toolPaths: value !== undefined && Object.hasOwn(value, "toolPaths") });
export const parseConfigurationDesired = (value: WorkerCloudDesired, limits = true): WorkerCloudDesired => parseWorkerCloudDesired(value, limits, configurationCapabilities(value.value));
export const freezeConfiguration = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeConfiguration(item);
    Object.freeze(value);
  }
  return value;
};
