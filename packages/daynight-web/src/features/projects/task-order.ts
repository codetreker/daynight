import type { GraphTask } from '../../api/types';
import { isTerminalStatus, taskEndedAt } from '../../api/task-status';
import { timestampNanoseconds } from './task-visibility';
import type { TaskProgressStatus } from "../../api/task-status";

const statusOrder: Readonly<Record<TaskProgressStatus, number>> = { in_progress: 0, todo: 1, proposed: 2, done: 3, cancelled: 3, ended: 3 };

export const compareTaskStatus = (left: TaskProgressStatus, right: TaskProgressStatus): number => statusOrder[left] - statusOrder[right];

export const compareTaskMembers = (left: GraphTask, right: GraphTask) => {
  const status = compareTaskStatus(left.status, right.status);
  if (status !== 0 || !isTerminalStatus(left.status)) return status;
  const leftEndedAt = taskEndedAt(left);
  const rightEndedAt = taskEndedAt(right);
  if (leftEndedAt === null) return rightEndedAt === null ? 0 : 1;
  if (rightEndedAt === null) return -1;
  const leftTime = timestampNanoseconds(leftEndedAt);
  const rightTime = timestampNanoseconds(rightEndedAt);
  return leftTime > rightTime ? -1 : leftTime < rightTime ? 1 : 0;
};
