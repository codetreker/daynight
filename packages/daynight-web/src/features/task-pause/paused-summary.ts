import type { TaskStatus } from '../../api/types';

export const pausedSummaryTaskIds = (
  nodes: Iterable<{ readonly id: string; readonly status: TaskStatus }>,
  pausedTaskIds: ReadonlySet<string>,
): Set<string> => {
  const eligible = new Set<string>();
  for (const node of nodes) {
    if (node.status !== 'done' && pausedTaskIds.has(node.id)) eligible.add(node.id);
  }
  return eligible;
};
