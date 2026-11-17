// Frozen source projection for existing configuration checkpoints.
import { jsonContainerSources, jsonObjectSources } from "../../api/json-source.js";
import { malformed } from "../../api/validation.js";
import { parseWorkerCloudDesired } from "./configuration-legacy-wire.js";
import type { WorkerCloudDesired } from "./configuration-legacy-wire.js";
type WorkerConfigurationCapabilityInput = boolean | { readonly controlMode: boolean; readonly toolPaths: boolean };
const workerConfigurationCapabilities = (value: WorkerConfigurationCapabilityInput = false) => typeof value === "boolean" ? { controlMode: value, toolPaths: false } : value;
type ReceivedWorkerDesired = { readonly json: string; readonly known: WorkerCloudDesired };
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
const desiredProjection = (source: string, options: WorkerConfigurationCapabilityInput): string => {
  const capabilities = workerConfigurationCapabilities(options);
  return project(source, ["revision", "updatedAt", "value"], { value: source => project(source,
    ["maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects", ...(capabilities.controlMode ? ["agentControlMode"] : []), ...(capabilities.toolPaths ? ["toolPaths"] : [])],
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
export const receiveLegacyWorkerDesired = (json: string, options?: WorkerConfigurationCapabilityInput): ReceivedWorkerDesired => {
  const root = jsonObjectSources(json), value = root.get("value");
  const members = value === undefined ? new Map<string, string>() : jsonObjectSources(value);
  const capabilities = options ?? { controlMode: members.has("agentControlMode"), toolPaths: members.has("toolPaths") };
  const enabled = workerConfigurationCapabilities(capabilities);
  if (!enabled.controlMode && members.has("agentControlMode") || !enabled.toolPaths && members.has("toolPaths")) return malformed();
  return { json, known: parseWorkerCloudDesired(knownJson(desiredProjection(json, capabilities)), false, capabilities) };
};

export const validateLegacyHiddenCapability = (desired: string, key: "agentControlMode" | "toolPaths", fragment: string): void => {
  const root = jsonObjectSources(desired), source = root.get("value");
  if (source === undefined) return malformed();
  const value = jsonObjectSources(source);
  if (value.has(key)) return malformed();
  receiveLegacyWorkerDesired(objectSource([...root].map(([name, part]) => [name, name === "value" ? objectSource([...value, [key, fragment]]) : part])));
};

export const legacyCapabilityKeys = ["agentControlMode", "toolPaths"] as const;
