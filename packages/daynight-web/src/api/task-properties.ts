import type { JsonValue, PullRequestProperty, TaskProperties, WorkerClaim, WorkerPhase } from "./types";
import { array, executionPlatform, id, malformed, record, string, timestamp } from "./validation";

const jsonValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) { value.forEach(jsonValue); return value as readonly JsonValue[]; }
  const data = record(value);
  Object.values(data).forEach(jsonValue);
  return data as Readonly<Record<string, JsonValue>>;
};

export const parseTaskProperties = (value: unknown): TaskProperties => {
  const data = record(value);
  return Object.fromEntries(Object.entries(data).map(([name, item]) => [name, jsonValue(item)]));
};

const pullRequest = (value: unknown): PullRequestProperty => {
  const data = record(value);
  return { url: string(data.url), title: string(data.title) };
};

const fields = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).some((key) => !names.includes(key))) return malformed();
  return data;
};
const workerText = (value: unknown): string => {
  const parsed = string(value);
  if (!parsed.isWellFormed() || parsed.includes("\0") || !/[^\p{White_Space}]/u.test(parsed)) return malformed();
  return parsed;
};
const workerPhase = (value: unknown): WorkerPhase => value === "preparing" || value === "executing" || value === "verifying" || value === "completing" || value === "waiting" || value === "paused" ? value : malformed();
const workerClaim = (value: unknown): WorkerClaim => {
  const data = fields(value, ["claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"]);
  const machine = fields(data.machine, ["id", "name"]);
  const herdr = data.herdr === null ? null : fields(data.herdr, ["session", "workspaceId", "paneId"]);
  const agentControlMode = data.agentControlMode;
  if (agentControlMode !== "herdr" && agentControlMode !== "web") return malformed();
  if (agentControlMode === "web" && herdr !== null) return malformed();
  return {
    claimId: id(data.claimId), state: data.state === "active" || data.state === "released" || data.state === "completed" ? data.state : malformed(),
    userId: id(data.userId), workerId: id(data.workerId), machine: { id: id(machine.id), name: workerText(machine.name) }, platform: executionPlatform(data.platform),
    agent: data.agent === "codex" || data.agent === "copilot" || data.agent === "claude" ? data.agent : malformed(), agentControlMode, worktreeId: id(data.worktreeId), phase: workerPhase(data.phase),
    herdr: herdr === null ? null : { session: workerText(herdr.session), workspaceId: workerText(herdr.workspaceId), paneId: workerText(herdr.paneId) },
    nativeSessionId: data.nativeSessionId === null ? null : workerText(data.nativeSessionId), claimedAt: timestamp(data.claimedAt),
  };
};

export const readPullRequests = (properties: TaskProperties): readonly PullRequestProperty[] | undefined => {
  if (!Object.hasOwn(properties, "pullRequests")) return undefined;
  const value = properties.pullRequests;
  array(value, pullRequest);
  return value as readonly PullRequestProperty[];
};

export const readWorkerClaim = (properties: TaskProperties): WorkerClaim | undefined =>
  Object.hasOwn(properties, "worker") ? workerClaim(properties.worker) : undefined;

const sameJsonValue = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]!));
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(right)) return false;
  const leftObject = left as Readonly<Record<string, JsonValue>>;
  const rightObject = right as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(leftObject);
  return keys.length === Object.keys(rightObject).length && keys.every((key) => Object.hasOwn(rightObject, key) && sameJsonValue(leftObject[key]!, rightObject[key]!));
};

export const sameTaskProperties = (left: TaskProperties, right: TaskProperties, excludeWorker = false): boolean => {
  if (!excludeWorker) return sameJsonValue(left, right);
  const withoutWorker = (properties: TaskProperties): TaskProperties => Object.fromEntries(Object.entries(properties).filter(([name]) => name !== "worker"));
  return sameJsonValue(withoutWorker(left), withoutWorker(right));
};
