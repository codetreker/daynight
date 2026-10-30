import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import type { TaskDetail } from "../src/api/types";
import { pauseAuthRequests } from "../src/api/client";
import { TaskCacheProvider } from "../src/features/task-cache/TaskCacheProvider";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TaskDetailSessionProvider, TaskDetailSessions, useTaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, TaskCacheError } from "../src/features/task-cache/database";
import { saveDetail } from "../src/features/task-detail/detail-cache";
import { useTaskDetail } from "../src/features/task-detail/useTaskDetail";
import { detailFixture, graphFixture, resourceResponse } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const prerequisite = "20000000-0000-4000-8000-000000000002";
const signal = () => new AbortController().signal;
const body = (changes: Partial<TaskDetail> = {}) => detailFixture(projectId, taskId, { title: "Task", version: 5n, ...changes });
const scopes: TaskCacheScope[] = [];
const sessions: TaskDetailSessions[] = [];
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const apply = async (scope: TaskCacheScope, details: readonly TaskDetail[], snapshot = false) => {
  const ticket = await scope.beginSync(projectId, signal());
  return scope.applySync(ticket, taskSyncFromGraph(graphFixture(details), { query: snapshot || ticket.epoch === null ? {} : { epoch: ticket.epoch }, ...(snapshot ? { epoch: "30000000-0000-4000-8000-000000000002" } : {}), versionForTask: (task) => details.find((detail) => detail.id === task.id)!.version, propertiesForTask: (task) => details.find((detail) => detail.id === task.id)!.properties }), signal());
};
const seed = async (details: readonly TaskDetail[]) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); await apply(scope, details); return scope;
};
const wrapper = (scope: TaskCacheScope) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{children}</TaskDetailSessionProvider></TaskCacheProvider>;
const node = (scope: TaskCacheScope) => scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)!;
const open = async (scope: TaskCacheScope) => {
  const session = new TaskDetailSessions(scope); sessions.push(session); session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 1, "open");
  await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false)); return session;
};
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); scopes.splice(0).forEach((scope) => scope.dispose()); });

it("keeps successful duplicate receipts free of detail GETs and persistent writes", async () => {
  const detail = body(); const scope = await seed([detail]); const fetch = vi.fn().mockResolvedValue(resourceResponse(detail, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node(scope)), { initialProps: { revision: 1 }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  const puts: string[] = []; const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) { puts.push(this.name); return original.apply(this, args); });
  for (let revision = 2; revision <= 4; revision++) {
    await act(async () => { await apply(scope, [detail]); }); rerender({ revision });
  }
  expect(fetch).toHaveBeenCalledOnce(); expect(puts).toEqual([]); expect(result.current.canSetStatus).toBe(true);
});

it("does not publish a disk body until this mount has a successful graph receipt, and never enables writes from disk", async () => {
  const detail = body({ description: "Private cached body" }); const scope = await seed([detail]);
  await saveDetail(scope, await scope.beginSync(projectId, signal()), detail, signal());
  const live = deferred<Response>(); const fetch = vi.fn().mockReturnValue(live.promise); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, node(scope)), { initialProps: { revision: 0 }, wrapper: wrapper(scope) });
  expect(result.current.detail).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  rerender({ revision: 1 }); await waitFor(() => expect(result.current.detail?.description).toBe(detail.description));
  expect(result.current.requiresFreshRead).toBe(true); expect(result.current.canSetStatus).toBe(false); expect(fetch).toHaveBeenCalledOnce();
  live.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => expect(result.current.canSetStatus).toBe(true));
});

it("keeps accepted preparation alive across cached reopening and still requires the reopened view's live GET", async () => {
  const detail = body(); const scope = await seed([detail]); const prepare = deferred<void>(); const fresh = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID))
    .mockReturnValueOnce(fresh.promise); vi.stubGlobal("fetch", fetch);
  const latest = { current: null as ReturnType<typeof useTaskDetail> | null }; const observed = node(scope);
  const Probe = ({ revision }: { readonly revision: number }) => { latest.current = useTaskDetail(projectId, taskId, revision, observed); return null; };
  const Host = ({ visible, revision }: { readonly visible: boolean; readonly revision: number }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{visible && <Probe revision={revision} />}</TaskDetailSessionProvider></TaskCacheProvider>;
  const view = render(<Host visible revision={1} />); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true));
  const transaction = scope.detailTransaction.bind(scope);
  const preparation = vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { await prepare.promise; return transaction(...args); });
  act(() => latest.current!.setStatus("todo", detail.version)); await waitFor(() => expect(preparation).toHaveBeenCalledOnce());
  view.rerender(<Host visible={false} revision={1} />); view.rerender(<Host visible revision={0} />);
  expect(latest.current).toMatchObject({ detail: null, requiresFreshRead: true, canSetStatus: false, canSetAgentPermission: false, canSetRequiredPlatform: false, canDelete: false,
    mutation: { phase: "pending" } });
  await act(async () => { prepare.resolve(); });
  await waitFor(() => expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1));
  await waitFor(() => expect(latest.current?.mutation.phase).toBe("confirmed"));
  expect(latest.current?.detail).toBeNull(); expect(latest.current?.canSetStatus).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
  view.rerender(<Host visible revision={1} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(latest.current?.requiresFreshRead).toBe(true); expect(latest.current?.canSetStatus).toBe(false);
  fresh.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true));
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
});

it("refreshes description-only versions even when a cross-tab graph update retains this mount receipt", async () => {
  const first = body({ description: "Old" }); const next = { ...first, version: 6n, description: "New" }; const scope = await seed([first]);
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(first, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(next, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ observed }) => useTaskDetail(projectId, taskId, 1, observed), { initialProps: { observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  await act(async () => { await apply(scope, [next]); }); rerender({ observed: node(scope) });
  await waitFor(() => expect(result.current.detail?.description).toBe("New")); expect(fetch).toHaveBeenCalledTimes(2);
});

it("retains complete raw PR values when nested metadata changes during a refresh", async () => {
  const first = body({ properties: { pullRequests: [{ url: "https://example.test/pr", title: "A PR", metadata: { state: "old" } }] } });
  const next = { ...first, version: 6n, properties: { pullRequests: [{ url: "https://example.test/pr", title: "A PR", metadata: { state: "new" } }] } };
  const scope = await seed([first]);
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(first, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(next, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ observed }) => useTaskDetail(projectId, taskId, 1, observed), { initialProps: { observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  await act(async () => { await apply(scope, [next]); }); rerender({ observed: node(scope) });
  await waitFor(() => expect(result.current.detail?.version).toBe(next.version));
  expect(result.current.detail?.properties.pullRequests).toEqual(next.properties.pullRequests);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("rematerializes same-version dependency readiness without downloading the successor", async () => {
  const before = body({ dependsOn: [prerequisite], blockedBy: [prerequisite], ready: false });
  const dependency = detailFixture(projectId, prerequisite, { title: "Prerequisite" }); const scope = await seed([before, dependency]);
  const fetch = vi.fn().mockResolvedValue(resourceResponse(before, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ observed }) => useTaskDetail(projectId, taskId, 1, observed), { initialProps: { observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  await act(async () => { await apply(scope, [before, { ...dependency, version: 2n, status: "done", completedAt: dependency.updatedAt }]); }); rerender({ observed: node(scope) });
  await waitFor(() => expect(result.current.detail?.ready).toBe(true));
  expect(result.current.detail?.blockedBy).toEqual([]); expect(result.current.canSetStatus).toBe(true); expect(fetch).toHaveBeenCalledOnce();
});

it("preserves raw server derived mismatch evidence and requests graph recovery before local materialization", async () => {
  const detail = body(); const scope = await seed([detail]); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(resourceResponse({ ...detail, ready: false }, TEST_VIEWER_ID)));
  const session = new TaskDetailSessions(scope); sessions.push(session); const refresh = vi.fn(); session.subscribeProject(projectId, refresh); session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 1, "open");
  await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("ready"));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { ready: true }, requiresFreshRead: true, graphMismatch: true }); expect(refresh).toHaveBeenCalledOnce();
});

it("holds newer detail until matching summary, without advancing the project watermark or repeating GET", async () => {
  const first = body(); const next = { ...first, version: 6n, description: "New", updatedAt: "2026-10-22T10:00:20Z" }; const scope = await seed([first]);
  const fetch = vi.fn().mockResolvedValue(resourceResponse(next, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const session = new TaskDetailSessions(scope); sessions.push(session); const refresh = vi.fn(); session.subscribeProject(projectId, refresh); session.observe(projectId, taskId, node(scope));
  const watermark = (await scope.beginSync(projectId, signal())).maxUpdatedAt; session.load(projectId, taskId, 1, "open");
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); expect(session.snapshot(projectId, taskId).detail).toBeNull();
  expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(watermark);
  await apply(scope, [next]); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.snapshot(projectId, taskId).detail?.description).toBe("New")); expect(fetch).toHaveBeenCalledOnce();
});

it("rejects a late pre-snapshot response without restoring the private body", async () => {
  const detail = body(); const scope = await seed([detail]); const live = deferred<Response>(); const fetch = vi.fn().mockReturnValue(live.promise); vi.stubGlobal("fetch", fetch);
  const session = new TaskDetailSessions(scope); sessions.push(session); session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 1, "open");
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); const transactions = vi.spyOn(scope, "detailTransaction");
  await apply(scope, [detail], true); live.resolve(resourceResponse(detail, TEST_VIEWER_ID));
  await waitFor(() => expect(transactions).toHaveBeenCalledOnce());
  await expect(transactions.mock.results[0]!.value).rejects.toMatchObject({ name: "AbortError" });
  expect(session.snapshot(projectId, taskId).detail).toBeNull();
});

it("keeps a confirmed remote write distinct from a malformed successful body and reconciles only with GET", async () => {
  const detail = body(); const saved = { ...detail, version: 6n, allowAgents: true, updatedAt: "2026-10-22T10:00:20Z" }; const scope = await seed([detail]);
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse({ invalid: true }, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.setAgentPermission(projectId, taskId, true, detail.version);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"); expect(fetch.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
  await apply(scope, [saved]); session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(session.snapshot(projectId, taskId).detail?.allowAgents).toBe(true));
  expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed");
});

it("retains confirmed operation state and successful content across cache quota failure, then retries only GET", async () => {
  const detail = body(); const saved = { ...detail, version: 6n, allowAgents: true, updatedAt: "2026-10-22T10:00:20Z" }; const scope = await seed([detail]);
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)).mockImplementation(() => Promise.resolve(resourceResponse(saved, TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.setAgentPermission(projectId, taskId, true, detail.version);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  await apply(scope, [saved]);
  const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "details") throw new DOMException("Injected quota", "QuotaExceededError"); return original.apply(this, args);
  });
  session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.snapshot(projectId, taskId).error).toMatchObject({ category: "storage" }));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 6n, allowAgents: true }, mutation: { phase: "confirmed" } });
  fault.mockRestore(); session.load(projectId, taskId, 2, "refresh");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ error: null, refreshing: false }));
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1); expect(fetch).toHaveBeenCalledTimes(3);
});

it("queues only changed content behind a slow GET and never publishes the old version", async () => {
  const first = body({ description: "Old" }); const next = { ...first, version: 6n, description: "New" }; const scope = await seed([first]); const live = deferred<Response>();
  const fetch = vi.fn().mockReturnValueOnce(live.promise).mockResolvedValueOnce(resourceResponse(next, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ observed, revision }) => useTaskDetail(projectId, taskId, revision, observed), { initialProps: { observed: node(scope), revision: 1 }, wrapper: wrapper(scope) });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); rerender({ observed: node(scope), revision: 2 });
  await act(async () => { await apply(scope, [next]); }); rerender({ observed: node(scope), revision: 3 });
  live.resolve(resourceResponse(first, TEST_VIEWER_ID));
  await waitFor(() => expect(result.current.detail?.description).toBe("New")); expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.canSetStatus).toBe(true);
});

it("keeps submitted writes alive after close, while reopening still requires its own live GET", async () => {
  const detail = body(); const saved = { ...detail, version: 6n, allowAgents: true, updatedAt: "2026-10-22T10:00:20Z" }; const scope = await seed([detail]);
  const write = deferred<Response>(); const fresh = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockReturnValueOnce(write.promise).mockReturnValueOnce(fresh.promise); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); const close = session.subscribe(projectId, taskId, vi.fn());
  session.setAgentPermission(projectId, taskId, true, detail.version); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  session.setRequiredPlatform(projectId, taskId, "linux", detail.version); expect(fetch).toHaveBeenCalledTimes(2);
  close(); write.resolve(resourceResponse(saved, TEST_VIEWER_ID)); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  await apply(scope, [saved]); session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 2, "open");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(true);
  fresh.resolve(resourceResponse(saved, TEST_VIEWER_ID)); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false));
  expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"); expect(fetch.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
});

it("drops the prior generation's committed-version floor and live authority after history replacement", async () => {
  const detail = body(); const restored = body({ version: 1n, description: "Restored history" }); const scope = await seed([detail]);
  const live = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockReturnValueOnce(live.promise); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.setStatus(projectId, taskId, "todo", detail.version);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  await apply(scope, [restored], true); session.observe(projectId, taskId, node(scope));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, loadedRevision: null, requiresFreshRead: true, mutation: { phase: "confirmed" } }); session.load(projectId, taskId, 2, "automatic");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3)); live.resolve(resourceResponse(restored, TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 1n, description: "Restored history" }, requiresFreshRead: false }));
});

it("shows a valid confirmed write's raw authoritative body while summary sync is behind, without advancing coverage", async () => {
  const detail = body(); const saved = { ...detail, version: 6n, status: "in_progress" as const, ready: false, startedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" }; const scope = await seed([detail]);
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); const watermark = (await scope.beginSync(projectId, signal())).maxUpdatedAt;
  session.setStatus(projectId, taskId, "in_progress", detail.version);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 6n, status: "in_progress", ready: false }, requiresFreshRead: true, graphMismatch: true });
  expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n); expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(watermark);
  const { openDB } = await import("idb"); const connection = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  expect((await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).detail.version).toBe(5n); connection.close();
  await apply(scope, [saved]); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ requiresFreshRead: false, graphMismatch: false })); expect(fetch).toHaveBeenCalledTimes(2);
});


it("retains already admitted content during same-user foreground identity revalidation", async () => {
  const detail = body(); const scope = await seed([detail]); const fetch = vi.fn().mockResolvedValue(resourceResponse(detail, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const observed = node(scope);
  const { result, rerender } = renderHook(({ revision }) => useTaskDetail(projectId, taskId, revision, observed), { initialProps: { revision: 1 }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  const resume = pauseAuthRequests();
  try {
    // The parent retains its existing graph while the ordinary request gate is paused.
    expect(() => rerender({ revision: 2 })).not.toThrow();
    expect(result.current.detail?.id).toBe(observed.id); expect(fetch).toHaveBeenCalledOnce();
  } finally { resume(); }
});


it("clears same-version private content immediately on a new generation and keeps it absent through GET failure", async () => {
  const old = body({ description: "E1 private description", properties: { pullRequests: [{ url: "https://example.test/old", title: "E1 private PR" }] } });
  const restored = { ...old, description: "E2 restored description", properties: { pullRequests: [{ url: "https://example.test/new", title: "E2 restored PR" }] } };
  const scope = await seed([old]); const held = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(old, TEST_VIEWER_ID)).mockReturnValueOnce(held.promise).mockResolvedValueOnce(resourceResponse(restored, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => useTaskDetail(projectId, taskId, revision, observed), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  const oldTicket = await scope.beginSync(projectId, signal());
  await act(async () => { await apply(scope, [restored], true); });
  rerender({ revision: 2, observed: node(scope) });
  expect(result.current.detail).toBeNull(); expect(result.current.loadedRevision).toBeNull(); expect(result.current.canSetStatus).toBe(false);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  held.reject(new Error("Disconnected after history replacement"));
  await waitFor(() => expect(result.current.status).toBe("error"));
  expect(result.current.detail).toBeNull(); expect(result.current.loadedRevision).toBeNull(); expect(result.current.error).toMatchObject({ kind: "network" });
  await expect(saveDetail(scope, oldTicket, old, signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(result.current.detail).toBeNull();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.detail?.description).toBe(restored.description));
  expect(result.current.detail?.properties.pullRequests).toEqual(restored.properties.pullRequests); expect(result.current.canSetStatus).toBe(true);
  expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(oldTicket.maxUpdatedAt);
});

it("retains an admitted body through a failed refresh within the same generation", async () => {
  const detail = body({ description: "Retained current-generation body" }); const scope = await seed([detail]); const held = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockReturnValueOnce(held.promise); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.load(projectId, taskId, 2, "refresh");
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); expect(session.snapshot(projectId, taskId).detail?.description).toBe(detail.description);
  held.reject(new Error("Disconnected during current generation refresh"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).error).toMatchObject({ kind: "network" }));
  expect(session.snapshot(projectId, taskId).detail?.description).toBe(detail.description); expect(session.snapshot(projectId, taskId).loadedRevision).toBe(1);
});


it("keeps unknown write intent while dropping the old generation's body and reconciliation read", async () => {
  const detail = body({ description: "E1 private body" }); const restored = { ...detail, description: "E2 private body" }; const scope = await seed([detail]);
  const oldRead = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Write result lost"))
    .mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(resourceResponse(restored, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.setAgentPermission(projectId, taskId, true, detail.version);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: true });
  const oldSignal = fetch.mock.calls[2]![1]!.signal as AbortSignal;
  await apply(scope, [restored], true); session.observe(projectId, taskId, node(scope));
  expect(oldSignal.aborted).toBe(true);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, loadedRevision: null, mutation: { operation: { action: "allowAgents", allowAgents: true, version: detail.version }, phase: "unknown", reconciling: false } });
  oldRead.resolve(resourceResponse(detail, TEST_VIEWER_ID)); session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { description: restored.description }, mutation: { phase: "reconciled" } }));
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
});


it.each(["confirmed", "refused"] as const)("requires a new opening's live GET after a pending same-version write is %s", async (outcome) => {
  const detail = body(); const scope = await seed([detail]); const heldWrite = deferred<Response>(); const heldRead = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockReturnValueOnce(heldWrite.promise).mockReturnValueOnce(heldRead.promise); vi.stubGlobal("fetch", fetch);
  const latest = { current: null as ReturnType<typeof useTaskDetail> | null }; const observed = node(scope);
  const Probe = () => { latest.current = useTaskDetail(projectId, taskId, 1, observed); return null; };
  const Host = ({ visible }: { readonly visible: boolean }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{visible && <Probe />}</TaskDetailSessionProvider></TaskCacheProvider>;
  const view = render(<Host visible />); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true));
  act(() => latest.current!.setStatus("todo", detail.version)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  view.rerender(<Host visible={false} />); view.rerender(<Host visible />);
  expect(latest.current?.mutation.phase).toBe("pending"); expect(latest.current?.canSetStatus).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
  heldWrite.resolve(outcome === "confirmed" ? resourceResponse(detail, TEST_VIEWER_ID) : new Response(JSON.stringify({ error: { code: "forbidden", message: "Denied", requestId: "opening-denied" } }), { status: 403, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(latest.current?.mutation.phase).toBe(outcome); expect(latest.current?.canSetStatus).toBe(false); expect(latest.current?.requiresFreshRead).toBe(true);
  heldRead.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true));
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
});

it("coalesces a second view's required fresh GET after a pending no-op write while retaining the first view", async () => {
  const detail = body(); const scope = await seed([detail]); const heldWrite = deferred<Response>(); const heldRead = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockReturnValueOnce(heldWrite.promise).mockReturnValueOnce(heldRead.promise); vi.stubGlobal("fetch", fetch);
  const latest: Array<ReturnType<typeof useTaskDetail> | null> = [null, null]; const observed = node(scope);
  const Probe = ({ index }: { readonly index: number }) => { latest[index] = useTaskDetail(projectId, taskId, 1, observed); return null; };
  const Host = ({ second }: { readonly second: boolean }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe index={0} />{second && <Probe index={1} />}</TaskDetailSessionProvider></TaskCacheProvider>;
  const view = render(<Host second={false} />); await waitFor(() => expect(latest[0]?.canSetStatus).toBe(true));
  act(() => latest[0]!.setStatus("todo", detail.version)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); view.rerender(<Host second />);
  expect(latest[1]?.mutation.phase).toBe("pending"); expect(fetch).toHaveBeenCalledTimes(2);
  heldWrite.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(latest[0]?.canSetStatus).toBe(false); expect(latest[1]?.canSetStatus).toBe(false);
  heldRead.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => { expect(latest[0]?.canSetStatus).toBe(true); expect(latest[1]?.canSetStatus).toBe(true); });
  expect(fetch).toHaveBeenCalledTimes(3); expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
});

it("does not let reconciliation started before reopening satisfy the new opening's live read", async () => {
  const detail = body(); const scope = await seed([detail]); const oldRead = deferred<Response>(); const freshRead = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Unknown write outcome"))
    .mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise); vi.stubGlobal("fetch", fetch);
  const latest = { current: null as ReturnType<typeof useTaskDetail> | null }; const observed = node(scope);
  const Probe = () => { latest.current = useTaskDetail(projectId, taskId, 1, observed); return null; };
  const Host = ({ visible }: { readonly visible: boolean }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{visible && <Probe />}</TaskDetailSessionProvider></TaskCacheProvider>;
  const view = render(<Host visible />); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true));
  act(() => latest.current!.setStatus("todo", detail.version)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  view.rerender(<Host visible={false} />); view.rerender(<Host visible />); expect(latest.current?.mutation.reconciling).toBe(true);
  oldRead.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  expect(latest.current?.mutation.phase).toBe("reconciled"); expect(latest.current?.canSetStatus).toBe(false);
  freshRead.resolve(resourceResponse(detail, TEST_VIEWER_ID)); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true));
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
});


it.each(["done", "todo"] as const)("reconciles a lost write when current summaries skip its pending version and final status is %s", async (status) => {
  const initial = body();
  const intermediate = { ...initial, version: 6n, status: "done" as const, ready: false, completedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" };
  const current = { ...intermediate, version: 7n, status, ready: status === "todo", completedAt: status === "done" ? intermediate.completedAt : null,
    description: "Current content after another edit", properties: { pullRequests: [{ url: "https://example.test/current", title: "Current PR" }] }, updatedAt: "2026-10-22T10:00:21Z" };
  const scope = await seed([initial]); const fresh = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Write result lost"))
    .mockResolvedValueOnce(resourceResponse(intermediate, TEST_VIEWER_ID)).mockReturnValueOnce(fresh.promise); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => ({ ...useTaskDetail(projectId, taskId, revision, observed), sessions: useTaskDetailSessions() }), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); const refresh = vi.fn(); const unsubscribe = result.current.sessions.subscribeProject(projectId, refresh);
  act(() => result.current.setStatus("done", initial.version)); await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledTimes(3); expect(result.current.mutation).toMatchObject({ phase: "unknown", reconciling: true });
  for (const revision of [2, 3]) { await act(async () => { await apply(scope, [initial]); }); rerender({ revision, observed: node(scope) }); }
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => { await apply(scope, [current]); }); rerender({ revision: 4, observed: node(scope) });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4)); expect(result.current.canSetStatus).toBe(false);
  expect(result.current.mutation).toMatchObject({ operation: { action: "status", status: "done", version: initial.version }, phase: "unknown", reconciling: true });
  const { openDB } = await import("idb"); const connection = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  expect(await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
  fresh.resolve(resourceResponse(current, TEST_VIEWER_ID));
  await waitFor(() => expect(result.current.mutation).toMatchObject({ phase: "reconciled", reconciling: false, reconciliationError: null }));
  expect(result.current.detail?.version).toBe(7n); expect(result.current.detail?.status).toBe(status); expect(result.current.canSetStatus).toBe(true);
  expect(result.current.mutation.operation).toEqual({ action: "status", status: "done", version: initial.version });
  expect((await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).detail.version).toBe(7n); connection.close();
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1); unsubscribe();
});

it.each(["server", "stale"] as const)("keeps skipped-version reconciliation recoverable after a %s read failure and a new opening", async (failure) => {
  const initial = body(); const intermediate = { ...initial, version: 6n, status: "done" as const, ready: false, completedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" };
  const current = { ...intermediate, version: 7n, description: "Version seven material", updatedAt: "2026-10-22T10:00:21Z" }; const scope = await seed([initial]);
  const retry = deferred<Response>(); const failedResponse = failure === "stale" ? resourceResponse(intermediate, TEST_VIEWER_ID) : new Response(JSON.stringify({ error: { code: "internal_error", message: "Read failed", requestId: "pending-read-failed" } }), { status: 503, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Lost PUT response"))
    .mockResolvedValueOnce(resourceResponse(intermediate, TEST_VIEWER_ID)).mockResolvedValueOnce(failedResponse).mockReturnValueOnce(retry.promise); vi.stubGlobal("fetch", fetch);
  const latest = { current: null as ReturnType<typeof useTaskDetail> | null, sessions: null as TaskDetailSessions | null }; let observed = node(scope);
  const Probe = ({ revision }: { readonly revision: number }) => { latest.sessions = useTaskDetailSessions(); latest.current = useTaskDetail(projectId, taskId, revision, observed); return null; };
  const Host = ({ visible, revision }: { readonly visible: boolean; readonly revision: number }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{visible && <Probe revision={revision} />}</TaskDetailSessionProvider></TaskCacheProvider>;
  const view = render(<Host visible revision={1} />); await waitFor(() => expect(latest.current?.canSetStatus).toBe(true)); const refresh = vi.fn(); const unsubscribe = latest.sessions!.subscribeProject(projectId, refresh);
  act(() => latest.current!.setStatus("done", initial.version)); await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  view.rerender(<Host visible={false} revision={1} />); view.rerender(<Host visible revision={2} />);
  expect(latest.current?.canSetStatus).toBe(false); expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => { await apply(scope, [current]); }); observed = node(scope); view.rerender(<Host visible revision={3} />);
  await waitFor(() => expect(latest.current?.mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: { kind: failure === "stale" ? "protocol" : "server" } }));
  expect(fetch).toHaveBeenCalledTimes(4); expect(latest.current?.requiresFreshRead).toBe(true); expect(latest.current?.canSetStatus).toBe(false);
  for (const revision of [4, 5]) { await act(async () => { await apply(scope, [current]); }); view.rerender(<Host visible revision={revision} />); }
  expect(fetch).toHaveBeenCalledTimes(4);
  act(() => latest.current!.reconcile()); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5)); expect(latest.current?.canSetStatus).toBe(false);
  retry.resolve(resourceResponse(current, TEST_VIEWER_ID)); await waitFor(() => expect(latest.current?.mutation).toMatchObject({ phase: "reconciled", reconciling: false, reconciliationError: null }));
  expect(latest.current?.detail?.version).toBe(7n); expect(latest.current?.canSetStatus).toBe(true); expect(latest.current?.mutation.operation).toEqual({ action: "status", status: "done", version: 5n });
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1); unsubscribe();
});

it("retains a confirmed future payload through duplicate receipts and admits an exact matching summary without GET", async () => {
  const initial = body(); const saved = { ...initial, version: 6n, status: "done" as const, ready: false, completedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" };
  const scope = await seed([initial]); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => useTaskDetail(projectId, taskId, revision, observed), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); act(() => result.current.setStatus("done", initial.version));
  await waitFor(() => expect(result.current.mutation.phase).toBe("confirmed")); expect(result.current.detail?.version).toBe(6n); expect(result.current.canSetStatus).toBe(false);
  for (const revision of [2, 3]) { await act(async () => { await apply(scope, [initial]); }); rerender({ revision, observed: node(scope) }); }
  expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.detail?.version).toBe(6n);
  await act(async () => { await apply(scope, [saved]); }); rerender({ revision: 4, observed: node(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); expect(result.current.detail?.version).toBe(6n); expect(fetch).toHaveBeenCalledTimes(2);
});


it("ends exact-match pending reconciliation after storage admission fails and allows GET-only Retry", async () => {
  const initial = body(); const saved = { ...initial, version: 6n, status: "done" as const, ready: false, completedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" }; const scope = await seed([initial]);
  const retry = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Lost PUT"))
    .mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)).mockReturnValueOnce(retry.promise); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => ({ ...useTaskDetail(projectId, taskId, revision, observed), sessions: useTaskDetailSessions() }), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); const refresh = vi.fn(); const unsubscribe = result.current.sessions.subscribeProject(projectId, refresh);
  act(() => result.current.setStatus("done", initial.version)); await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(result.current.mutation).toMatchObject({ phase: "unknown", reconciling: true }); await act(async () => { await apply(scope, [saved]); });
  const failure = new TaskCacheError("storage", new DOMException("Injected admission failure", "UnknownError"));
  const fault = vi.spyOn(scope, "detailTransaction").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
  rerender({ revision: 2, observed: node(scope) });
  await waitFor(() => expect(result.current.mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: failure }));
  expect(fault).toHaveBeenCalledTimes(2); expect(result.current.canSetStatus).toBe(false); expect(result.current.requiresFreshRead).toBe(true); expect(fetch).toHaveBeenCalledTimes(3);
  fault.mockRestore(); act(() => result.current.reconcile()); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
  expect(result.current.mutation.reconciling).toBe(true); retry.resolve(resourceResponse(saved, TEST_VIEWER_ID));
  await waitFor(() => expect(result.current.mutation).toMatchObject({ phase: "reconciled", reconciling: false, reconciliationError: null }));
  expect(result.current.detail?.version).toBe(6n); expect(result.current.canSetStatus).toBe(true); expect(result.current.mutation.operation).toEqual({ action: "status", status: "done", version: 5n });
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1); unsubscribe();
});

it("does not let an old pending admission failure finalize a newer generation's active reconciliation", async () => {
  const initial = body(); const saved = { ...initial, version: 6n, status: "done" as const, ready: false, completedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" };
  const restored = body({ version: 1n, description: "Restored current generation" }); const scope = await seed([initial]); const fresh = deferred<Response>(); const oldGuard = deferred<never>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Lost PUT"))
    .mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)).mockReturnValueOnce(fresh.promise); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => ({ ...useTaskDetail(projectId, taskId, revision, observed), sessions: useTaskDetailSessions() }), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); const refresh = vi.fn(); const unsubscribe = result.current.sessions.subscribeProject(projectId, refresh);
  act(() => result.current.setStatus("done", initial.version)); await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); await act(async () => { await apply(scope, [saved]); });
  const failure = new TaskCacheError("storage"); const fault = vi.spyOn(scope, "detailTransaction").mockRejectedValueOnce(failure).mockImplementationOnce(() => oldGuard.promise);
  rerender({ revision: 2, observed: node(scope) }); await waitFor(() => expect(fault).toHaveBeenCalledTimes(2));
  await act(async () => { await apply(scope, [restored], true); }); rerender({ revision: 3, observed: node(scope) }); act(() => result.current.reconcile());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4)); expect(result.current.mutation).toMatchObject({ phase: "unknown", reconciling: true, reconciliationError: null });
  await act(async () => { oldGuard.reject(failure); await expect(oldGuard.promise).rejects.toBe(failure); });
  expect(result.current.mutation).toMatchObject({ phase: "unknown", reconciling: true, reconciliationError: null }); expect(result.current.detail).toBeNull();
  fresh.resolve(resourceResponse(restored, TEST_VIEWER_ID)); await waitFor(() => expect(result.current.mutation.phase).toBe("reconciled"));
  expect(result.current.detail?.description).toBe(restored.description); expect(result.current.canSetStatus).toBe(true);
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1); fault.mockRestore(); unsubscribe();
});

it("ends pending reconciliation if the summary advances after matching persistence but before publication", async () => {
  const initial = body(); const saved = { ...initial, version: 6n, status: "done" as const, ready: false, completedAt: "2026-10-22T10:00:20Z", updatedAt: "2026-10-22T10:00:20Z" };
  const current = { ...saved, version: 7n, description: "Current after admission commit", updatedAt: "2026-10-22T10:00:21Z" }; const scope = await seed([initial]);
  const fresh = deferred<Response>(); const committed = deferred<void>(); const publish = deferred<void>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Lost PUT"))
    .mockResolvedValueOnce(resourceResponse(saved, TEST_VIEWER_ID)).mockReturnValueOnce(fresh.promise); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => ({ ...useTaskDetail(projectId, taskId, revision, observed), sessions: useTaskDetailSessions() }), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); const refresh = vi.fn(); const unsubscribe = result.current.sessions.subscribeProject(projectId, refresh);
  act(() => result.current.setStatus("done", initial.version)); await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); await act(async () => { await apply(scope, [saved]); });
  const original = scope.detailTransaction.bind(scope); const fault = vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => {
    const result = await original(...args); committed.resolve(); await publish.promise; return result;
  });
  rerender({ revision: 2, observed: node(scope) }); await committed.promise;
  await act(async () => { await apply(scope, [current]); }); rerender({ revision: 3, observed: node(scope) });
  await act(async () => { publish.resolve(); });
  await waitFor(() => expect(result.current.mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: { kind: "protocol" } }));
  expect(result.current.detail?.version).toBe(5n); expect(fetch).toHaveBeenCalledTimes(3); fault.mockRestore();
  act(() => result.current.reconcile()); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4)); fresh.resolve(resourceResponse(current, TEST_VIEWER_ID));
  await waitFor(() => expect(result.current.mutation.phase).toBe("reconciled")); expect(result.current.detail?.version).toBe(7n); expect(result.current.canSetStatus).toBe(true);
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1); unsubscribe();
});

it("keeps ordinary skipped-version failures visible and clears their blockers on ordinary Retry", async () => {
  const initial = body(); const six = { ...initial, version: 6n, updatedAt: "2026-10-22T10:00:06Z" }; const seven = { ...six, version: 7n, description: "Future seven", updatedAt: "2026-10-22T10:00:07Z" };
  const eight = { ...seven, version: 8n, description: "Current eight", updatedAt: "2026-10-22T10:00:08Z" }; const scope = await seed([initial]); const failed = deferred<Response>(); const retry = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(initial, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(seven, TEST_VIEWER_ID)).mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ revision, observed }) => ({ ...useTaskDetail(projectId, taskId, revision, observed), sessions: useTaskDetailSessions() }), { initialProps: { revision: 1, observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); const refresh = vi.fn(); const stop = result.current.sessions.subscribeProject(projectId, refresh);
  await act(async () => { await apply(scope, [six]); }); rerender({ revision: 2, observed: node(scope) }); await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await act(async () => { await apply(scope, [eight]); }); rerender({ revision: 3, observed: node(scope) }); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  failed.reject(new Error("Ordinary read offline")); await waitFor(() => expect(result.current.error).toMatchObject({ kind: "network" }));
  expect(result.current.mutation).toMatchObject({ operation: null, phase: "idle", reconciling: false, reconciliationError: null });
  act(() => result.current.retry()); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4)); retry.resolve(resourceResponse(eight, TEST_VIEWER_ID));
  await waitFor(() => expect(result.current.canSetStatus).toBe(true)); expect(result.current.canSetAgentPermission).toBe(true); expect(result.current.canSetRequiredPlatform).toBe(true);
  expect(result.current.error).toBeNull(); expect(result.current.mutation).toMatchObject({ operation: null, phase: "idle", reconciliationError: null });
  expect(fetch.mock.calls.every((call) => call[1]?.method === undefined)).toBe(true); stop();
});

it("revokes known cached detail admission after a trusted 404 before an offline Retry can restore it", async () => {
  const detail = body({ description: "Private cached body" }); const scope = await seed([detail]);
  const notFound = new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "detail-denied" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(detail, TEST_VIEWER_ID)).mockResolvedValueOnce(notFound).mockRejectedValue(new Error("Offline")); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.load(projectId, taskId, 2, "open");
  await waitFor(() => expect(session.snapshot(projectId, taskId).detail).toBeNull()); await waitFor(() => expect(scope.getAuthorizedProject(projectId)).toBeNull());
  session.load(projectId, taskId, 3, "refresh"); expect(session.snapshot(projectId, taskId).detail).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  const { openDB } = await import("idb"); const connection = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await waitFor(async () => expect(await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined()); connection.close();
});

it("withdraws known detail access when its trusted 404 arrives during foreground revalidation", async () => {
  const value = body(); const scope = await seed([value]); const response = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockReturnValueOnce(response.promise); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.load(projectId, taskId, 2, "open"); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); const resume = pauseAuthRequests();
  response.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "paused-denied" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
  try { await waitFor(() => expect(session.snapshot(projectId, taskId).detail).toBeNull()); expect(session.snapshot(projectId, taskId).status).toBe("error"); }
  finally { resume(); }
  await waitFor(() => expect(scope.getAuthorizedProject(projectId)).toBeNull()); session.load(projectId, taskId, 3, "refresh"); expect(session.snapshot(projectId, taskId).detail).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
});

it("retains allowed cached content after a headerless 404 protocol error", async () => {
  const value = body(); const scope = await seed([value]); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockResolvedValueOnce(new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } })); vi.stubGlobal("fetch", fetch);
  const session = await open(scope); session.load(projectId, taskId, 2, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).error).toMatchObject({ kind: "protocol", status: 404 }));
  expect(session.snapshot(projectId, taskId).detail?.id).toBe(taskId); expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
});

it.each(["status", "allowAgents", "requiredPlatform"] as const)("revokes accepted project content on a trusted %s write 404 without replaying it", async (action) => {
  const value = body(); const scope = await seed([value]); const missing = new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "write-denied" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockResolvedValueOnce(missing); vi.stubGlobal("fetch", fetch); const session = await open(scope);
  if (action === "status") session.setStatus(projectId, taskId, "done", value.version); else if (action === "allowAgents") session.setAgentPermission(projectId, taskId, true, value.version); else session.setRequiredPlatform(projectId, taskId, "linux", value.version);
  await waitFor(() => expect(scope.getAuthorizedProject(projectId)).toBeNull()); expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, requiresFreshRead: true, mutation: { phase: "refused" } }); expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not let a late old-generation mutation 404 clear a newer task's accepted body", async () => {
  const value = body(); const scope = await seed([value]); const write = deferred<Response>(); const otherId = "20000000-0000-4000-8000-000000000009"; const other = detailFixture(projectId, otherId, { title: "New history body", description: "E2 private content" });
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockReturnValueOnce(write.promise).mockResolvedValueOnce(resourceResponse(other, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); const session = await open(scope);
  session.setStatus(projectId, taskId, "done", value.version); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); await apply(scope, [value, other], true);
  session.observe(projectId, taskId, node(scope)); session.observe(projectId, otherId, scope.getAuthorizedProject(projectId)!.index.nodes.get(otherId)); session.load(projectId, otherId, 2, "open");
  await waitFor(() => expect(session.snapshot(projectId, otherId).detail?.description).toBe(other.description));
  write.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "late-old-denied" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("refused")); expect(session.snapshot(projectId, otherId).detail?.description).toBe(other.description); expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
});


it("keeps a nonexistent task's trusted 404 local to that task without revoking its authorized project", async () => {
  const value = body(); const scope = await seed([value]); const ticket = await scope.beginSync(projectId, signal()); await saveDetail(scope, ticket, value, signal());
  const missingId = "20000000-0000-4000-8000-000000000099"; const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "unknown-task" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) })); vi.stubGlobal("fetch", fetch);
  const session = new TaskDetailSessions(scope); sessions.push(session); session.observe(projectId, missingId, undefined); session.load(projectId, missingId, 1, "open");
  await waitFor(() => expect(session.snapshot(projectId, missingId).error).toMatchObject({ kind: "server", code: "not_found" })); expect(scope.getAuthorizedProject(projectId)).not.toBeNull();
  const { openDB } = await import("idb"); const connection = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); expect(await connection.get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeDefined(); connection.close();
});

it.each(["status", "allowAgents", "requiredPlatform"] as const)("withdraws the live scope and peer cache after a disposed session's trusted %s write 404", async (action) => {
  const value = body(); const scope = await seed([value]); const peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(peer); await apply(peer, [value]); const peerTicket = await peer.beginSync(projectId, signal());
  const write = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockReturnValueOnce(write.promise); vi.stubGlobal("fetch", fetch); const session = await open(scope);
  const listener = vi.fn(); session.subscribe(projectId, taskId, listener);
  if (action === "status") session.setStatus(projectId, taskId, "done", value.version); else if (action === "allowAgents") session.setAgentPermission(projectId, taskId, true, value.version); else session.setRequiredPlatform(projectId, taskId, "linux", value.version);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); session.dispose(); listener.mockClear(); expect(scope.isInvalidated).toBe(false);
  write.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "disposed-write-denied" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
  await waitFor(() => expect(scope.getAuthorizedProject(projectId)).toBeNull()); await waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, requiresFreshRead: true, mutation: { phase: "refused", error: { kind: "server", code: "not_found", requestId: "disposed-write-denied" } } });
  await expect(peer.detailTransaction(peerTicket, signal(), async () => "private")).rejects.toMatchObject({ name: "AbortError" });
  expect(listener).not.toHaveBeenCalled(); expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT" || call[1]?.method === "PATCH")).toHaveLength(1);
});

it.each(["missing", "malformed"] as const)("keeps a live scope authorized when a disposed write receives a %s-principal 404 protocol error", async (principal) => {
  const value = body(); const scope = await seed([value]); const write = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockReturnValueOnce(write.promise); vi.stubGlobal("fetch", fetch); const session = await open(scope);
  const revoke = vi.spyOn(scope, "revokeProject"); session.setStatus(projectId, taskId, "done", value.version); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); session.dispose();
  const headers = new Headers({ "Content-Type": "application/json" }); if (principal === "malformed") headers.set("Daynight-User-ID", "invalid-principal");
  write.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "untrusted-disposed-error" } }), { status: 404, headers }));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("unknown")); expect(scope.isInvalidated).toBe(false); expect(scope.getAuthorizedProject(projectId)).not.toBeNull(); expect(revoke).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not let a disposed session's old write 404 withdraw a newly admitted history", async () => {
  const value = body(); const restored = { ...value, description: "E2 content stays authorized" }; const scope = await seed([value]); const write = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockReturnValueOnce(write.promise).mockResolvedValueOnce(resourceResponse(restored, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); const session = await open(scope);
  session.setStatus(projectId, taskId, "done", value.version); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); session.dispose(); await apply(scope, [restored], true);
  const current = await open(scope); const project = scope.getAuthorizedProject(projectId); const revoke = vi.spyOn(scope, "revokeProject");
  write.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "old-disposed-denial" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("refused")); expect(scope.getAuthorizedProject(projectId)).toBe(project); expect(current.snapshot(projectId, taskId).detail?.description).toBe(restored.description); expect(revoke).not.toHaveBeenCalled();
  expect(fetch.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
});

it("keeps scope denial retryable after a disposed write's trusted 404 purge fails", async () => {
  const value = body(); const scope = await seed([value]); const ticket = await scope.beginSync(projectId, signal()); const write = deferred<Response>();
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(value, TEST_VIEWER_ID)).mockReturnValueOnce(write.promise); vi.stubGlobal("fetch", fetch); const session = await open(scope); session.setStatus(projectId, taskId, "done", value.version); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2)); session.dispose();
  const original = IDBObjectStore.prototype.put; const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "projects" && (args[0] as { state?: string }).state === "invalidated") throw new DOMException("Disposed denial purge failure", "QuotaExceededError"); return original.apply(this, args);
  });
  const events: unknown[] = []; scope.subscribe((event) => events.push(event));
  write.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Not found", requestId: "disposed-purge-denied" } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) }));
  await waitFor(() => expect(events.some((event) => (event as { error?: { category?: string } }).error?.category === "storage")).toBe(true));
  expect(scope.getAuthorizedProject(projectId)).toBeNull(); expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, mutation: { phase: "refused", error: { requestId: "disposed-purge-denied" } } });
  await expect(scope.detailTransaction(ticket, signal(), async () => "private")).rejects.toMatchObject({ name: "AbortError" }); await expect(scope.beginSync(projectId, signal())).rejects.toMatchObject({ category: "storage" });
  fault.mockRestore(); const recovered = await scope.beginSync(projectId, signal()); expect(recovered.epoch).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
});
