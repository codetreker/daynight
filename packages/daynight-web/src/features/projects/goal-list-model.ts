import type { GraphIndex } from '../task-graph/model';
import type { TaskScope } from '../task-graph/scope';
import { scopedChainProgress, type ScopedChainProgress } from '../task-graph/scoped-chain-progress';
import { compareTaskStatus } from './task-order';
import { timestampNanoseconds } from '../../time/timestamp';

export type GoalChainItem = {
  readonly representativeId: string;
  readonly memberIds: readonly string[];
  readonly progress: ScopedChainProgress;
};

export type GoalListContents = {
  readonly standaloneIds: readonly string[];
  readonly chains: readonly GoalChainItem[];
};

export const goalListContents = (scope: TaskScope, index: GraphIndex): GoalListContents => {
  const compareCreated = (left: string, right: string) => {
    const leftTime = timestampNanoseconds(index.nodes.get(left)!.createdAt);
    const rightTime = timestampNanoseconds(index.nodes.get(right)!.createdAt);
    return leftTime > rightTime ? -1 : leftTime < rightTime ? 1 : (left < right ? 1 : left > right ? -1 : 0);
  };
  const standaloneIds = scope.standaloneIds.toSorted((left, right) =>
    compareTaskStatus(index.nodes.get(left)!.status, index.nodes.get(right)!.status) || compareCreated(left, right));
  const chains = scope.chains.map((chain) => ({ ...chain, progress: scopedChainProgress(index, chain.memberIds) }))
    .toSorted((left, right) => compareTaskStatus(left.progress.status, right.progress.status) || compareCreated(left.representativeId, right.representativeId));
  return { standaloneIds, chains };
};
