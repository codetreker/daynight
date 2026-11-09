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
  for (const task of response.tasks) observed.set(task.id, taskExecutionBinding(task));
  return observed;
};
