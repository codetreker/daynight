import type {
  Attachment,
  AttachmentPage,
  GraphTask,
  Project,
  ProjectPage,
  TaskDetail,
  TaskGraph,
  TaskGraphSummary,
} from "./types";
import { parseProjectOwnership } from "./team-parse";
import { isTaskVersion } from "./json";

export { array, boolean, canonicalId, executionPlatform, id, malformed, nonemptyString, record, string, timestamp } from "./validation";
import { array, boolean, canonicalId, count, id, ids, malformed, nonemptyString, nullableId, nullableTimestamp, record, requiredPlatform, taskStatusFields, taskTypeFields, string, timestamp } from "./validation";
import { parseTaskProperties, readPullRequests, readTaskPaused, readWorkerClaim } from "./task-properties";
import { parseTaskTags } from "./task-tags";

const projectSettings = (value: unknown): Project["settings"] => {
  const data = record(value);
  const version = data.version;
  const executionWarningMinutes = data.executionWarningMinutes;
  if (!isTaskVersion(version) || typeof executionWarningMinutes !== "number" || !Number.isInteger(executionWarningMinutes) || executionWarningMinutes < 1 || executionWarningMinutes > 2_147_483_647) return malformed();
  return { version, executionWarningMinutes };
};

export const project = (value: unknown): Project => {
  const data = record(value);
  const name = string(data.name);
  if (!name.isWellFormed() || name.includes("\0") || !/[^\p{White_Space}]/u.test(name)) return malformed();
  return {
    id: id(data.id),
    name,
    repoUrl: nonemptyString(data.repoUrl),
    settings: projectSettings(data.settings),
    ownership: parseProjectOwnership(data.ownership),
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
  const typed = taskTypeFields(data);
  if (typed.type !== "task") return malformed();
  return {
    id: id(data.id),
    ...typed,
    titlePreview: string(data.titlePreview),
    titleTruncated: boolean(data.titleTruncated),
    ...taskStatusFields(data),
    ...taskDependencies(data),
    blockedBy: ids(data.blockedBy),
    ready: boolean(data.ready),
    allowAgents: boolean(data.allowAgents),
    assignedTo: nullableId(data.assignedTo),
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
    proposed: count(data.proposed),
    todo: count(data.todo),
    inProgress: count(data.inProgress),
    done: count(data.done),
    cancelled: count(data.cancelled),
    ready: count(data.ready),
    blocked: count(data.blocked),
  };
  if (parsed.total !== parsed.proposed + parsed.todo + parsed.inProgress + parsed.done + parsed.cancelled || parsed.todo !== parsed.ready + parsed.blocked) return malformed();
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
    ...taskTypeFields(data),
    projectId: id(data.projectId),
    title: nonemptyString(data.title),
    description: string(data.description),
    properties: parseTaskProperties(data.properties),
    tags: parseTaskTags(data.tags),
    ...taskStatusFields(data),
    version,
    ...taskDependencies(data),
    blockedBy: ids(data.blockedBy),
    ready: boolean(data.ready),
    allowAgents: boolean(data.allowAgents),
    assignedTo: nullableId(data.assignedTo),
    requiredPlatform: requiredPlatform(data.requiredPlatform),
    startedAt: nullableTimestamp(data.startedAt),
    completedAt: nullableTimestamp(data.completedAt),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
  };
  if (parsed.projectId !== projectId || parsed.id !== taskId) return malformed();
  if (parsed.type === "goal" && (parsed.status === "proposed" || parsed.dependsOn.length !== 0 || parsed.blockedBy.length !== 0 || parsed.ready || parsed.allowAgents || parsed.requiredPlatform !== null)) return malformed();
  readPullRequests(parsed.properties);
  readTaskPaused(parsed.properties);
  const worker = readWorkerClaim(parsed.properties);
  if (worker?.state === "active" && parsed.status !== "in_progress") return malformed();
  return parsed;
};

export type ServerError = {
  readonly code: string;
  readonly requestId: string;
  readonly serverMessage?: string;
  readonly stepsLimit?: { readonly encodedBytes: number; readonly maxEncodedBytes: number };
  readonly writeOutcome?: "not_committed";
};

export const parseServerError = (value: unknown, includeSteps = false): ServerError => {
  const data = record(record(value).error);
  const code = string(data.code);
  const requestId = string(data.requestId);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(code) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(requestId)) return malformed();
  const message = string(data.message);
  const detailsValue = data.details;
  const writeOutcome = typeof detailsValue === "object" && detailsValue !== null && !Array.isArray(detailsValue) &&
    (detailsValue as Record<string, unknown>).writeOutcome === "not_committed" ? "not_committed" as const : undefined;
  const withOutcome = (error: ServerError): ServerError => writeOutcome === undefined ? error : { ...error, writeOutcome };
  if (includeSteps && code === "steps_limit_exceeded") {
    const details = record(data.details);
    return withOutcome({ code, requestId, serverMessage: message, stepsLimit: { encodedBytes: count(details.encodedBytes), maxEncodedBytes: count(details.maxEncodedBytes) } });
  }
  return withOutcome({ code, requestId, ...(includeSteps ? { serverMessage: message } : {}) });
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
