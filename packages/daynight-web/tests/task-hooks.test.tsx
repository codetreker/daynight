import { createTaskSessionWorld } from "./helpers/taskSessions";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { performance as nodePerformance } from "node:perf_hooks";
import * as cacheProjection from "../src/features/task-cache/projection";
import { TestTaskCacheBoundary } from "./helpers/taskCache";
import { createGraphSyncFixture } from "./helpers/taskSync";
import { act, renderHook as renderHookWithoutSession, waitFor as waitForWithRealTimers, type RenderHookOptions } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphTask, TaskDetail, TaskGraph } from "../src/api/types";
import { ApiError, setTaskStatus, getTask, getTaskSync } from "../src/api/client";
import { useTaskGraph } from "../src/features/projects/useTaskGraph";
import { useTaskDetail } from "../src/features/task-detail/useTaskDetail";
import { TaskDetailSessionBoundary } from "../src/features/task-detail/TaskDetailSession";
import { isTaskStale, taskDescriptor, taskReviewKey } from "../src/features/task-detail/freshness";

// IndexedDB finishes on event-loop tasks while polling time remains under test control.
const waitFor: typeof waitForWithRealTimers = async (assertion, options) => {
  if (!vi.isFakeTimers()) return waitForWithRealTimers(assertion, options);
  const deadline = nodePerformance.now() + (options?.timeout ?? 1_000);
  for (;;) {
    await act(async () => { await nextEventLoopTurn(); });
    try { return await assertion(); }
    catch (error) { if (nodePerformance.now() >= deadline) throw error; }
  }
};

let detailWorld: ReturnType<typeof createTaskSessionWorld> | null = null;

const renderHook = <Result, Props,>(render: (props: Props) => Result, options?: RenderHookOptions<Props>) =>
  renderHookWithoutSession(render, { ...options, wrapper: ({ children }) => <TestTaskCacheBoundary {...(detailWorld === null ? {} : { scope: detailWorld.scope })}><TaskDetailSessionBoundary>{children}</TaskDetailSessionBoundary></TestTaskCacheBoundary> });

vi.mock("../src/api/client", async (original) => ({ ...await original<typeof import("../src/api/client")>(), setTaskStatus: vi.fn(), getTask: vi.fn(), getTaskSync: vi.fn() }));
const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();
const detailRequest = vi.mocked(getTask);
const projectId = "10000000-0000-0000-0000-000000000001";
const otherProject = "10000000-0000-0000-0000-000000000002";
const taskId = "20000000-0000-0000-0000-000000000001";
const otherTask = "20000000-0000-0000-0000-000000000002";
const time = "2026-10-20T12:00:00.123456Z";
const node: GraphTask = { requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null, id: taskId, titlePreview: "任务一", titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time };
const detail: TaskDetail = { requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null, id: taskId, projectId, title: "任务一", description: "完整描述", properties: { pullRequests: [] }, status: "todo", version: 1n, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time };
const graph = (id = projectId): TaskGraph => ({ observedAt: "2026-10-20T12:00:00Z",
  project: { settings: { version: 1n, executionWarningMinutes: 60 }, id, name: `项目 ${id}`, repoUrl: "https://github.com/example/repo", createdAt: time, updatedAt: time },
  tasks: [node], summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 },
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const replacementEpochs = new WeakMap<TaskGraph, string>();
const resetSnapshot = (value: TaskGraph): TaskGraph => { replacementEpochs.set(value, crypto.randomUUID()); return value; };
const syncFixture = createGraphSyncFixture({ propertiesForTask: () => detail.properties });
beforeEach(() => {
  syncFixture.reset();
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => {
    const value = await graphRequest(projectId, signal);
    return syncFixture.toSync(value, query, replacementEpochs.get(value));
  });
});

beforeEach(() => { graphRequest.mockReset(); detailRequest.mockReset(); vi.mocked(setTaskStatus).mockReset(); });

describe("task graph snapshots", () => {
  it("publishes marker-only changes as task data while clock-only samples preserve the new graph and index", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const initial: TaskGraph = { ...graph(), tasks: [
      { ...node, id: otherTask, titlePreview: "Prerequisite", status: "done", ready: false, startedAt: time, completedAt: time, createdAt: "2026-10-20T12:00:00.123455Z" },
      { ...node, dependsOn: [otherTask] },
    ], summary: { total: 2, todo: 1, inProgress: 0, done: 1, ready: 1, blocked: 0 } };
    const classified: TaskGraph = { ...initial, tasks: initial.tasks.map((task) => task.id === taskId
      ? { ...task, externalDependsOn: [otherTask] } : task) };
    const later = { ...classified, observedAt: "2026-10-20T12:00:10.123456Z" };
    graphRequest.mockResolvedValueOnce(initial).mockResolvedValueOnce(classified).mockResolvedValueOnce(later);
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.snapshot!;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(result.current.snapshot!.revision).toBeGreaterThan(first.revision));
    const changed = result.current.snapshot!;
    expect(changed.graph).not.toBe(first.graph);
    expect(changed.index).not.toBe(first.index);
    expect(changed.index.nodes.get(taskId)).toMatchObject({ externalDependsOn: [otherTask], updatedAt: time, ready: true });
    expect(first.index.representativeIds).toEqual([otherTask]);
    expect(changed.index.representativeIds).toEqual([otherTask, taskId]);
    expect(first.index.components.get(otherTask)!.memberIds).toEqual(new Set([otherTask, taskId]));
    expect(changed.index.components.get(taskId)!.memberIds).toEqual(new Set([taskId]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(result.current.snapshot!.observedAt).toBe(later.observedAt));
    expect(result.current.snapshot!.graph).toBe(changed.graph);
    expect(result.current.snapshot!.index).toBe(changed.index);
  });

  it("captures the monotonic receipt before durable merge and index work while preserving the wall-clock label", async () => {
    let monotonic = 125;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    vi.spyOn(Date, "now").mockReturnValue(123456);
    const projectSummaries = cacheProjection.projectSummaries;
    vi.spyOn(cacheProjection, "projectSummaries").mockImplementation((...args) => {
      monotonic += 500;
      return projectSummaries(...args);
    });
    graphRequest.mockResolvedValue(graph());
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshot?.receivedMonotonic).toBe(125);
    expect(result.current.snapshot?.receivedAt).toBe(123456);
    expect(monotonic).toBeGreaterThan(125);
  });

  it("publishes fresh clock samples without replacing unchanged graph content or announcing background loading", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(1_000);
    graphRequest.mockImplementation(async () => graph());
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.snapshot!;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    const next = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(next.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    expect(result.current).toMatchObject({ snapshot: first, status: "ready", refreshing: false });
    const observedAt = "2026-10-20T12:00:05.123456Z";
    await act(async () => { next.resolve({ ...graph(), observedAt }); });
    await waitFor(() => expect(result.current.snapshot!.observedAt).toBe(observedAt));
    expect(result.current.snapshot!.graph).toBe(first.graph);
    expect(result.current.snapshot!.index).toBe(first.index);
    expect(first.observedAt).toBe(graph().observedAt);
    expect(result.current.snapshot!.receivedAt).toBe(6_000);
    expect(result.current.snapshot!.revision).toBeGreaterThan(first.revision);
  });

  it("publishes bigint project settings while preserving task projections and graph identity on later clock-only samples", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const initial = graph();
    const changed: TaskGraph = { ...initial, project: { ...initial.project, settings: {
      version: 9_007_199_254_740_993n, executionWarningMinutes: 90,
    } }, observedAt: "2026-10-20T12:00:05Z" };
    graphRequest.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed).mockResolvedValueOnce({ ...changed, observedAt: "2026-10-20T12:00:10Z" });
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.snapshot!;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(result.current.snapshot!.revision).toBeGreaterThan(first.revision));
    const second = result.current.snapshot!;
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(second.graph).not.toBe(first.graph);
    expect(second.graph.project.settings).toEqual(changed.project.settings);
    expect(second.index).toBe(first.index);
    expect(second.graph.tasks).toBe(first.graph.tasks);
    expect(second.graph.summary).toBe(first.graph.summary);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(result.current.snapshot!.observedAt).toBe("2026-10-20T12:00:10Z"));
    expect(result.current.snapshot!.graph).toBe(second.graph);
    expect(result.current.snapshot!.index).toBe(first.index);
  });

  it("lets slow automatic requests finish and gives manual refresh priority", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const slow = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(slow.promise).mockResolvedValue(graph());
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    const signal = graphRequest.mock.calls[0]![1];
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(false);
    act(() => result.current.refresh());
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const fresh = result.current.snapshot;
    await act(async () => { slow.reject(new Error("superseded")); });
    expect(result.current.snapshot).toBe(fresh);
    await waitFor(() => expect(result.current.error).toBeNull());
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(3));
  });

  it("pauses hidden-page polling, refreshes on return, and removes timers and listeners on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    graphRequest.mockImplementation(async () => graph());
    const { result, unmount } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.snapshot!.revision).toBe(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(3));
    unmount();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(3));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps errors visible during background retry and recovers automatically with a fresh receipt", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const failure = new Error("offline");
    const recovery = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockRejectedValueOnce(failure).mockReturnValueOnce(recovery.promise);
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.snapshot!;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(result.current).toMatchObject({ snapshot: first, error: failure }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current).toMatchObject({ snapshot: first, error: failure, refreshing: false });
    await act(async () => { recovery.resolve(graph()); });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.snapshot!.index).toBe(first.index);
    expect(result.current.snapshot!.revision).toBeGreaterThan(first.revision);
  });

  it("keeps an initial error visible through an automatic retry without repeating the loading state", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const recovery = deferred<TaskGraph>();
    const failure = new Error("offline");
    graphRequest.mockRejectedValueOnce(failure).mockReturnValueOnce(recovery.promise);
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ snapshot: null, status: "error", error: failure });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current).toMatchObject({ snapshot: null, status: "error", error: failure });
    await act(async () => { recovery.resolve(graph()); });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("continues an in-flight graph across a hidden and visible transition", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const pending = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(pending.promise).mockResolvedValue(graph());
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    const signal = graphRequest.mock.calls[0]![1];
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    expect(signal.aborted).toBe(false);
    await act(async () => { pending.resolve(graph()); });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
  });

  it("publishes status and readiness changes even with unchanged task timestamps", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const reviewed: TaskGraph = { ...graph(), tasks: [{ ...node, status: "done", ready: false }],
      summary: { total: 1, todo: 0, inProgress: 0, done: 1, ready: 0, blocked: 0 } };
    graphRequest.mockResolvedValueOnce(graph()).mockResolvedValueOnce(reviewed);
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.snapshot!;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(result.current.snapshot!.index).not.toBe(first.index));
    expect(result.current.snapshot!.index.nodes.get(taskId)).toMatchObject({ status: "done", ready: false, updatedAt: time });
    expect(result.current.snapshot!.graph.summary.done).toBe(1);
  });

  it("publishes graph, validated index, local receipt time and revision atomically", async () => {
    vi.spyOn(Date, "now").mockReturnValue(123456);
    graphRequest.mockResolvedValue(graph());
    const { result } = renderHook(() => useTaskGraph(projectId));
    expect(result.current).toMatchObject({ snapshot: null, status: "loading", refreshing: false, error: null });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.snapshot?.graph).toMatchObject({ project: graph().project, tasks: graph().tasks, summary: graph().summary });
    expect(result.current.snapshot?.index.nodes.get(taskId)).toEqual(node);
    expect(result.current.snapshot?.receivedAt).toBe(123456);
    expect(result.current.snapshot?.observedAt).toBe(graph().observedAt);
    expect(result.current.snapshot?.revision).toBeGreaterThan(0);
    expect(graphRequest.mock.calls[0]?.[0]).toBe(projectId);
    expect(graphRequest.mock.calls[0]?.[1].aborted).toBe(false);
  });

  it("retains a same-project snapshot through refresh and failure, then replaces it whole on success", async () => {
    const update = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(update.promise).mockResolvedValueOnce(resetSnapshot({ ...graph(), tasks: [],
      summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } }));
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.snapshot;
    act(() => result.current.refresh());
    expect(result.current).toMatchObject({ snapshot: first, status: "ready", refreshing: true, error: null });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    const failure = new Error("private diagnostic");
    await act(async () => { update.reject(failure); });
    await waitFor(() => expect(result.current).toMatchObject({ snapshot: first, status: "ready", refreshing: false, error: failure }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.snapshot?.graph.tasks).toEqual([]));
    expect(result.current.snapshot?.index.nodes.size).toBe(0);
    expect(result.current.snapshot?.revision).toBeGreaterThan(first!.revision);
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("discards the entire retained graph after an authoritative not-found response", async () => {
    const failure = new ApiError("server", 404, "not_found");
    graphRequest.mockResolvedValueOnce(graph()).mockRejectedValueOnce(failure);
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.snapshot?.graph).toMatchObject({ project: graph().project, tasks: graph().tasks, summary: graph().summary }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ snapshot: null, refreshing: false, error: failure });
  });

  it("hides prior project data on the very first render after identity changes", async () => {
    const next = deferred<TaskGraph>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(next.promise);
    const renders: Array<{ project: string; displayed: string | null; error: unknown }> = [];
    const { result, rerender } = renderHook(({ project }) => {
      const state = useTaskGraph(project);
      renders.push({ project, displayed: state.snapshot?.graph.project.id ?? null, error: state.error });
      return state;
    }, { initialProps: { project: projectId } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    rerender({ project: otherProject });
    expect(renders.filter((render) => render.project === otherProject).every((render) => render.displayed === null)).toBe(true);
    expect(result.current).toMatchObject({ snapshot: null, status: "loading", error: null });
    await act(async () => { next.resolve(graph(otherProject)); });
    await waitFor(() => expect(result.current.snapshot?.graph.project.id).toBe(otherProject));
  });

  it("cancels navigation and ignores late success/failure even when the transport ignores abort", async () => {
    const old = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(old.promise).mockResolvedValueOnce(graph(otherProject));
    const { result, rerender } = renderHook(({ project }) => useTaskGraph(project), { initialProps: { project: projectId } });
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    const oldSignal = graphRequest.mock.calls[0]![1];
    rerender({ project: otherProject });
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.snapshot?.graph.project.id).toBe(otherProject));
    await act(async () => { old.resolve(graph()); });
    await waitFor(() => expect(result.current.snapshot?.graph.project.id).toBe(otherProject));
    const lateFailure = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(lateFailure.promise).mockResolvedValueOnce(graph(otherProject));
    act(() => result.current.refresh());
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(3));
    const superseded = graphRequest.mock.calls[2]![1];
    act(() => result.current.refresh());
    expect(superseded.aborted).toBe(true);
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    await act(async () => { lateFailure.reject(new Error("late failure")); });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("rejects invalid graph semantics as a whole and can retry successfully", async () => {
    graphRequest.mockResolvedValueOnce({ ...graph(), tasks: [{ ...node, dependsOn: [otherTask] }] }).mockResolvedValueOnce(graph());
    const { result } = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toMatchObject({ kind: "protocol" });
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("does not show aborts as errors and cancels outstanding work on unmount", async () => {
    graphRequest.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const aborted = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(1));
    expect(aborted.result.current.error).toBeNull();
    aborted.unmount();
    const late = deferred<TaskGraph>();
    graphRequest.mockReturnValueOnce(late.promise);
    const mounted = renderHook(() => useTaskGraph(projectId));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    const pendingSignal = graphRequest.mock.calls.at(-1)![1];
    mounted.unmount();
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => { late.resolve(graph()); });
  });
});

describe("task details", () => {
  beforeEach(() => { detailWorld = createTaskSessionWorld(); });
  afterEach(() => { detailWorld?.dispose(); detailWorld = null; });
  const seed = (...details: TaskDetail[]) => detailWorld!.sync(details);
  const observed = (value: TaskDetail) => detailWorld!.node(value.projectId, value.id);
  const prerequisite: TaskDetail = { ...detail, id: otherTask, title: "Prerequisite" };

  it("invalidates a cached reviewed detail when only its external subset changes", async () => {
    const reviewed = { ...detail, ready: false, dependsOn: [otherTask], blockedBy: [otherTask] };
    const changed = { ...reviewed, externalDependsOn: [otherTask], version: reviewed.version + 1n };
    await seed(prerequisite, reviewed);
    const pending = deferred<TaskDetail>();
    detailRequest.mockResolvedValueOnce(reviewed).mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(({ revision, snapshot }) => useTaskDetail(projectId, taskId, revision, snapshot), {
      initialProps: { revision: 1, snapshot: observed(reviewed) },
    });
    await waitFor(() => expect(result.current.canSetStatus).toBe(true));
    const first = result.current.detail;
    await seed(changed);
    rerender({ revision: 2, snapshot: observed(changed) });
    expect(result.current.detail).toBe(first);
    expect(result.current.requiresFreshRead).toBe(true);
    expect(result.current.canSetStatus).toBe(false);
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(2));
    await act(async () => { pending.resolve(changed); });
    await waitFor(() => expect(result.current.detail).toEqual(changed));
    expect(result.current.requiresFreshRead).toBe(false);
    expect(result.current.canSetStatus).toBe(true);
  });

  it("keeps a slow reviewed version through unchanged five-second receipts and derives prerequisite completion without another GET", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const reviewed = { ...detail, ready: false, dependsOn: [otherTask], blockedBy: [otherTask] };
    let predecessor: GraphTask = { ...node, id: otherTask, titlePreview: "Prerequisite" };
    graphRequest.mockImplementation(async () => ({ ...graph(), tasks: [{ ...node, dependsOn: [otherTask], blockedBy: predecessor.status === "done" ? [] : [otherTask], ready: predecessor.status === "done" }, predecessor], summary: {
      total: 2, todo: predecessor.status === "todo" ? 2 : 1, inProgress: 0,
      done: predecessor.status === "done" ? 1 : 0, ready: 1, blocked: predecessor.status === "done" ? 0 : 1,
    } }));
    let active = 0;
    let maximumActive = 0;
    detailRequest.mockImplementation(async (_project, _task, signal) => {
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      active--;
      expect(signal.aborted).toBe(false);
      return reviewed;
    });
    let graphRevision = 0;
    const { result } = renderHook(() => {
      const { snapshot } = useTaskGraph(projectId);
      graphRevision = snapshot?.revision ?? 0;
      return useTaskDetail(projectId, taskId, snapshot?.revision ?? 0, snapshot?.index.nodes.get(taskId));
    });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledOnce());
    let elapsed = 0;
    const advance = async (duration: number) => {
      let remaining = duration;
      while (remaining > 0) {
        const step = Math.min(remaining, 5_000 - elapsed % 5_000);
        const previousRevision = graphRevision;
        await act(async () => { await vi.advanceTimersByTimeAsync(step); });
        elapsed += step; remaining -= step;
        if (elapsed % 5_000 === 0) await waitFor(() => expect(graphRevision).toBeGreaterThan(previousRevision));
      }
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      await advance(6_000);
      await waitFor(() => expect(result.current.detail).toEqual(reviewed));
      expect(result.current.canSetStatus).toBe(true);
      expect(setTaskStatus).not.toHaveBeenCalled();
    }
    const first = result.current.detail;
    expect(detailRequest).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);
    expect(graphRevision).toBe(4);
    predecessor = { ...predecessor, status: "done", ready: false };
    await advance(2_000);
    await waitFor(() => expect(result.current.detail).toMatchObject({ version: reviewed.version, ready: true, blockedBy: [] }));
    expect(result.current.detail!.properties.pullRequests).toBe(first!.properties.pullRequests);
    expect(result.current.requiresFreshRead).toBe(false);
    expect(result.current.canSetStatus).toBe(true);
    await advance(10_000);
    expect(detailRequest).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(1);
    expect(setTaskStatus).not.toHaveBeenCalled();
  });

  it("loads independently, retries failures locally and never exposes an old detail while retrying", async () => {
    await seed(detail);
    const retry = deferred<TaskDetail>();
    detailRequest.mockRejectedValueOnce(new Error("detail unavailable")).mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => useTaskDetail(projectId, taskId, 1, node));
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.detail).toBeNull();
    act(() => result.current.retry());
    expect(result.current).toMatchObject({ status: "loading", detail: null, error: null });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(2));
    await act(async () => { retry.resolve(detail); });
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", detail, error: null }));
  });

  it("clears immediately for identity changes and retains loaded details through an unchanged graph receipt", async () => {
    await seed(detail, { ...detail, id: otherTask }, { ...detail, id: otherTask, projectId: otherProject });
    detailRequest.mockImplementation(async (project, task) => ({ ...detail, projectId: project, id: task }));
    const renders: Array<{ key: string; displayed: string | null }> = [];
    const { result, rerender } = renderHook(({ project, task, revision }) => {
      const state = useTaskDetail(project, task, revision, { ...node, id: task });
      renders.push({ key: `${project}/${task}/${revision}`, displayed: state.detail?.id ?? null });
      return state;
    }, { initialProps: { project: projectId, task: taskId, revision: 1 } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    for (const props of [
      { project: projectId, task: otherTask, revision: 1 },
      { project: otherProject, task: otherTask, revision: 1 },
    ]) {
      const first = renders.length;
      rerender(props);
      expect(renders[first]?.displayed).toBeNull();
      await waitFor(() => expect(result.current.loadedRevision).toBe(props.revision));
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.detail?.projectId).toBe(props.project);
      expect(result.current.detail?.id).toBe(props.task);
    }
    const first = renders.length;
    rerender({ project: otherProject, task: otherTask, revision: 2 });
    expect(renders[first]?.displayed).toBe(otherTask);
    expect(detailRequest).toHaveBeenCalledTimes(3);
    expect(result.current.canSetStatus).toBe(true);
  });

  it.each([new Error("Background detail read failed"), new DOMException("Background read cancelled", "AbortError")])("retains loaded details and the actual background error until a fresh retry succeeds %#", async (error) => {
    const pending = deferred<TaskDetail>();
    const recovery = deferred<TaskDetail>();
    const fresh = { ...detail, version: detail.version + 1n, title: "Updated task" };
    await seed(detail);
    detailRequest.mockResolvedValueOnce(detail).mockReturnValueOnce(pending.promise).mockReturnValueOnce(recovery.promise);
    const { result, rerender } = renderHook(({ revision, snapshot }) => useTaskDetail(projectId, taskId, revision, snapshot), { initialProps: { revision: 1, snapshot: observed(detail) } });
    await waitFor(() => expect(result.current.loadedRevision).toBe(1));
    const first = result.current.detail;
    await seed(fresh);
    rerender({ revision: 2, snapshot: observed(fresh) });
    expect(result.current.detail).toBe(first);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.canSetStatus).toBe(false);
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(2));
    await act(async () => { pending.reject(error); });
    await waitFor(() => expect(result.current).toMatchObject({ detail: first, status: "ready", loadedRevision: 1, revision: 2, refreshing: false, error }));
    expect(result.current.error).toBe(error);
    expect(result.current.canSetStatus).toBe(false);
    act(() => result.current.retry());
    expect(result.current.detail).toBe(first);
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(3));
    await act(async () => { recovery.resolve(fresh); });
    await waitFor(() => expect(result.current).toMatchObject({ detail: fresh, loadedRevision: 2, refreshing: false, error: null, canSetStatus: true }));
  });

  it("admits a confirmed status body at the current summary version and preserves explicit refresh", async () => {
    await seed(detail);
    const mutation = deferred<TaskDetail>();
    const refresh = deferred<TaskDetail>();
    const started = { ...detail, status: "in_progress" as const, ready: false, startedAt: time, version: detail.version + 1n };
    detailRequest.mockResolvedValueOnce(detail).mockReturnValueOnce(refresh.promise);
    vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    const { result, rerender } = renderHook(({ revision, snapshot }) => useTaskDetail(projectId, taskId, revision, snapshot), { initialProps: { revision: 1, snapshot: observed(detail) } });
    await waitFor(() => expect(result.current.loadedRevision).toBe(1));
    act(() => result.current.setStatus("in_progress", result.current.detail!.version));
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledOnce());
    await seed(started);
    rerender({ revision: 2, snapshot: observed(started) });
    rerender({ revision: 3, snapshot: observed(started) });
    expect(detailRequest).toHaveBeenCalledTimes(1);
    expect(result.current.mutation.phase).toBe("pending");
    await act(async () => { mutation.resolve(started); });
    await waitFor(() => expect(result.current.mutation.phase).toBe("confirmed"));
    await waitFor(() => expect(result.current.detail).toEqual(started));
    expect(result.current.canSetStatus).toBe(true);
    expect(detailRequest).toHaveBeenCalledTimes(1);
    expect(result.current.loadedRevision).toBe(1);
    act(() => result.current.retry());
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(2));
    expect(result.current).toMatchObject({ detail: started, refreshing: true });
    await act(async () => { refresh.resolve(started); });
    await waitFor(() => expect(result.current).toMatchObject({ detail: started, refreshing: false, loadedRevision: 3, error: null }));
  });

  it("aborts superseded details and ignores late values without patching the graph", async () => {
    await seed(detail, { ...detail, id: otherTask });
    const late = deferred<TaskDetail>();
    detailRequest.mockReturnValueOnce(late.promise).mockResolvedValueOnce({ ...detail, id: otherTask });
    const { result, rerender } = renderHook(({ task }) => useTaskDetail(projectId, task, 1, { ...node, id: task }), { initialProps: { task: taskId } });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledOnce());
    const oldSignal = detailRequest.mock.calls[0]![2];
    rerender({ task: otherTask });
    expect(oldSignal.aborted).toBe(true);
    await waitFor(() => expect(result.current.detail?.id).toBe(otherTask));
    await act(async () => { late.resolve(detail); });
    expect(result.current.detail?.id).toBe(otherTask);
  });

  it("ignores a cancelled failure and cleans up requests on unmount", async () => {
    await seed(detail);
    const late = deferred<TaskDetail>();
    detailRequest.mockReturnValueOnce(late.promise).mockResolvedValueOnce(detail);
    const { result, rerender, unmount } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node), { initialProps: { revision: 1 } });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledOnce());
    rerender({ revision: 2 });
    expect(detailRequest).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => { late.reject(new Error("stale failure")); });
    await waitFor(() => expect(result.current.error).toBeNull());
    const pending = deferred<TaskDetail>();
    detailRequest.mockReturnValueOnce(pending.promise);
    act(() => result.current.retry());
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(3));
    const pendingSignal = detailRequest.mock.calls.at(-1)![2];
    unmount();
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => { pending.resolve(detail); });
  });

  it("coalesces business-version changes behind slow details without cancellation and reads the newest properties", async () => {
    await seed(detail);
    const slow = deferred<TaskDetail>();
    const updated = { ...detail, version: detail.version + 2n, description: "updated", properties: { pullRequests: [{ title: "PR", url: "https://example.com/pr/1" }] } };
    detailRequest.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(updated);
    const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node), { initialProps: { revision: 1 } });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledOnce());
    const signal = detailRequest.mock.calls[0]![2];
    await seed({ ...detail, version: detail.version + 1n });
    rerender({ revision: 2 });
    await seed(updated);
    rerender({ revision: 3 });
    expect(detailRequest).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => { slow.resolve(detail); });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.detail).toEqual(updated));
    expect(result.current.loadedRevision).toBe(3);
    expect(result.current.error).toBeNull();
  });

  it("retains successful detail and PR pagination identity through failures and automatically recovers", async () => {
    await seed(detail);
    const retry = deferred<TaskDetail>();
    const failure = new Error("offline");
    const updated = { ...detail, version: detail.version + 1n, description: "new description" };
    detailRequest.mockResolvedValueOnce(detail).mockRejectedValueOnce(failure).mockReturnValueOnce(retry.promise);
    const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node), { initialProps: { revision: 1 } });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = result.current.detail!;
    await seed(updated);
    rerender({ revision: 2 });
    expect(result.current.detail).toBe(first);
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current).toMatchObject({ detail: first, status: "ready" });
    rerender({ revision: 3 });
    expect(result.current.error).toBe(failure);
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(3));
    await act(async () => { retry.resolve(updated); });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.detail!.description).toBe("new description");
    expect(result.current.detail!.properties.pullRequests).toBe(first.properties.pullRequests);
  });

  it("retries an initial detail failure on an unchanged graph receipt and discards retained data on not-found", async () => {
    await seed(detail);
    const recovery = deferred<TaskDetail>();
    const failure = new Error("offline");
    detailRequest.mockRejectedValueOnce(failure).mockReturnValueOnce(recovery.promise)
      .mockRejectedValueOnce(new ApiError("server", 404, "not_found"));
    const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node), { initialProps: { revision: 1 } });
    await waitFor(() => expect(result.current.status).toBe("error"));
    rerender({ revision: 2 });
    expect(result.current).toMatchObject({ status: "error", detail: null, error: failure });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledTimes(2));
    await act(async () => { recovery.resolve(detail); });
    await waitFor(() => expect(result.current.detail).toEqual(detail));
    rerender({ revision: 3 });
    expect(detailRequest).toHaveBeenCalledTimes(2);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.detail).toBeNull();
    expect(detailRequest).toHaveBeenCalledTimes(3);
  });

  it("defers an automatic business-version read while hidden and resumes on the next graph receipt", async () => {
    await seed(detail);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const pending = deferred<TaskDetail>();
    const latest = { ...detail, description: "latest", version: detail.version + 1n };
    detailRequest.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(latest);
    const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node), { initialProps: { revision: 1 } });
    await waitFor(() => expect(detailRequest).toHaveBeenCalledOnce());
    await seed(latest);
    rerender({ revision: 2 });
    visibility.mockReturnValue("hidden");
    await act(async () => { pending.resolve(detail); });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(detailRequest).toHaveBeenCalledTimes(1);
    rerender({ revision: 3 });
    expect(detailRequest).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    rerender({ revision: 4 });
    await waitFor(() => expect(result.current.detail?.description).toBe("latest"));
    expect(detailRequest).toHaveBeenCalledTimes(2);
  });

  it("does not turn an AbortError into a displayed failure", async () => {
    await seed(detail);
    detailRequest.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const { result } = renderHook(() => useTaskDetail(projectId, taskId, 1, node));
    await waitFor(() => expect(detailRequest).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.detail).toBeNull();
  });
});

describe("detail freshness", () => {
  it("includes automation permission and external subsets in reviewed task identity", () => {
    const classified = { ...detail, dependsOn: [taskId, otherTask], externalDependsOn: [taskId, otherTask] };
    expect(taskReviewKey(classified)).toBe(taskReviewKey({ ...classified, externalDependsOn: [otherTask, taskId] }));
    expect(taskReviewKey(classified)).not.toBe(taskReviewKey({ ...classified, externalDependsOn: [otherTask] }));
    expect(taskReviewKey(classified)).not.toBe(taskReviewKey({ ...classified, allowAgents: true }));
    expect(isTaskStale({ ...node, allowAgents: true }, detail)).toBe(true);
    expect(isTaskStale({ ...node, requiredPlatform: 'linux' }, detail)).toBe(true);
    expect(taskDescriptor({ ...node, requiredPlatform: 'linux' })).not.toBe(taskDescriptor(node));
    expect(taskReviewKey({ ...detail, requiredPlatform: 'linux' })).not.toBe(taskReviewKey(detail));
    expect(taskDescriptor({ ...node, allowAgents: true })).not.toBe(taskDescriptor(node));
  });

  it("compares external subsets as sets and detects classification changes independently of task timestamps", () => {
    const dependencies = { dependsOn: [taskId, otherTask], blockedBy: [taskId, otherTask], ready: false };
    const classified = { ...node, ...dependencies, externalDependsOn: [taskId, otherTask] };
    const reordered = { ...detail, ...dependencies, externalDependsOn: [otherTask, taskId] };
    expect(isTaskStale(classified, reordered)).toBe(false);
    expect(taskDescriptor(classified)).toBe(taskDescriptor({ ...classified, externalDependsOn: [otherTask, taskId] }));
    expect(isTaskStale({ ...classified, externalDependsOn: [otherTask] }, reordered)).toBe(true);
    expect(taskDescriptor(classified)).not.toBe(taskDescriptor({ ...classified, externalDependsOn: [otherTask] }));
    expect(classified.updatedAt).toBe(reordered.updatedAt);
  });

  it("accepts the same fields and order-independent dependency sets", () => {
    expect(isTaskStale(node, detail)).toBe(false);
    expect(taskDescriptor({ ...node, dependsOn: [taskId, otherTask], blockedBy: [taskId, otherTask] })).toBe(
      taskDescriptor({ ...node, dependsOn: [otherTask, taskId], blockedBy: [otherTask, taskId] }));
    expect(isTaskStale({ ...node, dependsOn: [taskId, otherTask], blockedBy: [taskId, otherTask] },
      { ...detail, dependsOn: [otherTask, taskId], blockedBy: [otherTask, taskId] })).toBe(false);
  });

  it.each([
    undefined,
    { ...node, id: otherTask }, { ...node, updatedAt: "2026-10-21T12:00:00Z" }, { ...node, status: "done" as const },
    { ...node, ready: false }, { ...node, dependsOn: [otherTask] }, { ...node, blockedBy: [otherTask] },
    { ...node, titlePreview: "另一个标题" }, { ...node, titleTruncated: true },
  ])("detects changed snapshot-derived fields %#", (changed) => {
    expect(isTaskStale(changed, detail)).toBe(true);
  });

  it("detects a dependency completion changing readiness with no task updatedAt change", () => {
    const blocked = { ...node, dependsOn: [otherTask], blockedBy: [otherTask], ready: false };
    const newlyReady = { ...detail, dependsOn: [otherTask], blockedBy: [], ready: true };
    expect(blocked.updatedAt).toBe(newlyReady.updatedAt);
    expect(isTaskStale(blocked, newlyReady)).toBe(true);
  });

  it("compares Unicode code point previews without truncating a surrogate pair", () => {
    const title = "😀".repeat(161);
    expect(isTaskStale({ ...node, titlePreview: "😀".repeat(160), titleTruncated: true }, { ...detail, title })).toBe(false);
  });
});
