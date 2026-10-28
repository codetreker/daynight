import type { TaskStatus } from "../../api/types";

const statusOrder: Readonly<Record<TaskStatus, number>> = { in_progress: 0, todo: 1, done: 2 };

export const compareTaskStatus = (left: TaskStatus, right: TaskStatus): number => statusOrder[left] - statusOrder[right];
