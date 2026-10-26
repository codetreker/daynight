import type { GraphIndex } from "../task-graph/model";

export type OverviewTaskTarget = { readonly kind: "chain"; readonly taskId: string } | { readonly kind: "standalone" };
export type OverviewProgressCount = { readonly done: number; readonly total: number; readonly percent: number };
export type OverviewChainProgress = OverviewProgressCount & {
  readonly taskId: string;
  readonly title: string;
  readonly titleTruncated: boolean;
};
export type OverviewProgress = {
  readonly chains: readonly OverviewChainProgress[];
  readonly standalone: OverviewProgressCount | null;
  readonly nextUpdateAt: bigint | null;
};

const week = 7n * 24n * 60n * 60n * 1_000_000_000n;

// API timestamps retain nanoseconds; truncating them would change the inclusive seven-day boundary.
export const overviewTimestamp = (value: string): bigint => BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1_000_000n +
  BigInt((value[19] === "." ? value.slice(20, -1) : "").padEnd(9, "0"));

const count = (done: number, total: number): OverviewProgressCount => ({ done, total, percent: Math.floor(done * 100 / total) });

export const overviewProgress = (index: GraphIndex, chainIds: readonly string[], standaloneIds: readonly string[], now: bigint): OverviewProgress => {
  const chains = chainIds.flatMap((taskId): OverviewChainProgress[] => {
    const progress = index.components.get(taskId)!.progress;
    if (progress.status === "done") return [];
    const task = index.nodes.get(taskId)!;
    return [{ taskId, title: task.titlePreview, titleTruncated: task.titleTruncated, ...count(progress.done, progress.total) }];
  });
  const standaloneTasks = standaloneIds.map((id) => index.nodes.get(id)!);
  const unfinished = standaloneTasks.filter((task) => task.status !== "done").length;
  if (unfinished === 0) return { chains, standalone: null, nextUpdateAt: null };

  let done = 0;
  let nextUpdateAt: bigint | null = null;
  const boundary = (value: bigint) => { if (nextUpdateAt === null || value < nextUpdateAt) nextUpdateAt = value; };
  for (const task of standaloneTasks) {
    if (task.status !== "done" || task.completedAt === null) continue;
    const completed = overviewTimestamp(task.completedAt);
    if (completed > now) boundary(completed);
    else if (completed + week >= now) {
      done++;
      boundary(completed + week + 1n);
    }
  }
  return { chains, standalone: count(done, unfinished + done), nextUpdateAt };
};
