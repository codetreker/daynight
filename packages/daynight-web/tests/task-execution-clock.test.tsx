import { summariesForGraph } from './helpers/taskSync';
import { StrictMode, Suspense, type ReactNode } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TaskGraph } from "../src/api/types";
import { buildGraphIndex } from "../src/features/task-graph/model";
import type { GraphSnapshot } from "../src/features/projects/useTaskGraph";
import { createTaskExecutionClock, taskExecution, type ClockEnvironment, type ClockInput, type ExecutionTask } from "../src/features/task-execution/clock";
import { ClockInputProvider, TaskExecutionClockProvider, useTaskExecution } from "../src/features/task-execution/TaskExecutionClock";
import { useCompletionTime } from "../src/features/task-completion/useCompletionTime";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

const start = "2026-10-23T00:00:00Z";
const epoch = Date.parse(start);
const projectId = "10000000-0000-4000-8000-000000000001";
const otherProjectId = "10000000-0000-4000-8000-000000000002";
const running: ExecutionTask = { allowAgents: true, status: "in_progress", startedAt: start, completedAt: null, cancelledAt: null };
const input = (warningMinutes = 60): ClockInput => ({ observedAt: start, receivedMonotonic: 100, warningMinutes });
const snapshot = (observedAt = start, receivedMonotonic = 0, warningMinutes = 60, id = projectId): GraphSnapshot => {
  const graph: TaskGraph = {
    observedAt, project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id, name: "Project", repoUrl: "https://example.com/repo", settings: { version: 1n, executionWarningMinutes: warningMinutes }, createdAt: start, updatedAt: start },
    tasks: [], summary: { proposed: 0, total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 },
  };
  return { graph, index: buildGraphIndex(graph), summaries: summariesForGraph(graph), workerMachines: new Map(), pausedTaskIds: new Set<string>(), observedAt, receivedMonotonic, receivedAt: 123456, revision: 1 };
};

const environment = () => {
  let now = 100;
  let visible = true;
  let visibility: (() => void) | null = null;
  let sequence = 0;
  const ticks = new Map<number, () => void>();
  const release = vi.fn(() => { visibility = null; });
  const api: ClockEnvironment = {
    now: () => now, visible: () => visible,
    schedule: vi.fn((tick) => { const id = ++sequence; ticks.set(id, tick); return id as unknown as ReturnType<typeof setInterval>; }),
    cancel: vi.fn((timer) => { ticks.delete(timer as unknown as number); }),
    listen: vi.fn((listener) => { visibility = listener; return release; }),
  };
  return {
    api, ticks, release,
    advance: (milliseconds: number) => { now += milliseconds; for (const tick of [...ticks.values()]) tick(); },
    elapse: (milliseconds: number) => { now += milliseconds; },
    visibility: (value: boolean) => { visible = value; visibility?.(); },
  };
};

describe("execution intervals", () => {
  it("uses a direct observation anchor and updates its warning threshold without remounting", () => {
    vi.useFakeTimers();
    let monotonic = 100;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    let current = input(60);
    const wrapper = ({ children }: { children: ReactNode }) => <ClockInputProvider input={current}>{children}</ClockInputProvider>;
    const { result, rerender, unmount } = renderHook(() => useTaskExecution(running), { wrapper });
    expect(result.current?.elapsedMilliseconds).toBe(0);
    monotonic += 61 * 60_000;
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current?.overdue).toBe(true);
    current = { ...input(120), receivedMonotonic: monotonic };
    rerender();
    expect(result.current?.overdue).toBe(false);
    expect(result.current?.warningMinutes).toBe(120);
    unmount(); expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers(); vi.restoreAllMocks();
  });
  it.each([true, false].flatMap((allowAgents) => [3_599_000, 3_600_000, 3_601_000].map((elapsed) => ({ allowAgents, elapsed, overdue: allowAgents && elapsed > 3_600_000 }))))
    ("compares exact elapsed $elapsed with allowAgents=$allowAgents against the saved threshold", ({ allowAgents, elapsed, overdue }) => {
      expect(taskExecution({ ...running, allowAgents }, { serverMilliseconds: epoch + elapsed, warningMinutes: 60 }))
        .toMatchObject({ kind: "running", elapsedMilliseconds: elapsed, overdue, startedAt: start, completedAt: null });
    });

  it("keeps completion exact and frozen while an incoming running start awaits its matching anchor", () => {
    const completed: ExecutionTask = { ...running, status: "done", completedAt: new Date(epoch + 2_700_000).toISOString() };
    expect(taskExecution(completed, { serverMilliseconds: epoch + 86_400_000, warningMinutes: 1 }))
      .toMatchObject({ kind: "completed", elapsedMilliseconds: 2_700_000, overdue: false });
    expect(taskExecution(running, { serverMilliseconds: epoch - 1, warningMinutes: 60 })?.elapsedMilliseconds).toBe(0);
    expect(taskExecution({ ...completed, completedAt: new Date(epoch - 1).toISOString() }, { serverMilliseconds: epoch, warningMinutes: 60 })?.elapsedMilliseconds).toBe(-1);
  });

  it.each([
    { allowAgents: false, status: "todo", startedAt: start, completedAt: null, cancelledAt: null },
    { allowAgents: true, status: "in_progress", startedAt: null, completedAt: null, cancelledAt: null },
    { allowAgents: true, status: "done", startedAt: null, completedAt: start, cancelledAt: null },
    { allowAgents: true, status: "done", startedAt: start, completedAt: null, cancelledAt: null },
  ] satisfies ExecutionTask[])("omits timing without a measurable $status execution", (task) => {
    expect(taskExecution(task, { serverMilliseconds: epoch, warningMinutes: 60 })).toBeNull();
  });
});

describe("project execution clock ownership", () => {
  it("shares one ticker and releases it and the visibility listener with the last running subscriber", () => {
    const platform = environment();
    const clock = createTaskExecutionClock(input(), platform.api);
    const stop = clock.mount();
    const settings = vi.fn();
    const removeSettings = clock.subscribeSettings(settings);
    expect(platform.ticks.size).toBe(0);
    expect(platform.api.listen).not.toHaveBeenCalled();
    const initial = clock.getSnapshot();
    expect(clock.getSnapshot()).toBe(initial);
    const warning = clock.getWarningSnapshot();
    const first = vi.fn(); const second = vi.fn();
    const removeFirst = clock.subscribeRunning(first);
    const removeSecond = clock.subscribeRunning(second);
    expect(platform.ticks.size).toBe(1);
    expect(platform.api.schedule).toHaveBeenCalledTimes(1);
    expect(platform.api.listen).toHaveBeenCalledTimes(1);
    platform.advance(2_500);
    expect(clock.getSnapshot()!.serverMilliseconds).toBe(epoch + 2_500);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
    expect(clock.getWarningSnapshot()).toBe(warning);
    removeFirst(); expect(platform.ticks.size).toBe(1);
    removeSecond(); expect(platform.ticks.size).toBe(0); expect(platform.release).toHaveBeenCalledTimes(1);
    platform.elapse(5_000);
    const removeLate = clock.subscribeRunning(vi.fn());
    expect(clock.getSnapshot()!.serverMilliseconds).toBe(epoch + 7_500);
    stop(); expect(platform.ticks.size).toBe(0); expect(platform.release).toHaveBeenCalledTimes(2);
    removeLate(); removeSettings();
  });

  it("pauses while hidden and immediately reconciles monotonic elapsed on return", () => {
    const platform = environment();
    const clock = createTaskExecutionClock(input(), platform.api);
    const stop = clock.mount(); const change = vi.fn(); const remove = clock.subscribeRunning(change);
    platform.visibility(false);
    expect(platform.ticks.size).toBe(0);
    platform.elapse(30_000);
    expect(clock.getSnapshot()!.serverMilliseconds).toBe(epoch);
    platform.visibility(true);
    expect(clock.getSnapshot()!.serverMilliseconds).toBe(epoch + 30_000);
    expect(change).toHaveBeenCalledTimes(1);
    expect(platform.ticks.size).toBe(1);
    remove(); stop();
  });

  it("applies each receipt and saved threshold atomically without notifying completed consumers for clock-only updates", () => {
    const platform = environment();
    const clock = createTaskExecutionClock(input(), platform.api);
    const observations: Array<{ clock: number; warning: number; elapsed: number }> = [];
    const remove = clock.subscribeRunning(() => observations.push({ clock: clock.getSnapshot()!.warningMinutes,
      warning: clock.getWarningSnapshot()!.warningMinutes, elapsed: clock.getSnapshot()!.serverMilliseconds! - epoch }));
    const settings = vi.fn(); const removeSettings = clock.subscribeSettings(settings);
    platform.elapse(700);
    clock.update({ observedAt: new Date(epoch + 5_000).toISOString(), receivedMonotonic: 300, warningMinutes: 2 });
    expect(observations).toEqual([{ clock: 2, warning: 2, elapsed: 5_500 }]);
    expect(settings).toHaveBeenCalledTimes(1);
    clock.update({ observedAt: new Date(epoch + 6_000).toISOString(), receivedMonotonic: 800, warningMinutes: 2 });
    expect(settings).toHaveBeenCalledTimes(1);
    const latest = clock.getSnapshot();
    clock.update({ observedAt: new Date(epoch + 6_000).toISOString(), receivedMonotonic: 800, warningMinutes: 2 });
    expect(clock.getSnapshot()).toBe(latest);
    remove(); removeSettings();
  });
});

describe("execution clock provider", () => {
  it("keeps cached running time unknown and completed intervals available until a live sample arrives", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const graph = snapshot();
    let current: GraphSnapshot = { ...graph, observedAt: null, receivedAt: null, revision: 0, localTime: Date.parse("2055-01-01T00:00:00Z") };
    const wrapper = ({ children }: { children: ReactNode }) => <TaskExecutionClockProvider projectId={projectId} snapshot={current}>{children}</TaskExecutionClockProvider>;
    const completed: ExecutionTask = { ...running, status: "done", completedAt: new Date(epoch + 60_000).toISOString() };
    const { result, rerender, unmount } = renderHook(() => ({ running: useTaskExecution(running), completed: useTaskExecution(completed) }), { wrapper });
    expect(result.current.running).toBeNull();
    expect(result.current.completed).toMatchObject({ kind: "completed", elapsedMilliseconds: 60_000 });
    expect(vi.getTimerCount()).toBe(0);
    current = snapshot(new Date(epoch + 3_601_000).toISOString());
    rerender();
    expect(result.current.running).toMatchObject({ kind: "running", elapsedMilliseconds: 3_601_000, overdue: true });
    expect(vi.getTimerCount()).toBe(1);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("includes commit delay and fresh server receipts while ignoring the client wall clock", () => {
    vi.useFakeTimers();
    let monotonic = 1_700;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2055-01-01T00:00:00Z"));
    let current = snapshot(start, 1_000);
    const wrapper = ({ children }: { children: ReactNode }) => <TaskExecutionClockProvider projectId={projectId} snapshot={current}>{children}</TaskExecutionClockProvider>;
    const { result, rerender, unmount } = renderHook(() => useTaskExecution(running), { wrapper });
    expect(result.current?.elapsedMilliseconds).toBe(700);
    monotonic = 2_000;
    current = snapshot(new Date(epoch + 5_000).toISOString(), 1_500, 1);
    rerender();
    expect(result.current).toMatchObject({ elapsedMilliseconds: 5_500, warningMinutes: 1 });
    monotonic += 1_000;
    act(() => vi.advanceTimersByTime(1_000));
    expect(result.current?.elapsedMilliseconds).toBe(6_500);
    expect(vi.getTimerCount()).toBe(1);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("stops ticking after completion and updates only saved threshold metadata for completed consumers", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    let current = snapshot(new Date(epoch + 3_601_000).toISOString());
    const wrapper = ({ children }: { children: ReactNode }) => <TaskExecutionClockProvider projectId={projectId} snapshot={current}>{children}</TaskExecutionClockProvider>;
    const { result, rerender, unmount } = renderHook(({ task }) => useTaskExecution(task), { initialProps: { task: running }, wrapper });
    expect(result.current?.overdue).toBe(true); expect(vi.getTimerCount()).toBe(1);
    const completed: ExecutionTask = { ...running, status: "done", completedAt: new Date(epoch + 3_601_000).toISOString() };
    rerender({ task: completed });
    expect(result.current).toMatchObject({ kind: "completed", elapsedMilliseconds: 3_601_000, overdue: false });
    expect(vi.getTimerCount()).toBe(0);
    current = snapshot(new Date(epoch + 86_400_000).toISOString(), 0, 120);
    rerender({ task: completed });
    expect(result.current).toMatchObject({ elapsedMilliseconds: 3_601_000, warningMinutes: 120, overdue: false });
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("keeps unknown facts inactive and makes missing or mismatched required context explicit", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTaskExecution({ ...running, startedAt: null }));
    expect(result.current).toBeNull(); expect(vi.getTimerCount()).toBe(0); unmount();
    expect(() => renderHook(() => useTaskExecution(running))).toThrow("requires TaskExecutionClockProvider");
    const wrapper = ({ children }: { children: ReactNode }) => <TaskExecutionClockProvider projectId={otherProjectId} snapshot={snapshot()}>{children}</TaskExecutionClockProvider>;
    expect(() => renderHook(() => useTaskExecution(running), { wrapper })).toThrow("requires its project's graph snapshot");
  });

  it("owns a single live timer through StrictMode and replaces the scope on project navigation", () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    let project = projectId;
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode><TaskExecutionClockProvider projectId={project}
      snapshot={snapshot(new Date(epoch + (project === projectId ? 1_000 : 5_000)).toISOString(), 0, 60, project)}>{children}</TaskExecutionClockProvider></StrictMode>;
    const { result, rerender, unmount } = renderHook(() => useTaskExecution(running), { wrapper });
    expect(result.current?.elapsedMilliseconds).toBe(1_000); expect(vi.getTimerCount()).toBe(1);
    project = otherProjectId; rerender();
    expect(result.current?.elapsedMilliseconds).toBe(5_000); expect(vi.getTimerCount()).toBe(1);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});

it("stops cancellation reminders and preserves only a known historical execution interval", () => {
  const cancelled: ExecutionTask = { ...running, status: "cancelled", cancelledAt: "2026-10-23T02:00:00Z" };
  const clock = { serverMilliseconds: epoch + 7_200_000, warningMinutes: 1 };
  expect(taskExecution(cancelled, clock)).toBeNull();
  expect(taskExecution({ ...cancelled, completedAt: "2026-10-23T01:00:00Z" }, clock))
    .toMatchObject({ kind: "completed", elapsedMilliseconds: 3_600_000, completedAt: "2026-10-23T01:00:00Z", overdue: false });
});


describe("completion clock", () => {
  it("shares one interval across completion and running subscribers and handles cache, live and empty samples", () => {
    const platform = environment();
    const clock = createTaskExecutionClock(null, platform.api);
    const stop = clock.mount();
    const completion = vi.fn(); const runningChange = vi.fn(); const settings = vi.fn();
    const removeCompletion = clock.subscribeCompletion(completion);
    const removeRunning = clock.subscribeRunning(runningChange);
    const removeSettings = clock.subscribeSettings(settings);
    expect(clock.getCompletionNow()).toBeNull();
    expect(clock.getSnapshot()).toBeNull();
    expect(clock.getWarningSnapshot()).toBeNull();
    expect(platform.ticks.size).toBe(0);
    clock.update({ observedAt: null, localTime: epoch, receivedMonotonic: 100, warningMinutes: 60 });
    expect(clock.getCompletionNow()).toBe(BigInt(epoch) * 1_000_000n);
    expect(clock.getSnapshot()!.serverMilliseconds).toBeNull();
    expect(platform.ticks.size).toBe(1);
    platform.advance(2_500);
    expect(clock.getCompletionNow()).toBe(BigInt(epoch + 2_500) * 1_000_000n);
    expect(runningChange).toHaveBeenCalledTimes(1);
    expect(settings).toHaveBeenCalledTimes(1);
    clock.update({ observedAt: "2026-10-23T00:00:10.123456789Z", receivedMonotonic: 2_600, warningMinutes: 1 });
    expect(clock.getCompletionNow()).toBe(BigInt(epoch + 10_123) * 1_000_000n + 456_789n);
    expect(clock.getSnapshot()!.serverMilliseconds).toBe(epoch + 10_123);
    expect(clock.getWarningSnapshot()!.warningMinutes).toBe(1);
    expect(platform.ticks.size).toBe(1);
    platform.visibility(false); expect(platform.ticks.size).toBe(0);
    platform.elapse(3_000); platform.visibility(true);
    expect(clock.getCompletionNow()).toBe(BigInt(epoch + 13_123) * 1_000_000n + 456_789n);
    expect(platform.ticks.size).toBe(1);
    clock.update(null);
    expect(clock.getCompletionNow()).toBeNull(); expect(clock.getSnapshot()).toBeNull();
    expect(clock.getWarningSnapshot()).toBeNull(); expect(platform.ticks.size).toBe(0);
    expect(platform.release).toHaveBeenCalledTimes(1);
    removeCompletion(); removeRunning(); removeSettings(); stop();
  });

  it("runs for completed-only subscribers and releases each resource on removal or owner unmount", () => {
    const platform = environment(); const clock = createTaskExecutionClock(input(), platform.api);
    const stop = clock.mount(); const remove = clock.subscribeCompletion(vi.fn());
    expect(platform.ticks.size).toBe(1);
    remove(); expect(platform.ticks.size).toBe(0); expect(platform.release).toHaveBeenCalledTimes(1);
    const removeAgain = clock.subscribeCompletion(vi.fn());
    expect(platform.ticks.size).toBe(1);
    stop(); expect(platform.ticks.size).toBe(0); expect(platform.release).toHaveBeenCalledTimes(2);
    removeAgain();
  });

  it("changes React output only when the reading changes and keeps the child mounted as samples arrive", () => {
    vi.useFakeTimers();
    let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    let current: GraphSnapshot | null = null;
    const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider initial={{ locale: "en", issue: null }}>
      <TaskExecutionClockProvider projectId={projectId} snapshot={current}>{children}</TaskExecutionClockProvider>
    </LocaleProvider>;
    const renders = vi.fn();
    const { result, rerender, unmount } = renderHook(() => { renders(); return useCompletionTime(start); }, { wrapper });
    expect(result.current).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    current = snapshot(start); rerender();
    const first = result.current;
    expect(first?.timestamp).toBe(start); expect(vi.getTimerCount()).toBe(1);
    const count = renders.mock.calls.length;
    monotonic = 1_000; act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(first); expect(renders).toHaveBeenCalledTimes(count);
    monotonic = 60_000; act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).not.toBe(first);
    expect(result.current?.label).toContain("1 minute");
    current = null; rerender(); expect(result.current).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not acquire a ticker from an uncommitted render", () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {});
    const Suspended = () => { useCompletionTime(start); throw pending; };
    const view = render(<LocaleProvider initial={{ locale: "en", issue: null }}>
      <TaskExecutionClockProvider projectId={projectId} snapshot={snapshot()}>
        <Suspense fallback={<span>Loading</span>}><Suspended /></Suspense>
      </TaskExecutionClockProvider>
    </LocaleProvider>);
    expect(view.getByText("Loading")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects missing clock for a known completion and keeps unknown completion inactive", () => {
    const wrapper = ({ children }: { children: ReactNode }) => <LocaleProvider initial={{ locale: "en", issue: null }}>{children}</LocaleProvider>;
    const { result, unmount } = renderHook(() => useCompletionTime(null), { wrapper });
    expect(result.current).toBeNull(); unmount();
    expect(() => renderHook(() => useCompletionTime(start), { wrapper })).toThrow("requires TaskExecutionClockProvider");
  });
});
