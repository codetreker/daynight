import { jsonObjectSources } from "./json-source.js";
import { parseWorkerReportReceipt } from "./parse.js";
import type { WorkerReportReceipt } from "./types.js";
import { array, bool, fields, id, malformed, record, timestamp } from "./validation.js";

export type WorkerCloudNative = { readonly agent: "codex" | "copilot" | "claude"; readonly model: string | null; readonly args: readonly string[] };
export type WorkerCloudProject = { readonly projectId: string; readonly nativeOverrides: Readonly<Partial<WorkerCloudNative>> };
export type WorkerCloudValue = { readonly maxConcurrent: number; readonly pollIntervalMs: number; readonly recoveryLimit: number; readonly preferPlatformSpecificTasks: boolean; readonly native: WorkerCloudNative; readonly projects: readonly WorkerCloudProject[] };
export type WorkerCloudDesired = { readonly revision: string; readonly updatedAt: string; readonly value: WorkerCloudValue };
export type WorkerCloudFailure = {
  readonly code: "not_found" | "permission_denied" | "timeout" | "command_failed" | "invalid_output" | "invalid_configuration" | "io_error" | "unavailable";
  readonly category: "validation" | "repository" | "agent" | "runtime" | "storage";
  readonly phase: "validate" | "prepare" | "apply" | "stop" | "persist";
  readonly occurredAt: string;
};
export type WorkerCloudItemKey = { readonly kind: "maxConcurrent" | "pollIntervalMs" | "recoveryLimit" | "preferPlatformSpecificTasks" | "native" }
  | { readonly kind: "projectPreparation" | "projectRemoval" | "projectNative"; readonly projectId: string };
export type WorkerCloudItem = {
  readonly key: WorkerCloudItemKey;
  readonly targetRevision: string;
  readonly appliedValue: number | WorkerCloudNative | boolean | null;
  readonly state: "pending" | "applying" | "applied" | "error";
  readonly error: WorkerCloudFailure | null;
  readonly lastFailure: WorkerCloudFailure | null;
  readonly nextAttemptAt: string | null;
};
export type WorkerCloudObservation = { readonly baseRevision: string; readonly desiredRevision: string; readonly items: readonly WorkerCloudItem[] };
export type WorkerCloudResource = { readonly desired: WorkerCloudDesired | null; readonly observationRevision: string; readonly observation: (WorkerCloudObservation & { readonly reportedAt: string }) | null };
export type WorkerCloudReport = { readonly bootstrap: WorkerCloudValue | null; readonly observation: WorkerCloudObservation | null };
export type WorkerCloudReceipt = { readonly desired: WorkerCloudDesired | null; readonly observationRevision: string; readonly observationAccepted: boolean };
export type WorkerCloudReportReceipt = WorkerReportReceipt & { readonly configuration: WorkerCloudReceipt };

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
export const parseWorkerCloudValue = (value: unknown, limits = true): WorkerCloudValue => {
  const data = exact(value, ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects"]);
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
  return { maxConcurrent: scalar(data.maxConcurrent, 1, limits ? 64 : Number.MAX_SAFE_INTEGER), pollIntervalMs: scalar(data.pollIntervalMs, limits ? 1000 : 1, limits ? 60_000 : 2_147_483_647), recoveryLimit: scalar(data.recoveryLimit, 0, limits ? 10 : Number.MAX_SAFE_INTEGER), preferPlatformSpecificTasks: bool(data.preferPlatformSpecificTasks), native: parseWorkerCloudNative(data.native, limits), projects };
};
export const parseWorkerCloudDesired = (value: unknown, limits = true): WorkerCloudDesired => {
  const data = exact(value, ["revision", "updatedAt", "value"]);
  return { revision: parseWorkerCloudRevision(data.revision), updatedAt: instant(data.updatedAt), value: parseWorkerCloudValue(data.value, limits) };
};
export const parseWorkerCloudFailure = (value: unknown): WorkerCloudFailure => {
  const data = exact(value, ["code", "category", "phase", "occurredAt"]);
  const code = data.code, category = data.category, phase = data.phase;
  if (code !== "not_found" && code !== "permission_denied" && code !== "timeout" && code !== "command_failed" && code !== "invalid_output" && code !== "invalid_configuration" && code !== "io_error" && code !== "unavailable") return malformed();
  if (category !== "validation" && category !== "repository" && category !== "agent" && category !== "runtime" && category !== "storage") return malformed();
  if (phase !== "validate" && phase !== "prepare" && phase !== "apply" && phase !== "stop" && phase !== "persist") return malformed();
  return { code, category, phase, occurredAt: instant(data.occurredAt) };
};
export const parseWorkerCloudItem = (value: unknown, limits = true): WorkerCloudItem => {
  const data = exact(value, ["key", "targetRevision", "appliedValue", "state", "error", "lastFailure", "nextAttemptAt"]);
  const keyData = record(data.key), kind = keyData.kind;
  let key: WorkerCloudItemKey;
  if (kind === "projectPreparation" || kind === "projectRemoval" || kind === "projectNative") {
    exact(keyData, ["kind", "projectId"]);
    key = { kind, projectId: id(keyData.projectId) };
  } else {
    exact(keyData, ["kind"]);
    if (kind !== "maxConcurrent" && kind !== "pollIntervalMs" && kind !== "recoveryLimit" && kind !== "preferPlatformSpecificTasks" && kind !== "native") return malformed();
    key = { kind };
  }
  const state = data.state;
  if (state !== "pending" && state !== "applying" && state !== "applied" && state !== "error") return malformed();
  if ((state === "error") !== (data.error !== null) || state === "applied" && data.appliedValue === null || state !== "error" && data.nextAttemptAt !== null) return malformed();
  let appliedValue: WorkerCloudItem["appliedValue"] = null;
  if (data.appliedValue !== null) {
    switch (kind) {
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
export const parseWorkerCloudObservation = (value: unknown, limits = true): WorkerCloudObservation => {
  const data = exact(value, ["baseRevision", "desiredRevision", "items"]);
  const desiredRevision = parseWorkerCloudRevision(data.desiredRevision), seen = new Set<string>();
  const items = boundedArray(data.items, limits ? 1025 : Infinity, item => parseWorkerCloudItem(item, limits));
  for (const item of items) {
    const key = `${item.key.kind}:${"projectId" in item.key ? item.key.projectId : ""}`;
    if (seen.has(key) || BigInt(item.targetRevision) > BigInt(desiredRevision)) return malformed();
    seen.add(key);
  }
  return { baseRevision: parseWorkerCloudRevision(data.baseRevision, true), desiredRevision, items };
};
export const parseWorkerCloudReport = (value: unknown): WorkerCloudReport => {
  const data = exact(value, ["bootstrap", "observation"]);
  return { bootstrap: data.bootstrap === null ? null : parseWorkerCloudValue(data.bootstrap), observation: data.observation === null ? null : parseWorkerCloudObservation(data.observation) };
};
export const parseWorkerCloudResource = (value: unknown): WorkerCloudResource => {
  const data = exact(value, ["desired", "observationRevision", "observation"]);
  const desired = data.desired === null ? null : parseWorkerCloudDesired(data.desired, false), observationRevision = parseWorkerCloudRevision(data.observationRevision, true);
  let observation: WorkerCloudResource["observation"] = null;
  if (data.observation !== null) {
    const observed = exact(data.observation, ["baseRevision", "desiredRevision", "items", "reportedAt"]);
    observation = { ...parseWorkerCloudObservation({ baseRevision: observed.baseRevision, desiredRevision: observed.desiredRevision, items: observed.items }, false), reportedAt: instant(observed.reportedAt) };
    if (desired === null || BigInt(observation.desiredRevision) > BigInt(desired.revision) || BigInt(observation.baseRevision) + 1n !== BigInt(observationRevision)) return malformed();
  }
  if ((observation === null) !== (observationRevision === "0") || desired === null && observation !== null) return malformed();
  return { desired, observationRevision, observation };
};
export const parseWorkerCloudReceipt = (value: unknown): WorkerCloudReceipt => {
  const data = exact(value, ["desired", "observationRevision", "observationAccepted"]);
  const desired = data.desired === null ? null : parseWorkerCloudDesired(data.desired, false), observationRevision = parseWorkerCloudRevision(data.observationRevision, true), observationAccepted = bool(data.observationAccepted);
  if (desired === null && observationRevision !== "0" || observationAccepted && (desired === null || observationRevision === "0")) return malformed();
  return { desired, observationRevision, observationAccepted };
};
export const parseWorkerCloudReportReceipt = (value: unknown): WorkerCloudReportReceipt => {
  const data = exact(value, ["observedAt", "lastReportedAt", "configuration"]);
  return { ...parseWorkerReportReceipt({ observedAt: data.observedAt, lastReportedAt: data.lastReportedAt }), configuration: parseWorkerCloudReceipt(data.configuration) };
};

export const decodeWorkerCloudJsonSource = (source: string): unknown => {
  jsonObjectSources(source);
  const json = JSON as unknown as { parse(source: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown };
  return json.parse(source, (_key, value: unknown, context: { source?: string }) => {
    if (typeof value === "number" && (context.source === undefined || !/^(?:0|[1-9][0-9]*)$/.test(context.source))) return malformed();
    return value;
  });
};
