import type { Project, TaskGraph, TaskGraphSummary, TaskSummary } from "../../api/types";
import { buildGraphIndex, type GraphIndex } from "../task-graph/model";

export const compareTimestamps = (left: string, right: string): number => {
  const seconds = left.slice(0, 19).localeCompare(right.slice(0, 19));
  if (seconds !== 0) return seconds;
  const fraction = (value: string) => value[19] === "." ? value.slice(20, -1).padEnd(9, "0") : "000000000";
  return fraction(left).localeCompare(fraction(right));
};

export const maxUpdatedAt = (tasks: readonly TaskSummary[]): string | null => {
  let maximum: string | null = null;
  for (const task of tasks) if (maximum === null || compareTimestamps(task.updatedAt, maximum) > 0) maximum = task.updatedAt;
  return maximum;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);
const sameTime = (left: string | null, right: string | null): boolean =>
  left === null || right === null ? left === right : compareTimestamps(left, right) === 0;

export const sameSummary = (left: TaskSummary, right: TaskSummary): boolean =>
  left.id === right.id && left.version === right.version && left.titlePreview === right.titlePreview &&
  left.titleTruncated === right.titleTruncated && left.status === right.status &&
  sameIds(left.dependsOn, right.dependsOn) && sameIds(left.externalDependsOn, right.externalDependsOn) &&
  left.allowAgents === right.allowAgents && left.requiredPlatform === right.requiredPlatform && left.workerNeedsAttention === right.workerNeedsAttention &&
  sameTime(left.startedAt, right.startedAt) && sameTime(left.completedAt, right.completedAt) &&
  sameTime(left.createdAt, right.createdAt) && sameTime(left.updatedAt, right.updatedAt);

export const sameProject = (left: Project, right: Project): boolean =>
  left.id === right.id && left.name === right.name && left.repoUrl === right.repoUrl &&
  left.settings.version === right.settings.version && left.settings.executionWarningMinutes === right.settings.executionWarningMinutes &&
  sameTime(left.createdAt, right.createdAt) && sameTime(left.updatedAt, right.updatedAt);

export type TaskProjection = { readonly graph: TaskGraph; readonly index: GraphIndex; readonly versions: ReadonlyMap<string, bigint> };

export const projectSummaries = (project: Project, summaries: readonly TaskSummary[], observedAt: string): TaskProjection => {
  const ordered = [...summaries].sort((left, right) => compareTimestamps(left.createdAt, right.createdAt) || left.id.localeCompare(right.id));
  const nodes = new Map(ordered.map((task) => [task.id, task]));
  const summary: { -readonly [Key in keyof TaskGraphSummary]: number } = { total: ordered.length, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 };
  const tasks = ordered.map(({ version: _version, ...task }) => {
    const blockedBy = task.dependsOn.filter((dependency) => nodes.get(dependency)?.status !== "done");
    const ready = task.status === "todo" && blockedBy.length === 0;
    if (task.status === "todo") { summary.todo++; if (ready) summary.ready++; else summary.blocked++; }
    else if (task.status === "in_progress") summary.inProgress++;
    else summary.done++;
    return { ...task, blockedBy, ready };
  });
  const graph: TaskGraph = { project, observedAt, tasks, summary };
  return { graph, index: buildGraphIndex(graph), versions: new Map(ordered.map((task) => [task.id, task.version])) };
};
