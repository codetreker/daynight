import { isText } from "../platform/text.js";
import type { ErrorDetails, GraphTask, Page, Project, ProjectMember, ServerError, Task, TaskAttachment, TaskGraph, TaskGraphSummary, TaskPlatform, TaskStatus, User, WorkerReportReceipt } from "./types.js";

export { canonicalId, ProtocolError } from "./validation.js";
import { array, bool, canonicalId, count, fields, id, malformed, nullableTimestamp, record, resourceVersion, text, timestamp } from "./validation.js";
import { parseTaskProperties, readWorkerClaim } from "./task-properties.js";

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

export const parseWorkerReportReceipt = (value: unknown): WorkerReportReceipt => {
  const data = fields(value, ["observedAt", "lastReportedAt"]);
  const parsed = { observedAt: timestamp(data.observedAt), lastReportedAt: timestamp(data.lastReportedAt) };
  if (Object.values(parsed).some((value) => /^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(value))) return malformed();
  return parsed;
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
export const parseTask = (value: unknown, projectId: string, taskId?: string): Task => {
  const data = record(value);
  const version = resourceVersion(data.version);
  const parsed = { ...dependencyState(data), projectId: id(data.projectId), title: text(data.title, true), description: text(data.description), properties: parseTaskProperties(data.properties), version };
  if (parsed.projectId !== projectId || (taskId !== undefined && parsed.id !== taskId)) return malformed();
  const worker = readWorkerClaim(parsed.properties);
  if (worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  if (worker?.state === "released" && parsed.status !== "todo") return malformed();
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
  const parsed = { ...dependencyState(data), titlePreview: text(data.titlePreview), titleTruncated: bool(data.titleTruncated) };
  const characters = Array.from(parsed.titlePreview).length;
  if (characters === 0 || characters > 160 || (parsed.titleTruncated && characters !== 160)) return malformed();
  return parsed;
};
const summary = (value: unknown): TaskGraphSummary => {
  const data = record(value);
  return { total: count(data.total), todo: count(data.todo), inProgress: count(data.inProgress), done: count(data.done), ready: count(data.ready), blocked: count(data.blocked) };
};

const graphChainMembers = (byId: ReadonlyMap<string, GraphTask>, taskId: string): Set<string> => {
  if (!byId.has(taskId)) return malformed();
  const neighbors = new Map(Array.from(byId.keys(), (id) => [id, new Set<string>()]));
  for (const task of byId.values()) {
    for (const dependency of task.dependsOn) {
      if (task.externalDependsOn.includes(dependency) || !byId.has(dependency)) continue;
      neighbors.get(task.id)!.add(dependency);
      neighbors.get(dependency)!.add(task.id);
    }
  }
  const members = new Set<string>();
  const pending = [taskId];
  for (const current of pending) {
    if (members.has(current)) continue;
    members.add(current);
    pending.push(...neighbors.get(current)!);
  }
  return members;
};

export const parseTaskGraph = (value: unknown, projectId: string, taskId: string): TaskGraph => {
  const data = record(value);
  const parsed = { observedAt: timestamp(data.observedAt), project: parseProject(data.project, projectId), summary: summary(data.summary), tasks: array(data.tasks, graphTask) };
  const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
  if (parsed.tasks.length > 1000 || byId.size !== parsed.tasks.length || parsed.tasks.reduce((sum, task) => sum + task.dependsOn.length, 0) > 5000) return malformed();
  const members = graphChainMembers(byId, taskId);
  const selected = new Set(members);
  for (const member of members) {
    const task = byId.get(member)!;
    if (task.dependsOn.some((dependency) => !byId.has(dependency))) return malformed();
    task.externalDependsOn.forEach((dependency) => selected.add(dependency));
  }
  if (selected.size !== byId.size || Array.from(selected).some((id) => !byId.has(id))) return malformed();
  const expected = { total: parsed.tasks.length, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 };
  for (const task of parsed.tasks) {
    if (task.status === "todo") { expected.todo++; if (task.ready) expected.ready++; else expected.blocked++; }
    else if (task.status === "in_progress") expected.inProgress++;
    else expected.done++;
    for (const dependency of task.dependsOn) {
      const target = byId.get(dependency);
      if (target !== undefined && task.blockedBy.includes(dependency) !== (target.status !== "done")) return malformed();
    }
  }
  for (const key of Object.keys(expected) as (keyof TaskGraphSummary)[]) if (expected[key] !== parsed.summary[key]) return malformed();
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (taskId: string): void => {
    if (active.has(taskId)) return malformed();
    if (visited.has(taskId)) return;
    active.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) if (byId.has(dependency)) visit(dependency);
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
