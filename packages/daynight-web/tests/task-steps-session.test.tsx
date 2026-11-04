import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskDetail } from "../src/api/types";
import type { StepsResource, TaskStep } from "../src/api/task-steps";
import { pauseAuthRequests } from "../src/api/client";
import { TaskCacheProvider } from "../src/features/task-cache/TaskCacheProvider";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TaskDetailSessionProvider, TaskDetailSessions, useTaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { useTaskSteps } from "../src/features/task-detail/useTaskSteps";
import { detailFixture, graphFixture, resourceResponse } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_VIEWER_ID, viewerHeaders } from "./helpers/taskSync";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const body = (version = 5n) => detailFixture(projectId, taskId, { title: "Task", version, updatedAt: `2026-10-22T10:00:${version.toString().padStart(2, "0")}Z` });
const item: TaskStep = { id: "00000001", title: "Read", description: "Private Steps text", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
const resource = (version = 5n, steps: readonly TaskStep[] = [item]): StepsResource => ({ projectId, taskId, version, steps });
const signal = () => new AbortController().signal;
const scopes: TaskCacheScope[] = [];
const sessions: TaskDetailSessions[] = [];
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const apply = async (scope: TaskCacheScope, detail: TaskDetail, snapshot = false) => {
  const ticket = await scope.beginSync(projectId, signal());
  return scope.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { query: snapshot || ticket.epoch === null ? {} : { epoch: ticket.epoch }, ...(snapshot ? { epoch: "30000000-0000-4000-8000-000000000002" } : {}), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
};
const seed = async () => { const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); await apply(scope, body()); return scope; };
const node = (scope: TaskCacheScope) => scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)!;
const open = async (scope: TaskCacheScope) => { const session = new TaskDetailSessions(scope); sessions.push(session); session.observe(projectId, taskId, node(scope)); return session; };
const start = (session: TaskDetailSessions, listener = vi.fn()) => { const release = session.subscribeSteps(projectId, taskId, listener); session.loadSteps(projectId, taskId); return release; };
const failure = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: "Failure", requestId: "steps-failure" } }), { status, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); scopes.splice(0).forEach((scope) => scope.dispose()); });

it("lazily reads a separate complete resource and never persists it in the detail cache", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValue(resourceResponse(resource(), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  expect(fetch).not.toHaveBeenCalled(); const puts: string[] = []; const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) { puts.push(this.name); return original.apply(this, args); });
  const release = start(session); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(), status: "ready", stale: false }));
  expect(fetch).toHaveBeenCalledOnce(); expect(puts).toEqual([]); expect(session.snapshot(projectId, taskId).detail).toBeNull(); release();
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("retains the collection until the final reader leaves, then aborts and rejects late results", async () => {
  const scope = await seed(); const session = await open(scope); const late = deferred<Response>(); const fetch = vi.fn().mockReturnValue(late.promise); vi.stubGlobal("fetch", fetch);
  const first = start(session); const second = session.subscribeSteps(projectId, taskId, vi.fn()); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const requestSignal = fetch.mock.calls[0]![1].signal as AbortSignal; first(); expect(requestSignal.aborted).toBe(false); second(); expect(requestSignal.aborted).toBe(true);
  late.resolve(resourceResponse(resource(), TEST_VIEWER_ID)); await Promise.resolve(); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("distinguishes a valid empty collection, first failure and retained refresh failure", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValueOnce(failure(500, "internal_error")).mockResolvedValueOnce(resourceResponse(resource(5n, []), TEST_VIEWER_ID)).mockRejectedValueOnce(new Error("Offline")); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "error", resource: null, error: { kind: "server" } }));
  session.loadSteps(projectId, taskId, true); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "ready", resource: { steps: [] }, error: null }));
  session.loadSteps(projectId, taskId, true); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "ready", resource: { steps: [] }, stale: true, error: { kind: "network" } }));
});

it("invalidates an active collection when a newer parent summary arrives and coalesces an in-flight follow-up", async () => {
  const scope = await seed(); const session = await open(scope); const late = deferred<Response>(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)).mockReturnValueOnce(late.promise).mockResolvedValueOnce(resourceResponse(resource(7n), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await apply(scope, body(7n)); session.observe(projectId, taskId, node(scope)); expect(fetch).toHaveBeenCalledTimes(2); expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 5n }, stale: true, refreshing: true });
  late.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID)); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 7n }, stale: false })); expect(fetch).toHaveBeenCalledTimes(3);
});

it("holds an ahead response until summary admission without advancing its watermark", async () => {
  const scope = await seed(); const session = await open(scope); const next = body(6n); const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(6n) : next, TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn(); session.subscribeProject(projectId, refresh); const before = (await scope.beginSync(projectId, signal())).maxUpdatedAt; start(session);
  await waitFor(() => expect(refresh).toHaveBeenCalled()); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(before);
  await apply(scope, next); session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 6n }, stale: false }));
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/steps"))).toHaveLength(1);
});

it("exposes parent-refresh failure during ahead admission and permits explicit recovery", async () => {
  const scope = await seed(); const session = await open(scope); let parentReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(url.endsWith("/steps") ? resourceResponse(resource(6n), TEST_VIEWER_ID) : ++parentReads === 1 ? failure(500, "internal_error") : resourceResponse(body(6n), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "error", error: { status: 500 } }));
  session.loadSteps(projectId, taskId, true); await waitFor(() => expect(parentReads).toBe(2)); expect(session.stepsSnapshot(projectId, taskId).status).toBe("waiting");
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 6n }, status: "ready", error: null }));
});

it("rereads an ahead response skipped by synchronization", async () => {
  const scope = await seed(); const session = await open(scope); let stepsReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(++stepsReads === 1 ? 6n : 7n) : body(6n), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => !url.endsWith("/steps"))).toBe(true)); await apply(scope, body(7n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 7n }, stale: false })); expect(stepsReads).toBe(2);
});

it("fails repeated obsolete responses explicitly after one floor-bound reread", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValue(resourceResponse(resource(4n), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "error", error: { kind: "protocol" } })); expect(fetch).toHaveBeenCalledTimes(2);
});

it("rejects same-version changed content without replacing confirmed rows", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(resource(5n, [{ ...item, title: "Changed at the same version" }]), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(), stale: true, error: { kind: "protocol" } }));
});

it("discards a late response from a replaced cache generation and reads the new generation", async () => {
  const scope = await seed(); const session = await open(scope); const late = deferred<Response>(); const fetch = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); start(session); await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await apply(scope, body(), true); session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  late.resolve(resourceResponse(resource(5n, [{ ...item, title: "Old generation" }]), TEST_VIEWER_ID)); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(), stale: false }));
});

it("checks the parent after Steps 404 and preserves its readable content", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)).mockResolvedValueOnce(failure(404, "not_found")).mockResolvedValueOnce(resourceResponse(body(), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(), error: { kind: "server", status: 404 } })); expect(scope.getAuthorizedProject(projectId)).not.toBeNull(); expect(session.snapshot(projectId, taskId).detail?.id).toBe(taskId); expect(fetch).toHaveBeenCalledTimes(3);
});

it("retires project content only after a trusted parent 404", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)).mockImplementation(() => Promise.resolve(failure(404, "not_found"))); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(scope.getAuthorizedProject(projectId)).toBeNull()); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); expect(session.snapshot(projectId, taskId).detail).toBeNull(); expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(["steps", "parent"])("treats a trusted %s 410 as deletion and clears the collection", async (source) => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID));
  if (source === "parent") fetch.mockResolvedValueOnce(failure(404, "not_found")); fetch.mockResolvedValue(failure(410, "task_deleted")); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "deleted" })); expect(session.snapshot(projectId, taskId).status).toBe("deleted");
});

it("leaves project access intact after a Steps 403", async () => {
  const scope = await seed(); const session = await open(scope); const fetch = vi.fn().mockResolvedValue(failure(403, "forbidden")); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "error", error: { status: 403 } })); expect(scope.getAuthorizedProject(projectId)).not.toBeNull(); expect(fetch).toHaveBeenCalledOnce();
});

it("clears private arrays immediately on project retirement and identity retirement", async () => {
  const scope = await seed(); const session = await open(scope); vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID)))); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).resource).not.toBeNull()); const ticket = await scope.beginSync(projectId, signal()); const revoked = scope.revokeProject(ticket, scope.signal); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); await revoked;
  session.observe(projectId, taskId, undefined, false); expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "error", error: { code: "not_found" } });
  const freshScope = await seed(); const fresh = await open(freshScope); start(fresh); await waitFor(() => expect(fresh.stepsSnapshot(projectId, taskId).resource).not.toBeNull()); const retired = freshScope.invalidateScope(); expect(fresh.stepsSnapshot(projectId, taskId).resource).toBeNull(); await retired;
});

it("waits through same-identity verification before admitting a response", async () => {
  const scope = await seed(); const session = await open(scope); const late = deferred<Response>(); vi.stubGlobal("fetch", vi.fn().mockReturnValue(late.promise)); start(session); await waitFor(() => expect(fetch).toHaveBeenCalledOnce()); const resume = pauseAuthRequests();
  late.resolve(resourceResponse(resource(), TEST_VIEWER_ID)); await Promise.resolve(); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); resume(); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource()));
});

it("the view hook does not read or retain a hidden collection, and reactivation reads again", async () => {
  const scope = await seed(); const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)).mockResolvedValueOnce(resourceResponse(resource(6n), TEST_VIEWER_ID)); vi.stubGlobal("fetch", fetch);
  const wrapper = ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{children}</TaskDetailSessionProvider></TaskCacheProvider>;
  const { result, rerender } = renderHook(({ active }) => ({ ...useTaskSteps(projectId, taskId, active), sessions: useTaskDetailSessions() }), { wrapper, initialProps: { active: false } }); expect(fetch).not.toHaveBeenCalled();
  act(() => result.current.sessions.observe(projectId, taskId, node(scope)));
  rerender({ active: true }); await waitFor(() => expect(result.current.resource).toEqual(resource()));
  rerender({ active: false }); expect(result.current.resource).toBeNull(); expect(result.current.sessions.stepsSnapshot(projectId, taskId).resource).toBeNull();
  await act(async () => { await apply(scope, body(6n)); result.current.sessions.observe(projectId, taskId, node(scope)); }); expect(fetch).toHaveBeenCalledOnce();
  rerender({ active: true }); await waitFor(() => expect(result.current.resource).toEqual(resource(6n))); expect(fetch).toHaveBeenCalledTimes(2);
});
