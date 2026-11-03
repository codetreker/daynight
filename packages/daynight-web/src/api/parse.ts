import type {
  Attachment,
  AttachmentPage,
  GraphLimitDetails,
  GraphTask,
  Project,
  ProjectPage,
  TaskDetail,
  TaskGraph,
  TaskGraphSummary,
} from "./types";
import { isTaskVersion } from "./json";

export { array, boolean, canonicalId, executionPlatform, id, malformed, nonemptyString, record, string, timestamp } from "./validation";
import { array, boolean, canonicalId, count, id, ids, malformed, nonemptyString, nullableTimestamp, record, requiredPlatform, status, string, timestamp } from "./validation";
import { parseTaskProperties, readPullRequests, readWorkerClaim } from "./task-properties";

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

export const parseTaskDetail = (value: unknown, projectId: string, taskId: string): TaskDetail => {
  const data = record(value);
  const version = data.version;
  if (!isTaskVersion(version)) return malformed();
  const parsed = {
    id: id(data.id),
    projectId: id(data.projectId),
    title: nonemptyString(data.title),
    description: string(data.description),
    properties: parseTaskProperties(data.properties),
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
  readPullRequests(parsed.properties);
  const worker = readWorkerClaim(parsed.properties);
  if (worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  if (worker?.state === "released" && parsed.status !== "todo") return malformed();
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
