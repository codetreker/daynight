import type { GraphTask, TaskStatus } from "./types";

export type TaskProgressStatus = TaskStatus | "ended";
export const isTerminalStatus = (status: TaskStatus): boolean => status === "done" || status === "cancelled";
export const taskEndedAt = (task: Pick<GraphTask, "status" | "completedAt" | "cancelledAt">): string | null =>
  task.status === "done" ? task.completedAt : task.status === "cancelled" ? task.cancelledAt : null;
export const taskProgressStatus = (done: number, cancelled: number, total: number, inProgress: boolean, proposed: number): TaskProgressStatus =>
  done === total ? "done" : cancelled === total ? "cancelled" : done + cancelled === total ? "ended"
    : done + cancelled > 0 || inProgress ? "in_progress" : proposed === total ? "proposed" : "todo";
