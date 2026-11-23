// Preserve and validate historical JSON sources without projecting through network DTOs.
import { jsonContainerSources, jsonObjectSources } from "../../api/json-source.js";
import { malformed, ProtocolError, timestamp } from "../../api/validation.js";
import { parseWorkerCloudDesired, parseWorkerCloudObservation, parseWorkerCloudRevision, workerConfigurationCapabilities } from "./configuration-storage-wire.js";
import type { WorkerConfigurationCapabilityInput } from "./configuration-storage-wire.js";
import type { WorkerCloudDesired } from "./configuration-storage-types.js";

export type ReceivedWorkerDesired = { readonly json: string; readonly known: WorkerCloudDesired };

const objectSource = (members: Iterable<readonly [string, string]>): string => `{${[...members].map(([key, source]) => `${JSON.stringify(key)}:${source}`).join(",")}}`;
const project = (source: string, names: readonly string[], children: Readonly<Record<string, (source: string) => string>> = {}): string =>
  objectSource([...jsonObjectSources(source)].filter(([key]) => names.includes(key)).map(([key, value]) => [key, Object.hasOwn(children, key) ? children[key]!(value) : value]));
const arraySource = (source: string, map: (source: string) => string): string => {
  if (!source.trimStart().startsWith("[")) return malformed();
  return `[${jsonContainerSources(source).map(map).join(",")}]`;
};
const native = (source: string): string => project(source, ["agent", "model", "args"]);
const nullable = (source: string, map: (source: string) => string): string => source === "null" ? source : map(source);
const tools = (source: string): string => project(source, ["codex", "copilot", "herdr"], Object.fromEntries(["codex", "copilot", "herdr"].map(key => [key, (source: string) => nullable(source, value => {
  return project(value, ["kind", "path"]);
})])));
const desiredProjection = (source: string, options: WorkerConfigurationCapabilityInput, recognizeSudo = true): string => {
  const capabilities = workerConfigurationCapabilities(options);
  return project(source, ["revision", "updatedAt", "value"], { value: source => project(source,
    ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects", ...(recognizeSudo ? ["enableSudoCleanup"] : []), ...(capabilities.controlMode ? ["agentControlMode"] : []), ...(capabilities.toolPaths ? ["toolPaths"] : []), ...(capabilities.archiveSessions ? ["archiveSessions"] : [])],
    { native, projects: source => arraySource(source, source => project(source, ["projectId", "nativeOverrides"], { nativeOverrides: native })), toolPaths: tools }) });
};
const knownJson = (source: string): unknown => {
  const json = source.trim();
  if (json.startsWith("{")) return Object.fromEntries([...jsonObjectSources(json)].map(([key, value]) => [key, knownJson(value)]));
  if (json.startsWith("[")) return jsonContainerSources(json).map(knownJson);
  if (json.startsWith('"') || json === "true" || json === "false" || json === "null") return JSON.parse(json) as unknown;
  if (!/^(?:0|[1-9][0-9]*)$/.test(json)) return malformed();
  const value = Number(json);
  return Number.isSafeInteger(value) ? value : malformed();
};
export const receiveWorkerDesired = (json: string, options?: WorkerConfigurationCapabilityInput, recognizeSudo = true): ReceivedWorkerDesired => {
  const root = jsonObjectSources(json), value = root.get("value");
  const members = value === undefined ? new Map<string, string>() : jsonObjectSources(value);
  const capabilities = options ?? { controlMode: members.has("agentControlMode"), toolPaths: members.has("toolPaths"), archiveSessions: members.has("archiveSessions") };
  const enabled = workerConfigurationCapabilities(capabilities);
  if (!enabled.controlMode && members.has("agentControlMode") || !enabled.toolPaths && members.has("toolPaths") || !enabled.archiveSessions && members.has("archiveSessions")) return malformed();
  return { json, known: parseWorkerCloudDesired(knownJson(desiredProjection(json, capabilities, recognizeSudo)), false, capabilities) };
};

// Schema 9 preserves an authority that a newer server can describe even when
// this binary cannot interpret its value. Validate the envelope independently.
export const receiveStoredDesired9 = (json: string): { readonly json: string; readonly revision: string; readonly updatedAt: string; readonly known: WorkerCloudDesired | null } => {
  const root = jsonObjectSources(json), revisionSource = root.get("revision"), updatedAtSource = root.get("updatedAt"), value = root.get("value");
  if (revisionSource === undefined || updatedAtSource === undefined || value === undefined) return malformed();
  jsonObjectSources(value);
  const revision = parseWorkerCloudRevision(knownJson(revisionSource));
  const updatedAt = timestamp(knownJson(updatedAtSource));
  if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(updatedAt)) return malformed();
  try { return { json, revision, updatedAt, known: receiveWorkerDesired(json).known }; }
  catch (error) {
    if (!(error instanceof ProtocolError) && !(error instanceof SyntaxError)) throw error;
    return { json, revision, updatedAt, known: null };
  }
};
const failure = (source: string): string => nullable(source, value => project(value, ["code", "category", "phase", "occurredAt"]));
const observationProjection = (source: string, options: WorkerConfigurationCapabilityInput, recognizeSudo = true): string => project(source, ["baseRevision", "desiredRevision", "items", "reportedAt"], {
  items: source => {
    const knownKinds = ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", ...(recognizeSudo ? ["enableSudoCleanup"] : []), "native", "projectPreparation", "projectRemoval", "projectNative", ...(workerConfigurationCapabilities(options).controlMode ? ["agentControlMode"] : []), ...(workerConfigurationCapabilities(options).archiveSessions ? ["archiveSessions"] : [])];
    if (!source.trimStart().startsWith("[")) return malformed();
    const items = jsonContainerSources(source).filter(source => {
      const key = jsonObjectSources(source).get("key");
      if (key === undefined) return malformed();
      const kind = jsonObjectSources(key).get("kind");
      if (kind === undefined || typeof JSON.parse(kind) !== "string") return malformed();
      if (JSON.parse(kind) === "agentControlMode" && !workerConfigurationCapabilities(options).controlMode || JSON.parse(kind) === "archiveSessions" && !workerConfigurationCapabilities(options).archiveSessions) return malformed();
      return knownKinds.includes(JSON.parse(kind) as string);
    }).map(source => project(source, ["key", "targetRevision", "appliedValue", "state", "error", "lastFailure", "nextAttemptAt"], {
      key: source => project(source, ["kind", "projectId"]),
      appliedValue: value => value.trimStart().startsWith("{") ? native(value) : value,
      error: failure, lastFailure: failure,
    }));
    return `[${items.join(",")}]`;
  },
});
export const validateWorkerRemoteObservation = (json: string, observationRevision: string, recognizeSudo = true): void => {
  const projection = jsonObjectSources(observationProjection(json, { controlMode: true, toolPaths: true, archiveSessions: true }, recognizeSudo)), reportedAt = projection.get("reportedAt");
  if (reportedAt === undefined) return malformed();
  const instant = timestamp(knownJson(reportedAt));
  if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(instant)) return malformed();
  const observation = parseWorkerCloudObservation(knownJson(objectSource([...projection].filter(([key]) => key !== "reportedAt"))), false, { controlMode: true, toolPaths: true, archiveSessions: true });
  if (BigInt(observation.baseRevision) + 1n !== BigInt(parseWorkerCloudRevision(observationRevision))) return malformed();
};

export type WorkerCapabilityKey = "agentControlMode" | "toolPaths" | "archiveSessions";
export const workerCapabilityKeys: readonly WorkerCapabilityKey[] = ["agentControlMode", "toolPaths", "archiveSessions"];

export const desiredCapabilitySources = (json: string): ReadonlyMap<string, string> => {
  const value = jsonObjectSources(json).get("value");
  if (value === undefined) return malformed();
  return jsonObjectSources(value);
};

export const validateHiddenCapabilitySource = (desired: string, key: WorkerCapabilityKey, source: string, independent = false): void => {
  const root = jsonObjectSources(desired), value = desiredCapabilitySources(desired);
  if (value.has(key)) return malformed();
  if (independent) {
    jsonObjectSources(`{"value":${source}}`);
    return;
  }
  receiveWorkerDesired(objectSource([...root].map(([name, part]) => [name, name === "value" ? objectSource([...value, [key, source]]) : part])));
};
