import { act, fireEvent, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphTask, TaskGraph, TaskStatus } from "../src/api/types";
import { ProjectOverview } from "../src/features/projects/ProjectOverview";
import { overviewProgress } from "../src/features/projects/overview-progress";
import { recentTaskWindow, timestampNanoseconds } from "../src/features/projects/task-visibility";
import { useOverviewProgress } from "../src/features/projects/useOverviewProgress";
import type { GraphSnapshot } from "../src/features/projects/useTaskGraph";
import { buildGraphIndex } from "../src/features/task-graph/model";
import { renderWithLocale } from "./helpers/renderWithLocale";

const localDate = (day: number, hour = 0): string => new Date(2026, 9, day, hour).toISOString();
const observedAt = localDate(26, 12).replace(".000Z", ".123456789Z");
const cutoff = localDate(20);
const beforeCutoff = new Date(Date.parse(cutoff) - 1_000).toISOString().replace(".000Z", ".999999999Z");
type Seed = { readonly id: string; readonly status: TaskStatus; readonly completedAt?: string | null;
  readonly dependsOn?: readonly string[]; readonly externalDependsOn?: readonly string[]; readonly titleTruncated?: boolean };
const snapshot = (seeds: readonly Seed[], observed = observedAt): Extract<GraphSnapshot, { observedAt: string }> => {
  const tasks: GraphTask[] = seeds.map((seed) => {
    const dependsOn = seed.dependsOn === undefined ? [] : seed.dependsOn;
    const blockedBy = dependsOn.filter((id) => seeds.find((task) => task.id === id)!.status !== "done");
    return { id: seed.id, titlePreview: `Title ${seed.id}`, titleTruncated: seed.titleTruncated === true, status: seed.status,
      dependsOn, externalDependsOn: seed.externalDependsOn === undefined ? [] : seed.externalDependsOn, blockedBy,
      ready: seed.status === "todo" && blockedBy.length === 0, allowAgents: false, requiredPlatform: null,
      startedAt: null, completedAt: seed.completedAt === undefined ? null : seed.completedAt, createdAt: beforeCutoff, updatedAt: observed };
  });
  const graph: TaskGraph = { observedAt: observed,
    project: { id: "project", name: "Project", repoUrl: "https://example.com/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: cutoff, updatedAt: observed },
    tasks, summary: { total: tasks.length, todo: tasks.filter((task) => task.status === "todo").length,
      inProgress: tasks.filter((task) => task.status === "in_progress").length, done: tasks.filter((task) => task.status === "done").length,
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.ready === false && task.status === "todo").length } };
  return { graph, index: buildGraphIndex(graph), observedAt: observed, receivedMonotonic: 0, receivedAt: 0, revision: 1 };
};
const categories = ({ index }: GraphSnapshot) => ({
  chainIds: index.representativeIds.toReversed().filter((id) => index.components.get(id)!.memberIds.size > 1),
  standaloneIds: index.representativeIds.toReversed().filter((id) => index.components.get(id)!.memberIds.size === 1),
});
const project = (value: GraphSnapshot, now = timestampNanoseconds(value.graph.observedAt)) => {
  const { chainIds, standaloneIds } = categories(value);
  return overviewProgress(value.index, chainIds, standaloneIds, now);
};
const mixed = (): GraphSnapshot => snapshot([
  { id: "root", status: "done", titleTruncated: true },
  { id: "left", status: "todo", dependsOn: ["root"] },
  { id: "right", status: "todo", dependsOn: ["root"] },
  { id: "shared", status: "todo", dependsOn: ["left", "right"] },
  { id: "finished", status: "done" },
  { id: "finished-child", status: "done", dependsOn: ["finished"] },
  { id: "todo", status: "todo" }, { id: "running", status: "in_progress" },
  { id: "external", status: "todo", dependsOn: ["finished"], externalDependsOn: ["finished"] },
  { id: "recent", status: "done", completedAt: localDate(25, 12) },
  { id: "boundary", status: "done", completedAt: cutoff },
  { id: "old", status: "done", completedAt: beforeCutoff },
  { id: "unknown", status: "done" },
]);

const presentation = (value: GraphSnapshot) => {
  const progress = project(value);
  const total = progress.chains.length + (progress.standalone === null ? 0 : 1);
  return { snapshot: value, progress, pagination: { page: 1, pageCount: Math.max(1, Math.ceil(total / 20)), total,
    start: total === 0 ? 0 : 1, end: Math.min(total, 20), onPageChange: () => {} } };
};

describe("overview and task-list visibility", () => {
  it.each<[{ statuses: TaskStatus[]; expected: TaskStatus }]>([
    [{ statuses: ["todo"], expected: "todo" }],
    [{ statuses: ["todo", "todo"], expected: "todo" }],
    [{ statuses: ["in_progress", "todo"], expected: "in_progress" }],
    [{ statuses: ["done", "todo"], expected: "in_progress" }],
    [{ statuses: ["done", "in_progress"], expected: "in_progress" }],
    [{ statuses: ["done", "done"], expected: "done" }],
  ])("derives standalone aggregate status from the complete recent set: $statuses", ({ statuses, expected }) => {
    const value = snapshot(statuses.map((status, position) => ({ id: String(position), status, completedAt: status === "done" ? observedAt : null })));
    expect(project(value).standalone?.status).toBe(expected);
  });

  it("keeps unfinished components whole and derives the same standalone row set used by its aggregate", () => {
    const result = project(mixed());
    expect(result.chains).toEqual([{ taskId: "root", title: "Title root", titleTruncated: true, done: 1, total: 4, percent: 25, status: "in_progress" }]);
    expect(result.standalone).toEqual({ done: 2, total: 5, percent: 40, status: "in_progress" });
    expect(result.recentStandaloneIds).toEqual(["boundary", "recent", "external", "running", "todo"]);
    expect(result.nextUpdateAt).toBe(timestampNanoseconds(localDate(27)));
  });

  it("includes the sixth previous local midnight exactly and waits for future completion facts", () => {
    const future = observedAt.replace("789Z", "790Z");
    const value = snapshot([{ id: "todo", status: "todo" }, { id: "boundary", status: "done", completedAt: cutoff },
      { id: "old", status: "done", completedAt: beforeCutoff }, { id: "future", status: "done", completedAt: future }, { id: "unknown", status: "done" }]);
    const now = timestampNanoseconds(observedAt);
    expect(project(value, now).standalone).toEqual({ done: 1, total: 2, percent: 50, status: "in_progress" });
    expect(project(value, now).nextUpdateAt).toBe(now + 1n);
    expect(project(value, now + 1n).standalone).toEqual({ done: 2, total: 3, percent: 66, status: "in_progress" });
    expect(project(value, timestampNanoseconds(localDate(27))).recentStandaloneIds).toEqual(["future", "todo"]);
  });

  it("shows a fully complete recent standalone aggregate and excludes all-unknown or old completed inventory", () => {
    expect(project(snapshot([{ id: "done", status: "done", completedAt: observedAt }]))).toEqual({ chains: [],
      standalone: { done: 1, total: 1, percent: 100, status: "done" }, recentStandaloneIds: ["done"], nextUpdateAt: timestampNanoseconds(localDate(27)) });
    expect(project(snapshot([{ id: "unknown", status: "done" }, { id: "old", status: "done", completedAt: beforeCutoff }])).standalone).toBeNull();
  });

  it("uses the latest ordinary member completion including the representative and keeps historical null facts unknown", () => {
    const value = snapshot([
      { id: "recent-root", status: "done", completedAt: localDate(25) },
      { id: "old-child", status: "done", completedAt: beforeCutoff, dependsOn: ["recent-root"] },
      { id: "unknown-root", status: "done" },
      { id: "recent-child", status: "done", completedAt: cutoff, dependsOn: ["unknown-root"] },
      { id: "old-root", status: "done", completedAt: beforeCutoff },
      { id: "unknown-child", status: "done", dependsOn: ["old-root"] },
      { id: "all-unknown-root", status: "done" },
      { id: "all-unknown-child", status: "done", dependsOn: ["all-unknown-root"] },
    ]);
    expect(project(value).chains.map(({ taskId, done, total }) => ({ taskId, done, total }))).toEqual([
      { taskId: "unknown-root", done: 2, total: 2 }, { taskId: "recent-root", done: 2, total: 2 },
    ]);
    expect(project(value, timestampNanoseconds(localDate(27))).chains.map(({ taskId }) => taskId)).toEqual(["recent-root"]);
  });

  it("excludes recent external prerequisites from an old Goal's completion and includes a reopened Goal", () => {
    const completed = snapshot([
      { id: "external", status: "done", completedAt: observedAt },
      { id: "root", status: "done", completedAt: beforeCutoff, dependsOn: ["external"], externalDependsOn: ["external"] },
      { id: "child", status: "done", completedAt: beforeCutoff, dependsOn: ["root"] },
    ]);
    expect(project(completed).chains).toEqual([]);
    expect(project(completed).recentStandaloneIds).toEqual(["external"]);
    const reopened = snapshot([
      { id: "root", status: "done", completedAt: beforeCutoff },
      { id: "child", status: "todo", dependsOn: ["root"] },
    ]);
    expect(project(reopened).chains).toEqual([{ taskId: "root", title: "Title root", titleTruncated: false, done: 1, total: 2, percent: 50, status: "in_progress" }]);
    expect(project(reopened).nextUpdateAt).toBeNull();
  });

  it("floors partial percentages and preserves the full task-list order", () => {
    const value = snapshot([{ id: "older", status: "done" }, { id: "older-child", status: "todo", dependsOn: ["older"] },
      { id: "newer", status: "done" }, { id: "newer-child", status: "done", dependsOn: ["newer"] },
      { id: "newer-last", status: "todo", dependsOn: ["newer-child"] }]);
    expect(project(value).chains.map(({ taskId, percent }) => ({ taskId, percent })))
      .toEqual([{ taskId: "newer", percent: 66 }, { taskId: "older", percent: 50 }]);
  });
});

describe("shared local calendar clock", () => {
  const midnight = new Date(2026, 9, 27).getTime();
  const expiring = () => snapshot([
    { id: "root", status: "done" }, { id: "child", status: "done", completedAt: cutoff, dependsOn: ["root"] },
    { id: "todo", status: "todo" }, { id: "done", status: "done", completedAt: cutoff },
  ], new Date(midnight - 1).toISOString());

  it("supports initial loading without conditional hooks or timers", () => {
    const { result, rerender, unmount } = renderHook(({ value }: { value: GraphSnapshot | null }) => useOverviewProgress(value, [], [], true), { initialProps: { value: null as GraphSnapshot | null } });
    expect(result.current).toEqual({ chains: [], standalone: null, recentStandaloneIds: [], nextUpdateAt: null });
    rerender({ value: snapshot([]) });
    expect(result.current.recentStandaloneIds).toEqual([]);
    unmount();
  });

  it("uses the cached display's local reference until a server receipt reanchors the calendar", () => {
    vi.useFakeTimers(); vi.spyOn(performance, "now").mockReturnValue(0);
    const live = snapshot([{ id: "todo", status: "todo" }, { id: "done", status: "done", completedAt: localDate(25) }]);
    const cached: GraphSnapshot = { ...live, observedAt: null, receivedAt: null, revision: 0, localTime: new Date(2026, 10, 2, 12).getTime() };
    const { chainIds, standaloneIds } = categories(live);
    const { result, rerender, unmount } = renderHook(({ value }: { value: GraphSnapshot }) => useOverviewProgress(value, chainIds, standaloneIds, true), { initialProps: { value: cached as GraphSnapshot } });
    expect(result.current.standalone).toEqual({ done: 0, total: 1, percent: 0, status: "todo" });
    rerender({ value: live });
    expect(result.current.standalone).toEqual({ done: 1, total: 2, percent: 50, status: "in_progress" });
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("expires Goal and standalone completions at local midnight without a new snapshot or browser wall clock", () => {
    vi.useFakeTimers(); let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now").mockReturnValue(new Date(2055, 0, 1).getTime());
    const value = expiring(); const { chainIds, standaloneIds } = categories(value);
    const { result, unmount } = renderHook(() => useOverviewProgress(value, chainIds, standaloneIds, true));
    expect(result.current.chains).toHaveLength(1);
    expect(result.current.recentStandaloneIds).toEqual(["done", "todo"]);
    act(() => { monotonic = 1; vi.advanceTimersByTime(1); });
    expect(result.current.chains).toEqual([]);
    expect(result.current.standalone).toEqual({ done: 0, total: 1, percent: 0, status: "todo" });
    expect(result.current.recentStandaloneIds).toEqual(["todo"]);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("recomputes after visibility and section changes and cleans up the midnight deadline", () => {
    vi.useFakeTimers(); let monotonic = 0; let visible = false;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
    const value = expiring(); const { chainIds, standaloneIds } = categories(value);
    const { result, rerender, unmount } = renderHook(({ active }) => useOverviewProgress(value, chainIds, standaloneIds, active), { initialProps: { active: true } });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { monotonic = 1; visible = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.chains).toEqual([]);
    expect(result.current.standalone?.done).toBe(0);
    monotonic = 0; rerender({ active: false }); expect(vi.getTimerCount()).toBe(0);
    rerender({ active: true }); expect(vi.getTimerCount()).toBe(1);
    act(() => { visible = false; document.dispatchEvent(new Event("visibilitychange")); }); expect(vi.getTimerCount()).toBe(0);
    act(() => { visible = true; document.dispatchEvent(new Event("visibilitychange")); }); expect(vi.getTimerCount()).toBe(1);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("reanchors unchanged data and schedules the following local midnight only when there are known completed facts", () => {
    vi.useFakeTimers(); vi.spyOn(performance, "now").mockReturnValue(0);
    const first = expiring(); const { chainIds, standaloneIds } = categories(first);
    const { result, rerender, unmount } = renderHook(({ value }) => useOverviewProgress(value, chainIds, standaloneIds, true), { initialProps: { value: first } });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ value: { ...first, observedAt: new Date(midnight).toISOString() } });
    expect(result.current.standalone?.done).toBe(0);
    expect(result.current.nextUpdateAt).toBe(recentTaskWindow(BigInt(midnight) * 1_000_000n).nextMidnight);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    const absent = renderHook(() => useOverviewProgress(snapshot([{ id: "unknown", status: "done" }]), [], ["unknown"], true));
    expect(vi.getTimerCount()).toBe(0); absent.unmount();
  });
});

describe("project overview progress presentation", () => {
  it("offers both navigation targets, explains the recent scope, and keeps project statistics complete in both languages", () => {
    const value = mixed(); const onNavigate = vi.fn();
    const view = renderWithLocale(<ProjectOverview {...presentation(value)} onNavigate={onNavigate} />, { locale: "zh-CN" });
    const region = screen.getByRole("region", { name: "整体进度" });
    const buttons = within(region).getAllByRole("button");
    expect(buttons).toHaveLength(2); expect(buttons[0]).toHaveTextContent("Title root…");
    expect(buttons[0]).toHaveAttribute("data-task-status", "in_progress");
    expect(buttons[1]).toHaveAttribute("data-task-status", "in_progress");
    expect(buttons[1]).toHaveTextContent("2 / 5"); expect(buttons[1]).toHaveTextContent("40%");
    fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!);
    expect(onNavigate.mock.calls).toEqual([[{ kind: "chain", taskId: "root" }], [{ kind: "standalone" }]]);
    expect(screen.getByText("任务总数").parentElement).toHaveTextContent("13");
    view.setLocale("en");
    expect(screen.getByRole("region", { name: "Overall progress" })).toHaveTextContent("2 / 5");
  });

  it("shows recent work at 100% and reserves empty presentation for no currently eligible rows", () => {
    const view = renderWithLocale(<ProjectOverview {...presentation(snapshot([]))} onNavigate={vi.fn()} />, { locale: "zh-CN" });
    expect(screen.getByRole("heading", { name: "还没有任务" })).toBeTruthy();
    view.rerender(<ProjectOverview {...presentation(snapshot([{ id: "done", status: "done", completedAt: observedAt }]))} onNavigate={vi.fn()} />);
    expect(screen.getByRole("region", { name: "整体进度" })).toHaveTextContent("100%");
    expect(document.querySelector(".overview-progress-row")).toHaveAttribute("data-task-status", "done");
    view.rerender(<ProjectOverview {...presentation(snapshot([{ id: "old", status: "done", completedAt: beforeCutoff }]))} onNavigate={vi.fn()} />);
    expect(within(screen.getByRole("region", { name: "整体进度" })).queryByRole("button")).toBeNull();
  });
});
