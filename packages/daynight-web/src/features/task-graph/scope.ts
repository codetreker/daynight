import type { GraphIndex } from './model';

export type ScopedChain = {
  readonly representativeId: string;
  readonly memberIds: readonly string[];
};

export type TaskScope = {
  readonly chains: readonly ScopedChain[];
  readonly standaloneIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly progress: { readonly total: number; readonly done: number; readonly cancelled: number; readonly unfinished: number };
};

// Classify against the complete ordinary graph before selecting a Parent scope.
export const projectTaskScope = (index: GraphIndex, parentId: string | null): TaskScope => {
  const taskIds = [...index.nodes.values()].filter((task) => task.parentId === parentId).map((task) => task.id);
  const membersByChain = new Map<string, string[]>();
  const standaloneIds: string[] = [];
  let done = 0;
  let cancelled = 0;
  for (const id of taskIds) {
    const task = index.nodes.get(id)!;
    if (task.status === 'done') done++;
    else if (task.status === 'cancelled') cancelled++;
    const representativeId = index.componentByTask.get(id)!;
    if (index.components.get(representativeId)!.memberIds.size === 1) standaloneIds.push(id);
    else {
      const members = membersByChain.get(representativeId) ?? [];
      members.push(id);
      membersByChain.set(representativeId, members);
    }
  }
  const chains = index.representativeIds.filter((id) => membersByChain.has(id))
    .map((representativeId) => ({ representativeId, memberIds: membersByChain.get(representativeId)! }));
  return { chains, standaloneIds, taskIds, progress: { total: taskIds.length, done, cancelled, unfinished: taskIds.length - done - cancelled } };
};
