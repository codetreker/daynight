import type { GraphIndex } from "../task-graph/model";

export type RecentTaskWindow = {
  readonly now: bigint;
  readonly start: bigint;
  readonly nextMidnight: bigint;
};

// Sub-millisecond facts must remain distinct at a local calendar boundary.
export const timestampNanoseconds = (value: string): bigint => BigInt(Date.parse(`${value.slice(0, 19)}Z`)) * 1_000_000n +
  BigInt((value[19] === "." ? value.slice(20, -1) : "").padEnd(9, "0"));

export const recentTaskWindow = (now: bigint): RecentTaskWindow => {
  const date = new Date(Number(now / 1_000_000n));
  // Carrying the current hour into a DST gap can normalize the intended date into the following day.
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 6);
  const nextMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { now, start: BigInt(start.getTime()) * 1_000_000n, nextMidnight: BigInt(nextMidnight.getTime()) * 1_000_000n };
};

export const isRecentCompletion = (completedAt: bigint | null, window: RecentTaskWindow): boolean =>
  completedAt !== null && completedAt >= window.start && completedAt <= window.now;

export const latestKnownGoalCompletion = (index: GraphIndex, taskId: string): bigint | null => {
  let latest: bigint | null = null;
  for (const id of index.components.get(taskId)!.memberIds) {
    const completedAt = index.nodes.get(id)!.completedAt;
    if (completedAt === null) continue;
    const completed = timestampNanoseconds(completedAt);
    if (latest === null || completed > latest) latest = completed;
  }
  return latest;
};
