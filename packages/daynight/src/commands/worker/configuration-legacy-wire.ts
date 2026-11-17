// Frozen decoder for Worker configuration checkpoints written before Web-only admission.
import { array, bool, fields, id, malformed, record, timestamp } from "../../api/validation.js";
import { parseToolPathChoice } from "../../api/worker-tool-paths.js";
import type { ToolPathChoice } from "../../platform/tool-path-choice.js";
type AgentControlMode = "web" | "herdr";
type WorkerCloudToolPaths = Readonly<Record<"codex" | "copilot" | "herdr", ToolPathChoice | null>>;
type WorkerConfigurationCapabilityInput = boolean | { readonly controlMode: boolean; readonly toolPaths: boolean };
const workerConfigurationCapabilities = (value: WorkerConfigurationCapabilityInput = false) => typeof value === "boolean" ? { controlMode: value, toolPaths: false } : value;
const parseWorkerCloudToolPaths = (value: unknown): WorkerCloudToolPaths => {
  const data = fields(value, ["codex", "copilot", "herdr"]);
  if (["codex", "copilot", "herdr"].some(key => !Object.hasOwn(data, key))) return malformed();
  const entry = (item: unknown) => item === null ? null : parseToolPathChoice(item);
  return { codex: entry(data.codex), copilot: entry(data.copilot), herdr: entry(data.herdr) };
};
export type WorkerCloudNative = { readonly agent: "codex" | "copilot" | "claude"; readonly model: string | null; readonly args: readonly string[] };
export type WorkerCloudProject = { readonly projectId: string; readonly nativeOverrides: Readonly<Partial<WorkerCloudNative>> };
export type WorkerCloudValue = { readonly toolPaths?: WorkerCloudToolPaths; readonly agentControlMode?: AgentControlMode | null; readonly maxConcurrent: number; readonly pollIntervalMs: number; readonly recoveryLimit: number; readonly preferPlatformSpecificTasks: boolean; readonly native: WorkerCloudNative; readonly projects: readonly WorkerCloudProject[] };
export type WorkerCloudDesired = { readonly revision: string; readonly updatedAt: string; readonly value: WorkerCloudValue };
export type WorkerCloudFailure = {
  readonly code: "not_found" | "permission_denied" | "timeout" | "command_failed" | "invalid_output" | "invalid_configuration" | "io_error" | "unavailable";
  readonly category: "validation" | "repository" | "agent" | "runtime" | "storage";
  readonly phase: "validate" | "prepare" | "apply" | "stop" | "persist";
  readonly occurredAt: string;
};
export type WorkerCloudItemKey = { readonly kind: "maxConcurrent" | "pollIntervalMs" | "recoveryLimit" | "preferPlatformSpecificTasks" | "agentControlMode" | "native" }
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
export const parseWorkerControlMode = (value: unknown): AgentControlMode => value === "herdr" || value === "web" ? value : malformed();

const exact = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const data = fields(value, names);
  if (names.some(name => !Object.hasOwn(data, name))) return malformed();
  return data;
};
const nativeText = (value: unknown, limit: number): string => typeof value === "string" && value.trim() !== "" && value.isWellFormed() && !/\p{Cc}/u.test(value) && Buffer.byteLength(value, "utf8") <= limit ? value : malformed();
const nativeModel = (value: unknown, limits: boolean): string => nativeText(value, limits ? 256 : Infinity);
const nativeArgs = (value: unknown, limits: boolean): string[] => {
  if (!Array.isArray(value) || limits && value.length > 128) return malformed();
  return array(value, item => nativeText(item, limits ? 4096 : Infinity));
};
const boundedArray = <T>(value: unknown, limit: number, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > limit) return malformed();
  return array(value, parse);
};
const agent = (value: unknown): WorkerCloudNative["agent"] => value === "codex" || value === "copilot" || value === "claude" ? value : malformed();
const scalar = (value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : malformed();
const instant = (value: unknown): string => {
  const result = timestamp(value);
  if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(result)) return malformed();
  return result;
};
export const parseWorkerCloudRevision = (value: unknown, allowZero = false): string => {
  if (typeof value !== "string" || value.length > 19 || !/^(?:0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9_223_372_036_854_775_807n || !allowZero && value === "0") return malformed();
  return value;
};
export const parseWorkerCloudNative = (value: unknown, limits = true): WorkerCloudNative => {
  const data = exact(value, ["agent", "model", "args"]);
  return { agent: agent(data.agent), model: data.model === null ? null : nativeModel(data.model, limits), args: nativeArgs(data.args, limits) };
};
export const parseWorkerCloudValue = (value: unknown, limits = true, options: WorkerConfigurationCapabilityInput = false): WorkerCloudValue => {
  const { controlMode, toolPaths } = workerConfigurationCapabilities(options);
  const data = exact(value, ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects", ...(controlMode ? ["agentControlMode"] : []), ...(toolPaths ? ["toolPaths"] : [])]);
  const seen = new Set<string>();
  const projects = boundedArray(data.projects, limits ? 128 : Infinity, value => {
    const project = exact(value, ["projectId", "nativeOverrides"]), projectId = id(project.projectId);
    if (seen.has(projectId)) return malformed();
    seen.add(projectId);
    const overrides = fields(project.nativeOverrides, ["agent", "model", "args"]);
    return { projectId, nativeOverrides: {
      ...(Object.hasOwn(overrides, "agent") ? { agent: agent(overrides.agent) } : {}),
      ...(Object.hasOwn(overrides, "model") ? { model: overrides.model === null ? null : nativeModel(overrides.model, limits) } : {}),
      ...(Object.hasOwn(overrides, "args") ? { args: nativeArgs(overrides.args, limits) } : {}),
    } };
  });
  return { ...(toolPaths ? { toolPaths: parseWorkerCloudToolPaths(data.toolPaths) } : {}), ...(controlMode ? { agentControlMode: data.agentControlMode === null ? null : parseWorkerControlMode(data.agentControlMode) } : {}), maxConcurrent: scalar(data.maxConcurrent, 1, limits ? 64 : Number.MAX_SAFE_INTEGER), pollIntervalMs: scalar(data.pollIntervalMs, limits ? 1000 : 1, limits ? 60_000 : 2_147_483_647), recoveryLimit: scalar(data.recoveryLimit, 0, limits ? 10 : Number.MAX_SAFE_INTEGER), preferPlatformSpecificTasks: bool(data.preferPlatformSpecificTasks), native: parseWorkerCloudNative(data.native, limits), projects };
};
export const parseWorkerCloudDesired = (value: unknown, limits = true, options: WorkerConfigurationCapabilityInput = false): WorkerCloudDesired => {
  const data = exact(value, ["revision", "updatedAt", "value"]);
  return { revision: parseWorkerCloudRevision(data.revision), updatedAt: instant(data.updatedAt), value: parseWorkerCloudValue(data.value, limits, options) };
};
export const parseWorkerCloudFailure = (value: unknown): WorkerCloudFailure => {
  const data = exact(value, ["code", "category", "phase", "occurredAt"]);
  const code = data.code, category = data.category, phase = data.phase;
  if (code !== "not_found" && code !== "permission_denied" && code !== "timeout" && code !== "command_failed" && code !== "invalid_output" && code !== "invalid_configuration" && code !== "io_error" && code !== "unavailable") return malformed();
  if (category !== "validation" && category !== "repository" && category !== "agent" && category !== "runtime" && category !== "storage") return malformed();
  if (phase !== "validate" && phase !== "prepare" && phase !== "apply" && phase !== "stop" && phase !== "persist") return malformed();
  return { code, category, phase, occurredAt: instant(data.occurredAt) };
};
export const parseWorkerCloudItem = (value: unknown, limits = true, options: WorkerConfigurationCapabilityInput = false): WorkerCloudItem => {
  const { controlMode } = workerConfigurationCapabilities(options);
  const data = exact(value, ["key", "targetRevision", "appliedValue", "state", "error", "lastFailure", "nextAttemptAt"]);
  const keyData = record(data.key), kind = keyData.kind;
  let key: WorkerCloudItemKey;
  if (kind === "projectPreparation" || kind === "projectRemoval" || kind === "projectNative") {
    exact(keyData, ["kind", "projectId"]);
    key = { kind, projectId: id(keyData.projectId) };
  } else {
    exact(keyData, ["kind"]);
    if (kind !== "maxConcurrent" && kind !== "pollIntervalMs" && kind !== "recoveryLimit" && kind !== "preferPlatformSpecificTasks" && kind !== "native" && !(controlMode && kind === "agentControlMode")) return malformed();
    key = { kind };
  }
  const state = data.state;
  if (state !== "pending" && state !== "applying" && state !== "applied" && state !== "error") return malformed();
  if ((state === "error") !== (data.error !== null) || state === "applied" && data.appliedValue === null || state !== "error" && data.nextAttemptAt !== null) return malformed();
  let appliedValue: WorkerCloudItem["appliedValue"] = null;
  if (data.appliedValue !== null) {
    switch (kind) {
      case "agentControlMode": appliedValue = parseWorkerControlMode(data.appliedValue); break;
      case "native": case "projectNative": appliedValue = parseWorkerCloudNative(data.appliedValue, limits); break;
      case "maxConcurrent": appliedValue = scalar(data.appliedValue, 1, limits ? 64 : Number.MAX_SAFE_INTEGER); break;
      case "pollIntervalMs": appliedValue = scalar(data.appliedValue, limits ? 1000 : 1, limits ? 60_000 : 2_147_483_647); break;
      case "recoveryLimit": appliedValue = scalar(data.appliedValue, 0, limits ? 10 : Number.MAX_SAFE_INTEGER); break;
      case "preferPlatformSpecificTasks": appliedValue = bool(data.appliedValue); break;
      default: if (data.appliedValue !== true) return malformed(); appliedValue = true;
    }
  }
  return { key, targetRevision: parseWorkerCloudRevision(data.targetRevision), appliedValue, state,
    error: data.error === null ? null : parseWorkerCloudFailure(data.error),
    lastFailure: data.lastFailure === null ? null : parseWorkerCloudFailure(data.lastFailure), nextAttemptAt: data.nextAttemptAt === null ? null : instant(data.nextAttemptAt) };
};
