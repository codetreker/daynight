import { parseProjectAccess } from "./auth-parse";
import { isTaskVersion } from "./json";
import { parseTaskProperties, readTaskPaused } from "./task-properties";
import { array, boolean, id, malformed, project, record, string, timestamp, executionPlatform } from "./parse";
import type { TaskSummary, TaskSync } from "./types";
import { nullableId } from "./validation";

const ids = (value: unknown): string[] => {
  const result = array(value, id);
  if (new Set(result).size !== result.length) return malformed();
  return result;
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
  if (data.status !== "todo" && data.status !== "in_progress" && data.status !== "done") return malformed();
  const properties = parseTaskProperties(data.properties);
  readTaskPaused(properties);
  return {
    id: id(data.id), version, properties,
    titlePreview: string(data.titlePreview), titleTruncated: boolean(data.titleTruncated),
    status: data.status, dependsOn, externalDependsOn,
    allowAgents: boolean(data.allowAgents),
    assignedTo: nullableId(data.assignedTo),
    requiredPlatform: data.requiredPlatform === null ? null : executionPlatform(data.requiredPlatform),
    startedAt: data.startedAt === null ? null : timestamp(data.startedAt),
    completedAt: data.completedAt === null ? null : timestamp(data.completedAt),
    createdAt: timestamp(data.createdAt), updatedAt: timestamp(data.updatedAt),
  };
};

export const parseTaskSync = (value: unknown, projectId: string, userId?: string): TaskSync => {
  const data = record(value);
  if (data.mode !== "snapshot" && data.mode !== "delta") return malformed();
  const result: TaskSync = {
    actorAccess: parseProjectAccess(data.actorAccess, projectId, userId),
    mode: data.mode, epoch: id(data.epoch), project: project(data.project),
    observedAt: timestamp(data.observedAt), tasks: array(data.tasks, parseTaskSummary),
  };
  if (result.project.id !== projectId || result.tasks.length > 1000 ||
    new Set(result.tasks.map((task) => task.id)).size !== result.tasks.length ||
    result.tasks.reduce((count, task) => count + task.dependsOn.length, 0) > 5000) return malformed();
  return result;
};
