import type { TaskDetail } from "../../api/types";
import { timestampNanoseconds } from "../../time/timestamp";
import { GraphDataError, type GraphIndex } from "../task-graph/model";

export type CompletionTask = Pick<TaskDetail, "status" | "completedAt">;

export const completedAtFor = (task: CompletionTask): string | null =>
  task.status === "done" ? task.completedAt : null;

export const latestScopedCompletion = (index: GraphIndex, memberIds: readonly string[]): string | null => {
  if (memberIds.length === 0) return null;
  let latest: string | null = null;
  let latestNanos: bigint | null = null;
  let incomplete = false;
  for (const id of memberIds) {
    const task = index.nodes.get(id);
    if (task === undefined) throw new GraphDataError();
    const completedAt = completedAtFor(task);
    if (completedAt === null) {
      incomplete = true;
      continue;
    }
    const nanos = timestampNanoseconds(completedAt);
    if (latestNanos === null || nanos > latestNanos) {
      latest = completedAt;
      latestNanos = nanos;
    }
  }
  return incomplete ? null : latest;
};

export type CompletionReading =
  | { readonly kind: "justNow" }
  | { readonly kind: "relative"; readonly unit: "minute" | "hour" | "day"; readonly value: number }
  | { readonly kind: "absolute"; readonly includeYear: boolean };

const minute = 60_000_000_000n;
const hour = 60n * minute;
const day = 24n * hour;

// Date accepts milliseconds; floor negative values so the local year stays correct at boundaries.
const localYear = (nanos: bigint): number =>
  new Date(Number(nanos >= 0n ? nanos / 1_000_000n : (nanos - 999_999n) / 1_000_000n)).getFullYear();

export const completionReading = (completedAt: bigint, now: bigint): CompletionReading => {
  const elapsed = now > completedAt ? now - completedAt : 0n;
  if (elapsed < minute) return { kind: "justNow" };
  if (elapsed < hour) return { kind: "relative", unit: "minute", value: Number(elapsed / minute) };
  if (elapsed < day) return { kind: "relative", unit: "hour", value: Number(elapsed / hour) };
  if (elapsed < 7n * day) return { kind: "relative", unit: "day", value: Number(elapsed / day) };
  return { kind: "absolute", includeYear: localYear(completedAt) !== localYear(now) };
};
