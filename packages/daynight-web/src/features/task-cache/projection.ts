import type { Project, TaskDependencyState, TaskGraph, TaskGraphSummary, TaskSummary, WorkerClaim } from "../../api/types";
import { readTaskPaused, readWorkerClaim, sameTaskProperties } from "../../api/task-properties";
import { sameTaskTags } from "../../api/task-tags";
import { buildGraphIndex, GraphDataError, type GraphIndex } from "../task-graph/model";

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
  left.id === right.id && left.version === right.version && left.type === right.type && left.parentId === right.parentId && left.titlePreview === right.titlePreview &&
  left.titleTruncated === right.titleTruncated && left.status === right.status &&
  sameIds(left.dependsOn, right.dependsOn) && sameIds(left.externalDependsOn, right.externalDependsOn) &&
  left.allowAgents === right.allowAgents && left.assignedTo === right.assignedTo && left.requiredPlatform === right.requiredPlatform &&
  sameTaskProperties(left.properties, right.properties) && sameTaskTags(left.tags, right.tags) &&
  sameTime(left.startedAt, right.startedAt) && sameTime(left.completedAt, right.completedAt) && sameTime(left.cancelledAt, right.cancelledAt) &&
  sameTime(left.createdAt, right.createdAt) && sameTime(left.updatedAt, right.updatedAt);

export const sameProject = (left: Project, right: Project): boolean =>
  left.id === right.id && left.name === right.name && left.repoUrl === right.repoUrl &&
  left.ownership.teamId === right.ownership.teamId && left.ownership.version === right.ownership.version &&
  left.settings.version === right.settings.version && left.settings.executionWarningMinutes === right.settings.executionWarningMinutes &&
  sameTime(left.createdAt, right.createdAt) && sameTime(left.updatedAt, right.updatedAt);

export type TaskProjection = { readonly graph: TaskGraph; readonly index: GraphIndex; readonly versions: ReadonlyMap<string, bigint>; readonly pausedTaskIds: ReadonlySet<string>; readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, "state" | "machine">> };

export const projectSummaries = (project: Project, summaries: readonly TaskSummary[], dependencyStates: ReadonlyMap<string, TaskDependencyState>, observedAt: string): TaskProjection => {
  const ordered = [...summaries].sort((left, right) => compareTimestamps(left.createdAt, right.createdAt) || left.id.localeCompare(right.id));
  const ordinary = ordered.filter((task) => task.type === "task");
  const summary: { -readonly [Key in keyof TaskGraphSummary]: number } = { total: ordinary.length, proposed: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 };
  const tasks = ordinary.map(({ version, properties: _properties, tags: _tags, ...task }) => {
    const state = dependencyStates.get(task.id);
    if (state === undefined || state.taskVersion !== version) throw new GraphDataError();
    const { blockedBy, ready } = state;
    if (task.status === "todo") { summary.todo++; if (ready) summary.ready++; else summary.blocked++; }
    else if (task.status === "in_progress") summary.inProgress++;
    else if (task.status === "done") summary.done++;
    else if (task.status === "cancelled") summary.cancelled++;
    else summary.proposed++;
    return { ...task, blockedBy, ready };
  });
  const workerMachines = new Map<string, Pick<WorkerClaim, "state" | "machine">>();
  for (const task of ordered) {
    const claim = readWorkerClaim(task.properties);
    if (claim !== undefined) workerMachines.set(task.id, { state: claim.state, machine: claim.machine });
  }
  const graph: TaskGraph = { project, observedAt, tasks, summary };
  return { graph, index: buildGraphIndex(graph), workerMachines, pausedTaskIds: new Set(ordered.filter((task) => readTaskPaused(task.properties) === true).map((task) => task.id)), versions: new Map(ordered.map((task) => [task.id, task.version])) };
};
