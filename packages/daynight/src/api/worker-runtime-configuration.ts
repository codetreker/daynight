import { array, id, malformed, record } from "./validation.js";
import type { WorkerConfigurationValue, WorkerRuntimeConfiguration, WorkerRuntimeNative } from "./types.js";

const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return malformed();
  return data;
};
const configuredValue = (value: unknown, limit: number): WorkerConfigurationValue => {
  const data = exact(value, ["value", "source"]);
  if (data.source === "native") return data.value === null ? { value: null, source: "native" } : malformed();
  if ((data.source !== "local" && data.source !== "cloud") || typeof data.value !== "string" || !data.value.isWellFormed()
    || !/[^\p{White_Space}]/u.test(data.value) || /\p{Cc}/u.test(data.value) || new TextEncoder().encode(data.value).length > limit) return malformed();
  return { value: data.value, source: data.source };
};
const native = (value: unknown): WorkerRuntimeNative | null => {
  if (value === null) return null;
  const data = exact(value, ["agent", "model", "reasoningEffort"]);
  if (data.agent !== "codex" && data.agent !== "claude" && data.agent !== "copilot") return malformed();
  return { agent: data.agent, model: configuredValue(data.model, 256), reasoningEffort: configuredValue(data.reasoningEffort, 64) };
};

export const parseWorkerRuntimeConfiguration = (value: unknown): WorkerRuntimeConfiguration => {
  const data = exact(value, ["schemaVersion", "native", "projects"]);
  if (data.schemaVersion !== 1 || !Array.isArray(data.projects) || data.projects.length > 1024) return malformed();
  const projects = array(data.projects, value => {
    const project = exact(value, ["projectId", "native"]);
    return { projectId: id(project.projectId), native: native(project.native) };
  });
  if (new Set(projects.map(project => project.projectId)).size !== projects.length) return malformed();
  return { schemaVersion: 1, native: native(data.native), projects };
};
