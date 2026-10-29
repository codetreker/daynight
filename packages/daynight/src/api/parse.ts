import { validateWorkerAgentMode, workerAgentControlMode } from "./worker-mode.js";
import { isNonemptyText, isText } from "../platform/text.js";
import type { ErrorDetails, GraphTask, Page, Project, ProjectMember, ServerError, Task, TaskAttachment, TaskGraph, TaskGraphSummary, TaskPlatform, TaskProperties, TaskStatus, User, WorkerClaim, WorkerHerdr, WorkerPhase } from "./types.js";

export class ProtocolError extends Error {
  constructor(message = "The server returned an invalid response.") { super(message); this.name = "ProtocolError"; }
}
const malformed = (): never => { throw new ProtocolError(); };
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return malformed();
  return value as Record<string, unknown>;
};
const text = (value: unknown, nonempty = false): string => {
  if (!isText(value) || (nonempty && !isNonemptyText(value))) return malformed();
  return value;
};
const bool = (value: unknown): boolean => typeof value === "boolean" ? value : malformed();
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : malformed();
const resourceVersion = (value: unknown): bigint => typeof value === "bigint" && value >= 1n && value <= 9_223_372_036_854_775_807n ? value : malformed();
export const canonicalId = (value: string): string | null => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null;
const id = (value: unknown): string => {
  const parsed = text(value);
  if (canonicalId(parsed) !== parsed) return malformed();
  return parsed;
};
const timestamp = (value: unknown): string => {
  const parsed = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(parsed)) return malformed();
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== parsed.slice(0, 19)) return malformed();
  return parsed;
};
const nullableTimestamp = (value: unknown): string | null => value === null ? null : timestamp(value);
const array = <T>(value: unknown, parse: (item: unknown) => T): T[] => Array.isArray(value) ? value.map((item) => parse(item)) : malformed();
const ids = (value: unknown): string[] => {
  const parsed = array(value, id);
  if (new Set(parsed).size !== parsed.length) return malformed();
  return parsed;
};
const dependencyIds = (value: unknown): string[] => {
  const parsed = ids(value);
  if (parsed.some((value, index) => index > 0 && parsed[index - 1]! > value)) return malformed();
  return parsed;
};
const status = (value: unknown): TaskStatus => value === "todo" || value === "in_progress" || value === "done" ? value : malformed();
const requiredPlatform = (value: unknown): TaskPlatform | null => value === null || value === "windows" || value === "linux" || value === "macos" ? value : malformed();

const validAttachmentPath = (value: string): boolean => isText(value) && !/^[A-Za-z]:\//.test(value) && !/[\\\p{Cc}]/u.test(value) && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
export const validateAttachmentPath = (value: string): string => {
  if (!validAttachmentPath(value)) throw new Error("Attachment path must be a valid relative path with nonempty segments and no dot segments, backslashes or control characters.");
  return value;
};

export const parseTaskAttachment = (value: unknown, expectedPath?: string): TaskAttachment => {
  const data = record(value);
  const path = text(data.path);
  if (!validAttachmentPath(path)) return malformed();
  const parsed = { path, contentType: text(data.contentType, true), sizeBytes: count(data.sizeBytes), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (expectedPath !== undefined && parsed.path !== expectedPath) return malformed();
  return parsed;
};

const projectSettings = (value: unknown): Project["settings"] => {
  const data = record(value);
  const executionWarningMinutes = count(data.executionWarningMinutes);
  if (executionWarningMinutes < 1 || executionWarningMinutes > 2_147_483_647) return malformed();
  return { version: resourceVersion(data.version), executionWarningMinutes };
};

export const parseProject = (value: unknown, expectedId?: string): Project => {
  const data = record(value);
  const parsed = { id: id(data.id), name: text(data.name, true), repoUrl: text(data.repoUrl, true), settings: projectSettings(data.settings), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  if (expectedId !== undefined && parsed.id !== expectedId) return malformed();
  return parsed;
};

const dependencyState = (data: Record<string, unknown>) => {
  const parsed = { id: id(data.id), status: status(data.status), allowAgents: bool(data.allowAgents), requiredPlatform: requiredPlatform(data.requiredPlatform), startedAt: nullableTimestamp(data.startedAt), completedAt: nullableTimestamp(data.completedAt), dependsOn: dependencyIds(data.dependsOn), externalDependsOn: dependencyIds(data.externalDependsOn), blockedBy: ids(data.blockedBy), ready: bool(data.ready), createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt) };
  const dependencies = new Set(parsed.dependsOn);
  if (dependencies.has(parsed.id) || parsed.externalDependsOn.some((item) => !dependencies.has(item)) || parsed.blockedBy.some((item) => !dependencies.has(item)) || parsed.ready !== (parsed.status === "todo" && parsed.blockedBy.length === 0)) return malformed();
  if ((parsed.status === "in_progress" || parsed.status === "done") && parsed.blockedBy.length > 0) return malformed();
  return parsed;
};

const rawString = (value: unknown): string => typeof value === "string" ? value : malformed();
const fields = (value: unknown, names: readonly string[]): Record<string, unknown> => {
  const data = record(value);
  if (Object.keys(data).some((key) => !names.includes(key))) return malformed();
  return data;
};
export const parseUser = (value: unknown): User => {
  const data = fields(value, ["id", "email", "emailVerified", "name", "avatarUrl"]);
  return {
    id: id(data.id), email: data.email === null ? null : text(data.email),
    emailVerified: data.emailVerified === null ? null : bool(data.emailVerified),
    name: data.name === null ? null : text(data.name), avatarUrl: data.avatarUrl === null ? null : text(data.avatarUrl),
  };
};
export const parseProjectMembers = (value: unknown, projectId: string): readonly ProjectMember[] => {
  const data = fields(value, ["items"]);
  const members = array(data.items, (value): ProjectMember => {
    const member = fields(value, ["projectId", "userId", "email", "name", "avatarUrl", "role", "version", "createdAt", "updatedAt"]);
    const parsed: ProjectMember = {
      projectId: id(member.projectId), userId: id(member.userId),
      email: member.email === null ? null : text(member.email), name: member.name === null ? null : text(member.name),
      avatarUrl: member.avatarUrl === null ? null : text(member.avatarUrl),
      role: member.role === "admin" || member.role === "member" ? member.role : malformed(),
      version: resourceVersion(member.version), createdAt: timestamp(member.createdAt), updatedAt: timestamp(member.updatedAt),
    };
    if (parsed.projectId !== projectId) return malformed();
    return parsed;
  });
  if (new Set(members.map(({ userId }) => userId)).size !== members.length) return malformed();
  return members;
};
const workerPhase = (value: unknown): WorkerPhase => value === "preparing" || value === "executing" || value === "verifying" || value === "completing" || value === "waiting" || value === "paused" ? value : malformed();
const workerHerdr = (value: unknown): WorkerHerdr | null => {
  if (value === null) return null;
  const data = record(value);
  return { session: text(data.session, true), workspaceId: text(data.workspaceId, true), paneId: text(data.paneId, true) };
};
const parseWorkerClaim = (value: unknown): WorkerClaim | null => {
  if (value === null) return null;
  const data = record(value);
  const machine = record(data.machine);
  const platform = requiredPlatform(data.platform);
  if (platform === null) return malformed();
  let agentControlMode;
  let agent;
  try { agentControlMode = workerAgentControlMode(data); agent = validateWorkerAgentMode(data.agent, agentControlMode); } catch { return malformed(); }
  if (agentControlMode === "web" && data.herdr !== null) return malformed();
  return {
    claimId: id(data.claimId), state: data.state === "active" || data.state === "released" || data.state === "completed" ? data.state : malformed(),
    userId: id(data.userId), workerId: id(data.workerId), machine: { id: id(machine.id), name: text(machine.name, true) }, platform,
    agent, agentControlMode, worktreeId: id(data.worktreeId), phase: workerPhase(data.phase), signaling: rawString(data.signaling),
    herdr: workerHerdr(data.herdr), nativeSessionId: data.nativeSessionId === null ? null : text(data.nativeSessionId, true), claimedAt: timestamp(data.claimedAt),
  };
};
const properties = (value: unknown): TaskProperties => {
  const data = record(value);
  return { pullRequests: array(data.pullRequests, (item) => {
    const pullRequest = record(item);
    return { url: rawString(pullRequest.url), title: rawString(pullRequest.title) };
  }), worker: parseWorkerClaim(data.worker) };
};

export const parseTask = (value: unknown, projectId: string, taskId?: string): Task => {
  const data = record(value);
  const version = resourceVersion(data.version);
  const parsed = { ...dependencyState(data), projectId: id(data.projectId), title: text(data.title, true), description: text(data.description), properties: properties(data.properties), version };
  if (parsed.projectId !== projectId || (taskId !== undefined && parsed.id !== taskId)) return malformed();
  if (parsed.properties.worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  if (parsed.properties.worker?.state === "released" && parsed.status !== "todo") return malformed();
  return parsed;
};

export const parsePage = <T>(value: unknown, parse: (item: unknown) => T, identity: (item: T) => string): Page<T> => {
  const data = record(value);
  const items = array(data.items, parse);
  if (items.length > 100 || new Set(items.map((item) => identity(item))).size !== items.length) return malformed();
  let nextCursor: string | null = null;
  if (data.nextCursor !== null) {
    nextCursor = text(data.nextCursor, true);
    if (items.length === 0) return malformed();
  }
  return { items, nextCursor };
};

const graphTask = (value: unknown): GraphTask => {
  const data = record(value);
  const parsed = { ...dependencyState(data), workerNeedsAttention: bool(data.workerNeedsAttention), titlePreview: text(data.titlePreview), titleTruncated: bool(data.titleTruncated) };
  const characters = Array.from(parsed.titlePreview).length;
  if (characters === 0 || characters > 160 || (parsed.titleTruncated && characters !== 160)) return malformed();
  return parsed;
};
const summary = (value: unknown): TaskGraphSummary => {
  const data = record(value);
  return { total: count(data.total), todo: count(data.todo), inProgress: count(data.inProgress), done: count(data.done), ready: count(data.ready), blocked: count(data.blocked) };
};

export const parseTaskGraph = (value: unknown, projectId: string): TaskGraph => {
  const data = record(value);
  const parsed = { observedAt: timestamp(data.observedAt), project: parseProject(data.project, projectId), summary: summary(data.summary), tasks: array(data.tasks, graphTask) };
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  if (parsed.tasks.length > 1000 || byId.size !== parsed.tasks.length || parsed.tasks.reduce((sum, task) => sum + task.dependsOn.length, 0) > 5000) return malformed();
  const expected = { total: parsed.tasks.length, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 };
  for (const task of parsed.tasks) {
    if (task.status === "todo") { expected.todo++; if (task.ready) expected.ready++; else expected.blocked++; }
    else if (task.status === "in_progress") expected.inProgress++;
    else expected.done++;
    const blocked = task.dependsOn.filter((dependency) => {
      const target = byId.get(dependency);
      if (target === undefined) return malformed();
      return target.status !== "done";
    });
    if (blocked.length !== task.blockedBy.length || blocked.some((dependency) => !task.blockedBy.includes(dependency))) return malformed();
  }
  for (const key of Object.keys(expected) as (keyof TaskGraphSummary)[]) if (expected[key] !== parsed.summary[key]) return malformed();
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (taskId: string): void => {
    if (active.has(taskId)) return malformed();
    if (visited.has(taskId)) return;
    active.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) visit(dependency);
    active.delete(taskId);
    visited.add(taskId);
  };
  for (const task of parsed.tasks) visit(task.id);
  return parsed;
};

export const parseServerError = (value: unknown): ServerError => {
  const data = record(record(value).error);
  const code = text(data.code, true);
  const requestId = text(data.requestId, true);
  const message = text(data.message, true);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(requestId)) return malformed();
  let details: ErrorDetails | undefined;
  if (data.details !== undefined) {
    const raw = record(data.details);
    details = {
      ...(raw.taskIds === undefined ? {} : { taskIds: ids(raw.taskIds) }),
      ...(raw.nodeCount === undefined ? {} : { nodeCount: count(raw.nodeCount) }),
      ...(raw.edgeCount === undefined ? {} : { edgeCount: count(raw.edgeCount) }),
      ...(raw.maxNodes === undefined ? {} : { maxNodes: count(raw.maxNodes) }),
      ...(raw.maxEdges === undefined ? {} : { maxEdges: count(raw.maxEdges) }),
    };
  }
  if (code === "graph_limit_exceeded" && (details?.nodeCount === undefined || details.edgeCount === undefined || details.maxNodes !== 1000 || details.maxEdges !== 5000 || (details.nodeCount <= details.maxNodes && details.edgeCount <= details.maxEdges))) return malformed();
  return { code, message, requestId, ...(details === undefined ? {} : { details }) };
};
