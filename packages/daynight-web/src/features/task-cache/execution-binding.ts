import { ApiError } from "../../api/client";
import { readWorkerClaim } from "../../api/task-properties";
import type { TaskSummary, TaskSync, WorkerClaim } from "../../api/types";
import type { TaskSyncTicket } from "./project-cache";

export type TaskExecutionBinding = {
  readonly status: TaskSummary["status"];
  readonly worker: Pick<WorkerClaim, "claimId" | "workerId" | "worktreeId" | "state" | "agentControlMode"> | null;
};

export const taskExecutionBinding = (task: Pick<TaskSummary, "status" | "properties">): TaskExecutionBinding => {
  const worker = readWorkerClaim(task.properties);
  return Object.freeze({ status: task.status, worker: worker === undefined ? null : Object.freeze({
    claimId: worker.claimId, workerId: worker.workerId, worktreeId: worker.worktreeId,
    state: worker.state, agentControlMode: worker.agentControlMode,
  }) });
};

export const sameTaskExecutionBinding = (left: TaskExecutionBinding, right: TaskExecutionBinding): boolean =>
  left.status === right.status && (left.worker === null || right.worker === null
    ? left.worker === right.worker
    : left.worker.claimId === right.worker.claimId && left.worker.workerId === right.worker.workerId &&
      left.worker.worktreeId === right.worker.worktreeId && left.worker.state === right.worker.state &&
      left.worker.agentControlMode === right.worker.agentControlMode);

export const eligibleTaskExecutionBinding = (binding: TaskExecutionBinding): boolean =>
  binding.status === "in_progress" && binding.worker?.agentControlMode === "web";

export const deriveTaskSyncBindings = (ticket: TaskSyncTicket, response: TaskSync): ReadonlyMap<string, TaskExecutionBinding> => {
  const observed = new Map(response.mode === "snapshot" ? [] : ticket.taskBindings);
  for (const id of response.deletedTaskIds) observed.delete(id);
  for (const task of response.tasks) observed.set(task.id, taskExecutionBinding(task));
  return observed;
};

export const deriveTaskSyncVersions = (ticket: TaskSyncTicket, response: TaskSync): ReadonlyMap<string, bigint> => {
  const versions = new Map(response.mode === "snapshot" ? [] : ticket.taskVersions);
  for (const id of response.deletedTaskIds) versions.delete(id);
  for (const task of response.tasks) versions.set(task.id, task.version);
  return versions;
};

/** Validate only bindings whose version is known from the request or response. */
export const validateTaskSyncObservationBindings = (response: TaskSync, bindings: ReadonlyMap<string, TaskExecutionBinding>, versions: ReadonlyMap<string, bigint>): void => {
  for (const [id, observation] of Object.entries(response.taskObservations)) {
    const binding = bindings.get(id);
    if (binding === undefined || versions.get(id) !== observation.taskVersion) continue;
    const active = binding.status === "in_progress" && binding.worker?.state === "active";
    if (binding.status !== "in_progress" || observation.canOpen && !active ||
      observation.state === "no_session" && active ||
      observation.state !== "no_session" && observation.state !== "unavailable" && !active) throw new ApiError("protocol");
  }
};
