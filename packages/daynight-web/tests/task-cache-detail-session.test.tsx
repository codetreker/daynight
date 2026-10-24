import { act, render, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import type { TaskDetail } from "../src/api/types";
import { pauseAuthRequests } from "../src/api/client";
import { TaskCacheProvider } from "../src/features/task-cache/TaskCacheProvider";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TaskDetailSessionProvider, TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
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
  return scope.applySync(ticket, taskSyncFromGraph(graphFixture(details), { query: snapshot || ticket.epoch === null ? {} : { epoch: ticket.epoch }, ...(snapshot ? { epoch: "30000000-0000-4000-8000-000000000002" } : {}), versionForTask: (task) => details.find((detail) => detail.id === task.id)!.version }), signal());
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

it("refreshes description-only versions even when a cross-tab graph update retains this mount receipt", async () => {
  const first = body({ description: "Old" }); const next = { ...first, version: 6n, description: "New" }; const scope = await seed([first]);
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(first, TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(next, TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const { result, rerender } = renderHook(({ observed }) => useTaskDetail(projectId, taskId, 1, observed), { initialProps: { observed: node(scope) }, wrapper: wrapper(scope) });
  await waitFor(() => expect(result.current.canSetStatus).toBe(true));
  await act(async () => { await apply(scope, [next]); }); rerender({ observed: node(scope) });
  await waitFor(() => expect(result.current.detail?.description).toBe("New")); expect(fetch).toHaveBeenCalledTimes(2);
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
  const { openDB } = await import("idb"); const connection = await openDB("daynight-task-cache", 1);
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
  const old = body({ description: "E1 private description", properties: { worker: null, pullRequests: [{ url: "https://example.test/old", title: "E1 private PR" }] } });
  const restored = { ...old, description: "E2 restored description", properties: { worker: null, pullRequests: [{ url: "https://example.test/new", title: "E2 restored PR" }] } };
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
