import { parseProfileVersion } from "./profile-version";
import { parseProjectAccess } from "./auth-parse";
import { isTaskVersion } from "./json";
import { parseTaskProperties, readTaskPaused, readWorkerClaim } from "./task-properties";
import { array, boolean, id, malformed, project, record, string, timestamp, executionPlatform } from "./parse";
import type { ProjectPersonVersion } from "./auth-types";
import type { TaskDependencyState, TaskListSessionState, TaskSummary, TaskSync, TaskSyncObservation } from "./types";
import { nullableId, taskStatusFields, taskTypeFields } from "./validation";
import { parseTaskTags } from "./task-tags";

const ids = (value: unknown): string[] => {
  const result = array(value, id);
  if (new Set(result).size !== result.length) return malformed();
  return result;
};

const syncTimestamp = (value: unknown): string => {
  const result = timestamp(value);
  if (result.startsWith("0000-")) return malformed();
  return result;
};

const parseTaskSessions = (value: unknown): Readonly<Record<string, TaskListSessionState>> => {
  const data = record(value);
  if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return malformed();
  const entries = Object.entries(data);
  const sessions: Record<string, TaskListSessionState> = {};
  for (const [taskId, state] of entries) {
    if (id(taskId) !== taskId || state !== "working" && state !== "notice" && state !== "warning" && state !== "pending") return malformed();
    sessions[taskId] = state;
  }
  return sessions;
};

export const parseTaskSyncObservation = (value: unknown): TaskSyncObservation => {
  const item = record(value);
  const fields = ["taskVersion", "state", "observedAt", "freshUntil", "needsAttention", "canOpen"];
  if (Object.keys(item).length !== fields.length || fields.some((field) => !Object.hasOwn(item, field))) return malformed();
  const version = string(item.taskVersion);
  if (!/^[1-9][0-9]*$/.test(version)) return malformed();
  const taskVersion = BigInt(version);
  if (!isTaskVersion(taskVersion)) return malformed();
  const state = item.state;
  if (state !== "no_session" && state !== "not_registered" && state !== "pending" && state !== "working" && state !== "notice" && state !== "warning" && state !== "unavailable") return malformed();
  const observedAt = item.observedAt === null ? null : syncTimestamp(item.observedAt);
  const freshUntil = item.freshUntil === null ? null : syncTimestamp(item.freshUntil);
  const needsAttention = item.needsAttention === null ? null : boolean(item.needsAttention);
  const canOpen = boolean(item.canOpen);
  if (state !== "unavailable" && observedAt === null || canOpen && (observedAt === null || freshUntil === null || state === "no_session" || state === "not_registered")) return malformed();
  return { taskVersion, state, observedAt, freshUntil, needsAttention, canOpen };
};

const parseTaskObservations = (value: unknown): Readonly<Record<string, TaskSyncObservation>> => {
  const data = record(value);
  if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return malformed();
  const result: Record<string, TaskSyncObservation> = {};
  for (const [taskId, value] of Object.entries(data)) {
    if (id(taskId) !== taskId) return malformed();
    result[taskId] = parseTaskSyncObservation(value);
  }
  return result;
};

export const parseDependencyState = (value: unknown): TaskDependencyState => {
  const data = record(value);
  const encodedVersion = string(data.taskVersion);
  if (!/^[1-9][0-9]*$/.test(encodedVersion)) return malformed();
  const taskVersion = BigInt(encodedVersion);
  if (!isTaskVersion(taskVersion)) return malformed();
  return { taskVersion, blockedBy: ids(data.blockedBy), ready: boolean(data.ready) };
};

export const validateDependencyState = (task: TaskSummary, state: TaskDependencyState): void => {
  if (task.type !== "task" || state.blockedBy.some((dependency) => !task.dependsOn.includes(dependency)) ||
    state.ready !== (task.status === "todo" && state.blockedBy.length === 0)) malformed();
};

const parseDependencyStates = (value: unknown): Readonly<Record<string, TaskDependencyState>> => {
  const data = record(value);
  if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return malformed();
  const states: Record<string, TaskDependencyState> = {};
  for (const [taskId, state] of Object.entries(data)) {
    if (id(taskId) !== taskId) return malformed();
    states[taskId] = parseDependencyState(state);
  }
  return states;
};

export const parseTaskSummary = (value: unknown): TaskSummary => {
  const data = record(value);
  const encodedVersion = string(data.version);
  if (!/^[1-9][0-9]*$/.test(encodedVersion)) return malformed();
  const version = BigInt(encodedVersion);
  if (!isTaskVersion(version)) return malformed();
  const dependsOn = ids(data.dependsOn);
  const externalDependsOn = ids(data.externalDependsOn);
  if (externalDependsOn.some((dependency) => !dependsOn.includes(dependency))) return malformed();
  const properties = parseTaskProperties(data.properties);
  readTaskPaused(properties);
  const worker = readWorkerClaim(properties);
  if (worker?.state === "active" && data.status !== "in_progress") return malformed();
  const result: TaskSummary = {
    id: id(data.id), version, properties, tags: parseTaskTags(data.tags),
    ...taskTypeFields(data),
    title: string(data.title), titlePreview: string(data.titlePreview), titleTruncated: boolean(data.titleTruncated),
    ...taskStatusFields(data), dependsOn, externalDependsOn,
    allowAgents: boolean(data.allowAgents),
    assignedTo: nullableId(data.assignedTo),
    requiredPlatform: data.requiredPlatform === null ? null : executionPlatform(data.requiredPlatform),
    startedAt: data.startedAt === null ? null : timestamp(data.startedAt),
    completedAt: data.completedAt === null ? null : timestamp(data.completedAt),
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt),
  };
  if (result.type === "goal" && (result.status === "proposed" || result.dependsOn.length !== 0 || result.allowAgents || result.requiredPlatform !== null)) return malformed();
  return result;
};

export const parseTaskSync = (value: unknown, projectId: string, userId?: string): TaskSync => {
  const data = record(value);
  if (data.mode !== "snapshot" && data.mode !== "delta") return malformed();
  const result: TaskSync = {
    assigneeVersions: array(data.assigneeVersions, (value): ProjectPersonVersion => {
      const person = record(value);
      if (Object.keys(person).length !== 3 || Object.keys(person).some((key) => !["userId", "version", "hasProjectAccess"].includes(key))) return malformed();
      return { userId: id(person.userId), version: parseProfileVersion(person.version), hasProjectAccess: boolean(person.hasProjectAccess) };
    }),
    actorAccess: parseProjectAccess(data.actorAccess, projectId, userId),
    mode: data.mode, epoch: id(data.epoch), project: project(data.project),
    observedAt: timestamp(data.observedAt), responseTaskAt: syncTimestamp(data.responseTaskAt),
    responseSessionAt: syncTimestamp(data.responseSessionAt), sessionPartial: boolean(data.sessionPartial),
    taskObservations: parseTaskObservations(data.taskObservations), tasks: array(data.tasks, parseTaskSummary),
    dependencyStates: parseDependencyStates(data.dependencyStates),
    sessions: parseTaskSessions(data.sessions),
  };
  if (!result.sessionPartial && Object.values(result.taskObservations).some((observation) => observation.state === "unavailable") ||
    new Set(result.assigneeVersions.map((person) => person.userId)).size !== result.assigneeVersions.length ||
    result.project.id !== projectId || result.actorAccess.ownership.teamId !== result.project.ownership.teamId ||
    result.actorAccess.ownership.version !== result.project.ownership.version ||
    new Set(result.tasks.map((task) => task.id)).size !== result.tasks.length) return malformed();
  for (const task of result.tasks) {
    const state = result.dependencyStates[task.id];
    if (task.type === "goal") {
      if (state !== undefined) return malformed();
    } else {
      if (state === undefined || state.taskVersion !== task.version) return malformed();
      validateDependencyState(task, state);
    }
  }
  if (result.mode === "snapshot" && Object.keys(result.dependencyStates).length !== result.tasks.filter((task) => task.type === "task").length) return malformed();
  return result;
};
