import { act, fireEvent, renderHook, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphTask, TaskGraph, TaskStatus } from "../src/api/types";
import { ProjectOverview } from "../src/features/projects/ProjectOverview";
import { overviewProgress, overviewTimestamp } from "../src/features/projects/overview-progress";
import { useOverviewProgress } from "../src/features/projects/useOverviewProgress";
import type { GraphSnapshot } from "../src/features/projects/useTaskGraph";
import { buildGraphIndex } from "../src/features/task-graph/model";
import { renderWithLocale } from "./helpers/renderWithLocale";

const observedAt = "2026-10-26T12:00:00.123456789Z";
const cutoff = "2026-10-19T12:00:00.123456789Z";
type Seed = { readonly id: string; readonly status: TaskStatus; readonly completedAt?: string | null;
  readonly dependsOn?: readonly string[]; readonly externalDependsOn?: readonly string[]; readonly titleTruncated?: boolean };
const snapshot = (seeds: readonly Seed[], observed = observedAt): Extract<GraphSnapshot, { observedAt: string }> => {
  const tasks: GraphTask[] = seeds.map((seed) => {
    const dependsOn = seed.dependsOn === undefined ? [] : seed.dependsOn;
    const blockedBy = dependsOn.filter((id) => seeds.find((task) => task.id === id)!.status !== "done");
    return { id: seed.id, titlePreview: `Title ${seed.id}`, titleTruncated: seed.titleTruncated === true, status: seed.status,
      dependsOn, externalDependsOn: seed.externalDependsOn === undefined ? [] : seed.externalDependsOn, blockedBy,
      ready: seed.status === "todo" && blockedBy.length === 0, allowAgents: false, requiredPlatform: null,
      startedAt: null, completedAt: seed.completedAt === undefined ? null : seed.completedAt, createdAt: cutoff, updatedAt: observed };
  });
  const graph: TaskGraph = { observedAt: observed,
    project: { id: "project", name: "Project", repoUrl: "https://example.com/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: cutoff, updatedAt: observed },
    tasks, summary: { total: tasks.length, todo: tasks.filter((task) => task.status === "todo").length,
      inProgress: tasks.filter((task) => task.status === "in_progress").length, done: tasks.filter((task) => task.status === "done").length,
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.status === "todo" && !task.ready).length } };
  return { graph, index: buildGraphIndex(graph), observedAt: observed, receivedMonotonic: 0, receivedAt: 0, revision: 1 };
};
const categories = ({ index }: GraphSnapshot) => ({
  chainIds: index.representativeIds.toReversed().filter((id) => index.components.get(id)!.memberIds.size > 1),
  standaloneIds: index.representativeIds.toReversed().filter((id) => index.components.get(id)!.memberIds.size === 1),
});
const mixed = (): GraphSnapshot => snapshot([
  { id: "root", status: "done", titleTruncated: true },
  { id: "left", status: "todo", dependsOn: ["root"] },
  { id: "right", status: "todo", dependsOn: ["root"] },
  { id: "shared", status: "todo", dependsOn: ["left", "right"] },
  { id: "finished", status: "done" },
  { id: "finished-child", status: "done", dependsOn: ["finished"] },
  { id: "todo", status: "todo" }, { id: "running", status: "in_progress" },
  { id: "external", status: "todo", dependsOn: ["finished"], externalDependsOn: ["finished"] },
  { id: "recent", status: "done", completedAt: "2026-10-25T12:00:00Z" },
  { id: "boundary", status: "done", completedAt: cutoff },
  { id: "old", status: "done", completedAt: "2026-10-19T12:00:00.123456788Z" },
  { id: "unknown", status: "done" },
]);

describe("overview progress counting", () => {
  it("keeps unfinished components whole and counts every shared member once without external prerequisites", () => {
    const value = mixed(); const { chainIds, standaloneIds } = categories(value);
    const result = overviewProgress(value.index, chainIds, standaloneIds, overviewTimestamp(observedAt));
    expect(result.chains).toEqual([{ taskId: "root", title: "Title root", titleTruncated: true, done: 1, total: 4, percent: 25 }]);
    expect(result.standalone).toEqual({ done: 2, total: 5, percent: 40 });
    expect(result.nextUpdateAt).toBe(overviewTimestamp(observedAt) + 1n);
  });

  it("retains the inclusive nanosecond cutoff, excludes unknown completion dates, and schedules future completion entry", () => {
    const value = snapshot([{ id: "todo", status: "todo" }, { id: "boundary", status: "done", completedAt: cutoff },
      { id: "old", status: "done", completedAt: "2026-10-19T12:00:00.123456788Z" },
      { id: "future", status: "done", completedAt: "2026-10-26T12:00:00.123456790Z" }, { id: "unknown", status: "done" }]);
    const { chainIds, standaloneIds } = categories(value); const now = overviewTimestamp(observedAt);
    expect(overviewProgress(value.index, chainIds, standaloneIds, now).standalone).toEqual({ done: 1, total: 2, percent: 50 });
    expect(overviewProgress(value.index, chainIds, standaloneIds, now).nextUpdateAt).toBe(now + 1n);
    expect(overviewProgress(value.index, chainIds, standaloneIds, now + 1n).standalone).toEqual({ done: 1, total: 2, percent: 50 });
    expect(overviewTimestamp("2026-10-26T12:00:00Z")).toBe(overviewTimestamp("2026-10-26T12:00:00.000000000Z"));
    expect(overviewTimestamp("2026-10-26T12:00:00.1Z")).toBe(overviewTimestamp("2026-10-26T12:00:00.100000000Z"));
  });

  it("does not show a completed standalone bucket or schedule deadlines for it", () => {
    const value = snapshot([{ id: "done", status: "done", completedAt: observedAt }]); const { chainIds, standaloneIds } = categories(value);
    expect(overviewProgress(value.index, chainIds, standaloneIds, overviewTimestamp(observedAt)))
      .toEqual({ chains: [], standalone: null, nextUpdateAt: null });
  });

  it("floors partial percentages and keeps task chain ordering supplied by the task list", () => {
    const value = snapshot([{ id: "older", status: "done" }, { id: "older-child", status: "todo", dependsOn: ["older"] },
      { id: "newer", status: "done" }, { id: "newer-child", status: "done", dependsOn: ["newer"] },
      { id: "newer-last", status: "todo", dependsOn: ["newer-child"] }]);
    const { chainIds, standaloneIds } = categories(value);
    expect(overviewProgress(value.index, chainIds, standaloneIds, overviewTimestamp(observedAt)).chains.map(({ taskId, percent }) => ({ taskId, percent })))
      .toEqual([{ taskId: "newer", percent: 66 }, { taskId: "older", percent: 50 }]);
  });
});

describe("overview rolling completion window", () => {
  const expiring = () => snapshot([{ id: "todo", status: "todo" }, { id: "done", status: "done", completedAt: "2026-10-19T12:00:00.124456789Z" }]);

  it("uses the cached display's local reference until a server receipt reanchors the rolling window", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const live = snapshot([{ id: "todo", status: "todo" }, { id: "done", status: "done", completedAt: "2026-10-25T12:00:00Z" }]);
    const cached: GraphSnapshot = { ...live, observedAt: null, receivedAt: null, revision: 0, localTime: Date.parse("2026-11-02T12:00:00Z") };
    const { chainIds, standaloneIds } = categories(live);
    const { result, rerender, unmount } = renderHook(({ value }: { value: GraphSnapshot }) => useOverviewProgress(value, chainIds, standaloneIds, true), { initialProps: { value: cached as GraphSnapshot } });
    expect(result.current.standalone).toEqual({ done: 0, total: 1, percent: 0 });
    rerender({ value: live });
    expect(result.current.standalone).toEqual({ done: 1, total: 2, percent: 50 });
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("expires a completion after the exact boundary with an unchanged snapshot and no client wall-clock dependency", () => {
    vi.useFakeTimers(); let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2055-01-01T00:00:00Z"));
    const value = expiring(); const { chainIds, standaloneIds } = categories(value);
    const { result, unmount } = renderHook(() => useOverviewProgress(value, chainIds, standaloneIds, true));
    expect(result.current.standalone).toEqual({ done: 1, total: 2, percent: 50 });
    act(() => { monotonic = 1; vi.advanceTimersByTime(1); });
    expect(result.current.standalone?.done).toBe(1);
    act(() => { monotonic = 2; vi.advanceTimersByTime(1); });
    expect(result.current.standalone).toEqual({ done: 0, total: 1, percent: 0 });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("reconciles visibility and active-section returns and releases scheduled work", () => {
    vi.useFakeTimers(); let monotonic = 0; let visible = false;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
    const value = expiring(); const { chainIds, standaloneIds } = categories(value);
    const { result, rerender, unmount } = renderHook(({ active }) => useOverviewProgress(value, chainIds, standaloneIds, active), { initialProps: { active: true } });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { monotonic = 2; visible = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.standalone?.done).toBe(0);
    monotonic = 0; rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ active: true }); expect(vi.getTimerCount()).toBe(1);
    act(() => { visible = false; document.dispatchEvent(new Event("visibilitychange")); });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { visible = true; document.dispatchEvent(new Event("visibilitychange")); });
    expect(vi.getTimerCount()).toBe(1);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("reanchors new server receipts and has no scheduled work without an eligible standalone deadline", () => {
    vi.useFakeTimers(); vi.spyOn(performance, "now").mockReturnValue(0);
    const first = expiring(); const { chainIds, standaloneIds } = categories(first);
    const { result, rerender, unmount } = renderHook(({ value }) => useOverviewProgress(value, chainIds, standaloneIds, true), { initialProps: { value: first } });
    expect(vi.getTimerCount()).toBe(1);
    rerender({ value: { ...first, observedAt: "2026-10-26T12:00:00.125456789Z" } });
    expect(result.current.standalone?.done).toBe(0); expect(vi.getTimerCount()).toBe(0);
    unmount();
    const empty = snapshot([]); const ids = categories(empty);
    const absent = renderHook(() => useOverviewProgress(empty, ids.chainIds, ids.standaloneIds, true));
    expect(vi.getTimerCount()).toBe(0); absent.unmount();
  });
});

describe("project overview progress presentation", () => {
  it("offers both navigation targets, shows the recent scope, and keeps project statistics complete in both languages", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const value = mixed(); const ids = categories(value); const onNavigate = vi.fn();
    const view = renderWithLocale(<ProjectOverview snapshot={value} {...ids} active onNavigate={onNavigate} />, { locale: "zh-CN" });
    const region = screen.getByRole("region", { name: "整体进度" });
    const buttons = within(region).getAllByRole("button");
    expect(buttons).toHaveLength(2); expect(buttons[0]).toHaveTextContent("Title root…");
    expect(buttons[1]).toHaveTextContent("未完成任务 + 最近 7 天完成的任务");
    expect(buttons[1]).toHaveTextContent("2 / 5"); expect(buttons[1]).toHaveTextContent("40%");
    fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!);
    expect(onNavigate.mock.calls).toEqual([[{ kind: "chain", taskId: "root" }], [{ kind: "standalone" }]]);
    expect(screen.getByText("任务总数").parentElement).toHaveTextContent("13");
    view.setLocale("en");
    expect(screen.getByRole("region", { name: "Overall progress" })).toHaveTextContent("All unfinished tasks + tasks completed in the last 7 days");
  });

  it("distinguishes an empty project from all-complete groups", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const empty = snapshot([]); const emptyIds = categories(empty);
    const view = renderWithLocale(<ProjectOverview snapshot={empty} {...emptyIds} active onNavigate={vi.fn()} />, { locale: "zh-CN" });
    expect(screen.getByRole("heading", { name: "还没有任务" })).toBeTruthy();
    const complete = snapshot([{ id: "done", status: "done", completedAt: observedAt }]);
    view.rerender(<ProjectOverview snapshot={complete} {...categories(complete)} active onNavigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "所有任务均已完成" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
