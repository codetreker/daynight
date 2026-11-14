import { act, fireEvent, renderHook, screen, waitFor as waitForDom, within } from "@testing-library/react";
import { waitForState as waitFor } from "./helpers/waitForState";
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
import { TaskDraftBoundary } from "../src/features/task-detail/TaskDraftNavigation";
import { TaskStepsPanel } from "../src/features/task-detail/steps/TaskStepsPanel";
import { renderWithLocale } from "./helpers/renderWithLocale";
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
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const apply = async (scope: TaskCacheScope, detail: TaskDetail, snapshot = false) => {
  let ticket = await scope.beginSync(projectId, signal());
  const build = () => taskSyncFromGraph(graphFixture([detail]), { query: snapshot || ticket.epoch === null ? {} : { epoch: ticket.epoch }, ...(snapshot ? { epoch: "30000000-0000-4000-8000-000000000002" } : {}), versionForTask: () => detail.version, propertiesForTask: () => detail.properties });
  let sync = build();
  if (await scope.observeHistory(ticket, sync.epoch, signal()) === "retired") { ticket = await scope.beginSync(projectId, signal()); sync = build(); }
  return scope.applySync(ticket, sync, signal());
};
const applyAbsentSnapshot = async (scope: TaskCacheScope, withSurvivor = false) => {
  const graph = graphFixture([body()]);
  const empty = withSurvivor ? graphFixture([detailFixture(projectId, "20000000-0000-4000-8000-000000000002")])
    : { ...graph, tasks: [], summary: { proposed: 0, total: 0, todo: 0, inProgress: 0, done: 0, cancelled: 0, ready: 0, blocked: 0 } };
  const ticket = await scope.beginSync(projectId, signal());
  return scope.applySync(ticket, taskSyncFromGraph(empty, { epoch: "30000000-0000-4000-8000-000000000003", versionForTask: () => 1n }), signal());
};
const seed = async () => { const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); await apply(scope, body()); return scope; };
const node = (scope: TaskCacheScope) => scope.getAuthorizedProject(projectId)!.index.nodes.get(taskId)!;
const open = async (scope: TaskCacheScope) => { const session = new TaskDetailSessions(scope); sessions.push(session); session.observe(projectId, taskId, node(scope)); return session; };
const start = (session: TaskDetailSessions, listener = vi.fn()) => { const release = session.subscribeSteps(projectId, taskId, listener); session.loadSteps(projectId, taskId); return release; };
const failure = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: "Failure", requestId: "steps-failure" } }), { status, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json" }) });
afterEach(() => { sessions.splice(0).forEach((session) => session.dispose()); scopes.splice(0).forEach((scope) => scope.dispose()); });

it("keeps loaded Steps when a dispatched status write is suspended before a receipt", async () => {
  const scope = await seed(); const session = await open(scope);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT"
    ? new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }))
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1));
  const reads = fetcher.mock.calls.filter(([, options]) => options.method === undefined).length;
  const resume = pauseAuthRequests();
  try {
    session.suspendForAccountRefresh();
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: false }));
    expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "ready", detail: body() });
    expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource());
    expect(fetcher.mock.calls.filter(([, options]) => options.method === undefined)).toHaveLength(reads);
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  } finally { resume(); }
});

it("releases a retained Steps collection after permanent suspension and the last reader leaves", async () => {
  const scope = await seed(); const session = await open(scope);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT"
    ? new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }))
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); const unsubscribe = start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1));
  const resume = pauseAuthRequests();
  try {
    session.suspendForAccountRefresh();
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "unknown", reconciling: false }));
    expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource());
    unsubscribe();
    await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull());
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  } finally { resume(); }
});

it("releases Steps when the last reader leaves before a confirmed publication is permanently suspended", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); const unsubscribe = start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1));
  const resume = pauseAuthRequests();
  try {
    write.resolve(resourceResponse(resource(6n, [{ ...item, status: "done" }]), TEST_VIEWER_ID));
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false, publicationPending: true }));
    unsubscribe(); expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource());
    session.suspendForAccountRefresh();
    await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull());
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  } finally { resume(); }
});

it.each(["conflict", "missing", "network"] as const)("settles a known %s outcome when its admission is paused", async (outcome) => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PUT" ? write.promise
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1));
  const entered = deferred<void>(); const release = deferred<void>(); const ready = scope.ready.bind(scope);
  vi.spyOn(scope, "ready").mockImplementationOnce(async (signal) => { entered.resolve(); await release.promise; return ready(signal); });
  if (outcome === "network") {
    // A real transport rejection is observed by the request before outcome admission.
    write.reject(new Error("Offline"));
  } else write.resolve(failure(outcome === "conflict" ? 409 : 404, outcome === "conflict" ? "version_conflict" : "not_found"));
  await entered.promise;
  const reads = fetcher.mock.calls.filter(([, options]) => options.method === undefined).length;
  const resume = pauseAuthRequests();
  try {
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: outcome === "conflict" ? "conflict" : outcome === "missing" ? "refused" : "unknown", reconciling: false }));
    expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "ready", detail: body() });
    expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource());
    expect(fetcher.mock.calls.filter(([, options]) => options.method === undefined)).toHaveLength(reads);
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  } finally { session.suspendForAccountRefresh(); release.resolve(); resume(); }
});

it("preserves a newer Step draft when a confirmed edit publishes after a temporary pause", async () => {
  const scope = await seed(); let taskNode = node(scope); const write = deferred<Response>(); let updated = false;
  const saved = { ...item, title: "Submitted title", updatedAt: "2026-10-22T10:00:06Z" };
  const newer = { ...saved, title: "Newer draft", updatedAt: "2026-10-22T10:00:07Z" }; let writes = 0;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "PATCH" ? ++writes === 1 ? write.promise : Promise.resolve(resourceResponse(resource(7n, [newer]), TEST_VIEWER_ID))
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(updated ? 6n : 5n, updated ? [saved] : [item]) : body(updated ? 6n : 5n), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher);
  let session!: TaskDetailSessions;
  const Workspace = () => {
    session = useTaskDetailSessions();
    const current = useTaskDetail(projectId, taskId, 1, taskNode);
    return <TaskStepsPanel projectId={projectId} taskId={taskId} active={current.detail !== null} available={current.detail !== null} renderMarkdown={(text) => <div>{text}</div>} />;
  };
  const tree = () => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>
    <TaskDraftBoundary projectId={projectId} taskId={taskId} page><Workspace /></TaskDraftBoundary>
  </TaskDetailSessionProvider></TaskCacheProvider>;
  const view = renderWithLocale(tree(), { locale: "en" });
  await waitForDom(() => expect(screen.getByRole("button", { name: "Read" })).toBeVisible());
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit step" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Submitted title" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(1));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return transaction(...args); });
  let resume: (() => void) | null = null;
  try {
    await act(async () => { write.resolve(resourceResponse(resource(6n, [saved]), TEST_VIEWER_ID)); await entered.promise; });
    resume = pauseAuthRequests();
    await act(async () => { release.resolve(); });
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false }));
    expect(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Newer draft" } });
    updated = true; resume(); resume = null;
    await act(async () => { await apply(scope, body(6n)); taskNode = node(scope); view.rerender(tree()); });
    await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 6n }, requiresFreshRead: false, mutation: { phase: "confirmed", reconciling: false } }));
    await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(6n, [saved]), stale: false }));
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.publicationPending).not.toBe(true));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Newer draft");
    await waitForDom(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(2));
    expect(JSON.parse(String(fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")[1]![1].body))).toEqual({ version: 6, title: "Newer draft", description: item.description });
  } finally { release.resolve(); resume?.(); }
});

it.each(["before", "after"] as const)("retains a dirty delete draft when old admission releases %s replacement readback", async (releaseOrder) => {
  const scope = await seed(); const write = deferred<Response>(); let restoredHistory = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "DELETE" ? write.promise
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(restoredHistory ? 7n : 5n) : body(restoredHistory ? 7n : 5n), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher);
  let session!: TaskDetailSessions;
  const Capture = () => { session = useTaskDetailSessions(); return null; };
  const Workspace = () => {
    const current = useTaskDetail(projectId, taskId, 1, scope.getAuthorizedProject(projectId)?.index.nodes.get(taskId));
    return <TaskStepsPanel projectId={projectId} taskId={taskId} active={current.detail !== null} available={current.detail !== null} renderMarkdown={(text) => <div>{text}</div>} />;
  };
  const tree = () => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Capture />
    <TaskDraftBoundary projectId={projectId} taskId={taskId} page>
      <Workspace />
    </TaskDraftBoundary>
  </TaskDetailSessionProvider></TaskCacheProvider>;
  const view = renderWithLocale(tree(), { locale: "en" });
  act(() => { session.observe(projectId, taskId, node(scope)); session.load(projectId, taskId, 1, "open"); session.loadSteps(projectId, taskId); });
  await waitForDom(() => {
    expect(session.canSetStepStatus(projectId, taskId)).toBe(true);
    expect(screen.getByRole("button", { name: "Read" })).toBeVisible();
  });
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit step" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unsaved revision" } });
  fireEvent.click(screen.getByRole("button", { name: "More actions for Read" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete step" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete step" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1));
  const entered = deferred<void>(); const release = deferred<void>(); const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return transaction(...args); });
  const phases: string[] = [];
  const unsubscribe = session.subscribe(projectId, taskId, () => phases.push(session.snapshot(projectId, taskId).mutation.phase));
  try {
    await act(async () => { write.resolve(resourceResponse(resource(6n, []), TEST_VIEWER_ID)); await entered.promise; });
    expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: true });
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unsaved revision");
    // Retire the real receipt ticket before its cache admission transaction runs.
    await act(async () => { restoredHistory = true; await apply(scope, body(7n), true); view.rerender(tree()); });
    if (releaseOrder === "before") await act(async () => { release.resolve(); });
    // Flush the inactive-reader cleanup before observing the replacement UI.
    await act(async () => {});
    await waitForDom(() => {
      expect(session.snapshot(projectId, taskId)).toMatchObject({ status: "ready", refreshing: false, detail: { version: 7n }, requiresFreshRead: false });
      expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ status: "ready", stale: false, refreshing: false, error: null, resource: resource(7n, [item]) });
      expect(screen.getByRole("button", { name: "Read" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unsaved revision");
    });
    expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item]);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unsaved revision");
    if (releaseOrder === "after") await act(async () => { release.resolve(); });
    await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "reconciled", reconciledFrom: "unknown", reconciling: false }));
    expect(phases).toContain("confirmed"); expect(phases).toContain("unknown");
    expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item]);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unsaved revision");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeEnabled();
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
  } finally { release.resolve(); unsubscribe(); }
});

it.each([true, false])("cleans a confirmed delete draft after admission with the Steps tab visible %s", async (visibleDuringAdmission) => {
  const scope = await seed(); const write = deferred<Response>(); let deleted = false; let visible = true;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "DELETE" ? write.promise
    : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(deleted ? 6n : 5n, deleted ? [] : [item]) : body(deleted ? 6n : 5n), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher);
  let session!: TaskDetailSessions;
  const Workspace = () => {
    session = useTaskDetailSessions();
    const current = useTaskDetail(projectId, taskId, 1, node(scope));
    return <TaskStepsPanel projectId={projectId} taskId={taskId} active={visible && current.detail !== null} available={current.detail !== null} renderMarkdown={(text) => <div>{text}</div>} />;
  };
  const tree = () => <TaskCacheProvider scope={scope}><TaskDetailSessionProvider>
    <TaskDraftBoundary projectId={projectId} taskId={taskId} page><Workspace /></TaskDraftBoundary>
  </TaskDetailSessionProvider></TaskCacheProvider>;
  const view = renderWithLocale(tree(), { locale: "en" });
  await waitForDom(() => {
    expect(session.canSetStepStatus(projectId, taskId)).toBe(true);
    expect(screen.getByRole("button", { name: "Read" })).toBeVisible();
  });
  fireEvent.click(screen.getByRole("button", { name: "Read" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit step" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Unsaved revision" } });
  fireEvent.click(screen.getByRole("button", { name: "More actions for Read" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete step" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete step" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1));
  visible = visibleDuringAdmission; view.rerender(tree());
  await act(async () => { deleted = true; write.resolve(resourceResponse(resource(6n, []), TEST_VIEWER_ID)); });
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: true }));
  await act(async () => { await apply(scope, body(6n)); view.rerender(tree()); });
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ requiresFreshRead: false, mutation: { phase: "confirmed", reconciling: false } }));
  expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed");
  if (!visibleDuringAdmission) {
    expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
    visible = true; view.rerender(tree());
  }
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ stale: false, resource: { version: 6n, steps: [] } }));
  await waitForDom(() => expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull());
  await waitForDom(() => expect(screen.getByRole("button", { name: "Add step" })).toHaveFocus());
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});

it("recovers a completed deletion after project access is revoked and restored without replay", async () => {
  const scope = await seed(); const session = await open(scope); let deleted = false; let restored = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "DELETE") { deleted = true; return Promise.resolve(resourceResponse(resource(6n, []), TEST_VIEWER_ID)); }
    const version = restored ? 7n : deleted ? 6n : 5n;
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(version, deleted ? [] : [item]) : body(version), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.deleteStep(projectId, taskId, item.id, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation.phase).toBe("confirmed"));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false }));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const ticket = await scope.beginSync(projectId, signal()); await scope.revokeProject(ticket, scope.signal);
  session.observe(projectId, taskId, undefined, false);
  expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: null, mutation: { phase: "unknown", reconciling: false } });
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
  restored = true; await apply(scope, body(7n), true); session.observe(projectId, taskId, node(scope));
  session.load(projectId, taskId, 2, "open");
  await waitFor(() => expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: { version: 7n }, requiresFreshRead: false, mutation: { phase: "reconciled", reconciledFrom: "unknown", reconciling: false } }));
  expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ stale: false, resource: { version: 7n, steps: [] } });
  expect(session.canSetStepStatus(projectId, taskId)).toBe(true);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});

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

it("submits each Step status in sequence and confirms a same-status no-op without changing the resource", async () => {
  const scope = await seed(); const session = await open(scope); const other = { ...item, id: "00000002", title: "Other" };
  let version = 5n; let current = item;
  const writes: { version: number; status: TaskStep["status"]; requestId: string }[] = [];
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") {
      const input = JSON.parse(String(options.body)) as { version: number; status: TaskStep["status"] };
      writes.push({ ...input, requestId: (options.headers as Record<string, string>)["X-Request-ID"]! });
      if (current.status !== input.status) { version++; current = { ...current, status: input.status }; }
      return Promise.resolve(resourceResponse(resource(version, [current, other]), TEST_VIEWER_ID));
    }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(version, [current, other]) : body(version), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  for (const [index, status] of (["in_progress", "done", "skipped", "todo"] as const).entries()) {
    const previousVersion = version;
    session.setStepStatus(projectId, taskId, item.id, status, previousVersion);
    await waitFor(() => expect(writes).toHaveLength(index + 1));
    expect(writes[index]).toMatchObject({ version: Number(previousVersion), status });
    expect(writes[index]!.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(version).toBe(previousVersion + 1n);
    await apply(scope, body(version)); session.observe(projectId, taskId, node(scope));
    await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
    expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource(version, [current, other]));
    expect(current.status).toBe(status);
  }
  const before = session.stepsSnapshot(projectId, taskId).resource;
  session.setStepStatus(projectId, taskId, item.id, "todo", version);
  await waitFor(() => expect(writes).toHaveLength(5));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false }));
  expect(writes[4]).toMatchObject({ version: 9, status: "todo" });
  expect(version).toBe(9n); expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(before);
  expect(new Set(writes.map(write => write.requestId)).size).toBe(5);
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

it("keeps another loaded task's Steps unchanged when the earlier task's write arrives", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>();
  const otherId = "20000000-0000-4000-8000-000000000002";
  const otherDetail = detailFixture(projectId, otherId, { title: "Other task", version: 5n });
  const otherSteps: StepsResource = { projectId, taskId: otherId, version: 5n, steps: [{ ...item, id: "00000002", title: "Other task step" }] };
  const changed = { ...item, status: "done" as const, updatedAt: "2026-10-22T10:00:06Z" };
  let updated = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PUT") return write.promise;
    if (url.includes(`/tasks/${otherId}`)) return Promise.resolve(resourceResponse(url.endsWith("/steps") ? otherSteps : otherDetail, TEST_VIEWER_ID));
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(updated ? 6n : 5n, updated ? [changed] : [item]) : body(updated ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher);
  const releaseDetail = session.subscribe(projectId, taskId, vi.fn());
  session.load(projectId, taskId, 1, "open"); const releaseSteps = start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  await waitFor(() => expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1));
  releaseDetail(); releaseSteps();
  await apply(scope, otherDetail);
  session.observe(projectId, otherId, scope.getAuthorizedProject(projectId)!.index.nodes.get(otherId)!);
  const releaseOtherDetail = session.subscribe(projectId, otherId, vi.fn());
  const releaseOtherSteps = session.subscribeSteps(projectId, otherId, vi.fn());
  session.load(projectId, otherId, 1, "open"); session.loadSteps(projectId, otherId);
  await waitFor(() => expect(session.stepsSnapshot(projectId, otherId)).toMatchObject({ status: "ready", resource: otherSteps, stale: false }));
  updated = true; await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  write.resolve(resourceResponse(resource(6n, [changed]), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false }));
  expect(session.snapshot(projectId, otherId).detail).toEqual(otherDetail);
  expect(session.stepsSnapshot(projectId, otherId)).toMatchObject({ status: "ready", resource: otherSteps, stale: false });
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  releaseOtherSteps(); releaseOtherDetail();
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
  const entered = deferred<void>(); const release = deferred<void>();
  const transaction = scope.detailTransaction.bind(scope); let intercepted = false;
  vi.spyOn(scope, "detailTransaction").mockImplementation(async (...args) => {
    const result = await transaction(...args);
    // Hold parent admission after its real IndexedDB transaction completes.
    if (result !== null && typeof result === "object" && "kind" in result && result.kind === "matching" && !intercepted) {
      intercepted = true; entered.resolve(); await release.promise;
    }
    return result;
  });
  try {
    await apply(scope, next); session.observe(projectId, taskId, node(scope));
    await entered.promise;
    await waitFor(() => expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(6n), status: "ready", stale: false, refreshing: false, error: null }));
    expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: next, requiresFreshRead: true });
    expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
    session.setStepStatus(projectId, taskId, item.id, "done", 6n);
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(0);
  } finally { release.resolve(); }
  await waitFor(() => {
    expect(session.snapshot(projectId, taskId)).toMatchObject({ detail: next, requiresFreshRead: false });
    expect(session.stepsSnapshot(projectId, taskId)).toMatchObject({ resource: resource(6n), status: "ready", stale: false, refreshing: false, error: null });
    expect(session.canSetStepStatus(projectId, taskId)).toBe(true);
  });
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(0);
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

it("withdraws the task and requests a project access revalidation after a trusted parent 404", async () => {
  const scope = await seed(); const session = await open(scope); const events: string[] = []; scope.subscribe((event) => { if (event.taskNotFound) events.push(event.projectId); });
  const fetch = vi.fn().mockResolvedValueOnce(resourceResponse(resource(), TEST_VIEWER_ID)).mockImplementation(() => Promise.resolve(failure(404, "not_found"))); vi.stubGlobal("fetch", fetch); start(session);
  await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).stale).toBe(false)); session.loadSteps(projectId, taskId, true);
  await waitFor(() => expect(events).toEqual([projectId])); expect(scope.getAuthorizedProject(projectId)).not.toBeNull(); expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull(); expect(session.snapshot(projectId, taskId).detail).toBeNull(); expect(fetch).toHaveBeenCalledTimes(3);
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

// Hold successful Steps admission after its source-specific IndexedDB qualification.
// Recovery reads remain independently controlled so the terminal event wins the await.
const heldStepSuccess = async (action: "status" | "position", source: "summary" | "direct" = "summary") => {
  const scope = source === "summary" ? await seed() : createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  if (source === "direct") scopes.push(scope);
  const session = source === "summary" ? await open(scope) : new TaskDetailSessions(scope);
  if (source === "direct") sessions.push(session);
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
  vi.stubGlobal("fetch", fetcher);
  if (source === "direct") session.openDirect(projectId, taskId); else session.load(projectId, taskId, 1, "open");
  start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  if (action === "status") session.setStepStatus(projectId, taskId, item.id, "done", 5n);
  else session.moveStep(projectId, taskId, item.id, { position: "last" }, 5n);
  await waitFor(() => expect(submitted).toBe(true));
  if (source === "summary") {
    await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
    const transaction = scope.detailTransaction.bind(scope);
    vi.spyOn(scope, "detailTransaction").mockImplementation(async (...args) => {
      const result = await transaction(...args);
      if (typeof result === "bigint" && !intercepted) { intercepted = true; entered.resolve(); await release.promise; }
      return result;
    });
  } else {
    const verify = scope.verifyTaskRead.bind(scope);
    vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (...args) => {
      const result = await verify(...args);
      if (result && session.snapshot(projectId, taskId).mutation.phase === "confirmed" && !intercepted) {
        intercepted = true; entered.resolve(); await release.promise;
      }
      return result;
    });
  }
  write.resolve(resourceResponse(resource(6n, changed), TEST_VIEWER_ID)); await entered.promise;
  if (source === "direct") session.loadSteps(projectId, taskId, true);
  return { scope, session, fetcher, recovery, parent, release, replacementWrite, changed, restore: () => { restored = true; } };
};
const parentReadCount = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([url, options]) => options.method === undefined && !url.endsWith("/steps")).length;

it("publishes the original Step response after a temporary pause interrupts summary admission", async () => {
  const { session, fetcher, recovery, parent, release, changed } = await heldStepSuccess("status", "summary");
  const resume = pauseAuthRequests();
  try {
    expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false });
    const reads = fetcher.mock.calls.filter(([, options]) => options.method === undefined).length;
    release.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fetcher.mock.calls.filter(([, options]) => options.method === undefined)).toHaveLength(reads);
    expect(session.stepsSnapshot(projectId, taskId).resource?.steps).not.toEqual(changed);
    resume();
    // The independently controlled recovery GET is still pending, so these rows
    // can only come from the original write response.
    await waitFor(() => expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual(changed));
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  } finally { release.resolve(); resume(); recovery.resolve(failure(500, "internal_error")); parent.resolve(failure(500, "internal_error")); }
});

it.each([["status", "summary"], ["position", "summary"], ["status", "direct"], ["position", "direct"]] as const)("keeps deletion terminal when a successful Step %s awaits %s admission", async (action, source) => {
  const { scope, session, fetcher, recovery, parent, release } = await heldStepSuccess(action, source);
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

it.each(["history", "opening"] as const)("does not resume direct Step success after %s retirement during admission", async (retirement) => {
  const { scope, session, fetcher, recovery, parent, release } = await heldStepSuccess("status", "direct");
  if (retirement === "history") {
    const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, signal());
    expect(await scope.observeHistory(fence, "30000000-0000-4000-8000-000000000002", signal())).toBe("retired");
  } else session.openDirect(projectId, taskId);
  // Retirement owns independent readback, and reopening owns its new live GET.
  await drainReads(scope);
  const reads = parentReadCount(fetcher); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  const operation = session.snapshot(projectId, taskId).mutation.operation;
  release.resolve(); await drainReads(scope);
  expect(parentReadCount(fetcher)).toBe(reads); expect(refresh).not.toHaveBeenCalled();
  expect(session.snapshot(projectId, taskId).mutation.operation).toBe(operation);
  expect(session.stepsSnapshot(projectId, taskId).resource).toBeNull();
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  recovery.resolve(failure(500, "internal_error")); parent.resolve(failure(500, "internal_error"));
});

it("waits for same-identity verification before direct Step success follow-up without replay", async () => {
  const { scope, session, fetcher, recovery, parent, release, changed } = await heldStepSuccess("status", "direct");
  const reads = parentReadCount(fetcher); const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  const resume = pauseAuthRequests();
  try {
    release.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(parentReadCount(fetcher)).toBe(reads); expect(refresh).not.toHaveBeenCalled();
  } finally { resume(); }
  recovery.resolve(resourceResponse(resource(6n, changed), TEST_VIEWER_ID)); parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(parentReadCount(fetcher)).toBe(reads + 1); expect(refresh).toHaveBeenCalled();
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  await drainReads(scope);
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
  expect(session.stepsSnapshot(projectId, taskId).resource).toEqual(resource(6n, changed));
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

it.each([["status", "summary"], ["position", "summary"], ["status", "direct"], ["position", "direct"]] as const)("continues a live Step %s success after awaited %s admission without replay", async (action, source) => {
  const { scope, session, fetcher, recovery, parent, release, changed } = await heldStepSuccess(action, source);
  recovery.resolve(resourceResponse(resource(6n, changed), TEST_VIEWER_ID));
  const refresh = vi.fn(); session.subscribeProject(projectId, refresh);
  const reads = parentReadCount(fetcher);
  parent.resolve(resourceResponse(body(6n), TEST_VIEWER_ID)); release.resolve();
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(parentReadCount(fetcher)).toBe(reads + 1);
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

it.each(["before", "after"] as const)("admits an exact %s insertion through the shared owner", async (direction) => {
  const scope = await seed(); const session = await open(scope); let submitted = false;
  const added: TaskStep = { ...item, id: "0000000a", title: "New", description: "Draft", status: "todo" };
  const ordered = direction === "before" ? [added, item] : [item, added];
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "POST") { submitted = true; return Promise.resolve(new Response(JSON.stringify({ ...resource(6n, ordered), version: 6 }), { status: 201, headers: viewerHeaders(TEST_VIEWER_ID, { "Content-Type": "application/json", Location: `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${added.id}` }) })); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? 6n : 5n, submitted ? ordered : [item]) : body(submitted ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.addStep(projectId, taskId, added.id, added.title, added.description, added.status, 5n, { [direction]: item.id } as { before: string } | { after: string });
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepAdd", requestId: token }, phase: "confirmed" }));
  expect(fetcher.mock.calls.find(([, options]) => options.method === "POST")![1].body).toContain(`"${direction}":"${item.id}"`);
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual(ordered);
});

it.each([true, false])("validates atomic content edits and preserves other rows, including no-op %#", async (changed) => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); let submitted = false;
  const other = { ...item, id: "00000002" };
  const updated = changed ? { ...item, title: "Changed", description: "" } : item;
  const version = changed ? 6n : 5n;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PATCH") { submitted = true; return write.promise; }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? version : 5n, submitted ? [updated, other] : [item, other]) : body(submitted ? version : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session);
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.editStep(projectId, taskId, item.id, updated.title, updated.description, 5n);
  expect(token).toMatch(/^[0-9a-f-]{36}$/); session.setStatus(projectId, taskId, "done", 5n);
  expect(session.editStep(projectId, taskId, other.id, "Other", "", 5n)).toBeNull();
  await waitFor(() => expect(submitted).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item, other]);
  write.resolve(resourceResponse(resource(version, [updated, other]), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepEdit", stepId: item.id, requestId: token }, phase: "confirmed" }));
  if (changed) { await apply(scope, body(version)); session.observe(projectId, taskId, node(scope)); }
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([updated, other]);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(1);
});

it.each(["conflict", "unknown", "altered-neighbor", "no-op-timestamp"] as const)("reconciles content edit %s without replay or changing the baseline", async (outcome) => {
  const scope = await seed(); const session = await open(scope); let submitted = false;
  const other = { ...item, id: "00000002" };
  const title = outcome === "no-op-timestamp" ? item.title : "Changed";
  const description = outcome === "no-op-timestamp" ? item.description : "";
  const bad = outcome === "no-op-timestamp" ? [{ ...item, updatedAt: "2026-10-22T10:01:00Z" }, other] : [{ ...item, title, description }, { ...other, status: "done" as const }];
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "PATCH") {
      submitted = true;
      if (outcome === "conflict") return Promise.resolve(failure(409, "version_conflict"));
      if (outcome === "unknown") return Promise.reject(new Error("Offline"));
      return Promise.resolve(resourceResponse(resource(outcome === "no-op-timestamp" ? 5n : 6n, bad), TEST_VIEWER_ID));
    }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(5n, [item, other]) : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.editStep(projectId, taskId, item.id, title, description, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepEdit", requestId: token }, phase: "reconciled", reconciledFrom: outcome === "conflict" ? "conflict" : "unknown" }));
  expect(submitted).toBe(true); expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item, other]);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(1);
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

it.each(["todo", "in_progress", "done", "skipped"] as const)("deletes a %s step and preserves remaining records", async (status) => {
  const scope = await seed(); const session = await open(scope); const target = { ...item, status }; const other = { ...item, id: "00000002", title: "Other" }; let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "DELETE") { submitted = true; return Promise.resolve(resourceResponse(resource(6n, [other]), TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(submitted ? 6n : 5n, submitted ? [other] : [target, other]) : body(submitted ? 6n : 5n), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.deleteStep(projectId, taskId, target.id, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepDelete", requestId: token }, phase: "confirmed" }));
  await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope));
  await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([other]);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});

it.each(["unknown", "conflict", "altered-neighbor"] as const)("reconciles deletion %s without replay and excludes concurrent edits", async (outcome) => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); const other = { ...item, id: "00000002" }; let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "DELETE") { submitted = true; return write.promise; }
    return Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource(5n, [item, other]) : body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.deleteStep(projectId, taskId, item.id, 5n);
  expect(session.editStep(projectId, taskId, other.id, "New", "", 5n)).toBeNull();
  expect(session.deleteStep(projectId, taskId, other.id, 5n)).toBeNull();
  await waitFor(() => expect(submitted).toBe(true));
  write.resolve(outcome === "unknown" ? resourceResponse({ invalid: true }, TEST_VIEWER_ID) : outcome === "conflict" ? failure(409, "version_conflict") : resourceResponse(resource(6n, [{ ...other, title: "altered" }]), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepDelete", requestId: token }, phase: "reconciled", reconciledFrom: outcome === "conflict" ? "conflict" : "unknown" }));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([item, other]);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});

it("keeps the task readable when deletion reports a missing step", async () => {
  const scope = await seed(); const session = await open(scope);
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => options.method === "DELETE" ? Promise.resolve(failure(404, "not_found")) : Promise.resolve(resourceResponse(url.endsWith("/steps") ? resource() : body(), TEST_VIEWER_ID)));
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  session.deleteStep(projectId, taskId, item.id, 5n);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepDelete" }, phase: "refused", error: { status: 404 } }));
  expect(session.snapshot(projectId, taskId).status).toBe("ready");
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});

it("retains a verified deletion when local admission fails and recovers without replay", async () => {
  const scope = await seed(); const session = await open(scope); const write = deferred<Response>(); const parent = deferred<void>(); let submitted = false;
  const fetcher = vi.fn().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "DELETE") { submitted = true; return write.promise; }
    if (url.endsWith("/steps")) return Promise.resolve(resourceResponse(submitted ? resource(6n, []) : resource(), TEST_VIEWER_ID));
    return submitted ? parent.promise.then(() => resourceResponse(body(6n), TEST_VIEWER_ID)) : Promise.resolve(resourceResponse(body(), TEST_VIEWER_ID));
  });
  vi.stubGlobal("fetch", fetcher); session.load(projectId, taskId, 1, "open"); start(session); await waitFor(() => expect(session.canSetStepStatus(projectId, taskId)).toBe(true));
  const token = session.deleteStep(projectId, taskId, item.id, 5n); await waitFor(() => expect(submitted).toBe(true));
  const error = new Error("Local admission failed"); vi.spyOn(scope, "detailTransaction").mockRejectedValueOnce(error);
  write.resolve(resourceResponse(resource(6n, []), TEST_VIEWER_ID));
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ operation: { action: "stepDelete", requestId: token }, phase: "confirmed", reconciling: false, reconciliationError: error }));
  expect(session.canSetStepStatus(projectId, taskId)).toBe(false);
  parent.resolve(); await apply(scope, body(6n)); session.observe(projectId, taskId, node(scope)); session.reconcile(projectId, taskId);
  await waitFor(() => expect(session.snapshot(projectId, taskId).mutation).toMatchObject({ phase: "confirmed", reconciling: false, reconciliationError: null }));
  expect(session.stepsSnapshot(projectId, taskId).resource?.steps).toEqual([]);
  expect(fetcher.mock.calls.filter(([, options]) => options.method === "DELETE")).toHaveLength(1);
});
