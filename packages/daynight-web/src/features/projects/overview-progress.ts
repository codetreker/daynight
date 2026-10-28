import type { TaskStatus } from "../../api/types";
import type { GraphIndex } from "../task-graph/model";
import { isRecentCompletion, latestKnownGoalCompletion, recentTaskWindow, timestampNanoseconds } from "./task-visibility";

export type OverviewTaskTarget = { readonly kind: "chain"; readonly taskId: string } | { readonly kind: "standalone" };
export type OverviewProgressCount = { readonly done: number; readonly total: number; readonly percent: number; readonly status: TaskStatus };
export type OverviewChainProgress = OverviewProgressCount & {
  readonly taskId: string;
  readonly title: string;
  readonly titleTruncated: boolean;
};
export type OverviewProgress = {
  readonly chains: readonly OverviewChainProgress[];
  readonly standalone: OverviewProgressCount | null;
  readonly recentStandaloneIds: readonly string[];
  readonly nextUpdateAt: bigint | null;
};

const count = (done: number, total: number, status: TaskStatus): OverviewProgressCount => ({ done, total, percent: Math.floor(done * 100 / total), status });

export const overviewProgress = (index: GraphIndex, chainIds: readonly string[], standaloneIds: readonly string[], now: bigint): OverviewProgress => {
  const window = recentTaskWindow(now);
  let nextUpdateAt: bigint | null = null;
  const observeCompletion = (completed: bigint | null) => {
    if (completed === null) return;
    const boundary = completed > now && completed < window.nextMidnight ? completed : window.nextMidnight;
    if (nextUpdateAt === null || boundary < nextUpdateAt) nextUpdateAt = boundary;
  };
  const chains = chainIds.flatMap((taskId): OverviewChainProgress[] => {
    const progress = index.components.get(taskId)!.progress;
    if (progress.status === "done") {
      const completed = latestKnownGoalCompletion(index, taskId);
      observeCompletion(completed);
      if (!isRecentCompletion(completed, window)) return [];
    }
    const task = index.nodes.get(taskId)!;
    return [{ taskId, title: task.titlePreview, titleTruncated: task.titleTruncated, ...count(progress.done, progress.total, progress.status) }];
  });
  let done = 0;
  let inProgress = false;
  const recentStandaloneIds = standaloneIds.filter((id) => {
    const task = index.nodes.get(id)!;
    if (task.status !== "done") {
      if (task.status === "in_progress") inProgress = true;
      return true;
    }
    const completed = task.completedAt === null ? null : timestampNanoseconds(task.completedAt);
    observeCompletion(completed);
    if (!isRecentCompletion(completed, window)) return false;
    done++;
    return true;
  });
  const total = recentStandaloneIds.length;
  const status = done === total ? "done" : done > 0 || inProgress ? "in_progress" : "todo";
  return { chains, standalone: total === 0 ? null : count(done, total, status), recentStandaloneIds, nextUpdateAt };
};
