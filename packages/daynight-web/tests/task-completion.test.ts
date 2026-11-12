import { describe, expect, it } from "vitest";
import type { GraphTask, TaskStatus } from "../src/api/types";
import { formatCompletionLabel } from "../src/features/task-completion/format";
import { completedAtFor, completionReading, latestScopedCompletion } from "../src/features/task-completion/model";
import { GraphDataError, type GraphIndex } from "../src/features/task-graph/model";
import { timestampNanoseconds } from "../src/time/timestamp";

const stamp = "2026-10-22T19:08:06.123456789Z";
const task = (status: TaskStatus, completedAt: string | null) => ({ status, completedAt });
const index = (entries: Record<string, ReturnType<typeof task>>): GraphIndex => ({
  nodes: new Map(Object.entries(entries).map(([id, value]): [string, GraphTask] => [id, {
    id, type: "task", parentId: null, titlePreview: id, titleTruncated: false, ...value,
    dependsOn: [], externalDependsOn: [], blockedBy: [], ready: value.status === "todo", allowAgents: false,
    assignedTo: null, requiredPlatform: null, startedAt: null, cancelledAt: null, createdAt: stamp, updatedAt: stamp,
  }])),
  successors: new Map(), representativeIds: [], components: new Map(), componentByTask: new Map(),
});

describe("completion facts", () => {
  it.each(["proposed", "todo", "in_progress", "cancelled"] as const)("hides retained completion for %s", (status) => {
    expect(completedAtFor(task(status, stamp))).toBeNull();
  });

  it("uses the current task or Goal's own completion even without a start time", () => {
    expect(completedAtFor(task("done", stamp))).toBe(stamp);
    expect(completedAtFor(task("done", null))).toBeNull();
  });

  it("aggregates exactly the supplied scope with nanosecond precision", () => {
    const earlier = "2026-10-22T19:08:06.123456788Z";
    const later = "2026-10-22T19:08:06.123456790Z";
    const graph = index({ a: task("done", stamp), b: task("done", earlier), external: task("done", later), open: task("todo", null), unknown: task("done", null) });
    expect(latestScopedCompletion(graph, ["a", "b"])).toBe(stamp);
    expect(latestScopedCompletion(graph, ["b", "external"])).toBe(later);
    expect(latestScopedCompletion(graph, [])).toBeNull();
    expect(latestScopedCompletion(graph, ["a", "open"])).toBeNull();
    expect(latestScopedCompletion(graph, ["a", "unknown"])).toBeNull();
    expect(() => latestScopedCompletion(graph, ["open", "missing"])).toThrow(GraphDataError);
  });
});

describe("completion readings", () => {
  const completed = timestampNanoseconds("2026-06-01T00:00:00Z");
  const minute = 60_000_000_000n;
  const hour = 60n * minute;
  const day = 24n * hour;
  it.each([
    [minute - 1n, { kind: "justNow" }],
    [minute, { kind: "relative", unit: "minute", value: 1 }],
    [hour - 1n, { kind: "relative", unit: "minute", value: 59 }],
    [hour, { kind: "relative", unit: "hour", value: 1 }],
    [day - 1n, { kind: "relative", unit: "hour", value: 23 }],
    [day, { kind: "relative", unit: "day", value: 1 }],
    [7n * day - 1n, { kind: "relative", unit: "day", value: 6 }],
    [7n * day, { kind: "absolute", includeYear: false }],
  ])("selects and floors the bucket at %s nanoseconds", (elapsed, expected) => {
    expect(completionReading(completed, completed + elapsed)).toEqual(expected);
  });

  it("clamps a future completion for display without changing its fact", () => {
    expect(completionReading(completed, completed - 1n)).toEqual({ kind: "justNow" });
  });

  it("retains local calendar boundaries for pre-epoch values", () => {
    const fact = BigInt(new Date(1968, 11, 20, 12).getTime()) * 1_000_000n;
    const newYear = BigInt(new Date(1969, 0, 1).getTime()) * 1_000_000n;
    expect(completionReading(fact, newYear - 1n)).toEqual({ kind: "absolute", includeYear: false });
    expect(completionReading(fact, newYear)).toEqual({ kind: "absolute", includeYear: true });
  });

  it("uses the local year at the exact local new year", () => {
    const completedMs = new Date(2026, 11, 20, 12).getTime();
    const newYearMs = new Date(2027, 0, 1).getTime();
    const fact = BigInt(completedMs) * 1_000_000n;
    const now = BigInt(newYearMs) * 1_000_000n;
    expect(completionReading(fact, now - 1n)).toEqual({ kind: "absolute", includeYear: false });
    expect(completionReading(fact, now)).toEqual({ kind: "absolute", includeYear: true });
  });
});

describe("completion labels", () => {
  const date = new Date(2026, 9, 2, 19, 8, 6).toISOString();
  it.each([
    [{ kind: "justNow" }, "Completed just now", "刚刚完成"],
    [{ kind: "relative", unit: "minute", value: 1 }, "Completed 1 minute ago", "1 分钟前完成"],
    [{ kind: "relative", unit: "minute", value: 2 }, "Completed 2 minutes ago", "2 分钟前完成"],
    [{ kind: "relative", unit: "hour", value: 1 }, "Completed 1 hour ago", "1 小时前完成"],
    [{ kind: "relative", unit: "day", value: 6 }, "Completed 6 days ago", "6 天前完成"],
    [{ kind: "absolute", includeYear: false }, "Completed Oct 2, 19:08", "10-02 19:08 完成"],
    [{ kind: "absolute", includeYear: true }, "Completed Oct 2, 2026, 19:08", "2026-10-02 19:08 完成"],
  ] as const)("formats %o in both languages", (reading, en, zh) => {
    expect(formatCompletionLabel(reading, date, "en")).toBe(en);
    expect(formatCompletionLabel(reading, date, "zh-CN")).toBe(zh);
  });

  it.each(["en", "zh-CN"] as const)("rejects invalid dates in %s", (locale) => {
    expect(() => formatCompletionLabel({ kind: "absolute", includeYear: true }, "invalid", locale)).toThrow(RangeError);
  });

  it("uses 00 for midnight in both languages", () => {
    const midnight = new Date(2026, 0, 2, 0, 5).toISOString();
    expect(formatCompletionLabel({ kind: "absolute", includeYear: false }, midnight, "en")).toBe("Completed Jan 2, 00:05");
    expect(formatCompletionLabel({ kind: "absolute", includeYear: false }, midnight, "zh-CN")).toBe("01-02 00:05 完成");
  });
});
