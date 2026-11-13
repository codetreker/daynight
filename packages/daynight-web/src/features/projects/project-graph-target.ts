import type { GraphIndex } from '../task-graph/model';

export type ProjectGraphTarget = {
  readonly kind: 'chain';
  readonly witnessTaskId: string;
  readonly rootId: string;
};

export const resolveProjectGraphTarget = (witness: string | null, index: GraphIndex | null): ProjectGraphTarget | null => {
  if (witness === null || index === null || index.nodes.get(witness)?.type !== 'task') return null;
  const rootId = index.componentByTask.get(witness);
  if (rootId === undefined || (index.components.get(rootId)?.memberIds.size ?? 0) <= 1) return null;
  return { kind: 'chain', witnessTaskId: witness, rootId };
};
