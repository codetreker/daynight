import { validateWorkerAgentMode } from "./worker-mode.js";
import { array, fields, id, malformed, record, resourceVersion, text, timestamp } from "./validation.js";
import type { JsonValue, PullRequestProperty, TaskProperties, TaskPropertyResource, TaskPropertySchema, TaskPlatform, WorkerClaim, WorkerHerdr, WorkerPhase } from "./types.js";

const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : malformed();
  if (Array.isArray(value)) return value.map(jsonValue);
  return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [key, jsonValue(item)]));
};

export const parseTaskProperties = (value: unknown): TaskProperties =>
  Object.fromEntries(Object.entries(record(value)).map(([name, item]) => [name, jsonValue(item)]));

export const readPullRequests = (properties: TaskProperties): readonly PullRequestProperty[] | undefined => {
  if (!Object.hasOwn(properties, "pullRequests")) return undefined;
  return array(properties.pullRequests, (item) => {
    const value = fields(item, ["url", "title"]);
    if (typeof value.url !== "string" || typeof value.title !== "string") return malformed();
    return { url: value.url, title: value.title };
  });
};

const workerPhase = (value: unknown): WorkerPhase => value === "preparing" || value === "executing" || value === "verifying" || value === "completing" || value === "waiting" || value === "paused" ? value : malformed();
const workerHerdr = (value: unknown): WorkerHerdr | null => {
  if (value === null) return null;
  const data = fields(value, ["session", "workspaceId", "paneId"]);
  return { session: text(data.session, true), workspaceId: text(data.workspaceId, true), paneId: text(data.paneId, true) };
};

export const readWorkerClaim = (properties: TaskProperties): WorkerClaim | undefined => {
  if (!Object.hasOwn(properties, "worker")) return undefined;
  const data = fields(properties.worker, ["claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"]);
  const machine = fields(data.machine, ["id", "name"]);
  const platform: TaskPlatform = data.platform === "windows" || data.platform === "linux" || data.platform === "macos" ? data.platform : malformed();
  const agentControlMode = data.agentControlMode === "herdr" || data.agentControlMode === "web" ? data.agentControlMode : malformed();
  let agent;
  try { agent = validateWorkerAgentMode(data.agent, agentControlMode); } catch { return malformed(); }
  if (agentControlMode === "web" && data.herdr !== null) return malformed();
  return {
    claimId: id(data.claimId), state: data.state === "active" || data.state === "released" || data.state === "completed" ? data.state : malformed(),
    userId: id(data.userId), workerId: id(data.workerId), machine: { id: id(machine.id), name: text(machine.name, true) }, platform,
    agent, agentControlMode, worktreeId: id(data.worktreeId), phase: workerPhase(data.phase),
    herdr: workerHerdr(data.herdr), nativeSessionId: data.nativeSessionId === null ? null : text(data.nativeSessionId, true), claimedAt: timestamp(data.claimedAt),
  };
};

const sameJsonValue = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]!));
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  const names = Object.keys(left);
  return names.length === Object.keys(right).length && names.every((name) => Object.hasOwn(right, name) && sameJsonValue((left as TaskProperties)[name]!, (right as TaskProperties)[name]!));
};

export const sameTaskProperties = (left: TaskProperties, right: TaskProperties): boolean => sameJsonValue(left, right);

export const parseTaskPropertyResource = (value: unknown, projectId: string, taskId: string): TaskPropertyResource => {
  const data = record(value);
  const result = { projectId: id(data.projectId), taskId: id(data.taskId), version: resourceVersion(data.version), properties: parseTaskProperties(data.properties) };
  if (result.projectId !== projectId || result.taskId !== taskId) return malformed();
  return result;
};

export const parseTaskPropertySchema = (value: unknown): TaskPropertySchema => {
  const data = record(value);
  const definitions = record(data.properties);
  return { properties: Object.fromEntries(Object.entries(definitions).map(([name, value]) => {
    const definition = record(value);
    if (typeof definition.description !== "string" || typeof definition.readOnly !== "boolean") return malformed();
    return [name, { ...parseTaskProperties(definition), description: definition.description, readOnly: definition.readOnly, schema: parseTaskProperties(definition.schema) }];
  })) };
};
