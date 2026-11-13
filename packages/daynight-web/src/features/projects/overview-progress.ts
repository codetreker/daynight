import { isTerminalStatus, taskEndedAt, taskProgressStatus, type TaskProgressStatus } from "../../api/task-status";
import { completionProgress } from '../task-graph/completion-progress';
import type { GraphIndex } from "../task-graph/model";
import { isRecentCompletion, latestKnownGoalCompletion, recentTaskWindow } from "./task-visibility";
import { timestampNanoseconds } from "../../time/timestamp";

export type OverviewTaskTarget = { readonly kind: "chain"; readonly taskId: string } | { readonly kind: "standalone" };
export type OverviewProgressCount = { readonly done: number; readonly cancelled: number; readonly ended: number; readonly total: number; readonly percent: number; readonly status: TaskProgressStatus };
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

const count = (done: number, cancelled: number, total: number, status: TaskProgressStatus): OverviewProgressCount =>
  ({ done, cancelled, ended: done + cancelled, total, percent: completionProgress({ done, cancelled, total }).percent, status });

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
    if (progress.ended === progress.total) {
      const completed = latestKnownGoalCompletion(index, taskId);
      observeCompletion(completed);
      if (!isRecentCompletion(completed, window)) return [];
    }
    const task = index.nodes.get(taskId)!;
    return [{ taskId, title: task.titlePreview, titleTruncated: task.titleTruncated, ...count(progress.done, progress.cancelled, progress.total, progress.status) }];
  });
  let done = 0;
  let cancelled = 0;
  let proposed = 0;
  let inProgress = false;
  const recentStandaloneIds = standaloneIds.filter((id) => {
    const task = index.nodes.get(id)!;
    if (!isTerminalStatus(task.status)) {
      if (task.status === "in_progress") inProgress = true;
      else if (task.status === "proposed") proposed++;
      return true;
    }
    const endedAt = taskEndedAt(task);
    const completed = endedAt === null ? null : timestampNanoseconds(endedAt);
    observeCompletion(completed);
    if (!isRecentCompletion(completed, window)) return false;
    if (task.status === "done") done++;
    else cancelled++;
    return true;
  });
  const total = recentStandaloneIds.length;
  const status = taskProgressStatus(done, cancelled, total, inProgress, proposed);
  return { chains, standalone: total === 0 ? null : count(done, cancelled, total, status), recentStandaloneIds, nextUpdateAt };
};
