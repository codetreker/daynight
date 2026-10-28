import type {
  Attachment,
  AttachmentPage,
  ExecutionPlatform,
  GraphLimitDetails,
  GraphTask,
  Project,
  ProjectPage,
  PullRequestProperty,
  TaskDetail,
  TaskGraph,
  TaskGraphSummary,
  TaskProperties,
  TaskStatus,
  WorkerClaim,
  WorkerPhase,
} from "./types";
import { isTaskVersion } from "./json";

export const malformed = (): never => {
  throw new Error("The server returned an invalid response.");
};

export const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
};

export const string = (value: unknown): string => {
  if (typeof value !== "string") return malformed();
  return value;
};

export const nonemptyString = (value: unknown): string => {
  const parsed = string(value);
  if (parsed.trim() === "" || parsed.includes("\0")) return malformed();
  return parsed;
};

export const boolean = (value: unknown): boolean => {
  if (typeof value !== "boolean") return malformed();
  return value;
};

const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return malformed();
  return value;
};

export const canonicalId = (value: string): string | null =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;

export const id = (value: unknown): string => {
  const parsed = canonicalId(string(value));
  if (parsed === null) return malformed();
  return parsed;
};

export const timestamp = (value: unknown): string => {
  const parsed = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(parsed)) return malformed();
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== parsed.slice(0, 19)) {
    return malformed();
  }
  return parsed;
};

const nullableTimestamp = (value: unknown): string | null => value === null ? null : timestamp(value);

export const array = <T>(value: unknown, parse: (item: unknown) => T): T[] => {
  if (!Array.isArray(value)) return malformed();
  return value.map(parse);
};

const ids = (value: unknown): string[] => {
  const values = array(value, id);
  if (new Set(values).size !== values.length) return malformed();
  return values;
};

export const executionPlatform = (value: unknown): ExecutionPlatform => {
  if (value !== "windows" && value !== "linux" && value !== "macos") return malformed();
  return value;
};

const requiredPlatform = (value: unknown): ExecutionPlatform | null => value === null ? null : executionPlatform(value);

const status = (value: unknown): TaskStatus => {
  if (value !== "todo" && value !== "in_progress" && value !== "done") return malformed();
  return value;
};

const projectSettings = (value: unknown): Project["settings"] => {
  const data = record(value);
  const version = data.version;
  const executionWarningMinutes = data.executionWarningMinutes;
  if (!isTaskVersion(version) || typeof executionWarningMinutes !== "number" || !Number.isInteger(executionWarningMinutes) || executionWarningMinutes < 1 || executionWarningMinutes > 2_147_483_647) return malformed();
  return { version, executionWarningMinutes };
};

export const project = (value: unknown): Project => {
  const data = record(value);
  return {
    id: id(data.id),
    name: nonemptyString(data.name),
    repoUrl: nonemptyString(data.repoUrl),
    settings: projectSettings(data.settings),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
  };
};

export const parseProjectPage = (value: unknown): ProjectPage => {
  const data = record(value);
  const items = array(data.items, project);
  if (new Set(items.map((item) => item.id)).size !== items.length) return malformed();
  return { items, nextCursor: data.nextCursor === null ? null : nonemptyString(data.nextCursor) };
};

const taskDependencies = (data: Record<string, unknown>): Pick<GraphTask, "dependsOn" | "externalDependsOn"> => {
  const dependsOn = ids(data.dependsOn);
  const externalDependsOn = ids(data.externalDependsOn);
  const dependencies = new Set(dependsOn);
  if (externalDependsOn.some((taskId) => !dependencies.has(taskId))) return malformed();
  return { dependsOn, externalDependsOn };
};

const graphTask = (value: unknown): GraphTask => {
  const data = record(value);
  return {
    id: id(data.id),
    titlePreview: string(data.titlePreview),
    titleTruncated: boolean(data.titleTruncated),
    status: status(data.status),
    ...taskDependencies(data),
    blockedBy: ids(data.blockedBy),
    ready: boolean(data.ready),
    allowAgents: boolean(data.allowAgents),
    requiredPlatform: requiredPlatform(data.requiredPlatform),
    startedAt: nullableTimestamp(data.startedAt),
    completedAt: nullableTimestamp(data.completedAt),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
  };
};

const summary = (value: unknown): TaskGraphSummary => {
  const data = record(value);
  const parsed = {
    total: count(data.total),
    todo: count(data.todo),
    inProgress: count(data.inProgress),
    done: count(data.done),
    ready: count(data.ready),
    blocked: count(data.blocked),
  };
  if (parsed.total !== parsed.todo + parsed.inProgress + parsed.done || parsed.todo !== parsed.ready + parsed.blocked) return malformed();
  return parsed;
};

export const parseTaskGraph = (value: unknown, projectId: string): TaskGraph => {
  const data = record(value);
  const parsed = { observedAt: timestamp(data.observedAt), project: project(data.project), summary: summary(data.summary), tasks: array(data.tasks, graphTask) };
  if (parsed.project.id !== projectId || new Set(parsed.tasks.map((task) => task.id)).size !== parsed.tasks.length) {
    return malformed();
  }
  return parsed;
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
const workerClaim = (value: unknown): WorkerClaim | null => {
  if (value === null) return null;
  const data = fields(value, ["claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt"]);
  const machine = fields(data.machine, ["id", "name"]);
  const herdr = data.herdr === null ? null : fields(data.herdr, ["session", "workspaceId", "paneId"]);
  const agentControlMode = !Object.hasOwn(data, "agentControlMode") ? "herdr" : data.agentControlMode;
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
const properties = (value: unknown): TaskProperties => {
  const data = record(value);
  return { pullRequests: array(data.pullRequests, pullRequest), worker: workerClaim(data.worker) };
};

export const parseTaskDetail = (value: unknown, projectId: string, taskId: string): TaskDetail => {
  const data = record(value);
  const version = data.version;
  if (!isTaskVersion(version)) return malformed();
  const parsed = {
    id: id(data.id),
    projectId: id(data.projectId),
    title: nonemptyString(data.title),
    description: string(data.description),
    properties: properties(data.properties),
    status: status(data.status),
    version,
    ...taskDependencies(data),
    blockedBy: ids(data.blockedBy),
    ready: boolean(data.ready),
    allowAgents: boolean(data.allowAgents),
    requiredPlatform: requiredPlatform(data.requiredPlatform),
    startedAt: nullableTimestamp(data.startedAt),
    completedAt: nullableTimestamp(data.completedAt),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
  };
  if (parsed.projectId !== projectId || parsed.id !== taskId) return malformed();
  if (parsed.properties.worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  if (parsed.properties.worker?.state === "released" && parsed.status !== "todo") return malformed();
  return parsed;
};

export type ServerError = {
  readonly code: string;
  readonly requestId: string;
  readonly graphLimit?: GraphLimitDetails;
};

export const parseServerError = (value: unknown): ServerError => {
  const data = record(record(value).error);
  const code = string(data.code);
  const requestId = string(data.requestId);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(requestId)) return malformed();
  string(data.message);
  if (code !== "graph_limit_exceeded") return { code, requestId };
  const details = record(data.details);
  return {
    code,
    requestId,
    graphLimit: {
      nodeCount: count(details.nodeCount),
      edgeCount: count(details.edgeCount),
      maxNodes: count(details.maxNodes),
      maxEdges: count(details.maxEdges),
    },
  };
};

export const isAttachmentPath = (value: string): boolean =>
  value !== "" && !/^[a-z]:\//i.test(value) && !/[\\\p{Cc}\p{Cs}]/u.test(value) &&
  value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

export const parseAttachment = (value: unknown): Attachment => {
  const data = record(value);
  const path = string(data.path);
  const contentType = nonemptyString(data.contentType);
  if (!isAttachmentPath(path) || !/^[!#$%&'*+.^_`|~a-z0-9-]+\/[!#$%&'*+.^_`|~a-z0-9-]+(?:\s*;[^\r\n]*)?$/i.test(contentType)) return malformed();
  return { path, contentType, sizeBytes: count(data.sizeBytes), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
};

export const parseAttachmentPage = (value: unknown): AttachmentPage => {
  const data = record(value);
  const items = array(data.items, parseAttachment);
  if (new Set(items.map((item) => item.path)).size !== items.length) return malformed();
  return { items, nextCursor: data.nextCursor === null ? null : nonemptyString(data.nextCursor) };
};

export {
  parseSessionCommand, parseSessionSnapshot, parseSessionOperation, parseSessionResource,
  parseSessionInteraction, parseInteractionResponse, parseTimelineEntry, parseSessionEvent,
} from "../../../daynight/src/session/protocol.js";
