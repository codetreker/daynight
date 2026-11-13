import type { TaskSummary } from '../../api/types';
import type { GraphIndex } from '../task-graph/model';

export type ProjectGraphTarget = {
  readonly kind: 'chain';
  readonly witnessTaskId: string;
  readonly rootId: string;
} | { readonly kind: 'goal'; readonly goalId: string };

export const resolveProjectGraphTarget = (witness: string | null, index: GraphIndex | null, summaries?: ReadonlyMap<string, TaskSummary>): ProjectGraphTarget | null => {
  if (witness === null || index === null) return null;
  if (summaries?.get(witness)?.type === 'goal') return { kind: 'goal', goalId: witness };
  if (index.nodes.get(witness)?.type !== 'task') return null;
  const rootId = index.componentByTask.get(witness);
  if (rootId === undefined || (index.components.get(rootId)?.memberIds.size ?? 0) <= 1) return null;
  return { kind: 'chain', witnessTaskId: witness, rootId };
};
