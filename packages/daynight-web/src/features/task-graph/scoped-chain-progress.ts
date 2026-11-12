import { taskProgressStatus, type TaskProgressStatus } from '../../api/task-status';
import type { GraphIndex } from './model';

export type ScopedChainProgress = {
  readonly total: number;
  readonly done: number;
  readonly cancelled: number;
  readonly inProgress: number;
  readonly status: TaskProgressStatus;
};

export const scopedChainProgress = (index: GraphIndex, memberIds: readonly string[]): ScopedChainProgress => {
  const tasks = memberIds.map((id) => index.nodes.get(id)!);
  const done = tasks.filter((task) => task.status === 'done').length;
  const cancelled = tasks.filter((task) => task.status === 'cancelled').length;
  const inProgress = tasks.filter((task) => task.status === 'in_progress').length;
  return { total: tasks.length, done, cancelled, inProgress, status: taskProgressStatus(done, cancelled, tasks.length, inProgress > 0, tasks.filter((task) => task.status === 'proposed').length) };
};
