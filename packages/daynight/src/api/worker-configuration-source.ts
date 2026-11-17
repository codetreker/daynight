import { jsonContainerSources, jsonObjectSources } from "./json-source.js";
import { parseWorkerReportReceipt } from "./parse.js";
import { malformed, timestamp } from "./validation.js";
import { parseWorkerCloudDesired, parseWorkerCloudResource, parseWorkerCloudReceipt, parseWorkerCloudObservation, parseWorkerCloudRevision } from "./worker-configuration.js";
import type { WorkerCloudDesired } from "./worker-configuration.js";
import type { WorkerReportReceipt } from "./types.js";

export type WorkerConfigurationJsonSource = { readonly json: string };
export type WorkerRawDesired = { readonly revision: string; readonly updatedAt: string; readonly value: Readonly<Record<string, unknown>> };
export type ReceivedWorkerDesired = { readonly json: string; readonly known: WorkerRawDesired };
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
const knownJson = (source: string): unknown => {
  const json = source.trim();
  if (json.startsWith("{")) return Object.fromEntries([...jsonObjectSources(json)].map(([key, value]) => [key, knownJson(value)]));
  if (json.startsWith("[")) return jsonContainerSources(json).map(knownJson);
  if (json.startsWith('"') || json === "true" || json === "false" || json === "null") return JSON.parse(json) as unknown;
  if (!/^(?:0|[1-9][0-9]*)$/.test(json)) return malformed();
  const value = Number(json);
  return Number.isSafeInteger(value) ? value : malformed();
};
const rawJson = (source: string): unknown => {
  const json = source.trim();
  if (json.startsWith("{")) return Object.fromEntries([...jsonObjectSources(json)].map(([key, part]) => [key, rawJson(part)]));
  if (json.startsWith("[")) return jsonContainerSources(json).map(rawJson);
  return JSON.parse(json) as unknown;
};
export const decodeWorkerConfigurationSource = (json: string): WorkerConfigurationJsonSource => { jsonObjectSources(json); return { json }; };
const sourceOf = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("json" in value) || typeof value.json !== "string") return malformed();
  jsonObjectSources(value.json);
  return value.json;
};
// A server target is an opaque object until the active schema is validated.
export const receiveWorkerDesired = (json: string): ReceivedWorkerDesired => {
  const root = jsonObjectSources(json);
  if (!root.has("revision") || !root.has("updatedAt") || !root.has("value")) return malformed();
  const revision = parseWorkerCloudRevision(knownJson(root.get("revision")!));
  const updatedAt = timestamp(knownJson(root.get("updatedAt")!));
  if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(updatedAt)) return malformed();
  const valueSource = root.get("value")!;
  jsonObjectSources(valueSource);
  const value = rawJson(valueSource) as Readonly<Record<string, unknown>>;
  return { json, known: { revision, updatedAt, value } };
};
const failure = (source: string): string => nullable(source, value => project(value, ["code", "category", "phase", "occurredAt"]));
const observationProjection = (source: string): string => project(source, ["baseRevision", "desiredRevision", "items", "reportedAt"], {
  items: source => {
    const knownKinds = ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projectPreparation", "projectRemoval", "projectNative", ];
    if (!source.trimStart().startsWith("[")) return malformed();
    const items = jsonContainerSources(source).filter(source => {
      const key = jsonObjectSources(source).get("key");
      if (key === undefined) return malformed();
      const kind = jsonObjectSources(key).get("kind");
      if (kind === undefined || typeof JSON.parse(kind) !== "string") return malformed();
      return knownKinds.includes(JSON.parse(kind) as string);
    }).map(source => project(source, ["key", "targetRevision", "appliedValue", "state", "error", "lastFailure", "nextAttemptAt"], {
      key: source => project(source, ["kind", "projectId"]),
      appliedValue: value => value.trimStart().startsWith("{") ? native(value) : value,
      error: failure, lastFailure: failure,
    }));
    return `[${items.join(",")}]`;
  },
});
export const validateWorkerRemoteObservation = (json: string, observationRevision: string): void => {
  const projection = jsonObjectSources(observationProjection(json)), reportedAt = projection.get("reportedAt");
  if (reportedAt === undefined) return malformed();
  const instant = timestamp(knownJson(reportedAt));
  if (/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(instant)) return malformed();
  const observation = parseWorkerCloudObservation(knownJson(objectSource([...projection].filter(([key]) => key !== "reportedAt"))), false);
  if (BigInt(observation.baseRevision) + 1n !== BigInt(parseWorkerCloudRevision(observationRevision))) return malformed();
};
export const parseReceivedWorkerConfigurationResource = (value: unknown): ReceivedWorkerConfigurationResource => {
  const json = sourceOf(value), members = jsonObjectSources(json);
  if (!members.has("desired") || !members.has("observationRevision") || !members.has("observation")) return malformed();
  const desiredSource = members.get("desired")!, observationSource = members.get("observation")!;
  const desired = desiredSource === "null" ? null : receiveWorkerDesired(desiredSource);
  const observationRevision = parseWorkerCloudRevision(knownJson(members.get("observationRevision")!), true);
  if (observationSource === "null") {
    if (observationRevision !== "0") return malformed();
  } else {
    if (desired === null || observationRevision === "0") return malformed();
    validateWorkerRemoteObservation(observationSource, observationRevision);
    const observed = jsonObjectSources(observationSource), observedDesired = observed.get("desiredRevision");
    if (observedDesired === undefined || BigInt(parseWorkerCloudRevision(knownJson(observedDesired))) > BigInt(desired.known.revision)) return malformed();
  }
  return { json, desired, observationRevision, observationJson: observationSource === "null" ? null : observationSource };
};
export const parseReceivedWorkerConfigurationReceipt = (value: unknown): ReceivedWorkerConfigurationReceipt => {
  const json = sourceOf(value), members = jsonObjectSources(json);
  if (!members.has("desired") || !members.has("observationRevision") || !members.has("observationAccepted")) return malformed();
  const desiredSource = members.get("desired")!, desired = desiredSource === "null" ? null : receiveWorkerDesired(desiredSource);
  const observationRevision = parseWorkerCloudRevision(knownJson(members.get("observationRevision")!), true);
  const observationAccepted = knownJson(members.get("observationAccepted")!);
  if (typeof observationAccepted !== "boolean" || desired === null && observationRevision !== "0" || observationAccepted && (desired === null || observationRevision === "0")) return malformed();
  return { json, desired, observationRevision, observationAccepted };
};
export const parseReceivedWorkerConfigurationReportReceipt = (value: unknown): ReceivedWorkerConfigurationReportReceipt => {
  const json = sourceOf(value), members = jsonObjectSources(json), configuration = members.get("configuration");
  if (configuration === undefined) return malformed();
  return { ...parseWorkerReportReceipt(knownJson(project(json, ["observedAt", "lastReportedAt"]))), configuration: parseReceivedWorkerConfigurationReceipt({ json: configuration }) };
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
