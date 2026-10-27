import type { ReactNode } from "react";
import { openDB } from "idb";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, getTaskSync, pauseAuthRequests } from "../src/api/client";
import type { TaskGraph, TaskSync } from "../src/api/types";
import { useTaskGraph } from "../src/features/projects/useTaskGraph";
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from "../src/features/task-cache/TaskCacheProvider";
import { TASK_CACHE_DATABASE, type TaskCacheSchema } from "../src/features/task-cache/database";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { taskSyncFromGraph, taskSyncEpoch, TEST_VIEWER_ID } from "./helpers/taskSync";

vi.mock("../src/api/client", async (original) => ({ ...await original<typeof import("../src/api/client")>(), getTaskSync: vi.fn() }));

const projectId = "10000000-0000-4000-8000-000000000001";
const otherProjectId = "10000000-0000-4000-8000-000000000002";
const otherUserId = "00000000-0000-4000-8000-000000000202";
const taskId = "20000000-0000-4000-8000-000000000001";
const graph = () => graphFixture([detailFixture(projectId, taskId)]);
const sync = (value: TaskGraph, version = 1n, epoch?: string) => taskSyncFromGraph(value, {
  query: { epoch: taskSyncEpoch(value.project.id) }, versionForTask: () => version, ...(epoch === undefined ? {} : { epoch }),
});
const scopes: TaskCacheScope[] = [];
const scope = (userId = TEST_VIEWER_ID) => {
  const cache = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  scopes.push(cache); return cache;
};
const seed = async (value = graph()) => {
  const cache = scope(); const signal = new AbortController().signal;
  const ticket = await cache.beginSync(value.project.id, signal);
  await cache.applySync(ticket, taskSyncFromGraph(value, { versionForTask: () => 1n }), signal);
  cache.dispose();
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const mount = (cache = scope(), id = projectId) => renderHook(({ projectId: currentId }) => useTaskGraph(currentId), {
  initialProps: { projectId: id },
  wrapper: ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={cache}>{children}</TaskCacheProvider>,
});

beforeEach(() => { vi.mocked(getTaskSync).mockReset(); });
afterEach(() => { scopes.splice(0).forEach((cache) => cache.dispose()); });

it("publishes cold durable data before sync, keeps online admission separate, and applies the background delta", async () => {
  await seed(); const cache = scope(); const pending = deferred<TaskSync>();
  vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  const { result } = mount(cache);
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  expect(result.current).toMatchObject({ status: "ready", error: null, snapshot: { observedAt: null, receivedAt: null } });
  expect(result.current.snapshot!.graph.summary.total).toBe(1);
  expect(cache.getAuthorizedProject(projectId)).toBeNull();
  expect(getTaskSync).toHaveBeenCalledWith(projectId, { epoch: taskSyncEpoch(projectId), since: graph().tasks[0]!.updatedAt }, TEST_VIEWER_ID, expect.any(AbortSignal), expect.any(Function));
  const fresh = graphFixture([detailFixture(projectId, taskId, { title: "Updated task", version: 2n })]);
  await act(async () => { pending.resolve(sync(fresh, 2n)); });
  await waitFor(() => expect(result.current.snapshot!.revision).toBeGreaterThan(0));
  expect(result.current.snapshot!.index.nodes.get(taskId)!.titlePreview).toBe("Updated task");
  expect(result.current.snapshot!.observedAt).toBe(fresh.observedAt);
  expect(cache.getAuthorizedProject(projectId)).not.toBeNull();
});

it.each([new ApiError("network"), new ApiError("server", 500, "internal_error")])("retains cached data and exposes a failed background sync %#", async (failure) => {
  await seed(); const pending = deferred<TaskSync>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  const { result } = mount();
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  const data = result.current.snapshot!.graph;
  await act(async () => { pending.reject(failure); });
  await waitFor(() => expect(result.current.error).toBe(failure));
  expect(result.current.status).toBe("ready"); expect(result.current.snapshot!.graph).toBe(data);
  expect(result.current.snapshot!.receivedAt).toBeNull();
  const retried = deferred<TaskSync>(); vi.mocked(getTaskSync).mockReturnValueOnce(retried.promise);
  act(() => { result.current.refresh(); });
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  expect(result.current).toMatchObject({ status: "ready", refreshing: true, error: failure });
  expect(result.current.snapshot!.graph).toBe(data);
  await act(async () => { retried.resolve(sync(graph())); });
  await waitFor(() => expect(result.current.snapshot!.revision).toBeGreaterThan(0));
  expect(result.current).toMatchObject({ refreshing: false, error: null });
});

it("displays a cached empty project before sync and atomically replaces history when the epoch changes", async () => {
  const empty = { ...graph(), tasks: [], summary: { total: 0, todo: 0, done: 0, inProgress: 0, ready: 0, blocked: 0 } };
  await seed(empty); const pending = deferred<TaskSync>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  const { result } = mount();
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  expect(result.current.snapshot!.graph.summary.total).toBe(0);
  await act(async () => { pending.resolve(sync(graph(), 1n, "30000000-0000-4000-8000-000000000002")); });
  await waitFor(() => expect(result.current.snapshot!.revision).toBeGreaterThan(0));
  expect(result.current.snapshot!.graph.summary.total).toBe(1);
});

it("retains loading without a baseline and keeps another user's and project's cached data isolated", async () => {
  await seed(); vi.mocked(getTaskSync).mockImplementation(() => new Promise(() => {}));
  const anotherUser = mount(scope(otherUserId));
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(1));
  expect(anotherUser.result.current).toMatchObject({ status: "loading", snapshot: null });
  const anotherProject = mount(scope(), otherProjectId);
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  expect(anotherProject.result.current).toMatchObject({ status: "loading", snapshot: null });
});

it("rebuilds corrupt local rows through the existing full sync without publishing an incomplete preview", async () => {
  await seed();
  const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, 1);
  await database.delete("summaries", [TEST_VIEWER_ID, projectId, taskId]); database.close();
  const pending = deferred<TaskSync>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  const { result } = mount();
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledOnce());
  expect(result.current).toMatchObject({ status: "loading", snapshot: null, error: null });
  expect(getTaskSync).toHaveBeenCalledWith(projectId, {}, TEST_VIEWER_ID, expect.any(AbortSignal), expect.any(Function));
  await act(async () => { pending.resolve(taskSyncFromGraph(graph(), { versionForTask: () => 1n })); });
  await waitFor(() => expect(result.current.snapshot!.revision).toBeGreaterThan(0));
  expect(result.current.snapshot!.graph.summary.total).toBe(1);
});

it("honors the foreground identity gate before displaying cached content", async () => {
  await seed(); const resume = pauseAuthRequests(); vi.mocked(getTaskSync).mockImplementation(() => new Promise(() => {}));
  const { result } = mount();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toMatchObject({ status: "loading", snapshot: null });
    expect(getTaskSync).not.toHaveBeenCalled();
  } finally { resume(); }
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
});

it("hides cached data immediately on an identity change and ignores the former user's late sync", async () => {
  await seed(); let currentScope = scope(); const pending = deferred<TaskSync>();
  vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise).mockImplementation(() => new Promise(() => {}));
  const { result, rerender } = renderHook(() => useTaskGraph(projectId), {
    wrapper: ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={currentScope}>{children}</TaskCacheProvider>,
  });
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  currentScope = scope(otherUserId); rerender();
  expect(result.current).toMatchObject({ status: "loading", snapshot: null });
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  await act(async () => { pending.resolve(sync(graph())); });
  expect(result.current.snapshot).toBeNull();
});

it("hides the previous project immediately and ignores its late background result", async () => {
  await seed(); const pending = deferred<TaskSync>();
  vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise).mockImplementation(() => new Promise(() => {}));
  const { result, rerender } = mount();
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  rerender({ projectId: otherProjectId });
  expect(result.current).toMatchObject({ status: "loading", snapshot: null });
  await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  await act(async () => { pending.resolve(sync(graph())); });
  expect(result.current.snapshot).toBeNull();
});

it("withdraws a cached preview and durable baseline when the live project check denies access", async () => {
  await seed(); const cache = scope(); const pending = deferred<TaskSync>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  const { result } = mount(cache);
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  const failure = new ApiError("server", 404, "not_found");
  await act(async () => { pending.reject(failure); });
  await waitFor(() => expect(result.current).toMatchObject({ status: "error", snapshot: null, error: failure }));
  expect(await cache.readProject(projectId, new AbortController().signal)).toBeNull();
});

it("does not resurrect a revoked cached generation from its late successful sync", async () => {
  await seed(); const cache = scope(); const pending = deferred<TaskSync>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  const { result } = mount(cache);
  await waitFor(() => expect(result.current.snapshot?.revision).toBe(0));
  const ticket = await cache.beginSync(projectId, new AbortController().signal);
  await act(async () => { await cache.revokeProject(ticket, new AbortController().signal); });
  expect(result.current.snapshot).toBeNull();
  await act(async () => { pending.resolve(sync(graph())); });
  expect(result.current.snapshot).toBeNull(); expect(cache.getAuthorizedProject(projectId)).toBeNull();
});
