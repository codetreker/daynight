import { afterEach, expect, it, vi } from "vitest";
import { waitForState as waitFor } from "./helpers/waitForState";
import { getTaskObservation, pauseAuthRequests } from "../src/api/client";
import { createTaskCacheScope, TaskCacheLifecycleChanged, type TaskCacheScope } from "../src/features/task-cache/project-cache";
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
const reopenWithSteps = async (sessions: TaskDetailSessions, version: bigint) => {
  sessions.releaseRead(project, task);
  sessions.openDirect(project, task);
  // A parent-check fault must not intercept the reads that reopen the Steps collection.
  await waitFor(() => {
    expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", refreshing: false, detail: { version } });
    expect(sessions.stepsSnapshot(project, task)).toMatchObject({ status: "ready", refreshing: false, stale: false, resource: { version } });
  });
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

it("keeps Step controls displayable during identity checking without admitting writes or revoked history", async () => {
  const { sessions, scope } = world(); let writes = 0;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(url.endsWith("/steps") ? { projectId: project, taskId: task, version: 1n, steps: [step] } : body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const unsubscribe = sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  const resume = pauseAuthRequests();
  try {
    expect(sessions.canDisplayStepStatus(project, task)).toBe(true);
    expect(sessions.canSetStepStatus(project, task)).toBe(false);
    sessions.setStepStatus(project, task, step.id, "done", 1n); expect(writes).toBe(0);
    scope.suspendProject(project); expect(sessions.canDisplayStepStatus(project, task)).toBe(false);
  } finally { resume(); unsubscribe(); }
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

it("finishes the same confirmed direct write after its follow-up read crosses a temporary pause", async () => {
  const { sessions } = world(); const followup = deferred<Response>(); let writes = 0; let reads = 0;
  const changed = { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response(changed)); }
    reads++; return reads === 1 ? Promise.resolve(response(body())) : reads === 2 ? followup.promise : Promise.resolve(response(changed));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => { expect(reads).toBe(2); expect(sessions.snapshot(project, task).mutation.phase).toBe("confirmed"); });
  const operation = sessions.snapshot(project, task).mutation.operation; const resume = pauseAuthRequests();
  try {
    followup.resolve(response(changed));
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation, phase: "confirmed", reconciling: false, publicationPending: true }));
    expect(sessions.snapshot(project, task).detail?.version).toBe(1n); expect(reads).toBe(2); expect(writes).toBe(1);
  } finally { resume(); }
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: changed, requiresFreshRead: false, mutation: { operation, phase: "confirmed", reconciling: false } }));
  await waitFor(() => expect(sessions.snapshot(project, task).mutation.publicationPending).not.toBe(true));
  expect(writes).toBe(1);
});

it.each(['confirmed', 'refused'] as const)('settles a %s direct write after a peer publishes an ordinary same-epoch graph', async outcome => {
  const { sessions } = world(), peer = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const write = deferred<Response>(); let writes = 0, committed = false;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    if (init.method === 'PUT') { writes++; return write.promise; }
    return Promise.resolve(response(committed ? { ...body(2n), status: 'in_progress', ready: false, startedAt: '2026-10-22T10:00:00Z' } : body()));
  }));
  try {
    sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
    sessions.setStatus(project, task, 'in_progress', 1n); await waitFor(() => expect(writes).toBe(1));
    const graph = graphFixture([body()]), ticket = await peer.beginSync(project, signal());
    await peer.applySync(ticket, taskSyncFromGraph(graph, { query: {}, epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal());
    if (outcome === 'confirmed') {
      committed = true; write.resolve(response({ ...body(2n), status: 'in_progress', ready: false, startedAt: '2026-10-22T10:00:00Z' }));
    } else write.resolve(response({ error: { code: 'forbidden', message: 'Denied', requestId: 'refused' } }, null, 403));
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe(outcome));
    expect(writes).toBe(1);
  } finally { peer.dispose(); }
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

it.each(["confirmed", "refused", "unknown"] as const)("does not re-register a %s write settled while its direct opening is closed", async outcome => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const write = deferred<Response>(); let writes = 0; let parent = body();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      writes++;
      return writes === 1 ? write.promise : Promise.resolve(response({ error: { code: "forbidden", message: "Denied", requestId: "next" } }, null, 403));
    }
    return Promise.resolve(response(parent));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {});
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(writes).toBe(1));
  unsubscribe(); sessions.releaseRead(project, task);
  if (outcome === "confirmed") {
    parent = { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" };
    write.resolve(response(parent));
  } else write.resolve(response({ error: { code: outcome === "refused" ? "forbidden" : "internal_error", message: "Failed", requestId: "old" } }, null, outcome === "refused" ? 403 : 500));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0));
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", mutation: { phase: "idle" } }));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(false);
  sessions.setStatus(project, task, outcome === "confirmed" ? "done" : "in_progress", parent.version);
  await waitFor(() => expect(writes).toBe(2));
  reopen();
});

it("does not re-register a closed old-history write after a replacement settles", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const write = deferred<Response>(); let writes = 0; let currentEpoch = epoch;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    return Promise.resolve(response(body(1n, currentEpoch === epoch ? "Original" : "Replacement"), currentEpoch));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {});
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(writes).toBe(1));
  unsubscribe(); currentEpoch = replacement;
  const fence = await scope.beginTaskRead(project, task, 0, 0, signal());
  expect(await scope.observeHistory(fence, replacement, signal())).toBe("retired");
  write.resolve(response({ ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" }));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0));
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", detail: { title: "Replacement" }, mutation: { phase: "idle" } }));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(false); reopen();
});

it("keeps an unresolved closed write locked on reopen and releases it after read-only retry", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const write = deferred<Response>(); const retry = deferred<Response>(); let writes = 0; let rejectReads = false; let reopenedReads = 0; let reopening = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return writes === 1 ? write.promise : Promise.resolve(response({ error: { code: "forbidden", message: "Denied", requestId: "next" } }, null, 403)); }
    if (rejectReads) return Promise.reject(new Error("offline"));
    return reopening && ++reopenedReads > 1 ? retry.promise : Promise.resolve(response(body()));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {});
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(writes).toBe(1));
  unsubscribe(); rejectReads = true;
  write.resolve(response({ error: { code: "internal_error", message: "Unknown", requestId: "old" } }, null, 500));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, { phase: string; reconciling: boolean }> }).retiredMutations;
  await waitFor(() => expect([...retired.values()]).toMatchObject([{ phase: "unknown", reconciling: false }]));
  rejectReads = false; reopening = true;
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  sessions.setStatus(project, task, "in_progress", 1n); expect(writes).toBe(1);
  await waitFor(() => expect(reopenedReads).toBeGreaterThan(1));
  reopening = false; retry.resolve(response(body()));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(writes).toBe(2));
  reopen();
});

it.each(["task", "step"] as const)("dispatches the original accepted %s review after closure during preparation", async kind => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); const write = deferred<Response>(); let writes = 0; let parent = body(); let stepVersion = 1n;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: stepVersion, steps: [{ ...step, status: stepVersion === 1n ? "todo" : "done" }] }));
    return Promise.resolve(response(parent));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {});
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const unsubscribeSteps = kind === "step" ? sessions.subscribeSteps(project, task, () => {}) : () => {};
  if (kind === "step") { sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true)); }
  const verify = scope.verifyTaskRead.bind(scope); let entered = false;
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (ticket, signal) => { entered = true; await preparation.promise; return verify(ticket, signal); });
  if (kind === "step") sessions.setStepStatus(project, task, step.id, "done", 1n);
  else sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(entered).toBe(true));
  unsubscribeSteps(); unsubscribe(); expect(writes).toBe(0);
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  preparation.resolve(); await waitFor(() => expect(writes).toBe(1));
  if (kind === "step") {
    parent = body(2n); stepVersion = 2n;
    write.resolve(response({ projectId: project, taskId: task, version: 2n, steps: [{ ...step, status: "done" }] }));
  } else {
    parent = { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" };
    write.resolve(response(parent));
  }
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.version).toBe(2n));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(sessions.snapshot(project, task).mutation.phase).toBe("idle"); expect(writes).toBe(1); reopen();
});

it("keeps the original review when closure occurs at the final send fence", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let checks = 0; let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response({ error: { code: "forbidden", message: "Denied", requestId: "old" } }, null, 403)); }
    return Promise.resolve(response(body()));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, signal) => {
    if (++checks === 2) { entered = true; await preparation.promise; }
    return verify(ticket, signal);
  });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  unsubscribe(); expect(writes).toBe(0); preparation.resolve();
  await waitFor(() => expect(writes).toBe(1));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0));
});

it("dispatches and reconciles an accepted direct review while no view is subscribed", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let writes = 0; let parent = body();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; parent = { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" }; }
    return Promise.resolve(response(parent));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (ticket, signal) => { entered = true; await preparation.promise; return verify(ticket, signal); });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  unsubscribe(); preparation.resolve();
  await waitFor(() => expect(writes).toBe(1));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0));
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", detail: { version: 2n }, mutation: { phase: "idle" } }));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(false); expect(writes).toBe(1); reopen();
});

it.each(["history", "access"] as const)("does not dispatch a closed direct review after %s retirement", async reason => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let writes = 0; let currentEpoch = epoch; let entered = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response(body())); }
    return Promise.resolve(response(body(), currentEpoch));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (ticket, signal) => { entered = true; await preparation.promise; return verify(ticket, signal); });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  unsubscribe();
  if (reason === "history") {
    currentEpoch = replacement; const fence = await scope.beginTaskRead(project, task, 0, 0, signal());
    expect(await scope.observeHistory(fence, replacement, signal())).toBe("retired");
  } else scope.suspendProject(project);
  preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0);
});

it("does not dispatch a closed review after the reopened task advances in the same history", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let parent = body(); let writes = 0; let entered = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(parent));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (ticket, signal) => { entered = true; await preparation.promise; return verify(ticket, signal); });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  unsubscribe(); parent = body(2n);
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.version).toBe(2n));
  preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0);
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false)); reopen();
});

it("does not dispatch a closed direct review after a summary opening observes a newer version", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let parent = body(); let writes = 0; let entered = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(parent));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (ticket, signal) => { entered = true; await preparation.promise; return verify(ticket, signal); });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  unsubscribe(); parent = body(2n);
  const graphTicket = await scope.beginSync(project, signal());
  expect(await scope.observeHistory(graphTicket, epoch, signal())).toBe("current");
  const graph = (await scope.applySync(graphTicket, taskSyncFromGraph(graphFixture([parent]), { epoch, versionForTask: () => 2n }), signal())).project;
  const reopen = sessions.subscribe(project, task, () => {}); sessions.requireOpeningRead(project, task);
  sessions.observe(project, task, graph.index.nodes.get(task), true);
  expect(scope.getSummaryVersion(project, task)).toBe(2n);
  preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0);
  expect(scope.getSummaryVersion(project, task)).toBe(2n); reopen();
});

it("does not dispatch a direct review after a summary opening receives a newer pending parent", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let parent = body(); let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(parent));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const ticket = await scope.beginSync(project, signal());
  expect(await scope.observeHistory(ticket, epoch, signal())).toBe("current");
  const graph = (await scope.applySync(ticket, taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal())).project;
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (fence, abortSignal) => { entered = true; await preparation.promise; return verify(fence, abortSignal); });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  parent = body(2n); sessions.requireOpeningRead(project, task); sessions.observe(project, task, graph.index.nodes.get(task), true); sessions.load(project, task, 1, "open");
  const entries = (sessions as unknown as { entries: Map<string, { pending: { detail: { version: bigint } } | null }> }).entries;
  await waitFor(() => expect(entries.get(`${project}/${task}`)?.pending?.detail.version).toBe(2n));
  expect(scope.getSummaryVersion(project, task)).toBe(1n); preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0); unsubscribe();
});

it("does not dispatch a retired review after newer Steps precede the parent", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); const parentRefresh = deferred<Response>(); let entered = false; let writes = 0; let parents = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response(body())); }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 2n, steps: [] }));
    if (++parents > 2) return parentRefresh.promise;
    return Promise.resolve(response(body()));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementationOnce(async (fence, abortSignal) => { entered = true; await preparation.promise; return verify(fence, abortSignal); });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const unsubscribeSteps = sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task);
  await waitFor(() => expect(sessions.stepsSnapshot(project, task).status).toBe("waiting"));
  expect(sessions.snapshot(project, task).detail?.version).toBe(1n); preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0);
  parentRefresh.resolve(response(body(2n))); unsubscribeSteps(); unsubscribe();
});

it.each([1, 2] as const)("keeps a valid summary review when the same Task opens direct during preparation stage %s", async stage => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let checks = 0; let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response({ error: { code: "forbidden", message: "Denied", requestId: "old" } }, null, 403)); }
    return Promise.resolve(response(body()));
  }));
  const graphTicket = await scope.beginSync(project, signal());
  expect(await scope.observeHistory(graphTicket, epoch, signal())).toBe("current");
  const graph = (await scope.applySync(graphTicket, taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal())).project;
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.requireOpeningRead(project, task);
  sessions.observe(project, task, graph.index.nodes.get(task), true); sessions.load(project, task, 1, "open");
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", detail: { version: 1n }, requiresFreshRead: false }));
  const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementation(async (ticket, signal, work) => {
    if (++checks === stage) { entered = true; await preparation.promise; }
    return transaction(ticket, signal, work);
  });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true); expect(writes).toBe(0);
  preparation.resolve(); await waitFor(() => expect(writes).toBe(1));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(sessions.snapshot(project, task).mutation.phase).toBe("idle"); unsubscribe();
});

it.each(["newer direct", "history", "access"] as const)("does not dispatch a retired summary review after %s", async change => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let writes = 0; let parent = body();
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(parent));
  }));
  const graphTicket = await scope.beginSync(project, signal());
  expect(await scope.observeHistory(graphTicket, epoch, signal())).toBe("current");
  const graph = (await scope.applySync(graphTicket, taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal())).project;
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.requireOpeningRead(project, task);
  sessions.observe(project, task, graph.index.nodes.get(task), true); sessions.load(project, task, 1, "open");
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", requiresFreshRead: false }));
  const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementationOnce(async (ticket, abortSignal, work) => {
    entered = true; await preparation.promise; return transaction(ticket, abortSignal, work);
  });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  if (change === "newer direct") parent = body(2n);
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.version).toBe(parent.version));
  if (change === "history") {
    const fence = await scope.beginTaskRead(project, task, 0, 0, signal());
    expect(await scope.observeHistory(fence, replacement, signal())).toBe("retired");
  } else if (change === "access") scope.suspendProject(project);
  preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0); unsubscribe();
});

it("rechecks the original summary ticket before sending after a silent persisted generation change", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let checks = 0; let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(body()));
  }));
  const graphTicket = await scope.beginSync(project, signal());
  expect(await scope.observeHistory(graphTicket, epoch, signal())).toBe("current");
  const graph = (await scope.applySync(graphTicket, taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal())).project;
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.requireOpeningRead(project, task);
  sessions.observe(project, task, graph.index.nodes.get(task), true); sessions.load(project, task, 1, "open");
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", requiresFreshRead: false }));
  const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementation(async (ticket, abortSignal, work) => {
    if (++checks === 2) { entered = true; await preparation.promise; }
    return transaction(ticket, abortSignal, work);
  });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  const manifest = await db.get("projects", [TEST_VIEWER_ID, project]);
  expect(manifest).toBeDefined();
  await db.put("projects", { ...manifest, cacheGeneration: crypto.randomUUID() }); db.close();
  preparation.resolve();
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0)); expect(writes).toBe(0); unsubscribe();
});

it("expires an active summary review when the persisted summary advances before its hint arrives", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const preparation = deferred<void>(); let entered = false; let checks = 0; let writes = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") writes++;
    return Promise.resolve(response(body()));
  }));
  const graphTicket = await scope.beginSync(project, signal());
  expect(await scope.observeHistory(graphTicket, epoch, signal())).toBe("current");
  const graph = (await scope.applySync(graphTicket, taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal())).project;
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.requireOpeningRead(project, task);
  sessions.observe(project, task, graph.index.nodes.get(task), true); sessions.load(project, task, 1, "open");
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", requiresFreshRead: false }));
  const transaction = scope.detailTransaction.bind(scope);
  vi.spyOn(scope, "detailTransaction").mockImplementation(async (ticket, abortSignal, work) => {
    if (++checks === 2) { entered = true; await preparation.promise; }
    return transaction(ticket, abortSignal, work);
  });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
  const db = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  const record = await db.get("summaries", [TEST_VIEWER_ID, project, task]);
  expect(record).toBeDefined();
  await db.put("summaries", { ...record, summary: { ...record.summary, version: 2n }, dependencyState: { ...record.dependencyState!, taskVersion: 2n } }); db.close();
  preparation.resolve();
  await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe("conflict"));
  expect(writes).toBe(0); expect(sessions.snapshot(project, task).requiresFreshRead).toBe(true); unsubscribe();
});

it.each([["direct", false], ["direct", true], ["summary", false], ["summary", true]] as const)("revalidates a %s review (retired: %s) when identity pauses during the final send check", async (source, retired) => {
    const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
    const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
    const preparation = deferred<void>(); let entered = false; let checks = 0; let writes = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.method === "PUT") { writes++; return Promise.resolve(response({ error: { code: "forbidden", message: "Denied", requestId: "old" } }, null, 403)); }
      return Promise.resolve(response(body()));
    }));
    const unsubscribe = sessions.subscribe(project, task, () => {});
    if (source === "summary") {
      const ticket = await scope.beginSync(project, signal());
      expect(await scope.observeHistory(ticket, epoch, signal())).toBe("current");
      const graph = (await scope.applySync(ticket, taskSyncFromGraph(graphFixture([body()]), { epoch, versionForTask: () => 1n, propertiesForTask: () => body().properties }), signal())).project;
      sessions.requireOpeningRead(project, task); sessions.observe(project, task, graph.index.nodes.get(task), true); sessions.load(project, task, 1, "open");
    } else sessions.openDirect(project, task);
    await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", requiresFreshRead: false }));
    if (source === "direct") {
      const verify = scope.verifyTaskRead.bind(scope);
      vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
        const result = await verify(ticket, abortSignal);
        if (++checks === 2) { entered = true; await preparation.promise; }
        return result;
      });
    } else {
      const transaction = scope.detailTransaction.bind(scope);
      vi.spyOn(scope, "detailTransaction").mockImplementation(async (ticket, abortSignal, work) => {
        const result = await transaction(ticket, abortSignal, work);
        if (++checks === 2) { entered = true; await preparation.promise; }
        return result;
      });
    }
    sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(entered).toBe(true));
    if (retired) { if (source === "direct") unsubscribe(); else sessions.openDirect(project, task); }
    const resume = pauseAuthRequests();
    try {
      preparation.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes).toBe(0);
      if (retired) expect((sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations.size).toBe(1);
      else expect(sessions.snapshot(project, task).mutation.phase).toBe("pending");
    } finally { resume(); }
    await waitFor(() => expect(writes).toBe(1));
    if (!retired || source === "summary") unsubscribe();
    sessions.dispose(); scope.dispose();
});

it("settles a submitted Step write while closed without locking its next opening", async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const write = deferred<Response>(); let writes = 0; let version = 1n;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  const steps = () => ({ projectId: project, taskId: task, version, steps: [{ ...step, status: version === 1n ? "todo" : "done" }] });
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return write.promise; }
    return Promise.resolve(response(url.endsWith("/steps") ? steps() : body(version)));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); const unsubscribeSteps = sessions.subscribeSteps(project, task, () => {});
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.setStepStatus(project, task, step.id, "done", 1n); await waitFor(() => expect(writes).toBe(1));
  unsubscribeSteps(); unsubscribe(); version = 2n; write.resolve(response(steps()));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0));
  const reopen = sessions.subscribe(project, task, () => {}); const reopenSteps = sessions.subscribeSteps(project, task, () => {});
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", detail: { version: 2n }, mutation: { phase: "idle" } }));
  sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  expect(sessions.stepsSnapshot(project, task).resource?.steps[0]?.status).toBe("done"); expect(writes).toBe(1);
  reopenSteps(); reopen();
});

it.each([
  ["status", 409, false, "throw"], ["step", 409, false, "throw"], ["status", 500, false, "throw"], ["step", 500, false, "throw"],
  ["status", 200, false, "throw"], ["step", 200, false, "throw"], ["status", 500, true, "throw"],
  ["status", 409, false, "false"], ["step", 500, false, "false"], ["status", 200, true, "false"],
] as const)("settles a %s write with HTTP %s when result verification is interrupted by identity checking (fast resume: %s, result: %s)", async (kind, status, fastResume, interrupted) => {
  const { sessions, scope } = world(); const verification = deferred<void>();
  let verifying = false; let held = false; let rejected = false; let writes = 0;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  const parent = () => status === 200 && writes > 0 ? kind === "status"
    ? { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" } : body(2n) : body();
  const steps = () => ({ projectId: project, taskId: task, version: status === 200 && writes > 0 ? 2n : 1n,
    steps: [{ ...step, status: status === 200 && writes > 0 ? "done" : "todo" }] });
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      writes++;
      if (status !== 200) return Promise.resolve(response({ error: { code: status === 409 ? "version_conflict" : "internal_error", message: "Failed", requestId: "write" } }, null, status));
      return Promise.resolve(response(kind === "step" ? steps() : parent()));
    }
    return Promise.resolve(response(url.endsWith("/steps") ? steps() : parent()));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const unsubscribe = kind === "step" ? sessions.subscribeSteps(project, task, () => {}) : () => {};
  if (kind === "step") { sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true)); }
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
    if (writes && !held) {
      held = true; verifying = true; await verification.promise;
      rejected = true;
      if (interrupted === "false") return false;
      throw new TaskCacheLifecycleChanged();
    }
    return verify(ticket, abortSignal);
  });
  if (kind === "step") sessions.setStepStatus(project, task, step.id, "done", 1n);
  else sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(verifying).toBe(true));
  const resume = pauseAuthRequests();
  try {
    verification.resolve();
    if (fastResume) resume();
    else {
      await waitFor(() => expect(rejected).toBe(true));
      expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: status === 200 ? "confirmed" : status === 409 ? "conflict" : "unknown", reconciling: false, publicationPending: true });
      expect(sessions.snapshot(project, task).detail?.version).toBe(1n);
      expect(writes).toBe(1);
    }
  } finally { resume(); }
  await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({
    phase: status === 200 ? "confirmed" : status === 409 && kind === "status" ? "conflict" : "reconciled", reconciling: false,
  }));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(writes).toBe(1);
  unsubscribe();
});

it.each(["throw", "false"] as const)("retries read-only result admission after consecutive identity pauses that have already resumed (%s)", async interrupted => {
  const { sessions, scope } = world(); let writes = 0; let interruptions = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response({ error: { code: "internal_error", message: "Failed", requestId: "write" } }, null, 500)); }
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
    if (writes && interruptions < 2) {
      interruptions++; const resume = pauseAuthRequests(); resume();
      if (interrupted === "false") return false;
      throw new TaskCacheLifecycleChanged();
    }
    return verify(ticket, abortSignal);
  });
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: "reconciled", reconciling: false }));
  expect(interruptions).toBe(2); expect(writes).toBe(1);
});

it.each([200, 409] as const)("holds HTTP %s outcome when identity pauses just after successful result verification", async status => {
  const { sessions, scope } = world(); const paused = deferred<void>(); let resume: (() => void) | null = null; let writes = 0; let held = false;
  const changed = { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") {
      writes++;
      return Promise.resolve(status === 200 ? response(changed) : response({ error: { code: "version_conflict", message: "Conflict", requestId: "write" } }, null, 409));
    }
    return Promise.resolve(response(status === 200 && writes ? changed : body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
    const current = await verify(ticket, abortSignal);
    if (writes && !held) { held = true; queueMicrotask(() => { resume = pauseAuthRequests(); paused.resolve(); }); }
    return current;
  });
  sessions.setStatus(project, task, "in_progress", 1n); await paused.promise;
  try { expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: status === 200 ? "confirmed" : "conflict", reconciling: false, publicationPending: true }); expect(sessions.snapshot(project, task).detail?.version).toBe(1n); expect(writes).toBe(1); }
  finally { (resume as (() => void) | null)?.(); }
  await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: status === 200 ? "confirmed" : "conflict", reconciling: false }));
  expect(writes).toBe(1);
});

it("withdraws the old result when identity retires during its paused admission", async () => {
  const { sessions, scope } = world(); const verification = deferred<void>(); let writes = 0; let reads = 0; let verifying = false;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response({ error: { code: "internal_error", message: "Failed", requestId: "write" } }, null, 500)); }
    reads++; return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
    if (writes) { verifying = true; await verification.promise; throw new TaskCacheLifecycleChanged(); }
    return verify(ticket, abortSignal);
  });
  sessions.setStatus(project, task, "in_progress", 1n); await waitFor(() => expect(verifying).toBe(true));
  const resume = pauseAuthRequests();
  try { const retired = scope.invalidateScope(); verification.resolve(); resume(); await retired; }
  finally { resume(); }
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null, mutation: { phase: "idle" } }));
  expect(scope.isInvalidated).toBe(true); expect(writes).toBe(1); expect(reads).toBe(1);
});

it("does not spin or retain a pending write on unrelated result-admission lifecycle failure", async () => {
  const { sessions, scope } = world(); let writes = 0; let verifications = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === "PUT") { writes++; return Promise.resolve(response({ error: { code: "internal_error", message: "Failed", requestId: "write" } }, null, 500)); }
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
    if (writes) { verifications++; throw new TaskCacheLifecycleChanged(); }
    return verify(ticket, abortSignal);
  });
  sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", mutation: { phase: "unknown" } }));
  expect(verifications).toBe(1); expect(writes).toBe(1);
});

it.each([
  ["status", false], ["step", false], ["delete", false], ["refused", false], ["unknown", false],
  ["status", true], ["unknown", true],
] as const)("settles a %s outcome transferred during post-response history verification (throws: %s)", async (kind, throws) => {
  const { sessions, scope } = world();
  // This graph read began before the direct opening and may return an old epoch.
  const delayedGraph = await scope.beginSync(project, signal());
  const verification = deferred<void>(); const recovery = deferred<Response>();
  let verifying = false; let held = false; let writes = 0; let recovering = false;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  const changedParent = { ...body(2n), status: "in_progress", ready: false, startedAt: "2026-10-22T10:00:00Z" };
  const currentParent = () => kind === "status" ? changedParent : body(kind === "step" ? 2n : 1n);
  const currentSteps = () => ({ projectId: project, taskId: task, version: kind === "step" && writes ? 2n : 1n, steps: [{ ...step, status: kind === "step" && writes ? "done" : "todo" }] });
  const deleted = () => response({ error: { code: "task_deleted", message: "Deleted", requestId: "deleted" } }, epoch, 410);
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "PUT" || init.method === "DELETE") {
      writes++;
      if (kind === "delete") return Promise.resolve(new Response(null, { status: 204, headers: viewerHeaders(TEST_VIEWER_ID) }));
      if (kind === "refused" || kind === "unknown") return Promise.resolve(response({ error: { code: kind === "refused" ? "forbidden" : "internal_error", message: "Failed", requestId: "write" } }, null, kind === "refused" ? 403 : 500));
      return Promise.resolve(response(kind === "step" ? currentSteps() : changedParent));
    }
    if (url.endsWith("/steps")) return Promise.resolve(response(currentSteps()));
    if (recovering) { recovering = false; return recovery.promise; }
    return Promise.resolve(kind === "delete" && writes ? deleted() : response(writes ? currentParent() : body()));
  }));
  sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  const unsubscribeSteps = kind === "step" ? sessions.subscribeSteps(project, task, () => {}) : () => {};
  if (kind === "step") { sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true)); }
  const verify = scope.verifyTaskRead.bind(scope);
  vi.spyOn(scope, "verifyTaskRead").mockImplementation(async (ticket, abortSignal) => {
    if (writes && !held) { held = true; verifying = true; await verification.promise; if (throws) throw new Error("verification failed"); }
    return verify(ticket, abortSignal);
  });
  if (kind === "step") sessions.setStepStatus(project, task, step.id, "done", 1n);
  else if (kind === "delete") sessions.deleteTask(project, task, 1n, false);
  else sessions.setStatus(project, task, "in_progress", 1n);
  await waitFor(() => expect(verifying).toBe(true));
  expect(writes).toBe(1);
  recovering = true;
  expect(await scope.observeHistory(delayedGraph, replacement, signal())).toBe("confirm");
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, { phase: string }> }).retiredMutations;
  await waitFor(() => expect([...retired.values()]).toMatchObject([{ phase: "pending" }]));
  const confirmation = await scope.beginTaskRead(project, task, 1, 1, signal());
  expect(await scope.observeHistory(confirmation, epoch, signal())).toBe("current");
  verification.resolve();
  recovery.resolve(kind === "delete" ? deleted() : response(currentParent()));
  await waitFor(() => expect(retired.size).toBe(0));
  if (kind === "delete") {
    await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("deleted"));
  } else {
    await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "ready", requiresFreshRead: false }));
    expect(sessions.directRequiresFreshRead(project, task)).toBe(false);
    if (kind === "step") await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  }
  expect(writes).toBe(1);
  unsubscribeSteps();
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
  expect(await scope.observeHistory(early, epoch, signal())).toBe("confirm");
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
  const internals = scope as unknown as { ensureHistoryPurged: (projectId: string) => Promise<void> };
  const purge = internals.ensureHistoryPurged.bind(scope);
  vi.spyOn(internals, "ensureHistoryPurged").mockRejectedValueOnce(new Error("storage unavailable")).mockImplementation((id) => purge(id));
  await expect(scope.observeHistory(next, replacement, signal())).rejects.toThrow("storage unavailable");
  const retried = await scope.beginTaskRead(project, task, 2, 1, signal());
  expect(await scope.observeHistory(retried, replacement, signal())).toBe("current");
  expect(internals.ensureHistoryPurged).toHaveBeenCalledTimes(2);
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

it("verifies a retired Step 404 against the parent and withdraws a denied parent", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); const parent = deferred<Response>(); const access = deferred<Response>(); let writes = 0; let checking = false; let checks = 0; let revoked = false;
  scope.subscribe(event => { if (event.accessRevoked) revoked = true; });
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "DELETE") { writes++; return write.promise; }
    if (url.endsWith("/access")) return access.promise;
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [step] }));
    if (checking) { checks++; return parent.promise; } return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.deleteStep(project, task, step.id, 1n); await waitFor(() => expect(writes).toBe(1));
  await reopenWithSteps(sessions, 1n); checking = true;
  write.resolve(response({ error: { code: "not_found", message: "Missing step", requestId: "step" } }, null, 404));
  await waitFor(() => expect(checks).toBe(1));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  const resume = pauseAuthRequests();
  parent.resolve(response({ error: { code: "not_found", message: "Missing task", requestId: "parent" } }, null, 404));
  try { await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: "error", detail: null, error: { status: 404 } })); }
  finally { resume(); }
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  access.resolve(response({ error: { code: "not_found", message: "Missing project", requestId: "access" } }, null, 404));
  await waitFor(() => expect(revoked).toBe(true));
  expect(writes).toBe(1);
});

it("keeps a retired Step refusal locked after a failed parent check and retries without another write", async () => {
  const { sessions } = world(); const write = deferred<Response>(); let checking = false; let checks = 0; let writes = 0;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "DELETE") { writes++; return write.promise; }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [step] }));
    if (checking) { checks++; if (checks === 1) return Promise.reject(new Error("offline")); } return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.deleteStep(project, task, step.id, 1n); await waitFor(() => expect(writes).toBe(1));
  await reopenWithSteps(sessions, 1n); checking = true;
  write.resolve(response({ error: { code: "not_found", message: "Missing step", requestId: "step" } }, null, 404));
  await waitFor(() => expect(checks).toBe(1));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, { reconciling: boolean }> }).retiredMutations;
  await waitFor(() => expect([...retired.values()]).toMatchObject([{ reconciling: false }]));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  sessions.load(project, task, 1, "refresh");
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(writes).toBe(1); expect(checks).toBeGreaterThanOrEqual(2);
});

it("does not let a late retired Step parent denial withdraw a replacement history", async () => {
  const { sessions, scope } = world(); const write = deferred<Response>(); const parent = deferred<Response>(); let checking = false; let checks = 0; let replaced = false; let writes = 0;
  const step = { id: "00000001", title: "First", description: "", status: "todo", createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z" };
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === "DELETE") { writes++; return write.promise; }
    if (url.endsWith("/steps")) return Promise.resolve(response({ projectId: project, taskId: task, version: 1n, steps: [step] }));
    if (checking && !replaced) { checks++; return parent.promise; }
    return Promise.resolve(response(body(1n, replaced ? "Replacement" : "Original"), replaced ? replacement : epoch));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe("ready"));
  sessions.subscribeSteps(project, task, () => {}); sessions.loadSteps(project, task); await waitFor(() => expect(sessions.canSetStepStatus(project, task)).toBe(true));
  sessions.deleteStep(project, task, step.id, 1n); await waitFor(() => expect(writes).toBe(1));
  await reopenWithSteps(sessions, 1n); checking = true;
  write.resolve(response({ error: { code: "not_found", message: "Missing step", requestId: "step" } }, null, 404));
  await waitFor(() => expect(checks).toBe(1)); replaced = true;
  const fence = await scope.beginTaskRead(project, task, 0, 0, signal());
  expect(await scope.observeHistory(fence, replacement, signal())).toBe("retired");
  await waitFor(() => expect(sessions.snapshot(project, task).detail?.title).toBe("Replacement"));
  parent.resolve(response({ error: { code: "not_found", message: "Missing task", requestId: "parent" } }, null, 404));
  const retired = (sessions as unknown as { retiredMutations: Map<unknown, unknown> }).retiredMutations;
  await waitFor(() => expect(retired.size).toBe(0));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(false);
  expect(sessions.snapshot(project, task).detail?.title).toBe("Replacement"); expect(writes).toBe(1);
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

it('retains the write lock when an ambiguous early response is confirmed as the same history', async () => {
  const { sessions, scope } = world(); const old = await scope.beginTaskRead(project, task, 1, 0, signal());
  const write = deferred<Response>(); let writes = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'PUT') { writes++; return write.promise; }
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  sessions.setStatus(project, task, 'in_progress', 1n); await waitFor(() => expect(writes).toBe(1));
  expect(await scope.observeHistory(old, replacement, signal())).toBe('confirm');
  await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ status: 'ready', detail: { version: 1n } }));
  expect(sessions.directRequiresFreshRead(project, task)).toBe(true);
  sessions.setStatus(project, task, 'done', 1n); expect(writes).toBe(1);
  write.resolve(response({ error: { code: 'forbidden', message: 'denied', requestId: 'refused' } }, null, 403));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(writes).toBe(1);
});

it.each([404, 410] as const)('handles a fresh parent %s after an ambiguous retired 404 without admitting the earlier positive read', async status => {
  const { sessions, scope } = world(); const old = await scope.beginTaskRead(project, task, 1, 0, signal());
  const write = deferred<Response>(); const confirmParent = deferred<Response>(); let parents = 0; let accessReads = 0; let writes = 0;
  const missing = () => response({ error: { code: 'not_found', message: 'missing', requestId: 'missing' } }, null, 404);
  const negative = () => response({ error: { code: status === 404 ? 'not_found' : 'task_deleted', message: 'missing', requestId: 'parent' } }, null, status);
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === 'PUT') { writes++; return write.promise; }
    if (url.endsWith('/access')) { accessReads++; return Promise.resolve(response(directAccessFixture(project, TEST_VIEWER_ID, 'admin'))); }
    parents++;
    if (parents === 2) return confirmParent.promise;
    if (parents === 3) return Promise.resolve(negative());
    return Promise.resolve(response(body()));
  }));
  sessions.openDirect(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  sessions.setStatus(project, task, 'in_progress', 1n); await waitFor(() => expect(writes).toBe(1));
  expect(await scope.observeHistory(old, replacement, signal())).toBe('confirm');
  await waitFor(() => expect(parents).toBe(2)); write.resolve(missing());
  await waitFor(() => expect(parents).toBe(3));
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toBeNull());
  if (status === 404) await waitFor(() => expect(accessReads).toBe(1));
  else expect(sessions.snapshot(project, task).status).toBe('deleted');
  confirmParent.resolve(response(body())); await new Promise(resolve => setTimeout(resolve, 20));
  expect(sessions.snapshot(project, task).detail).toBeNull(); expect(writes).toBe(1);
});

it('bounds and retries a retired 404 parent confirmation even without an open view', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const early = await scope.beginTaskRead(project, task, 1, 0, signal());
  const write = deferred<Response>(); const parent = deferred<Response>(); let parents = 0; let writes = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'PUT') { writes++; return write.promise; }
    parents++; return parents === 2 ? parent.promise : Promise.resolve(response(body()));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  sessions.setStatus(project, task, 'in_progress', 1n); await waitFor(() => expect(writes).toBe(1)); unsubscribe();
  expect(await scope.observeHistory(early, replacement, signal())).toBe('confirm');
  write.resolve(response({ error: { code: 'not_found', message: 'missing', requestId: 'missing' } }, null, 404));
  await waitFor(() => expect(parents).toBe(2));
  const confirming = await scope.beginTaskRead(project, task, 0, 0, signal());
  expect(await scope.observeHistory(confirming, epoch, signal())).toBe('current');
  parent.resolve(response(body(), replacement));
  await waitFor(() => expect(parents).toBe(3));
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  expect(writes).toBe(1); reopen();
});

it.each([200, 404] as const)('revalidates a fresh parent 404 without an open view when project access is %s', async accessStatus => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const sessions = new TaskDetailSessions(scope); worlds.push({ scope, sessions });
  const events = vi.fn(); scope.subscribe(events);
  const early = await scope.beginTaskRead(project, task, 1, 0, signal());
  const write = deferred<Response>(); let parents = 0; let accesses = 0;
  const missing = () => response({ error: { code: 'not_found', message: 'missing', requestId: 'missing' } }, null, 404);
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
    if (init.method === 'PUT') return write.promise;
    if (url.endsWith('/access')) { accesses++; return Promise.resolve(accessStatus === 200 ? response(directAccessFixture(project, TEST_VIEWER_ID, 'admin')) : missing()); }
    return ++parents === 2 ? Promise.resolve(missing()) : Promise.resolve(response(body()));
  }));
  const unsubscribe = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  sessions.setStatus(project, task, 'in_progress', 1n);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1));
  unsubscribe(); expect(await scope.observeHistory(early, replacement, signal())).toBe('confirm'); write.resolve(missing());
  await waitFor(() => expect(accesses).toBe(1));
  if (accessStatus === 404) { await waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ accessRevoked: true }))); return; }
  const reopen = sessions.subscribe(project, task, () => {}); sessions.openDirect(project, task);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
  await waitFor(() => expect(sessions.directRequiresFreshRead(project, task)).toBe(false));
  reopen();
});
