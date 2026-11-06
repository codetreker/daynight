import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { getTaskObservation, pauseAuthRequests } from "../src/api/client";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TaskCacheError, TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA } from "../src/features/task-cache/database";
import { openDB } from "idb";
import { TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { TEST_VIEWER_ID, viewerHeaders, taskSyncFromGraph, directAccessFixture } from "./helpers/taskSync";
import { wireResponse } from "./helpers/wireJson";

const project = "10000000-0000-4000-8000-000000000001";
const task = "20000000-0000-4000-8000-000000000001";
const epoch = "30000000-0000-4000-8000-000000000001";
const replacement = "30000000-0000-4000-8000-000000000002";
const body = (version = 1n, title = "Original") => detailFixture(project, task, { version, title });
const signal = () => new AbortController().signal;
const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
const response = (value: unknown, taskEpoch: string | null = epoch, status = 200) => wireResponse(value, { status, headers: viewerHeaders(TEST_VIEWER_ID, taskEpoch === null ? {} : { "Daynight-Task-Epoch": taskEpoch }) });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const worlds: { scope: TaskCacheScope; sessions: TaskDetailSessions }[] = [];
const world = () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  sessions.subscribe(project, task, () => {});
  return { scope, sessions };
};
afterEach(() => { for (const { sessions, scope } of worlds.splice(0)) { sessions.dispose(); scope.dispose(); } vi.unstubAllGlobals(); });

it("strictly validates principal, epoch and complete task identity", async () => {
  for (const header of [null, "invalid", "AAAAAAAA-0000-4000-8000-000000000001"]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body(), header)));
    await expect(getTaskObservation(project, task, signal(), admission)).rejects.toMatchObject({ kind: "protocol" });
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...body(), projectId: task })));
  await expect(getTaskObservation(project, task, signal(), admission)).rejects.toMatchObject({ kind: "protocol" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body())));
  await expect(getTaskObservation(project, task, signal(), admission)).resolves.toMatchObject({ epoch, detail: { id: task } });
});

it("admits a direct opening without a manifest and uses its parent version for Steps", async () => {
  const { sessions, scope } = world();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith("/steps") ? { projectId: project, taskId: task, version: 1n, steps: [] } : body()))));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", requiresFreshRead: false }));
  expect(scope.getAuthorizedProject(project)).toBeNull();
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.stepsSnapshot(project, task)).toMatchObject({ status: "ready", stale: false, resource: { version: 1n } }));
  expect(sessions.canSetStepStatus(project, task)).toBe(true);
});

it("preserves a confirmed write when the required refresh fails and never replays it", async () => {
  const { sessions } = world(); let writes = 0; let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response({ ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" })); }
    reads++; if (reads > 1) return Promise.reject(new Error("offline"));
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ requiresFreshRead: true, mutation: { phase: "confirmed" }, error: { kind: "network" } }));
  expect(writes).toBe(1); expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
});

it("retires an old opening on epoch replacement and rereads under the new fence", async () => {
  const { sessions } = world(); let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => { reads++; return Promise.resolve(response(reads === 1 ? body() : body(1n, "Replacement"), reads === 1 ? epoch : replacement)); }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe("Original"));
  sessions.load(project, task, 1, "refresh");
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe("Replacement"));
  expect(reads).toBe(3); expect(sessions.historyGeneration(project)).toBe(1);
});

it("does not admit a delayed read from a closed opening", async () => {
  const { sessions } = world(); const old = deferred<Response>(); let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => ++reads === 1 ? old.promise : Promise.resolve(response(body(1n, "Reopened")))));
  sessions.openDirect(project, task);
  await waitFor(() => expect(reads).toBe(1));
  sessions.releaseRead(project, task); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe("Reopened"));
  old.resolve(response(body()));
  await Promise.resolve();
  expect(sessions.snapshot(project, task).detail?.title).toBe("Reopened");
});

it("retains an in-flight write across a history replacement and reconciles without admitting its old body", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); let reads = 0; let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    reads++; return Promise.resolve(response(reads === 1 ? body() : body(1n, "Replacement"), reads === 1 ? epoch : replacement));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  const fence = await scope.beginTaskRead(project, task, 0, 0, signal());
  expect(await scope.observeHistory(fence, replacement, signal())).toBe("retired");
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: { title: "Replacement" }, mutation: { phase: "idle" } }));
  write.resolve(response({ ...body(2n), title: "Old write", status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" }));
  await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
  expect(sessions.snapshot(project, task)).toMatchObject({ detail: { title: "Replacement" }, mutation: { phase: "idle" } });
  expect(writes).toBe(1);
});

it("preserves conflict attribution after direct reconciliation", async () => {
  const { sessions } = world();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => init.method === "PUT"
    ? Promise.resolve(response({ error: { code: "version_conflict", message: "Conflict", requestId: "conflict" } }, null, 409))
    : Promise.resolve(response(body()))));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: "conflict", reconciling: false }));
});

it("rereads the parent when Steps advances independently of the graph", async () => {
  const { sessions } = world(); let parents = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 2n, steps: [] }));
    parents++; return Promise.resolve(response(body(parents === 1 ? 1n : 2n)));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.version).toBe(1n));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.stepsSnapshot(project, task)).toMatchObject({ status: "ready", stale: false, resource: { version: 2n } }));
  expect(sessions.snapshot(project, task).detail?.version).toBe(2n);
});

it("withdraws a 404 and permits a fresh opening after 410", async () => {
  const { sessions } = world(); let mode: "ok" | "missing" | "deleted" = "ok";
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(mode === "ok" ? response(body()) : response({ error: { code: mode === "missing" ? "not_found" : "task_deleted", message: "Missing", requestId: "missing" } }, null, mode === "missing" ? 404 : 410))));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  mode = "missing"; sessions.load(project, task, 1, "refresh");
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null, error: { status: 404 } }));
  mode = "deleted"; sessions.load(project, task, 1, "refresh");
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("deleted"));
  mode = "ok"; sessions.releaseRead(project, task); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
});

it("waits through same-account admission before publishing a positive GET", async () => {
  const { sessions } = world(); const pending = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
  sessions.openDirect(project, task);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledOnce());
  const resume = pauseAuthRequests();
  pending.resolve(response(body()));
  await Promise.resolve();
  expect(sessions.snapshot(project, task).status).toBe("loading");
  resume();
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
});

it("withdraws a 404 immediately while same-account admission is paused", async () => {
  const { sessions } = world(); const pending = deferred<Response>(); let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => ++reads === 1 ? Promise.resolve(response(body())) : pending.promise));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.load(project, task, 1, "refresh");
  await waitFor(() => expect(reads).toBe(2));
  const resume = pauseAuthRequests();
  pending.resolve(response({ error: { code: "not_found", message: "Missing", requestId: "missing" } }, null, 404));
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null }));
  resume();
});

it("settles a submitted old write without publishing it into a reopened detail", async () => {
  const { sessions } = world(); const write = deferred<Response>(); let reads = 0; let writes = 0; let committed = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    reads++; return Promise.resolve(response(reads === 1 ? body() : body(committed ? 2n : 1n, "Reopened")));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  sessions.releaseRead(project, task); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe("Reopened"));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  sessions.setStatus(project, task, "in_progress", 1n);
  expect(writes).toBe(1);
  committed = true;
  write.resolve(response({ ...body(2n), title: "Old write", status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" }));
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: { title: "Reopened", version: 2n }, mutation: { phase: "idle" } }));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(false);
  expect(writes).toBe(1);
});

it("does not persist or admit a same-version detail from a replacement history against the old graph", async () => {
  const { sessions, scope } = world(); const ticket = await scope.beginSync(project, signal());
  const graph = graphFixture([body()]);
  const sync = taskSyncFromGraph(graph, { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties });
  await scope.observeHistory(ticket, epoch, signal()); await scope.applySync(ticket, sync, signal());
  sessions.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body(1n, "Replacement"), replacement)));
  sessions.requireOpeningRead(project, task); sessions.load(project, task, 1, "open");
  await waitFor(() => expect(scope.getHistoryGeneration(project)).toBe(1));
  expect(sessions.snapshot(project, task).detail).toBeNull();
  expect(scope.getAuthorizedProject(project)).toBeNull();
});

it("keeps a confirmed Step write gated until parent and collection reach the committed version", async () => {
  const { sessions } = world(); let parentVersion = 1n; let stepVersion = 1n; let writes = 0;
  const step = (status: "todo" | "done") => ({ id: "00000001", title: "First", description: "", status, createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" });
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; parentVersion = 2n; stepVersion = 2n; return Promise.resolve(response({ projectId: project, taskId: task, version: 2n, steps: [step("done")] })); }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: stepVersion, steps: [step(stepVersion === 1n ? "todo" : "done")] }));
    return Promise.resolve(response(body(parentVersion)));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.setStepStatus(project, task, "00000001", "done", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: { version: 2n }, mutation: { phase: "confirmed", reconciling: false } }));
  await waitFor(() => expect(sessions.stepsSnapshot(project, task)).toMatchObject({ status: "ready", stale: false, resource: { version: 2n } }));
  expect(writes).toBe(1); expect(sessions.canSetStepStatus(project, task)).toBe(true);
});

it("cannot restore a retired epoch or let an earlier request replace a newer first observation", async () => {
  const { scope } = world();
  const early = await scope.beginTaskRead(project, task, 1, 1, signal());
  const later = await scope.beginTaskRead(project, task, 1, 2, signal());
  expect(await scope.observeHistory(later, replacement, signal())).toBe("current");
  await expect(scope.observeHistory(early, epoch, signal())).rejects.toMatchObject({ name: "AbortError" });
  const current = await scope.beginTaskRead(project, task, 1, 3, signal());
  expect(await scope.observeHistory(current, epoch, signal())).toBe("retired");
  const after = await scope.beginTaskRead(project, task, 1, 4, signal());
  await expect(scope.observeHistory(after, replacement, signal())).rejects.toMatchObject({ name: "AbortError" });
});

it("revalidates project access after a retired submitted write returns 404", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); let writes = 0; const events: boolean[] = [];
  scope.subscribe((event) => { if (event.accessRevoked) events.push(true); });
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    if (url.endsWith("/access")) return Promise.resolve(response({ error: { code: "not_found", message: "Missing", requestId: "missing" } }, null, 404));
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  sessions.releaseRead(project, task); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  write.resolve(response({ error: { code: "not_found", message: "Missing", requestId: "missing" } }, null, 404));
  await waitFor(() => expect(events).toHaveLength(1));
  expect(sessions.snapshot(project, task).detail).toBeNull();
});

it("retries failed history retirement cleanup before admitting another read", async () => {
  const { scope } = world(); const first = await scope.beginTaskRead(project, task, 1, 1, signal());
  await scope.observeHistory(first, epoch, signal());
  const next = await scope.beginTaskRead(project, task, 1, 2, signal());
  const internals = scope as unknown as { userTransaction: (...args: unknown[]) => Promise<unknown> };
  const transaction = internals.userTransaction.bind(scope);
  vi.spyOn(internals, "userTransaction").mockImplementationOnce((...args) => transaction(...args)).mockRejectedValueOnce(new Error("storage unavailable")).mockImplementation((...args) => transaction(...args));
  await expect(scope.observeHistory(next, replacement, signal())).rejects.toThrow("storage unavailable");
  const retried = await scope.beginTaskRead(project, task, 2, 1, signal());
  expect(await scope.observeHistory(retried, replacement, signal())).toBe("current");
  expect(internals.userTransaction).toHaveBeenCalledTimes(4);
});

it("does not blacklist a validated epoch when a delayed other-tab purge has no active manifest", async () => {
  const { sessions, scope } = world(); let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => { reads++; return Promise.resolve(response(body(1n, "Current"), replacement)); }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe("Current"));
  const receiver = scope as unknown as { receiveHint: (hint: { userId: string; projectId: string }) => Promise<void> };
  await receiver.receiveHint({ userId: TEST_VIEWER_ID, projectId: project });
  expect(reads).toBe(1);
  expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", detail: { title: "Current" } });
  expect(sessions.historyGeneration(project)).toBe(0);
});

it("does not retire the current write lock on a delayed absent-manifest hint", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    return Promise.resolve(response(body(), replacement));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  const receiver = scope as unknown as { receiveHint: (hint: { userId: string; projectId: string }) => Promise<void> };
  await receiver.receiveHint({ userId: TEST_VIEWER_ID, projectId: project });
  expect(sessions.historyGeneration(project)).toBe(0);
  expect(sessions.snapshot(project, task).mutation.phase).toBe("pending");
  sessions.setStatus(project, task, "in_progress", 1n);
  expect(writes).toBe(1);
  write.resolve(response({ error: { code: "version_conflict", message: "Conflict", requestId: "hint-conflict" } }, null, 409));
});

it("withdraws same-epoch direct Session memory without a manifest even when storage is unavailable", async () => {
  const { scope } = world(); const fence = await scope.beginTaskRead(project, task, 1, 1, signal());
  await scope.observeHistory(fence, replacement, signal());
  const received: string[] = []; scope.subscribe((event) => { if (event.sessionHistoryUncertain) received.push(event.sessionHistoryUncertain.taskId); });
  const internals = scope as unknown as { receiveDirectSessionDenied: (projectId: string, userFence: string, taskId: string, epoch: string) => Promise<void>; userTransaction: (...args: unknown[]) => Promise<unknown> };
  vi.spyOn(internals, "userTransaction").mockRejectedValue(new Error("storage offline"));
  await internals.receiveDirectSessionDenied(project, fence.userFence, task, epoch);
  expect(received).toEqual([]);
  await internals.receiveDirectSessionDenied(project, fence.userFence, task, replacement);
  expect(received).toEqual([task]);
});

it("keeps direct authority and its in-flight write when another tab invalidates only the cache", async () => {
  const { sessions, scope } = world(); const peer = world().scope;
  const ticket = await scope.beginSync(project, signal());
  const sync = taskSyncFromGraph(graphFixture([body()]), { epoch: replacement, versionForTask: () => 1n, propertiesForTask: () => body().properties });
  await scope.observeHistory(ticket, replacement, signal()); await scope.applySync(ticket, sync, signal());
  const write = deferred<Response>(); let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    return Promise.resolve(response(body(), replacement));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const qualification = sessions.captureDirectQualification(project, task)!;
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  await peer.invalidateProject(project, signal());
  const receiver = scope as unknown as { receiveHint: (hint: { userId: string; projectId: string }) => Promise<void> };
  await receiver.receiveHint({ userId: TEST_VIEWER_ID, projectId: project });
  expect(sessions.historyGeneration(project)).toBe(0);
  expect(sessions.isDirectQualificationHistoryCurrent(project, task, qualification)).toBe(true);
  expect(sessions.snapshot(project, task).mutation.phase).toBe("pending");
  sessions.setStatus(project, task, "in_progress", 1n);
  expect(writes).toBe(1);
  write.resolve(response({ error: { code: "version_conflict", message: "Conflict", requestId: "cache-conflict" } }, null, 409));
});

it("opens direct details despite a corrupt optional manifest while normal cache reads remain strict", async () => {
  const { sessions, scope } = world(); const internals = scope as unknown as { manifest: (...args: unknown[]) => Promise<unknown> };
  vi.spyOn(internals, "manifest").mockRejectedValue(new TaskCacheError("corrupt"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body())));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  await expect(scope.readProject(project, signal())).rejects.toMatchObject({ category: "corrupt" });
});

it("does not publish a direct GET after another tab rotates the persisted user fence", async () => {
  const { sessions, scope } = world(); const pending = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
  sessions.openDirect(project, task);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledOnce());
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await db.put("userScopes", { userId: TEST_VIEWER_ID, userFence: crypto.randomUUID() }); db.close();
  pending.resolve(response(body()));
  await waitFor(() => expect(scope.isInvalidated).toBe(true));
  expect(sessions.snapshot(project, task).detail).toBeNull();
});

it("does not dispatch a direct mutation after the persisted identity fence changes", async () => {
  const { sessions, scope } = world(); const fetcher = vi.fn().mockResolvedValue(response(body())); vi.stubGlobal("fetch", fetcher);
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await db.put("userScopes", { userId: TEST_VIEWER_ID, userFence: crypto.randomUUID() }); db.close();
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(scope.isInvalidated).toBe(true));
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(0);
});

it("does not publish Steps after the persisted identity fence changes", async () => {
  const { sessions, scope } = world(); const steps = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => url.endsWith("/steps") ? steps.promise : Promise.resolve(response(body()))));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.stepsSnapshot(project, task).status).toBe("loading"));
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await db.put("userScopes", { userId: TEST_VIEWER_ID, userFence: crypto.randomUUID() }); db.close();
  steps.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [] }));
  await waitFor(() => expect(scope.isInvalidated).toBe(true));
  expect(sessions.stepsSnapshot(project, task).resource).toBeNull();
});

it("withdraws direct-only details when the cache database is upgraded", async () => {
  const { sessions, scope } = world(); const listener = vi.fn(); sessions.subscribe(project, task, listener);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body())));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  listener.mockClear();
  const upgraded = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA + 1); upgraded.close();
  expect(scope.isInvalidated).toBe(true);
  expect(sessions.snapshot(project, task).detail).toBeNull();
  expect(listener).toHaveBeenCalled();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(TASK_CACHE_DATABASE); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
});

it("does not publish a direct write receipt after the persisted identity changes", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => init.method === "PUT" ? (writes++, write.promise) : Promise.resolve(response(body()))));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  await db.put("userScopes", { userId: TEST_VIEWER_ID, userFence: crypto.randomUUID() }); db.close();
  write.resolve(response({ ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" }));
  await waitFor(() => expect(scope.isInvalidated).toBe(true));
  expect(sessions.snapshot(project, task).detail).toBeNull();
  expect(sessions.snapshot(project, task).mutation.phase).not.toBe("confirmed");
});

it("withdraws a reopened task and keeps it locked while a retired write's 404 is revalidated", async () => {
  const { sessions } = world(); const write = deferred<Response>(); const access = deferred<Response>(); let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    if (url.endsWith("/access")) return access.promise;
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(writes).toBe(1));
  sessions.releaseRead(project, task); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  write.resolve(response({ error: { code: "not_found", message: "Missing", requestId: "missing" } }, null, 404));
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null }));
  sessions.setStatus(project, task, "in_progress", 1n); expect(writes).toBe(1);
  access.resolve(response(directAccessFixture(project), null));
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
});

it("reports a failed write-fence check before dispatch and allows a fresh read", async () => {
  const { sessions, scope } = world(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(body()))); vi.stubGlobal("fetch", fetcher);
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = vi.spyOn(scope, "verifyTaskRead").mockRejectedValueOnce(new TaskCacheError("storage"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null, mutation: { phase: "refused" } }));
  expect(fetcher.mock.calls.filter(([, init]) => init.method === "PUT")).toHaveLength(0);
  verify.mockRestore(); sessions.load(project, task, 1, "refresh");
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
});

it("retains a confirmed write and retries only a read after its receipt fence check fails", async () => {
  const { sessions, scope } = world(); let writes = 0; let committed = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; committed = true; return Promise.resolve(response({ ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" })); }
    return Promise.resolve(response(committed ? { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" } : body()));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const original = scope.verifyTaskRead.bind(scope);
  const verify = vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(original).mockImplementationOnce(original).mockRejectedValueOnce(new TaskCacheError("storage"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: null, requiresFreshRead: true, mutation: { phase: "confirmed", reconciliationError: { category: "storage" } } }));
  expect(writes).toBe(1); verify.mockRestore(); sessions.reconcile(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: { version: 2n }, mutation: { phase: "confirmed", reconciliationError: null } }));
  expect(writes).toBe(1);
});

it.each(["summary-to-direct", "direct-to-summary"] as const)("keeps one write owner through %s navigation", async (direction) => {
  const { sessions, scope } = world(); const ticket = await scope.beginSync(project, signal());
  const syncFor = (value: ReturnType<typeof body>, query: { epoch?: string } = {}) => taskSyncFromGraph(graphFixture([value]), { epoch, query, versionForTask: () => value.version, propertiesForTask: () => value.properties });
  const initial = syncFor(body()); await scope.observeHistory(ticket, epoch, signal()); await scope.applySync(ticket, initial, signal());
  const write = deferred<Response>(); let writes = 0; let committed = false;
  const current = () => committed ? { ...body(2n), status: "in_progress" as const, ready: false, startedAt: "2026-10-22T10:00:00Z" } : body();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    return Promise.resolve(response(current()));
  }));
  if (direction === "summary-to-direct") {
    sessions.requireOpeningRead(project, task); sessions.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions.load(project, task, 1, "open");
  } else sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(writes).toBe(1));
  sessions.releaseRead(project, task);
  if (direction === "summary-to-direct") sessions.openDirect(project, task);
  else { sessions.requireOpeningRead(project, task); sessions.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions.load(project, task, 1, "open"); }
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n); expect(writes).toBe(1);
  committed = true; write.resolve(response(current()));
  if (direction === "direct-to-summary") {
    const next = await scope.beginSync(project, signal()); const delta = syncFor(current(), { epoch });
    await scope.observeHistory(next, epoch, signal()); await scope.applySync(next, delta, signal());
    sessions.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task));
  }
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.version).toBe(2n));
  expect(writes).toBe(1);
});

it("withdraws a summary opening while a retired direct write's 404 revalidates access", async () => {
  const { sessions, scope } = world(); const ticket = await scope.beginSync(project, signal());
  const sync = taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties });
  await scope.observeHistory(ticket, epoch, signal()); await scope.applySync(ticket, sync, signal());
  const write = deferred<Response>(); const access = deferred<Response>(); let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    if (url.endsWith("/access")) return access.promise;
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(writes).toBe(1));
  sessions.releaseRead(project, task); sessions.requireOpeningRead(project, task);
  sessions.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions.load(project, task, 1, "open");
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  write.resolve(response({ error: { code: "not_found", message: "Missing", requestId: "missing" } }, null, 404));
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null }));
  sessions.setStatus(project, task, "in_progress", 1n); expect(writes).toBe(1);
  access.resolve(response(directAccessFixture(project), null));
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
});

it("tags same-scope direct denial events without sending the local origin as data", async () => {
  const { scope } = world(); const fence = await scope.beginTaskRead(project, task, 1, 1, signal());
  await scope.observeHistory(fence, epoch, signal());
  const origin = Symbol("source"); const seen: (symbol | undefined)[] = [];
  scope.subscribe((event) => { if (event.sessionHistoryUncertain) seen.push(event.sessionHistoryUncertain.origin); });
  expect(scope.reportDirectSessionDenied(fence, epoch, true, origin)).toBe(true);
  await waitFor(() => expect(seen).toEqual([origin]));
});

it("keeps a direct Task visible when a Step mutation returns 404", async () => {
  const { sessions, scope } = world(); const events: string[] = []; let writes = 0;
  scope.subscribe(event => { if (event.taskNotFound) events.push(event.projectId); });
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "DELETE") { writes++; return Promise.resolve(response({ error: { code: "not_found", message: "Missing step", requestId: "missing-step" } }, null, 404)); }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [step] }));
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.deleteStep(project, task, step.id, 1n);
  await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: "refused", error: { status: 404 } }));
  await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  expect(sessions.snapshot(project, task).detail?.title).toBe("Original"); expect(events).toEqual([]); expect(writes).toBe(1);
});

it("does not treat a retired Step 404 as project access loss", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); let writes = 0; let accessReads = 0;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "DELETE") { writes++; return write.promise; }
    if (url.endsWith("/access")) { accessReads++; return Promise.resolve(response(directAccessFixture(project), null)); }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [step] }));
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.deleteStep(project, task, step.id, 1n); await waitFor(() => expect(writes).toBe(1));
  sessions.releaseRead(project, task); sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  write.resolve(response({ error: { code: "not_found", message: "Missing step", requestId: "missing-step" } }, null, 404));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(sessions.snapshot(project, task).detail?.title).toBe("Original"); expect(accessReads).toBe(0); expect(scope.isInvalidated).toBe(false);
});

it("keeps the existing direct receipt fresh during a pending Step write while blocking writes", async () => {
  const { sessions } = world(); const write = deferred<Response>(); let writes = 0;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "DELETE") { writes++; return write.promise; }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [step] }));
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.deleteStep(project, task, step.id, 1n); await waitFor(() => expect(writes).toBe(1));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(false);
  expect(sessions.canSetStepStatus(project, task)).toBe(false);
  write.resolve(response({ error: { code: "not_found", message: "Missing step", requestId: "missing-step" } }, null, 404));
});
