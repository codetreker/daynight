import { jsonContainerSources, jsonObjectSources } from "./json-source.js";
import { parseWorkerReportReceipt } from "./parse.js";
import { bool, malformed, ProtocolError, timestamp } from "./validation.js";
import { parseWorkerCloudDesired, parseWorkerCloudObservation, parseWorkerCloudRevision } from "./worker-configuration.js";
import type { WorkerCloudDesired } from "./worker-configuration.js";
import type { WorkerReportReceipt } from "./types.js";
import type { WorkerConfigurationCapabilityInput } from "./worker-tool-paths.js";
import { workerConfigurationCapabilities } from "./worker-tool-paths.js";

export type WorkerConfigurationJsonSource = { readonly json: string };
export type ReceivedWorkerDesired = { readonly json: string; readonly revision: string; readonly updatedAt: string; readonly known: WorkerCloudDesired | null };
export type ReceivedWorkerConfigurationResource = { readonly json: string; readonly desired: ReceivedWorkerDesired | null; readonly observationRevision: string; readonly observationJson: string | null };
export type ReceivedWorkerConfigurationReceipt = { readonly json: string; readonly desired: ReceivedWorkerDesired | null; readonly observationRevision: string; readonly observationAccepted: boolean };
export type ReceivedWorkerConfigurationReportReceipt = WorkerReportReceipt & { readonly configuration: ReceivedWorkerConfigurationReceipt };

const objectSource = (members: Iterable<readonly [string, string]>): string => `{${[...members].map(([key, source]) => `${JSON.stringify(key)}:${source}`).join(",")}}`;
const project = (source: string, names: readonly string[], children: Readonly<Record<string, (source: string) => string>> = {}): string =>
  objectSource([...jsonObjectSources(source)].filter(([key]) => names.includes(key)).map(([key, value]) => [key, Object.hasOwn(children, key) ? children[key]!(value) : value]));
const arraySource = (source: string, map: (source: string) => string): string => {
  if (!source.trimStart().startsWith("[")) return malformed();
  return `[${jsonContainerSources(source).map(map).join(",")}]`;
};
const native = (source: string): string => project(source, ["agent", "model", "args"]);
const nullable = (source: string, map: (source: string) => string): string => source === "null" ? source : map(source);
const tools = (source: string): string => project(source, ["codex", "copilot"], Object.fromEntries(["codex", "copilot"].map(key => [key, (source: string) => nullable(source, value => {
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
export const decodeWorkerConfigurationSource = (json: string): WorkerConfigurationJsonSource => { jsonObjectSources(json); return { json }; };
const sourceOf = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("json" in value) || typeof value.json !== "string") return malformed();
  jsonObjectSources(value.json);
  return value.json;
};
export const receiveWorkerDesired = (json: string, options?: WorkerConfigurationCapabilityInput, recognizeSudo = true): ReceivedWorkerDesired => {
  const root = jsonObjectSources(json), value = root.get("value");
  if (value === undefined || !root.has("revision") || !root.has("updatedAt")) return malformed();
  const members = jsonObjectSources(value);
  const revision = parseWorkerCloudRevision(knownJson(root.get("revision")!));
  const updatedAt = timestamp(knownJson(root.get("updatedAt")!));
  if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(updatedAt)) return malformed();
  const capabilities = options ?? { controlMode: false, toolPaths: true, archiveSessions: members.has("archiveSessions") };
  const enabled = workerConfigurationCapabilities(capabilities);
  // The full source was validated above; a known-field shape or value that this
  // binary cannot decode is retained as raw authority, not a partial target.
  let known: WorkerCloudDesired | null;
  try {
    if (enabled.toolPaths !== members.has("toolPaths") || Boolean(enabled.archiveSessions) !== members.has("archiveSessions")) return { json, revision, updatedAt, known: null };
    known = parseWorkerCloudDesired(knownJson(desiredProjection(json, { ...enabled, controlMode: false }, recognizeSudo)), false, { ...enabled, controlMode: false });
  }
  catch (error) { if (!(error instanceof ProtocolError || error instanceof SyntaxError)) throw error; known = null; }
  return { json, revision, updatedAt, known };
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
export const parseReceivedWorkerConfigurationResource = (value: unknown, options?: WorkerConfigurationCapabilityInput): ReceivedWorkerConfigurationResource => {
  const json = sourceOf(value), members = jsonObjectSources(json), desiredSource = members.get("desired"), observationSource = members.get("observation");
  if (desiredSource === undefined || observationSource === undefined || !members.has("observationRevision")) return malformed();
  const desired = desiredSource === "null" ? null : receiveWorkerDesired(desiredSource, options);
  const capabilities = options ?? (desired === null ? false : (() => { const fields = desiredCapabilitySources(desired.json); return { controlMode: fields.has("agentControlMode"), toolPaths: fields.has("toolPaths"), archiveSessions: fields.has("archiveSessions") }; })());
  const observationRevision = parseWorkerCloudRevision(knownJson(members.get("observationRevision")!), true);
  if (observationSource === "null") {
    if (observationRevision !== "0") return malformed();
  } else {
    if (desired === null || observationRevision === "0") return malformed();
    const projection = jsonObjectSources(observationProjection(observationSource, capabilities)), reportedAt = projection.get("reportedAt");
    if (reportedAt === undefined) return malformed();
    const instant = timestamp(knownJson(reportedAt));
    if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(instant)) return malformed();
    const observation = parseWorkerCloudObservation(knownJson(objectSource([...projection].filter(([key]) => key !== "reportedAt"))), false, capabilities);
    if (BigInt(observation.desiredRevision) > BigInt(desired.revision) || BigInt(observation.baseRevision) + 1n !== BigInt(observationRevision)) return malformed();
  }
  return { json, desired, observationRevision, observationJson: observationSource === "null" ? null : observationSource };
};
export const parseReceivedWorkerConfigurationReceipt = (value: unknown, options?: WorkerConfigurationCapabilityInput): ReceivedWorkerConfigurationReceipt => {
  const json = sourceOf(value), members = jsonObjectSources(json), desiredSource = members.get("desired");
  if (desiredSource === undefined || !members.has("observationRevision") || !members.has("observationAccepted")) return malformed();
  const desired = desiredSource === "null" ? null : receiveWorkerDesired(desiredSource, options);
  const observationRevision = parseWorkerCloudRevision(knownJson(members.get("observationRevision")!), true);
  const observationAccepted = bool(knownJson(members.get("observationAccepted")!));
  if (desired === null && observationRevision !== "0" || observationAccepted && (desired === null || observationRevision === "0")) return malformed();
  return { json, desired, observationRevision, observationAccepted };
};
export const parseReceivedWorkerConfigurationReportReceipt = (value: unknown, options: WorkerConfigurationCapabilityInput = false): ReceivedWorkerConfigurationReportReceipt => {
  const json = sourceOf(value), members = jsonObjectSources(json), configuration = members.get("configuration");
  if (configuration === undefined) return malformed();
  return { ...parseWorkerReportReceipt(knownJson(project(json, ["observedAt", "lastReportedAt"]))), configuration: parseReceivedWorkerConfigurationReceipt({ json: configuration }, options) };
};

const numberKey = (source: string): string => {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(source)!;
  const fraction = match[3] ?? "", digits = (match[2]! + fraction).replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  return `${match[1]}${significant}e${BigInt(match[4] ?? "0") - BigInt(fraction.length) + BigInt(digits.length - significant.length)}`;
};
const semanticKey = (source: string): string => {
  const json = source.trim();
  if (json.startsWith("{")) return objectSource([...jsonObjectSources(json)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => [key, semanticKey(value)]));
  if (json.startsWith("[")) return `[${jsonContainerSources(json).map(semanticKey).join(",")}]`;
  if (json.startsWith('"')) return JSON.stringify(JSON.parse(json));
  if (json === "true" || json === "false" || json === "null") return json;
  return numberKey(json);
};
export const configurationJsonSourcesEqual = (left: string, right: string): boolean => {
  // Source inspection keeps duplicate keys and depth limits part of equality's contract.
  jsonContainerSources(left); jsonContainerSources(right);
  return semanticKey(left) === semanticKey(right);
};

export type WorkerCapabilityKey = "agentControlMode" | "toolPaths" | "archiveSessions";
export const workerCapabilityKeys: readonly WorkerCapabilityKey[] = ["agentControlMode", "toolPaths", "archiveSessions"];

export const desiredCapabilitySources = (json: string): ReadonlyMap<string, string> => {
  const value = jsonObjectSources(json).get("value");
  if (value === undefined) return malformed();
  return jsonObjectSources(value);
};

// Only established negotiated projections may hide a whole member.
export const configurationDesiredSourcesComparable = (left: string, right: string): boolean => {
  const leftRoot = jsonObjectSources(left), rightRoot = jsonObjectSources(right);
  const leftValue = desiredCapabilitySources(left), rightValue = desiredCapabilitySources(right);
  const hidden = new Set<WorkerCapabilityKey>(leftValue.has("archiveSessions") !== rightValue.has("archiveSessions") ? ["archiveSessions"] : []);
  const comparable = (root: ReadonlyMap<string, string>, value: ReadonlyMap<string, string>): string => objectSource(
    [...root].map(([key, source]) => [key, key === "value" ? objectSource([...value].filter(([name]) => !hidden.has(name as WorkerCapabilityKey))) : source]),
  );
  return configurationJsonSourcesEqual(comparable(leftRoot, leftValue), comparable(rightRoot, rightValue));
};

export const validateHiddenCapabilitySource = (desired: string, key: WorkerCapabilityKey, source: string): void => {
  const root = jsonObjectSources(desired), value = desiredCapabilitySources(desired);
  if (value.has(key)) return malformed();
  receiveWorkerDesired(objectSource([...root].map(([name, part]) => [name, name === "value" ? objectSource([...value, [key, source]]) : part])));
};

export const configurationSourceFragmentsEqual = (left: string, right: string): boolean =>
  configurationJsonSourcesEqual(objectSource([["value", left]]), objectSource([["value", right]]));
