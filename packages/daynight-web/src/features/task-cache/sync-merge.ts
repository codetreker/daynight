import { ApiError } from "../../api/client";
import type { Project, TaskDependencyState, TaskSummary, TaskSync } from "../../api/types";
import { GraphDataError } from "../task-graph/model";
import { compareTimestamps, projectSummaries, sameSummary } from "./projection";

const protocol = (): never => { throw new ApiError("protocol"); };
export const sameDependencyState = (left: TaskDependencyState | undefined, right: TaskDependencyState | undefined): boolean =>
  left === right || left !== undefined && right !== undefined && left.taskVersion === right.taskVersion && left.ready === right.ready &&
  left.blockedBy.length === right.blockedBy.length && left.blockedBy.every((id, index) => id === right.blockedBy[index]);
export const validDependencyState = (task: TaskSummary, state: TaskDependencyState): boolean =>
  task.type === "task" && task.version === state.taskVersion && state.blockedBy.every(id => task.dependsOn.includes(id)) &&
  state.ready === (task.status === "todo" && state.blockedBy.length === 0) &&
  !((task.status === "in_progress" || task.status === "done") && state.blockedBy.length !== 0);

export type StoredTasks = { readonly tasks: readonly TaskSummary[]; readonly dependencyStates: ReadonlyMap<string, TaskDependencyState> };
export const mergeTaskSync = (
  previous: StoredTasks, response: TaskSync, project: Project, replacing: boolean, retainedRemovals: ReadonlySet<string>,
) => {
  const merged = new Map((replacing ? [] : previous.tasks).map(task => [task.id, task]));
  const states = new Map(replacing ? [] : previous.dependencyStates);
  const deletedTaskIds = new Set(response.deletedTaskIds);
  if (deletedTaskIds.size !== response.deletedTaskIds.length || response.mode === "snapshot" && deletedTaskIds.size !== 0) return protocol();
  if (replacing) {
    const visible = new Set(response.tasks.map(task => task.id));
    for (const task of previous.tasks) if (!visible.has(task.id)) deletedTaskIds.add(task.id);
    const old = new Map(previous.tasks.map(task => [task.id, task]));
    for (const task of response.tasks) {
      const existing = old.get(task.id);
      if (existing === undefined) continue;
      if (existing.version > task.version || existing.version === task.version && !sameSummary(existing, task) ||
        existing.parentTaskId !== undefined && task.parentTaskId !== undefined && existing.parentTaskId !== task.parentTaskId) return protocol();
    }
  }
  const changedTaskIds = new Set<string>();
  const intrinsicChanged = new Set<string>();
  for (const taskId of deletedTaskIds) {
    if (merged.delete(taskId)) changedTaskIds.add(taskId);
    states.delete(taskId);
  }
  for (const task of response.tasks) {
    if (deletedTaskIds.has(task.id) || retainedRemovals.has(task.id) ||
      response.coverageUpdatedAt === null || compareTimestamps(task.updatedAt, response.coverageUpdatedAt) > 0) return protocol();
    const incoming = response.dependencyStates[task.id];
    if (task.type === "task" ? incoming === undefined || !validDependencyState(task, incoming) : incoming !== undefined) return protocol();
    const existing = merged.get(task.id);
    if (existing !== undefined && existing.version > task.version) continue;
    if (existing !== undefined && existing.version === task.version) {
      if (!sameSummary(existing, task)) return protocol();
      if (existing.parentTaskId === undefined && task.parentTaskId !== undefined) {
        merged.set(task.id, task); changedTaskIds.add(task.id);
      }
      continue;
    }
    if (existing?.parentTaskId !== undefined && (task.parentTaskId !== undefined && existing.parentTaskId !== task.parentTaskId ||
      existing.parentTaskId !== null && task.parentId !== null)) return protocol();
    merged.set(task.id, existing?.parentTaskId !== undefined && task.parentTaskId === undefined ? { ...task, parentTaskId: existing.parentTaskId } : task);
    changedTaskIds.add(task.id); intrinsicChanged.add(task.id); states.delete(task.id);
  }
  for (const [taskId, state] of Object.entries(response.dependencyStates)) {
    if (deletedTaskIds.has(taskId) || retainedRemovals.has(taskId)) return protocol();
    const task = merged.get(taskId);
    if (task === undefined || task.version !== state.taskVersion) continue;
    if (!validDependencyState(task, state)) return protocol();
    if (!sameDependencyState(states.get(taskId), state)) { states.set(taskId, state); changedTaskIds.add(taskId); }
  }
  const tasks = [...merged.values()];
  if (tasks.some(task => task.type === "task" && !states.has(task.id))) return protocol();
  if (replacing && Object.keys(response.dependencyStates).length !== states.size) return protocol();
  if (tasks.some(task => response.coverageUpdatedAt === null || compareTimestamps(task.updatedAt, response.coverageUpdatedAt) > 0)) return protocol();
  try { projectSummaries(project, tasks, states, response.observedAt); }
  catch (error) { if (error instanceof GraphDataError) throw new ApiError("protocol", null, "protocol", null, error); throw error; }
  return { tasks, merged, dependencyStates: states, changedTaskIds, intrinsicChanged, deletedTaskIds };
};
