import type { TaskProgressStatus } from "../../api/task-status";

const statusOrder: Readonly<Record<TaskProgressStatus, number>> = { in_progress: 0, todo: 1, done: 2, cancelled: 2, ended: 2 };

export const compareTaskStatus = (left: TaskProgressStatus, right: TaskProgressStatus): number => statusOrder[left] - statusOrder[right];
