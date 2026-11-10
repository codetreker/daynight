import type { TaskProgressStatus } from "../../api/task-status";

const statusOrder: Readonly<Record<TaskProgressStatus, number>> = { in_progress: 0, todo: 1, proposed: 2, done: 3, cancelled: 3, ended: 3 };

export const compareTaskStatus = (left: TaskProgressStatus, right: TaskProgressStatus): number => statusOrder[left] - statusOrder[right];
