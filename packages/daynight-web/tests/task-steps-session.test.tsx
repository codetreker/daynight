import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskDetail } from "../src/api/types";
import type { StepsResource, TaskStep } from "../src/api/task-steps";
import { getTaskSync, pauseAuthRequests } from "../src/api/client";
import { TaskCacheProvider } from "../src/features/task-cache/TaskCacheProvider";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { canSetStatus, TaskDetailSessionProvider, TaskDetailSessions, useTaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { useTaskSteps } from "../src/features/task-detail/useTaskSteps";
import { useTaskDetail } from "../src/features/task-detail/useTaskDetail";
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
const applyAbsentSnapshot = async (scope: TaskCacheScope, withSurvivor = false) => {
  const graph = graphFixture([body()]);
  const empty = withSurvivor ? graphFixture([detailFixture(projectId, "20000000-0000-4000-8000-000000000002")])
    : { ...graph, tasks: [], summary: { total: 0, todo: 0, inProgress: 0, done: 0, ready: 0, blocked: 0 } };
  const ticket = await scope.beginSync(projectId, signal());
  return scope.applySync(ticket, taskSyncFromGraph(empty, { epoch: "30000000-0000-4000-8000-000000000003", versionForTask: () => 1n }), signal());
};
const seed = async () => { const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); await apply(scope, body()); return scope; };
const node = (scope: TaskCacheScope) => scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)!;
const open = async (scope: TaskCacheScope) => { const session = new TaskDetailSessions(scope); sessions.push(session); session.observe(projectId, taskId, node(scope)); return session; };
const start = (session: TaskDetailSessions, listener = vi.fn()) => { const release = session.subscribeSteps(projectId, taskId, listener); session.loadSteps(projectId, taskId); return release; };
const failure = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: "Failure", requestId: "steps-failure" } }), { status, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); scopes.splice(0).forEach((scope) => scope.dispose()); });

it("keeps the original status until a confirmed result and three-resource convergence, including equal clock timestamps", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); let updated = false;
  const changed = { ...item, status: "done" as const };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(updated ? 6n : 5n, updated ? [changed] : [item]) : body(updated ? 6n : 5n), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); session.setStatus(projectId, taskId, "todo", 5n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps[0]?.status).toBe("todo"); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  updated = true; write.resolve(resourceResponse(resource(6n, [changed]), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: true }));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps[0]?.status).toBe("done");
  const writeHeaders = fetcher.mock.calls.find(([, options]) => options.method === "PUT")![1].headers as Record<string, string>; const id = writeHeaders["X-Request-ID"]!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/); expect(fetcher.mock.calls.some(([, options]) => (options.headers as Record<string, string> | undefined)?.["X-Request-ID"]?.startsWith(`${id}.r`))).toBe(true);
});

it("keeps malformed success unknown when readback fails, then reconciles without replay", async () => {
  const scope = await seed(); const session = await open(scope); let submitted = false; let failed = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(resourceResponse({ invalid: true }, TEST_VIEWER_ID)); }
    if (url.endsWith("/steps") && submitted && !failed) { failed = true; return Promise.resolve(failure(500, "internal_error")); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: { status: 500 } }));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps[0]?.status).toBe("todo"); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  session.reconcile(projectId, taskId); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: "unknown", reconciling: false, reconciliationError: null }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(true); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each(["unknown", "conflict"] as const)("reconciles %s after the detail is closed and reopened while Steps read remains pending", async (outcome) => {
  const scope = await seed(); const session = await open(scope); const pendingSteps = deferred<Response>(); const reopenedParent = deferred<Response>(); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return outcome === "unknown" ? Promise.reject(new Error("Offline")) : Promise.resolve(failure(409, "version_conflict")); }
    if (url.endsWith("/steps")) return submitted ? pendingSteps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    if (submitted && ++parentReads > 1) return reopenedParent.promise;
    return Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); const releaseDetail = session.subscribe(projectId, taskId, vi.fn()); const releaseSteps = start(session);
  session.requireOpeningRead(projectId, taskId); session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ refreshing: false, mutation: { phase: outcome, reconciling: true } })); expect(parentReads).toBe(1);
  releaseDetail(); releaseSteps(); session.requireOpeningRead(projectId, taskId); session.subscribe(projectId, taskId, vi.fn()); start(session);
  await waitFor(() => expect(parentReads).toBe(2)); pendingSteps.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false); reopenedParent.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: outcome, reconciling: false }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(true); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("coalesces multiple openings while the prior opening's parent GET is in flight", async () => {
  const scope = await seed(); const session = await open(scope); const oldParent = deferred<Response>(); const newParent = deferred<Response>(); const pendingSteps = deferred<Response>(); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return submitted ? pendingSteps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return submitted ? (++parentReads === 1 ? oldParent.promise : newParent.promise) : Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); const release = start(session); session.requireOpeningRead(projectId, taskId); session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1)); release();
  session.requireOpeningRead(projectId, taskId); session.requireOpeningRead(projectId, taskId); pendingSteps.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
  expect(parentReads).toBe(1); oldParent.resolve(resourceResponse(body(), TEST_VIEWER_ID)); await waitFor(() => expect(parentReads).toBe(2));
  expect(session.snapshot(projectId, taskId).mutation.reconciling).toBe(true); newParent.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciling: false }));
  expect(parentReads).toBe(2); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("does not retry a failed old-opening parent read until explicit recovery", async () => {
  const scope = await seed(); const session = await open(scope); const oldParent = deferred<Response>(); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(failure(409, "version_conflict")); }
    if (url.endsWith("/steps")) return Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    if (submitted && ++parentReads === 1) return oldParent.promise;
    return Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); start(session); session.requireOpeningRead(projectId, taskId); session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1)); session.requireOpeningRead(projectId, taskId);
  oldParent.resolve(failure(500, "internal_error")); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "conflict", reconciling: false, reconciliationError: { status: 500 } }));
  await drainReads(scope); expect(parentReads).toBe(1); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  session.reconcile(projectId, taskId); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); expect(parentReads).toBe(2);
});

it("reads the reopened parent even when an old-opening response awaits summary admission", async () => {
  const scope = await seed(); const session = await open(scope); const refresh = vi.fn(); session.subscribeProject(projectId, refresh); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return Promise.resolve(resourceResponse(resource(submitted ? 6n : 5n), TEST_VIEWER_ID));
    if (submitted) parentReads++;
    return Promise.resolve(resourceResponse(body(submitted ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); start(session); session.requireOpeningRead(projectId, taskId); session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(3));
  expect(parentReads).toBe(1); session.requireOpeningRead(projectId, taskId);
  await waitFor(() => expect(parentReads).toBe(2)); await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); expect(parentReads).toBe(2);
});

it("keeps retries bounded for a new opening and floor after a stale old-opening response", async () => {
  const scope = await seed(); const session = await open(scope); const oldParent = deferred<Response>(); const pendingSteps = deferred<Response>(); let submitted = false; let parentReads = 0; let recover = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return !submitted ? Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID)) : recover ? Promise.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID)) : pendingSteps.promise;
    if (submitted && ++parentReads === 1) return oldParent.promise;
    return Promise.resolve(resourceResponse(body(recover ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); start(session); session.requireOpeningRead(projectId, taskId); session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1)); session.requireOpeningRead(projectId, taskId);
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); pendingSteps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID)); oldParent.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: { kind: "protocol" } }));
  expect(parentReads).toBe(3); expect(session.canSetStepStatus(projectId, taskId)).toBe(false); recover = true; session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); expect(parentReads).toBe(4); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("finishes Steps reconciliation when a same-version graph mismatch clears", async () => {
  const scope = await seed(); const session = await open(scope); const parent = deferred<Response>(); const steps = deferred<Response>(); let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return submitted ? steps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return submitted ? parent.promise : Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); start(session); session.requireOpeningRead(projectId, taskId); session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.reconciling).toBe(true));
  session.observe(projectId, taskId, { ...node(scope), ready: false }); parent.resolve(resourceResponse(body(), TEST_VIEWER_ID)); steps.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ graphMismatch: true, mutation: { reconciling: true } }));
  session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciling: false }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(true); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("treats a child 404 as a refusal and verifies the parent without retiring readable content", async () => {
  const scope = await seed(); const session = await open(scope);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => Promise.resolve(options.method === "PUT" ? failure(404, "not_found") : resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "refused", error: { status: 404 }, reconciling: false }));
  expect(scope.getAuthorizedProject(projectId)).not.toBeNull(); expect(session.snapshot(projectId, taskId).detail?.id).toBe(taskId); expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource());
});

it("reconciles a conflict at the current version without repeating the write", async () => {
  const scope = await seed(); const session = await open(scope); let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(failure(409, "version_conflict")); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? 6n : 5n) : body(submitted ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("conflict"));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: "conflict" });
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps[0]?.status).toBe("todo"); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each(["unknown", "conflict"] as const)("reconciles %s when the first parent read finishes before Steps and summary advance", async (outcome) => {
  const scope = await seed(); const session = await open(scope); const laterSteps = deferred<Response>(); const laterParent = deferred<Response>(); let submitted = false; let parentReads = 0;
  const changed = { ...item, status: "done" as const, updatedAt: "2026-10-22T10:00:06Z" };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return outcome === "unknown" ? Promise.reject(new Error("Offline")) : Promise.resolve(failure(409, "version_conflict")); }
    if (url.endsWith("/steps")) return submitted ? laterSteps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    if (submitted) return ++parentReads === 1 ? Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID)) : laterParent.promise;
    return Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(parentReads).toBe(1)); await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 5n }, refreshing: false, mutation: { phase: outcome, reconciling: true } }));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); laterSteps.resolve(resourceResponse(resource(6n, [changed]), TEST_VIEWER_ID));
  await waitFor(() => expect(parentReads).toBe(2)); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  laterParent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID)); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: outcome });
  expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource(6n, [changed])); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("bounds outdated parent reads at one retry per floor and permits explicit recovery", async () => {
  const scope = await seed(); const session = await open(scope); const laterSteps = deferred<Response>(); let submitted = false; let parentReads = 0; let recover = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return !submitted ? Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID)) : recover ? Promise.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID)) : laterSteps.promise;
    if (submitted) parentReads++;
    return Promise.resolve(resourceResponse(body(recover ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ refreshing: false, mutation: { phase: "unknown", reconciling: true } }));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); laterSteps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: { kind: "protocol" } }));
  expect(parentReads).toBe(3); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  recover = true; session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(parentReads).toBe(4); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("schedules a parent read for ahead Steps before the summary catches up", async () => {
  const scope = await seed(); const session = await open(scope); const laterSteps = deferred<Response>(); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return submitted ? laterSteps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return Promise.resolve(resourceResponse(body(submitted && ++parentReads > 1 ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); const releaseDetail = session.subscribe(projectId, taskId, vi.fn()); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ refreshing: false, mutation: { phase: "unknown", reconciling: true } }));
  laterSteps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID)); await waitFor(() => expect(parentReads).toBe(2));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false); expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n);
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: "unknown" }); releaseDetail();
});

it("coalesces a new floor into an in-flight parent read that returns that version", async () => {
  const scope = await seed(); const session = await open(scope); const parent = deferred<Response>(); const steps = deferred<Response>(); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return submitted ? steps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    if (submitted) { parentReads++; return parent.promise; }
    return Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); steps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID));
  expect(parentReads).toBe(1); parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); expect(parentReads).toBe(1);
});

it("reconciles an advanced floor after the last Steps view closes", async () => {
  const scope = await seed(); const session = await open(scope); const laterSteps = deferred<Response>(); let submitted = false; let parentReads = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps")) return submitted ? laterSteps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return Promise.resolve(resourceResponse(body(submitted && ++parentReads > 1 ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); const release = start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1)); release();
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ refreshing: false, mutation: { phase: "unknown", reconciling: true } }));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); laterSteps.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 6n }, mutation: { phase: "reconciled", reconciling: false } }));
  expect(parentReads).toBe(2); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("continues a submitted write after the Steps view closes and releases the collection after convergence", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); let updated = false;
  const changed = { ...item, status: "done" as const, updatedAt: "2026-10-22T10:00:06Z" };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(updated ? 6n : 5n, updated ? [changed] : [item]) : body(updated ? 6n : 5n), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); const release = start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options.method === "PUT")).toBe(true)); release();
  updated = true; write.resolve(resourceResponse(resource(6n, [changed]), TEST_VIEWER_ID)); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.reconciling).toBe(false));
  expect(session.snapshot(projectId, taskId).detail?.version).toBe(6n); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("discards a confirmed intermediate result and retries a late parent read when sync skips its version", async () => {
  const scope = await seed(); const session = await open(scope); const late = deferred<Response>(); let submitted = false; let parentReads = 0;
  const changed = { ...item, status: "done" as const, updatedAt: "2026-10-22T10:00:06Z" };
  const latest = { ...changed, title: "Later update", updatedAt: "2026-10-22T10:00:07Z" };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(resourceResponse(resource(6n, [changed]), TEST_VIEWER_ID)); }
    if (url.endsWith("/steps")) return Promise.resolve(resourceResponse(submitted ? resource(7n, [latest]) : resource(), TEST_VIEWER_ID));
    if (submitted && ++parentReads === 1) return late.promise;
    return Promise.resolve(resourceResponse(body(submitted ? 7n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(parentReads).toBe(1));
  await apply(scope, body(7n)); session.observe(projectId, taskId, node(scope)); late.resolve(resourceResponse(body(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId).detail?.version).toBe(7n); expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource(7n, [latest])); expect(parentReads).toBeGreaterThanOrEqual(2);
});

it("keeps a failed parent read locked and allows explicit recovery", async () => {
  const scope = await seed(); const session = await open(scope); let submitted = false; let failParent = true;
  const changed = { ...item, status: "done" as const, updatedAt: "2026-10-22T10:00:06Z" };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(resourceResponse(resource(6n, [changed]), TEST_VIEWER_ID)); }
    if (!url.endsWith("/steps") && submitted && failParent) return Promise.resolve(failure(500, "internal_error"));
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? 6n : 5n, submitted ? [changed] : [item]) : body(submitted ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false, reconciliationError: { status: 500 } }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false); failParent = false; await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each([403, 410])("handles a Step write %s without inferring the wrong access state", async (status) => {
  const scope = await seed(); const session = await open(scope);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => Promise.resolve(options.method === "PUT" ? failure(status, status === 410 ? "task_deleted" : "forbidden") : resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  if (status === 403) { await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "refused", error: { status: 403 } })); expect(scope.getAuthorizedProject(projectId)).not.toBeNull(); }
  else { await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted")); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); }
});

it.each([
  { order: "receipt-first", withSurvivor: false }, { order: "receipt-first", withSurvivor: true },
  { order: "snapshot-first", withSurvivor: false }, { order: "snapshot-first", withSurvivor: true },
] as const)("shows parent deletion when a Step 410 races a replacement snapshot ($order, survivor=$withSurvivor)", async ({ order, withSurvivor }) => {
  const scope = await seed(); const write = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher);
  const wrapper = ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>{children}</TaskDetailSessionProvider></TaskCacheProvider>;
  const hook = renderHook(({ revision, observed }) => ({ detail: useTaskDetail(projectId, taskId, revision, observed), steps: useTaskSteps(projectId, taskId, true), sessions: useTaskDetailSessions() }), { wrapper, initialProps: { revision: 1, observed: node(scope) as ReturnType<typeof node> | undefined } });
  await waitFor(() => expect(hook.result.current.steps.canSetStatus).toBe(true));
  act(() => hook.result.current.steps.setStatus(item.id, "done", 5n)); await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options.method === "PUT")).toBe(true));
  if (order === "receipt-first") { await act(async () => { write.resolve(failure(410, "task_deleted")); }); await waitFor(() => expect(hook.result.current.detail.status).toBe("deleted")); }
  await act(async () => { await applyAbsentSnapshot(scope, withSurvivor); });
  if (order === "receipt-first") await waitFor(() => expect(hook.result.current.detail).toMatchObject({ status: "deleted", detail: null }));
  hook.rerender({ revision: 2, observed: undefined });
  if (order === "snapshot-first") await act(async () => { write.resolve(failure(410, "task_deleted")); });
  expect(hook.result.current.sessions.snapshot(projectId, taskId).status).toBe("deleted");
  expect(hook.result.current.sessions.hasCurrentGeneration(projectId, taskId)).toBe(true);
  await waitFor(() => expect(hook.result.current.detail).toMatchObject({ status: "deleted", detail: null }));
  expect(hook.result.current.steps.resource).toBeNull();
});

it("keeps removed Steps private when an old successful write receipt arrives after a replacement snapshot", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options.method === "PUT")).toBe(true));
  await applyAbsentSnapshot(scope); session.observe(projectId, taskId, undefined);
  write.resolve(resourceResponse(resource(6n, [{ ...item, status: "done", updatedAt: "2026-10-22T10:00:06Z" }]), TEST_VIEWER_ID)); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null }); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("rejects a late Step receipt after project retirement", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true)); session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options.method === "PUT")).toBe(true)); const ticket = await scope.beginSync(projectId, signal()); await scope.revokeProject(ticket, scope.signal);
  write.resolve(resourceResponse(resource(6n, [{ ...item, status: "done", updatedAt: "2026-10-22T10:00:06Z" }]), TEST_VIEWER_ID)); await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(scope.getAuthorizedProject(projectId)).toBeNull(); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
});

it("releases a hidden unknown collection after failed readback and recovers on reopening", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); let submitted = false; let failed = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return write.promise; }
    if (submitted && url.endsWith("/steps") && !failed) { failed = true; return Promise.resolve(failure(500, "internal_error")); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); const release = start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(submitted).toBe(true)); release(); write.resolve(resourceResponse({ invalid: true }, TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: false, reconciliationError: { status: 500 } }));
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); start(session); session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciling: false, reconciliationError: null }));
  expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource()); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each(["forbidden", "version_exhausted"])("releases the hidden collection when a submitted write is refused with %s", async (code) => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); const release = start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n); await waitFor(() => expect(fetcher.mock.calls.some(([, options]) => options.method === "PUT")).toBe(true)); release();
  write.resolve(failure(code === "forbidden" ? 403 : 409, code)); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "refused", error: { code } }));
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it("refreshes the independent Steps resource after an ordinary Task write", async () => {
  const scope = await seed(); const session = await open(scope); let submitted = false;
  const next = { ...body(6n), allowAgents: true };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PATCH") { submitted = true; return Promise.resolve(resourceResponse(next, TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? 6n : 5n) : submitted ? next : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setAgentPermission(projectId, taskId, true, 5n); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  await apply(scope, next); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 6n }, stale: false }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(true);
});

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

// A scheduler turn plus an IndexedDB transaction drains already-dispatched reads;
// the controlled response and admission barriers select the race itself.
const drainReads = async (scope: TaskCacheScope) => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await scope.beginSync(projectId, signal());
};

// Hold the real successful Steps admission after its IndexedDB transaction commits.
// Recovery reads remain independently controlled so the terminal event wins the await.
const heldStepSuccess = async (action: "status" | "position") => {
  const scope = await seed(); const session = await open(scope);
  const second = { ...item, id: "00000002", title: "Second" };
  const original = [item, second];
  const changed = action === "status" ? [{ ...item, status: "done" as const }, second] : [second, item];
  const write = deferred<Response>(); const replacementWrite = deferred<Response>(); const recovery = deferred<Response>(); const parent = deferred<Response>();
  const entered = deferred<void>(); const release = deferred<void>();
  let submitted = false; let intercepted = false; let restored = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { const pending = submitted ? replacementWrite : write; submitted = true; return pending.promise; }
    if (restored) return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(5n, original) : body(), TEST_VIEWER_ID));
    if (url.endsWith("/steps")) return submitted ? recovery.promise : Promise.resolve(resourceResponse(resource(5n, original), TEST_VIEWER_ID));
    return submitted ? parent.promise : Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  if (action === "status") session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  else session.moveStep(projectId, taskId, item.id, { position: "last" }, 5n);
  await waitFor(() => expect(submitted).toBe(true));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementation(async (...args) => {
    const result = await transaction(...args);
    if (typeof result === "bigint" && !intercepted) { intercepted = true; entered.resolve(); await release.promise; }
    return result;
  });
  write.resolve(resourceResponse(resource(6n, changed), TEST_VIEWER_ID)); await entered.promise;
  return { scope, session, fetcher, recovery, parent, release, replacementWrite, changed, restore: () => { restored = true; } };
};
const parentReadCount = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([url, options]) => options.method === undefined && !url.endsWith("/steps")).length;

it.each(["status", "position"] as const)("keeps deletion terminal when a successful Step %s awaits cache admission", async (action) => {
  const { scope, session, fetcher, recovery, parent, release } = await heldStepSuccess(action);
  recovery.resolve(failure(410, "task_deleted"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted"));
  const reads = parentReadCount(fetcher); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  const published: string[] = []; session.subscribe(projectId, taskId, () => { published.push(session.snapshot(projectId, taskId).status); });
  parent.resolve(failure(500, "internal_error")); release.resolve(); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null, requiresFreshRead: false, mutation: { phase: "confirmed", reconciling: false } });
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "deleted", resource: null });
  expect(published.every((status) => status === "deleted")).toBe(true);
  expect(parentReadCount(fetcher)).toBe(reads); expect(refresh).not.toHaveBeenCalled();
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("does not resume an old Step success after deletion restores a new cache generation", async () => {
  const { scope, session, fetcher, recovery, parent, release, restore } = await heldStepSuccess("status");
  recovery.resolve(failure(410, "task_deleted")); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted"));
  restore(); await apply(scope, body(), true); session.observe(projectId, taskId, node(scope));
  const reads = parentReadCount(fetcher); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID)); release.resolve(); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "loading", detail: null, mutation: { operation: null, phase: "idle" } });
  expect(parentReadCount(fetcher)).toBe(reads); expect(refresh).not.toHaveBeenCalled();
  session.load(projectId, taskId, 2, "open"); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId).detail?.version).toBe(5n);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each(["project", "identity", "session"] as const)("does not continue Step success after %s retirement during admission", async (retirement) => {
  const { scope, session, fetcher, recovery, parent, release } = await heldStepSuccess("status");
  if (retirement === "project") { const ticket = await scope.beginSync(projectId, signal()); await scope.revokeProject(ticket, scope.signal); }
  else if (retirement === "identity") await scope.invalidateScope();
  else session.dispose();
  const reads = parentReadCount(fetcher); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  recovery.resolve(resourceResponse(resource(6n), TEST_VIEWER_ID)); parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID)); release.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
  expect(parentReadCount(fetcher)).toBe(reads); expect(refresh).not.toHaveBeenCalled();
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("leaves a later operation in control when an earlier Step success resumes admission", async () => {
  const { scope, session, fetcher, recovery, parent, release, replacementWrite, changed } = await heldStepSuccess("status");
  session.requireOpeningRead(projectId, taskId);
  recovery.resolve(resourceResponse(resource(6n, changed), TEST_VIEWER_ID)); parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, "00000002", "done", 6n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(2));
  const operation = session.snapshot(projectId, taskId).mutation.operation;
  const reads = parentReadCount(fetcher); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  release.resolve(); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ requiresFreshRead: false, refreshing: false, mutation: { operation, phase: "pending" } });
  expect(parentReadCount(fetcher)).toBe(reads); expect(refresh).not.toHaveBeenCalled();
  replacementWrite.resolve(failure(403, "forbidden")); await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("refused"));
});

it("waits for same-identity verification between Steps admission and successful follow-up reads", async () => {
  const { scope, session, fetcher, recovery, parent, release } = await heldStepSuccess("status");
  let resume: (() => void) | null = null;
  session.subscribeSteps(projectId, taskId, () => {
    if (session.stepsSnapshot(projectId, taskId).resource?.version === 6n && resume === null) resume = pauseAuthRequests();
  });
  const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  release.resolve(); await waitFor(() => expect(resume).not.toBeNull());
  try { await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(refresh).not.toHaveBeenCalled(); }
  finally { resume!(); }
  recovery.resolve(resourceResponse(resource(6n, [{ ...item, status: "done" }, { ...item, id: "00000002", title: "Second" }]), TEST_VIEWER_ID));
  parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(refresh).toHaveBeenCalled(); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  await drainReads(scope);
});

it.each(["status", "position"] as const)("continues a live Step %s success after awaited admission without replay", async (action) => {
  const { scope, session, fetcher, recovery, parent, release, changed } = await heldStepSuccess(action);
  recovery.resolve(resourceResponse(resource(6n, changed), TEST_VIEWER_ID));
  const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID)); release.resolve();
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "ready", detail: { version: 6n }, mutation: { phase: "confirmed", reconciling: false } });
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual(changed);
  expect(refresh).toHaveBeenCalled();
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  await drainReads(scope);
});

it.each(["steps", "parent"] as const)("keeps %s 410 terminal against an older parent response", async (source) => {
  const scope = await seed(); const session = await open(scope); const late = deferred<Response>(); const steps = deferred<Response>(); let parentReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/steps")) return steps.promise;
    parentReads++;
    return parentReads === 1 ? Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID)) : parentReads === 2 ? late.promise : Promise.resolve(failure(410, "task_deleted"));
  }); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("ready"));
  session.load(projectId, taskId, 2, "refresh"); start(session); await waitFor(() => expect(parentReads).toBe(2));
  const requestSignal = fetch.mock.calls.filter(([url]) => !url.endsWith("/steps"))[1]![1].signal as AbortSignal;
  steps.resolve(failure(source === "steps" ? 410 : 404, source === "steps" ? "task_deleted" : "not_found"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted"));
  late.resolve(resourceResponse(body(), TEST_VIEWER_ID)); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null, requiresFreshRead: false });
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "deleted", resource: null });
  expect(requestSignal.aborted).toBe(true); expect(canSetStatus(session.snapshot(projectId, taskId))).toBe(false);
  expect(fetch.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
});

it.each([
  { source: "steps", version: 5n }, { source: "parent", version: 5n },
  { source: "steps", version: 6n }, { source: "parent", version: 6n },
] as const)("keeps $source 410 terminal while parent v$version admission is already awaited", async ({ source, version }) => {
  const scope = await seed(); const session = await open(scope); const steps = deferred<Response>(); let parentReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/steps")) return steps.promise;
    return Promise.resolve(++parentReads === 1 ? resourceResponse(body(), TEST_VIEWER_ID) : parentReads === 2 ? resourceResponse(body(version), TEST_VIEWER_ID) : failure(410, "task_deleted"));
  }); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("ready"));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { const result = await transaction(...args); entered.resolve(); await release.promise; return result; });
  session.load(projectId, taskId, 2, "refresh"); await entered.promise; start(session);
  steps.resolve(failure(source === "steps" ? 410 : 404, source === "steps" ? "task_deleted" : "not_found"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted")); release.resolve(); await drainReads(scope);
  await apply(scope, body(version)); session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 3, "automatic");
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null, requiresFreshRead: false });
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "deleted", resource: null });
  expect(canSetStatus(session.snapshot(projectId, taskId))).toBe(false); expect(parentReads).toBe(source === "steps" ? 2 : 3);
  expect(fetch.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
});

it("clears a parent response waiting for summary admission when Steps confirms deletion", async () => {
  const scope = await seed(); const session = await open(scope); const steps = deferred<Response>(); let parentReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => url.endsWith("/steps") ? steps.promise : Promise.resolve(resourceResponse(body(++parentReads === 1 ? 5n : 6n), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("ready"));
  const refresh = vi.fn(); session.subscribeProject(projectId, refresh); session.load(projectId, taskId, 2, "refresh"); await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); start(session);
  steps.resolve(failure(410, "task_deleted")); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted"));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 3, "automatic"); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null, requiresFreshRead: false }); expect(parentReads).toBe(2);
});

it.each(["matching", "ahead"] as const)("keeps deletion terminal while an awaited %s Task write receipt settles", async (kind) => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); const steps = deferred<Response>();
  const saved = kind === "matching" ? body() : { ...body(6n), allowAgents: true };
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method !== undefined ? write.promise : url.endsWith("/steps") ? steps.promise : Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false));
  if (kind === "matching") session.setStatus(projectId, taskId, "todo", 5n); else session.setAgentPermission(projectId, taskId, true, 5n);
  await waitFor(() => expect(fetch.mock.calls.filter(([, options]) => options.method !== undefined)).toHaveLength(1));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { const result = await transaction(...args); entered.resolve(); await release.promise; return result; });
  write.resolve(resourceResponse(saved, TEST_VIEWER_ID)); await entered.promise; start(session); steps.resolve(failure(410, "task_deleted"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted")); release.resolve();
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null, requiresFreshRead: false });
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "deleted", resource: null }); expect(canSetStatus(session.snapshot(projectId, taskId))).toBe(false);
  expect(fetch.mock.calls.filter(([, options]) => options.method !== undefined)).toHaveLength(1);
});

it("rejects old Steps after a newer parent GET while summary refresh fails", async () => {
  const scope = await seed(); const session = await open(scope); let parentReads = 0; const syncErrors: unknown[] = [];
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(url.includes("/task-sync") ? failure(500, "internal_error") : url.endsWith("/steps") ? resourceResponse(resource(), TEST_VIEWER_ID) : resourceResponse(body(++parentReads === 1 ? 5n : 6n), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false));
  session.subscribeProject(projectId, () => { void getTaskSync(projectId, {}, TEST_VIEWER_ID, signal()).catch((error: unknown) => { syncErrors.push(error); }); });
  session.load(projectId, taskId, 2, "refresh"); await waitFor(() => expect(syncErrors).toHaveLength(1)); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).status).not.toBe("loading"));
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "error", stale: true, error: { kind: "protocol" } });
  expect(session.snapshot(projectId, taskId).detail?.version).toBe(5n); expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/steps"))).toHaveLength(2); expect(fetch.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
});

it("invalidates already loaded Steps as soon as a newer parent GET awaits summary admission", async () => {
  const scope = await seed(); const session = await open(scope); const staleRead = deferred<Response>(); let parentReads = 0; let stepsReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/steps")) return ++stepsReads === 2 ? staleRead.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return Promise.resolve(resourceResponse(body(++parentReads === 1 ? 5n : 6n), TEST_VIEWER_ID));
  }); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false)); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  session.load(projectId, taskId, 2, "refresh"); await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 5n }, stale: true, refreshing: true });
  staleRead.resolve(resourceResponse(resource(), TEST_VIEWER_ID)); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).error).toMatchObject({ kind: "protocol" }));
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 5n }, stale: true }); expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n);
});

it.each(["steps", "parent"] as const)("keeps %s 410 terminal while an ahead parent resumes summary admission", async (source) => {
  const scope = await seed(); const session = await open(scope); const steps = deferred<Response>(); let parentReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/steps")) return steps.promise;
    return Promise.resolve(++parentReads === 1 ? resourceResponse(body(), TEST_VIEWER_ID) : parentReads === 2 ? resourceResponse(body(6n), TEST_VIEWER_ID) : failure(410, "task_deleted"));
  }); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("ready"));
  const refresh = vi.fn(); session.subscribeProject(projectId, refresh); session.load(projectId, taskId, 2, "refresh"); await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); await apply(scope, body(6n));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { const result = await transaction(...args); entered.resolve(); await release.promise; return result; });
  session.observe(projectId, taskId, node(scope)); await entered.promise; start(session);
  steps.resolve(failure(source === "steps" ? 410 : 404, source === "steps" ? "task_deleted" : "not_found"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted")); release.resolve(); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "deleted", detail: null, requiresFreshRead: false }); expect(canSetStatus(session.snapshot(projectId, taskId))).toBe(false);
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "deleted", resource: null }); expect(parentReads).toBe(source === "steps" ? 2 : 3);
});

it("retains the observed parent floor after a later refresh clears its pending body and fails", async () => {
  const scope = await seed(); const session = await open(scope); const oldSteps = deferred<Response>(); let parentReads = 0; let stepsReads = 0;
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/steps")) return ++stepsReads === 2 ? oldSteps.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return Promise.resolve(++parentReads === 1 ? resourceResponse(body(), TEST_VIEWER_ID) : parentReads === 2 ? resourceResponse(body(6n), TEST_VIEWER_ID) : failure(500, "internal_error"));
  }); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false)); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  session.load(projectId, taskId, 2, "refresh"); await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); await waitFor(() => expect(stepsReads).toBe(2));
  session.load(projectId, taskId, 3, "refresh"); await waitFor(() => expect(session.snapshot(projectId, taskId).error).toMatchObject({ status: 500 }));
  oldSteps.resolve(resourceResponse(resource(), TEST_VIEWER_ID)); await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).refreshing).toBe(false));
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 5n }, stale: true, error: { kind: "protocol" } });
  expect(stepsReads).toBe(3); expect(scope.getSummaryVersion(projectId, taskId)).toBe(5n);
});

it.each(["force refresh", "release and reopen"] as const)("retains a verified Steps floor through %s and permits lower versions only in a new cache generation", async (action) => {
  const scope = await seed(); const session = await open(scope); let stepsReads = 0; let restored = false;
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(restored ? 1n : ++stepsReads === 1 ? 6n : 5n) : body(restored ? 1n : 5n), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  const release = start(session); await waitFor(() => expect(session.snapshot(projectId, taskId).detail?.version).toBe(5n)); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
  if (action === "force refresh") session.loadSteps(projectId, taskId, true);
  else { release(); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); start(session); }
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).status).not.toBe("loading"));
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "error", stale: true, error: { kind: "protocol" } }); expect(stepsReads).toBe(3);
  restored = true; await apply(scope, body(1n), true); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: { version: 1n }, status: "ready", stale: false, error: null }));
  expect(fetch.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
});

it("remembers a verified Steps version even when its cache admission fails", async () => {
  const scope = await seed(); const session = await open(scope); let stepsReads = 0; const admissionError = new Error("Cache admission unavailable");
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(resourceResponse(resource(++stepsReads === 1 ? 6n : 5n), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  vi.spyOn(scope, "detailTransaction").mockRejectedValueOnce(admissionError); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).error).toBe(admissionError)); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).status).not.toBe("loading"));
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: null, status: "error", stale: true, error: { kind: "protocol" } }); expect(stepsReads).toBe(3);
});

it("excludes an old write admission after deletion and same-version restoration in a new cache generation", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); const restored = { ...body(), title: "Restored private title", description: "Restored private description" }; let restoredHistory = false; let stepsReads = 0;
  const fetch = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method !== undefined ? write.promise : Promise.resolve(url.endsWith("/steps") ? ++stepsReads === 1 ? failure(410, "task_deleted") : resourceResponse(resource(), TEST_VIEWER_ID) : resourceResponse(restoredHistory ? restored : body(), TEST_VIEWER_ID))); vi.stubGlobal("fetch", fetch);
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false));
  session.setStatus(projectId, taskId, "todo", 5n); await waitFor(() => expect(fetch.mock.calls.filter(([, options]) => options.method !== undefined)).toHaveLength(1));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { const result = await transaction(...args); entered.resolve(); await release.promise; return result; });
  write.resolve(resourceResponse(body(), TEST_VIEWER_ID)); await entered.promise; start(session); await waitFor(() => expect(session.snapshot(projectId, taskId).status).toBe("deleted"));
  restoredHistory = true; await apply(scope, restored, true); session.observe(projectId, taskId, node(scope)); expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, status: "loading", mutation: { phase: "idle" } });
  release.resolve(); await drainReads(scope);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, status: "loading", mutation: { phase: "idle" } });
  session.load(projectId, taskId, 3, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).detail).toEqual(restored));
  expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "ready", requiresFreshRead: false, mutation: { phase: "idle" } });
  expect(fetch.mock.calls.filter(([, options]) => options.method !== undefined)).toHaveLength(1);
});

it("waits for identity verification before publishing parent cache admission that already committed", async () => {
  const scope = await seed(); const session = await open(scope); let parentReads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(resourceResponse(body(++parentReads === 1 ? 5n : 6n), TEST_VIEWER_ID))));
  session.load(projectId, taskId, 1, "open"); await waitFor(() => expect(session.snapshot(projectId, taskId).requiresFreshRead).toBe(false)); await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { const result = await transaction(...args); entered.resolve(); await release.promise; return result; });
  session.load(projectId, taskId, 2, "refresh"); await entered.promise; const resume = pauseAuthRequests();
  try { release.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(session.snapshot(projectId, taskId).detail?.version).toBe(5n); }
  finally { resume(); }
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 6n }, status: "ready", requiresFreshRead: false }));
});

it.each(["resume", "retire"] as const)("rechecks identity after committed Steps cache admission before %s", async (outcome) => {
  const scope = await seed(); const session = await open(scope); vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID))));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { const result = await transaction(...args); entered.resolve(); await release.promise; return result; });
  start(session); await entered.promise; const resume = pauseAuthRequests();
  if (outcome === "resume") vi.spyOn(scope, "ready").mockRejectedValueOnce(new DOMException("Identity verification changed.", "AbortError"));
  try {
    release.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
    if (outcome === "retire") { await scope.invalidateScope(); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); }
  } finally { resume(); }
  if (outcome === "resume") await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(), status: "ready", stale: false }));
  else { await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); }
});


it("serializes an append with parent writes and admits it only after the parent and summary converge", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); let updated = false;
  const added: TaskStep = { ...item, id: "0000000a", title: "New", description: "Draft", status: "in_progress" };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "POST" ? write.promise : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(updated ? 6n : 5n, updated ? [item, added] : [item]) : body(updated ? 6n : 5n), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.addStep(projectId, taskId, "0000000a", "New", "Draft", "in_progress", 5n);
  expect(token).toMatch(/^[0-9a-f-]{36}$/); session.setStatus(projectId, taskId, "done", 5n); session.moveStep(projectId, taskId, item.id, { position: "last" }, 5n);
  expect(session.addStep(projectId, taskId, "0000000b", "Another", "", "todo", 5n)).toBeNull();
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1));
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(0);
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item]);
  updated = true;
  write.resolve(new Response(JSON.stringify({ ...resource(6n, [item, added]), version: 6 }), { status: 201, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json", Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a` }) }));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepAdd", stepId: "0000000a", requestId: token }, phase: "confirmed", reconciling: true }));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item, added]);
});

it("reconciles an unknown append against its original identity without replay or attributing existence", async () => {
  const scope = await seed(); const session = await open(scope); let submitted = false; let failed = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "POST") { submitted = true; return Promise.reject(new Error("Offline")); }
    if (url.endsWith("/steps") && submitted && !failed) { failed = true; return Promise.resolve(failure(500, "internal_error")); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.addStep(projectId, taskId, "0000000a", "New", "Draft", "todo", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepAdd", stepId: "0000000a", requestId: token }, phase: "unknown", reconciling: false, reconciliationError: { status: 500 } }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false); session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: "unknown", reconciling: false }));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps.some((step) => step.id === "0000000a")).toBe(false);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
});

it.each(["conflict", "invalid receipt"] as const)("reconciles an append %s after its view closes without another POST", async (outcome) => {
  const scope = await seed(); const session = await open(scope); const pending = deferred<Response>(); let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "POST") { submitted = true; return outcome === "conflict" ? Promise.resolve(failure(409, "version_conflict")) : Promise.resolve(new Response(JSON.stringify({ invalid: true }), { status: 201, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json", Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/0000000a` }) })); }
    if (url.endsWith("/steps")) return submitted ? pending.promise : Promise.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
    return Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); const release = start(session); session.load(projectId, taskId, 1, "open");
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.addStep(projectId, taskId, "0000000a", "New", "Draft", "todo", 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { requestId: token }, phase: outcome === "conflict" ? "conflict" : "unknown", reconciling: true }));
  release(); pending.resolve(resourceResponse(resource(), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { requestId: token, stepId: "0000000a" }, phase: "reconciled", reconciledFrom: outcome === "conflict" ? "conflict" : "unknown", reconciling: false }));
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
});

it('retains a verified append when local Steps admission fails and recovers without replay', async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); const parent = deferred<void>(); let submitted = false;
  const added: TaskStep = { ...item, id: '0000000a', title: 'New', description: 'Draft', status: 'todo' };
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === 'POST') { submitted = true; return write.promise; }
    if (url.endsWith('/steps')) return Promise.resolve(resourceResponse(submitted ? resource(6n, [item, added]) : resource(), TEST_VIEWER_ID));
    return submitted ? parent.promise.then(() => resourceResponse(body(6n), TEST_VIEWER_ID)) : Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal('fetch', fetcher); session.load(projectId, taskId, 1, 'open'); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.addStep(projectId, taskId, added.id, added.title, added.description, added.status, 5n);
  await waitFor(() => expect(submitted).toBe(true));
  const error = new Error('Local admission failed'); vi.spyOn(scope, 'detailTransaction').mockRejectedValueOnce(error);
  write.resolve(new Response(JSON.stringify({ ...resource(6n, [item, added]), version: 6 }), { status: 201,
    headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json', Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${added.id}` }) }));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: 'stepAdd', requestId: token }, phase: 'confirmed', reconciling: false, reconciliationError: error }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  parent.resolve(); await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: 'confirmed', reconciling: false, reconciliationError: null }));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item, added]);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
});

it.each([
  [{ position: "first" } as const, ["00000002", "00000001", "00000003"], 6n],
  [{ position: "last" } as const, ["00000001", "00000003", "00000002"], 6n],
  [{ before: "00000003" } as const, ["00000001", "00000002", "00000003"], 5n],
  [{ after: "00000003" } as const, ["00000001", "00000003", "00000002"], 6n],
])("accepts exact position result and converges, including no-op %#", async (placement, order, version) => {
  const scope = await seed(); const session = await open(scope);
  const second = { ...item, id: "00000002", title: "Second" }; const third = { ...item, id: "00000003", title: "Third" };
  const original = [item, second, third]; const reordered = order.map((id) => original.find((step) => step.id === id)!); let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(resourceResponse(resource(version, reordered), TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? version : 5n, submitted ? reordered : original) : body(submitted ? version : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.moveStep(projectId, taskId, second.id, placement, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepPosition" }, phase: "confirmed" }));
  if (version !== 5n) { await apply(scope, body(version)); session.observe(projectId, taskId, node(scope)); }
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual(reordered);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it("rejects a wrong order or altered step content as unknown and reconciles without replay", async () => {
  const scope = await seed(); const session = await open(scope); const second = { ...item, id: "00000002" }; const original = [item, second]; let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return Promise.resolve(resourceResponse(resource(6n, [{ ...second, title: "changed" }, item]), TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(5n, original) : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.moveStep(projectId, taskId, second.id, { position: "first" }, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: "unknown" }));
  expect(submitted).toBe(true); expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual(original);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each([[{ before: item.id }, 400, "invalid_input"], [{ after: "ffffffff" }, 404, "not_found"]] as const)("reports invalid anchor failures without a fallback %#", async (placement, status, code) => {
  const scope = await seed(); const session = await open(scope);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? Promise.resolve(failure(status, code)) : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.moveStep(projectId, taskId, item.id, placement, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepPosition" }, phase: "refused", error: { status, code } }));
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});

it.each(["unknown", "conflict"] as const)("reconciles a position %s without replay and excludes other writes", async (outcome) => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") { submitted = true; return write.promise; }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.moveStep(projectId, taskId, item.id, { position: "last" }, 5n); session.setStatus(projectId, taskId, "done", 5n);
  await waitFor(() => expect(submitted).toBe(true)); expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  expect(session.addStep(projectId, taskId, "0000000a", "New", "", "todo", 5n)).toBeNull();
  write.resolve(outcome === "unknown" ? resourceResponse({ invalid: true }, TEST_VIEWER_ID) : failure(409, "version_conflict"));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: outcome, reconciling: false }));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item]);
  expect(session.canSetStepStatus(projectId, taskId)).toBe(true); expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
});
