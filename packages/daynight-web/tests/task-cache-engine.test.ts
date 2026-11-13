import { directAccessFixture, viewerHeaders } from "./helpers/taskSync";
import * as fake from "fake-indexeddb";
import { openDB, type IDBPDatabase } from "idb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTask, pauseAuthRequests } from "../src/api/client";
import type { Project, TaskSummary, TaskSync, WorkerClaim } from "../src/api/types";
import { deriveTaskSyncBindings, eligibleTaskExecutionBinding, sameTaskExecutionBinding, taskExecutionBinding } from "../src/features/task-cache/execution-binding";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema, type TaskIntrinsicDetail } from "../src/features/task-cache/database";
import { TaskDetailSessions } from "../src/features/task-detail/TaskDetailSession";
import { detailFixture } from "./helpers/taskDetail";
import { wireResponse } from "./helpers/wireJson";

const userId = "10000000-0000-0000-0000-000000000001";
const otherUser = "10000000-0000-0000-0000-000000000002";
const projectId = "20000000-0000-0000-0000-000000000001";
const otherProject = "20000000-0000-0000-0000-000000000002";
const epoch = "30000000-0000-0000-0000-000000000001";
const nextEpoch = "30000000-0000-0000-0000-000000000002";
const taskId = (n: number) => `40000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
const time = "2026-10-20T12:00:00.123456789Z";
const later = "2026-10-20T12:00:01.000000001Z";
const project: Project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: projectId, name: "Project", repoUrl: "git@example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({ type: "task", parentId: null, assignedTo: null, id: taskId(n), version: 1n, properties: {}, tags: [], titlePreview: `Task ${n}`, titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time, ...changes });
const response = (tasks: readonly TaskSummary[], changes: Partial<TaskSync> = {}): TaskSync => ({ assigneeVersions: [], actorAccess: directAccessFixture(project.id), mode: "delta", epoch, project, observedAt: later, tasks, sessions: {}, dependencyStates: Object.fromEntries(tasks.filter(task => task.type === "task").map(task => {
  const blockedBy = task.dependsOn.filter(id => !tasks.some(candidate => candidate.id === id && (candidate.status === "done" || candidate.status === "cancelled")));
  return [task.id, { taskVersion: task.version, blockedBy, ready: task.status === "todo" && blockedBy.length === 0 }];
})), ...changes });
const signal = () => new AbortController().signal;
const worker = (changes: Partial<WorkerClaim> = {}): WorkerClaim => ({
  claimId: taskId(91), state: "active", userId, workerId: taskId(92), machine: { id: taskId(93), name: "test" },
  platform: "linux", agent: "codex", agentControlMode: "web", worktreeId: taskId(94), phase: "executing", herdr: null,
  nativeSessionId: "native-session", claimedAt: time, ...changes,
});
const executing = (changes: Partial<TaskSummary> = {}, claimChanges: Partial<WorkerClaim> = {}): TaskSummary =>
  task(1, { status: "in_progress", startedAt: time, properties: { worker: { ...worker(claimChanges) } }, ...changes });
const scopes: TaskCacheScope[] = [];
const connections: IDBPDatabase<TaskCacheSchema>[] = [];
class Channel {
  static channels = new Set<Channel>();
  static hints: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { Channel.channels.add(this); }
  postMessage(value: unknown) {
    Channel.hints.push(value);
    for (const channel of Channel.channels) if (channel !== this && channel.name === this.name) queueMicrotask(() => channel.onmessage?.({ data: value } as MessageEvent<unknown>));
  }
  close() { Channel.channels.delete(this); }
}
const scope = (identity = userId, onIdentityMismatch: () => void = vi.fn()) => {
  const value = createTaskCacheScope({ userId: identity, onIdentityMismatch }); scopes.push(value); return value;
};
const inspect = async () => { const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); connections.push(database); return database; };
const seed = async (cache: TaskCacheScope, tasks: readonly TaskSummary[] = [task(1)], ownerProject = project) => {
  const ticket = await cache.beginSync(ownerProject.id, signal());
  return cache.applySync(ticket, response(tasks, { mode: "snapshot", project: ownerProject }), signal());
};
const delta = async (cache: TaskCacheScope, tasks: readonly TaskSummary[], changes: Partial<TaskSync> = {}) => {
  const ticket = await cache.beginSync(projectId, signal());
  return cache.applySync(ticket, response(tasks, changes), signal());
};
const putCounts = () => {
  const counts = new Map<string, number>(); const put = fake.IDBObjectStore.prototype.put;
  vi.spyOn(fake.IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    counts.set(this.name, (counts.get(this.name) ?? 0) + 1); return put.apply(this, args);
  });
  return counts;
};
beforeEach(() => {
  for (const [name, value] of Object.entries(fake)) if (name !== "default" && name !== "indexedDB") vi.stubGlobal(name, value);
  vi.stubGlobal("indexedDB", new fake.IDBFactory()); vi.stubGlobal("BroadcastChannel", Channel);
  Channel.channels.clear(); Channel.hints = [];
});
afterEach(() => {
  for (const cache of scopes.splice(0)) cache.dispose();
  for (const database of connections.splice(0)) database.close();
});

it("atomically saves task data and reopens the exact maximum without granting local access", async () => {
  const first = scope(); const result = await seed(first, [task(1), task(2, { updatedAt: later, version: 9_007_199_254_740_993n })]);
  const database = await inspect();
  expect([...database.objectStoreNames]).toEqual(["details", "profiles", "projects", "sessionHistory", "summaries", "userScopes"]);
  const manifest = await database.get("projects", [userId, projectId]);
  expect(manifest).toMatchObject({ state: "active", epoch, maxUpdatedAt: later, taskCount: 2, edgeCount: 0 });
  expect(result.project.versions.get(taskId(2))).toBe(9_007_199_254_740_993n); first.dispose();
  const reopened = scope();
  expect(await reopened.beginSync(projectId, signal())).toMatchObject({ epoch, maxUpdatedAt: later, cacheGeneration: manifest!.cacheGeneration });
  expect((await reopened.readProject(projectId, signal()))!.graph.tasks).toHaveLength(2);
  expect(reopened.getAuthorizedProject(projectId)).toBeNull();
});

it("does not retire a live direct epoch when a cold peer commits its older graph", async () => {
  const peer = scope(); const delayed = await peer.beginSync(projectId, signal());
  const direct = scope(); const current = await direct.beginTaskRead(projectId, taskId(1), 1, 1, signal());
  expect(await direct.observeHistory(current, nextEpoch, signal())).toBe("current");
  const events: { historyChanged?: true }[] = []; direct.subscribe(event => events.push(event));
  expect(await peer.observeHistory(delayed, epoch, signal())).toBe("current");
  await peer.applySync(delayed, response([task(1)], { mode: "snapshot", epoch }), signal());
  await vi.waitFor(() => expect(events.some(event => event.historyChanged)).toBe(true));
  expect(direct.isTaskReadCurrent(current, true)).toBe(false);
  const retry = await direct.beginTaskRead(projectId, taskId(1), 1, 2, signal());
  expect(await direct.observeHistory(retry, nextEpoch, signal())).toBe("current");
  const graph = await direct.beginSync(projectId, signal());
  expect(graph.epoch).toBe(epoch);
  expect(await direct.observeHistory(graph, nextEpoch, signal())).toBe("current");
  expect((await direct.applySync(graph, response([task(1)], { mode: "snapshot", epoch: nextEpoch }), signal())).project.manifest.epoch).toBe(nextEpoch);
});

it("retires an old direct epoch only after a live observation confirms a peer replacement", async () => {
  const direct = scope(); const original = await direct.beginTaskRead(projectId, taskId(1), 1, 1, signal());
  expect(await direct.observeHistory(original, epoch, signal())).toBe("current");
  const peer = scope(); const ticket = await peer.beginSync(projectId, signal());
  expect(await peer.observeHistory(ticket, nextEpoch, signal())).toBe("current");
  const events: { historyChanged?: true }[] = []; direct.subscribe(event => events.push(event));
  await peer.applySync(ticket, response([task(1)], { mode: "snapshot", epoch: nextEpoch }), signal());
  await vi.waitFor(() => expect(events.some(event => event.historyChanged)).toBe(true));
  const confirmed = await direct.beginTaskRead(projectId, taskId(1), 1, 2, signal());
  expect(await direct.observeHistory(confirmed, nextEpoch, signal())).toBe("retired");
  const retry = await direct.beginTaskRead(projectId, taskId(1), 1, 3, signal());
  expect(await direct.observeHistory(retry, nextEpoch, signal())).toBe("current");
  const stale = await direct.beginTaskRead(projectId, taskId(1), 1, 4, signal());
  await expect(direct.observeHistory(stale, epoch, signal())).rejects.toMatchObject({ name: "AbortError" });
});

it("keeps a direct owner's recovery GET through duplicate stale manifest hints and detects a new manifest", async () => {
  const peer = scope(); const delayed = await peer.beginSync(projectId, signal());
  const direct = scope(); const sessions = new TaskDetailSessions(direct);
  const unsubscribe = sessions.subscribe(projectId, taskId(1), () => {});
  const live = () => wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(userId, { "Daynight-Task-Epoch": nextEpoch }) });
  let release!: (value: Response) => void; const held = new Promise<Response>(resolve => { release = resolve; });
  const signals: AbortSignal[] = []; let reads = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => { reads++; signals.push(init.signal!); return reads === 2 ? held : Promise.resolve(live()); }));
  const events: { historyChanged?: true; historyHint?: true }[] = []; direct.subscribe(event => events.push(event));
  try {
    sessions.openDirect(projectId, taskId(1));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1)).status).toBe("ready"));
    expect(await peer.observeHistory(delayed, epoch, signal())).toBe("current");
    await peer.applySync(delayed, response([task(1)], { mode: "snapshot", epoch }), signal());
    await vi.waitFor(() => expect(reads).toBe(2));
    const injector = new Channel("daynight-task-cache"); const before = events.length;
    injector.postMessage({ userId, projectId });
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
    expect(events.filter(event => event.historyChanged)).toHaveLength(1);
    expect(signals[1]!.aborted).toBe(false);
    release(live());
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1))).toMatchObject({ status: "ready", error: null, requiresFreshRead: false }));
    const database = await inspect(); const previous = await database.get("projects", [userId, projectId]);
    await database.put("projects", { ...previous!, epoch: "30000000-0000-0000-0000-000000000003", cacheGeneration: crypto.randomUUID() });
    injector.postMessage({ userId, projectId });
    await vi.waitFor(() => expect(events.filter(event => event.historyHint)).toHaveLength(2));
    injector.close();
  } finally { unsubscribe(); sessions.dispose(); }
});

it("honors a current history's access denial after repeated stale manifest hints", async () => {
  const peer = scope(); const delayed = await peer.beginSync(projectId, signal());
  const direct = scope(); const current = await direct.beginTaskRead(projectId, taskId(1), 1, 1, signal());
  expect(await direct.observeHistory(current, nextEpoch, signal())).toBe("current");
  const events: { historyChanged?: true; accessRevoked?: true }[] = []; direct.subscribe(event => events.push(event));
  expect(await peer.observeHistory(delayed, epoch, signal())).toBe("current");
  await peer.applySync(delayed, response([task(1)], { mode: "snapshot", epoch }), signal());
  await vi.waitFor(() => expect(events.filter(event => event.historyChanged)).toHaveLength(1));
  const injector = new Channel("daynight-task-cache"); const before = events.length; injector.postMessage({ userId, projectId });
  await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
  const recovery = await direct.beginTaskRead(projectId, taskId(1), 1, 2, signal());
  expect(await direct.observeHistory(recovery, nextEpoch, signal())).toBe("current");
  const suppress = vi.spyOn(Channel.prototype, "postMessage").mockImplementation(() => {});
  const newer = scope(); const old = await newer.beginSync(projectId, signal());
  expect(await newer.observeHistory(old, nextEpoch, signal())).toBe("confirm");
  const confirmation = await newer.beginSync(projectId, signal());
  expect(await newer.observeHistory(confirmation, nextEpoch, signal())).toBe("retired");
  const fresh = await newer.beginSync(projectId, signal());
  await newer.applySync(fresh, response([task(1)], { mode: "snapshot", epoch: nextEpoch }), signal());
  const denied = await newer.beginSync(projectId, signal()); suppress.mockRestore();
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: viewerHeaders(userId) })));
  expect(await newer.revokeProject(denied, signal())).toBe(true);
  await vi.waitFor(() => expect(events.some(event => event.accessRevoked)).toBe(true));
  expect(direct.isTaskReadCurrent(recovery, true)).toBe(false); injector.close();
});

it.each([true, false])("confirms overlapping graph and direct reads without retiring their newer live epoch (graph starts first: %s)", async (graphFirst) => {
  const cache = scope(); const sessions = new TaskDetailSessions(cache);
  const unsubscribe = sessions.subscribe(projectId, taskId(1), () => {});
  const live = (value: string) => wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(userId, { "Daynight-Task-Epoch": value }) });
  let release!: (value: Response) => void; const held = new Promise<Response>(resolve => { release = resolve; }); let reads = 0;
  let releaseConfirmation!: (value: Response) => void; const confirming = new Promise<Response>(resolve => { releaseConfirmation = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => ++reads === 1 ? held : confirming));
  const events: { historyHint?: true }[] = []; cache.subscribe(event => events.push(event));
  try {
    let graph = graphFirst ? await cache.beginSync(projectId, signal()) : null;
    sessions.openDirect(projectId, taskId(1)); await vi.waitFor(() => expect(reads).toBe(1));
    graph ??= await cache.beginSync(projectId, signal());
    expect(await cache.observeHistory(graph, nextEpoch, signal())).toBe("current");
    await cache.applySync(graph, response([task(1)], { mode: "snapshot", epoch: nextEpoch }), signal());
    release(live(epoch));
    await vi.waitFor(() => expect(events.some(event => event.historyHint)).toBe(true));
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(cache.canPreviewProject(projectId)).toBe(false);
    expect(await cache.readProject(projectId, signal())).toBeNull();
    const unconfirmed = await cache.beginSync(projectId, signal());
    await expect(cache.applySync(unconfirmed, response([task(1)], { epoch: nextEpoch }), signal())).rejects.toMatchObject({ name: "AbortError" });
    releaseConfirmation(live(nextEpoch));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1))).toMatchObject({ status: "ready", error: null, requiresFreshRead: false }));
    expect(reads).toBe(2);
    const retry = await cache.beginTaskRead(projectId, taskId(1), 2, 1, signal());
    expect(await cache.observeHistory(retry, nextEpoch, signal())).toBe("current");
  } finally { unsubscribe(); sessions.dispose(); }
});

it("confirms a delayed old graph after a direct owner has already admitted the newer epoch", async () => {
  const cache = scope(); const graph = await cache.beginSync(projectId, signal());
  const sessions = new TaskDetailSessions(cache); const unsubscribe = sessions.subscribe(projectId, taskId(1), () => {});
  let release!: (value: Response) => void; const held = new Promise<Response>(resolve => { release = resolve; }); let reads = 0;
  const live = () => wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(userId, { "Daynight-Task-Epoch": nextEpoch }) });
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => ++reads === 1 ? Promise.resolve(live()) : held));
  try {
    sessions.openDirect(projectId, taskId(1)); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1)).status).toBe("ready"));
    expect(await cache.observeHistory(graph, epoch, signal())).toBe("confirm");
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(cache.canPreviewProject(projectId)).toBe(false);
    const confirmed = await cache.beginSync(projectId, signal());
    expect(await cache.observeHistory(confirmed, nextEpoch, signal())).toBe("current");
    await cache.applySync(confirmed, response([task(1)], { mode: "snapshot", epoch: nextEpoch }), signal());
    release(live());
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1))).toMatchObject({ status: "ready", error: null, requiresFreshRead: false }));
    const later = await cache.beginTaskRead(projectId, taskId(1), 2, 1, signal());
    expect(await cache.observeHistory(later, nextEpoch, signal())).toBe("current");
  } finally { unsubscribe(); sessions.dispose(); }
});

it.each(["replacement", "revocation"] as const)("preserves uncertain write ownership through %s according to its history", async (ending) => {
  const cache = scope();
  const delayed = await cache.beginTaskRead(projectId, taskId(1), 1, 1, signal());
  const owner = await cache.beginTaskRead(projectId, taskId(1), 1, 2, signal());
  expect(await cache.observeHistory(owner, nextEpoch, signal())).toBe("current");
  expect(await cache.observeHistory(delayed, epoch, signal())).toBe("confirm");
  expect(cache.isTaskReadCurrent(owner, true)).toBe(false);
  expect(cache.isTaskHistoryPossiblyCurrent(owner)).toBe(true);
  expect(cache.isTaskHistoryConfirmedCurrent(owner)).toBe(false);
  const confirmation = await cache.beginTaskRead(projectId, taskId(1), 2, 1, signal());
  expect(await cache.observeHistory(confirmation, nextEpoch, signal())).toBe("current");
  expect(cache.isTaskHistoryConfirmedCurrent(owner)).toBe(true);
  if (ending === "replacement") {
    const later = await cache.beginTaskRead(projectId, taskId(1), 3, 1, signal());
    expect(await cache.observeHistory(later, "30000000-0000-0000-0000-000000000003", signal())).toBe("retired");
  } else {
    const denied = await cache.beginSync(projectId, signal());
    expect(await cache.revokeProject(denied, signal())).toBe(true);
  }
  expect(cache.isTaskHistoryPossiblyCurrent(owner)).toBe(ending === 'revocation');
  if (ending === 'revocation') expect(cache.isTaskHistoryConfirmedCurrent(owner)).toBe(false);
});

it("automatically rereads after a peer hint is confirmed as a real history replacement", async () => {
  const direct = scope(); const sessions = new TaskDetailSessions(direct);
  const unsubscribe = sessions.subscribe(projectId, taskId(1), () => {});
  const live = (value: string) => wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(userId, { "Daynight-Task-Epoch": value }) });
  let release!: (value: Response) => void; const held = new Promise<Response>(resolve => { release = resolve; });
  let reads = 0; const signals: AbortSignal[] = [];
  const events: { historyChanged?: true; historyHint?: true }[] = []; direct.subscribe(event => events.push(event));
  vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) => { reads++; signals.push(init.signal!); return reads === 1 ? Promise.resolve(live(epoch)) : reads === 2 ? held : Promise.resolve(live(nextEpoch)); }));
  try {
    sessions.openDirect(projectId, taskId(1));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1)).status).toBe("ready"));
    const peer = scope(); const ticket = await peer.beginSync(projectId, signal());
    expect(await peer.observeHistory(ticket, nextEpoch, signal())).toBe("current");
    await peer.applySync(ticket, response([task(1)], { mode: "snapshot", epoch: nextEpoch }), signal());
    await vi.waitFor(() => expect(reads).toBe(2));
    const injector = new Channel("daynight-task-cache"); const before = events.length; injector.postMessage({ userId, projectId });
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(before));
    expect(events.filter(event => event.historyHint)).toHaveLength(1);
    expect(signals[1]!.aborted).toBe(false);
    release(live(nextEpoch));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId(1))).toMatchObject({ status: "ready", error: null, requiresFreshRead: false }));
    expect(reads).toBe(3); injector.close();
  } finally { unsubscribe(); sessions.dispose(); }
});

it("keeps known empty epochs and repeated rows free of writes, hint broadcasts and index changes", async () => {
  const cache = scope(); const initial = await seed(cache, []); Channel.hints = []; const counts = putCounts();
  const ticket = await cache.beginSync(projectId, signal()); expect(ticket).toMatchObject({ epoch, maxUpdatedAt: null });
  const repeated = await cache.applySync(ticket, response([]), signal());
  expect(repeated.changed).toBe(false); expect(repeated.project.manifest.cacheGeneration).toBe(initial.project.manifest.cacheGeneration);
  expect(repeated.project.index).toBe(initial.project.index); expect([...counts]).toEqual([]); expect(Channel.hints).toEqual([]);
});

it("retains intrinsic row, graph and index identities on duplicate receipt", async () => {
  const cache = scope(); const initial = await seed(cache); const counts = putCounts(); Channel.hints = [];
  const repeated = await delta(cache, [task(1)]);
  expect(repeated.changedTaskIds).toEqual([]); expect(repeated.project.graph).toBe(initial.project.graph);
  expect(repeated.project.index).toBe(initial.project.index);
  expect(repeated.project.summaries.get(taskId(1))).toBe(initial.project.summaries.get(taskId(1)));
  expect([...counts]).toEqual([]); expect(Channel.hints).toEqual([]);
});

it("captures request bindings and the watermark in the existing same IndexedDB transaction", async () => {
  const cache = scope(); const initial = await seed(cache, [executing()]);
  const manifestTransactions: IDBTransaction[] = [];
  const summaryTransactions: IDBTransaction[] = [];
  const get = fake.IDBObjectStore.prototype.get;
  vi.spyOn(fake.IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "projects") manifestTransactions.push(this.transaction);
    return get.apply(this, args);
  });
  const getAll = fake.IDBIndex.prototype.getAll;
  vi.spyOn(fake.IDBIndex.prototype, "getAll").mockImplementation(function (this: IDBIndex, ...args) {
    if (this.objectStore.name === "summaries") summaryTransactions.push(this.objectStore.transaction);
    return getAll.apply(this, args);
  });
  const ticket = await cache.beginSync(projectId, signal());
  expect(manifestTransactions).toHaveLength(1); expect(summaryTransactions).toEqual(manifestTransactions);
  expect(ticket).toMatchObject({ epoch, maxUpdatedAt: time, cacheGeneration: initial.project.manifest.cacheGeneration });
  const binding = ticket.taskBindings.get(taskId(1))!;
  expect(binding).toEqual(taskExecutionBinding(executing()));
  expect(Object.isFrozen(binding)).toBe(true); expect(Object.isFrozen(binding.worker)).toBe(true);
  await delta(cache, [executing({ version: 2n, updatedAt: later }, { claimId: taskId(95) })]);
  expect(ticket.taskBindings.get(taskId(1))!.worker!.claimId).toBe(taskId(91));
  expect((await cache.beginSync(projectId, signal())).taskBindings.get(taskId(1))!.worker!.claimId).toBe(taskId(95));
});

it("retains the response's execution observation when a newer cache row wins its merge", async () => {
  const owner = scope(); await seed(owner, [executing()]);
  const observer = scope(); const old = await observer.beginSync(projectId, signal());
  await delta(owner, [executing({ version: 3n, updatedAt: later }, { claimId: taskId(95) })]);
  const incoming = response([executing({ version: 2n })], { sessions: { [taskId(1)]: "notice" } });
  const accepted = await observer.applySync(old, incoming, signal());
  expect(taskExecutionBinding(accepted.project.summaries.get(taskId(1))!).worker!.claimId).toBe(taskId(95));
  expect(deriveTaskSyncBindings(old, incoming).get(taskId(1))!.worker!.claimId).toBe(taskId(91));
  expect(deriveTaskSyncBindings(old, response([])).get(taskId(1))!.worker!.claimId).toBe(taskId(91));
  expect([...deriveTaskSyncBindings(old, response([task(2)], { mode: "snapshot", epoch: nextEpoch })).keys()]).toEqual([taskId(2)]);
});

it("keeps Session-only data out of persistence, detail invalidation and generic notifications", async () => {
  const cache = scope(); const row = executing(); const initial = await seed(cache, [row]);
  const ticket = await cache.beginSync(projectId, signal());
  await cache.detailTransaction(ticket, signal(), async (details, manifest) => {
    const detail: TaskIntrinsicDetail = { ...detailFixture(projectId, row.id, { status: row.status, startedAt: row.startedAt, properties: row.properties }), version: row.version };
    await details.put({ userId, projectId, taskId: row.id, userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration, detail, byteSize: 100, lastUsedAt: 1 });
  });
  const database = await inspect(); const before = await Promise.all([database.getAll("projects"), database.getAll("summaries"), database.getAll("details")]);
  const counts = putCounts(); Channel.hints = []; const notifications = vi.fn(); cache.subscribe(notifications);
  for (const state of ["working", "notice", "warning", "pending"] as const) {
    const result = await delta(cache, [], { sessions: { [row.id]: state } });
    expect(result.changed).toBe(false); expect(result.changedTaskIds).toEqual([]);
    expect(result.project.graph).toBe(initial.project.graph); expect(result.project.index).toBe(initial.project.index);
    expect(result.project.summaries.get(row.id)).toBe(initial.project.summaries.get(row.id));
  }
  await delta(cache, [], { sessions: {} });
  expect([...counts]).toEqual([]); expect(Channel.hints).toEqual([]); expect(notifications).not.toHaveBeenCalled();
  expect(await Promise.all([database.getAll("projects"), database.getAll("summaries"), database.getAll("details")])).toEqual(before);
});

it("compares all execution binding fields while excluding unrelated Task presentation data", () => {
  const binding = taskExecutionBinding(executing());
  expect(sameTaskExecutionBinding(binding, taskExecutionBinding(executing({ titlePreview: "new title", version: 5n })))).toBe(true);
  for (const changes of [{ claimId: taskId(95) }, { workerId: taskId(95) }, { worktreeId: taskId(95) }, { state: "completed" as const }, { agentControlMode: "herdr" as const }]) {
    expect(sameTaskExecutionBinding(binding, taskExecutionBinding(executing({}, changes)))).toBe(false);
  }
  const withoutWorker = taskExecutionBinding(task(1));
  expect(sameTaskExecutionBinding(withoutWorker, taskExecutionBinding(task(1)))).toBe(true);
  expect(sameTaskExecutionBinding(binding, withoutWorker)).toBe(false);
  expect(sameTaskExecutionBinding(withoutWorker, binding)).toBe(false);
  expect(sameTaskExecutionBinding(binding, taskExecutionBinding(executing({ status: "done" })))).toBe(false);
  expect(eligibleTaskExecutionBinding(binding)).toBe(true);
  expect(eligibleTaskExecutionBinding(withoutWorker)).toBe(false);
  expect(eligibleTaskExecutionBinding(taskExecutionBinding(executing({}, { agentControlMode: "herdr" })))).toBe(false);
  expect(eligibleTaskExecutionBinding(taskExecutionBinding(executing({ status: "done" })))).toBe(false);
});

it("merges late responses into the current full set even when task versions share the watermark", async () => {
  const first = scope(); const second = scope(); await seed(first);
  const a = await first.beginSync(projectId, signal()); const b = await second.beginSync(projectId, signal());
  await first.applySync(a, response([task(2)]), signal());
  const result = await second.applySync(b, response([task(1, { version: 3n, titlePreview: "Changed" })]), signal());
  expect(result.project.graph.tasks.map((row) => row.id)).toEqual([taskId(1), taskId(2)]);
  expect(result.project.manifest.maxUpdatedAt).toBe(time); expect(result.project.versions.get(taskId(1))).toBe(3n);
  const ignored = await delta(second, [task(1, { titlePreview: "Old", updatedAt: later })]);
  expect(ignored.changed).toBe(false); expect(ignored.project.manifest.maxUpdatedAt).toBe(time);
});

it("rejects contradictions at the same business version without a partial write", async () => {
  const cache = scope(); const initial = await seed(cache); const counts = putCounts();
  await expect(delta(cache, [task(1, { titlePreview: "Contradiction" })])).rejects.toMatchObject({ kind: "protocol" });
  expect((await cache.readProject(projectId, signal()))!.manifest).toEqual(initial.project.manifest); expect([...counts]).toEqual([]);
});

it("keeps settings monotonic and settings-only changes reuse the task index", async () => {
  const cache = scope(); const initial = await seed(cache);
  const changed = await delta(cache, [], { project: { ...project, updatedAt: later, settings: { version: 2n, executionWarningMinutes: 5 } } });
  expect(changed.project.index).toBe(initial.project.index); expect(changed.project.graph.tasks).toBe(initial.project.graph.tasks);
  const old = await delta(cache, []); expect(old.changed).toBe(false);
  expect(old.project.graph.project.settings).toEqual({ version: 2n, executionWarningMinutes: 5 });
  await expect(delta(cache, [], { project: { ...project, settings: { version: 2n, executionWarningMinutes: 10 } } })).rejects.toMatchObject({ kind: "protocol" });
});

it("replaces a changed epoch and rejects old outstanding lifecycle tickets", async () => {
  const cache = scope(); const initial = await seed(cache, [task(1), task(2)]); const stale = await cache.beginSync(projectId, signal());
  const next = await cache.applySync(stale, response([task(3)], { mode: "snapshot", epoch: nextEpoch }), signal());
  expect(next.project.graph.tasks.map((row) => row.id)).toEqual([taskId(3)]);
  expect(next.project.manifest.cacheGeneration).not.toBe(initial.project.manifest.cacheGeneration);
  await expect(cache.applySync(stale, response([task(1, { version: 2n })]), signal())).rejects.toMatchObject({ name: "AbortError" });
});

it("requires delta baselines and only accepts snapshot mode for a missing or different epoch", async () => {
  const cache = scope(); const cold = await cache.beginSync(projectId, signal());
  await expect(cache.applySync(cold, response([task(1)]), signal())).rejects.toMatchObject({ kind: "protocol" });
  await cache.applySync(cold, response([task(1)], { mode: "snapshot" }), signal()); const ticket = await cache.beginSync(projectId, signal());
  for (const changes of [{ epoch: nextEpoch }, { mode: "snapshot" as const }]) await expect(cache.applySync(ticket, response([], changes), signal())).rejects.toMatchObject({ kind: "protocol" });
});

it("detects a missing independent row and rebuilds without accepting a smaller complete baseline", async () => {
  const cache = scope(); await seed(cache, [task(1), task(2)]); const database = await inspect();
  await database.delete("summaries", [userId, projectId, taskId(2)]);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const ticket = await cache.beginSync(projectId, signal()); expect(ticket).toMatchObject({ epoch: null, maxUpdatedAt: null });
  expect(await database.getAll("summaries")).toEqual([]); expect(warning).toHaveBeenCalled();
  const rebuilt = await cache.applySync(ticket, response([task(1), task(2)], { mode: "snapshot" }), signal()); expect(rebuilt.project.manifest.taskCount).toBe(2);
});

it("detects corruption introduced after the request and invalidates its old baseline", async () => {
  const cache = scope(); await seed(cache); const ticket = await cache.beginSync(projectId, signal()); const database = await inspect();
  await database.put("summaries", { userId, projectId, taskId: taskId(1), summary: task(1, { dependsOn: [taskId(2)] }), dependencyState: { taskVersion: 1n, blockedBy: [taskId(2)], ready: true } });
  await expect(cache.applySync(ticket, response([task(1, { version: 2n })]), signal())).rejects.toMatchObject({ category: "corrupt" });
  expect(await database.get("projects", [userId, projectId])).toMatchObject({ state: "invalidated", maxUpdatedAt: null }); expect(await database.getAll("summaries")).toEqual([]);
});

it("aborts quota errors atomically and reopens the last valid rows and maximum", async () => {
  const cache = scope(); const initial = await seed(cache); const put = fake.IDBObjectStore.prototype.put;
  const failure = vi.spyOn(fake.IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "projects") throw new DOMException("Quota exceeded", "QuotaExceededError"); return put.apply(this, args);
  });
  await expect(delta(cache, [task(1, { version: 2n, updatedAt: later }), task(2)])).rejects.toMatchObject({ category: "storage", cause: { name: "QuotaExceededError" } });
  failure.mockRestore(); cache.dispose(); const stored = await scope().readProject(projectId, signal());
  expect(stored!.manifest).toEqual(initial.project.manifest); expect(stored!.versions).toEqual(new Map([[taskId(1), 1n]]));
});

it("clears a project with a retained invalidated generation and preserves another project", async () => {
  const cache = scope(); await seed(cache); await seed(cache, [task(2)], { ...project, id: otherProject }); const stale = await cache.beginSync(projectId, signal());
  await cache.invalidateProject(projectId, signal()); expect(await cache.readProject(projectId, signal())).toBeNull();
  expect((await cache.readProject(otherProject, signal()))!.graph.tasks).toHaveLength(1);
  await expect(cache.applySync(stale, response([task(1)]), signal())).rejects.toMatchObject({ name: "AbortError" });
});

it("synchronously invalidates a user and rotates its persistent fence while retaining the other user's rows", async () => {
  const first = scope(); const other = scope(otherUser); await seed(first); await seed(other); const ticket = await first.beginSync(projectId, signal());
  const cleanup = first.invalidateScope(); expect(() => first.getAuthorizedProject(projectId)).toThrow();
  await expect(first.applySync(ticket, response([]), signal())).rejects.toMatchObject({ name: "AbortError" }); await cleanup;
  const database = await inspect(); expect((await database.get("userScopes", userId))!.userFence).not.toBe(ticket.userFence);
  expect(await database.get("projects", [userId, projectId])).toMatchObject({ state: "invalidated" });
  expect(await database.getAllFromIndex("summaries", "by-user", userId)).toEqual([]); expect(await database.getAllFromIndex("summaries", "by-user", otherUser)).toHaveLength(1);
});

it("notifies the owner before destroying a projection on a real principal mismatch", async () => {
  let resume = () => {};
  let cache: TaskCacheScope;
  const mismatch = vi.fn(() => {
    expect(cache.signal.aborted).toBe(false);
    expect(cache.isInvalidated).toBe(false);
    expect(cache.getAuthorizedProject(projectId)?.versions.get(taskId(1))).toBe(1n);
    resume = pauseAuthRequests();
  });
  cache = scope(userId, mismatch); await seed(cache);
  const ticket = await cache.beginSync(projectId, signal());
  const received = wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(otherUser) });
  const body = vi.spyOn(received, "text"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(received));
  try {
    await expect(getTask(projectId, taskId(1), signal(), { userId, onPrincipalMismatch: cache.principalMismatch })).rejects.toMatchObject({ kind: "protocol", code: "principal_mismatch" });
    expect(mismatch).toHaveBeenCalledOnce(); expect(body).not.toHaveBeenCalled();
    expect(cache.signal.aborted).toBe(false); expect(cache.isInvalidated).toBe(false);
    await expect(cache.applySync(ticket, response([task(2)]), signal())).rejects.toMatchObject({ name: "AbortError", retryable: false });
    const database = await inspect();
    expect((await database.getAllFromIndex("summaries", "by-user", userId)).map(row => row.taskId)).toEqual([taskId(1)]);
  } finally { resume(); }
  expect(cache.getAuthorizedProject(projectId)?.versions.get(taskId(1))).toBe(1n);
  await expect(cache.readProject(projectId, signal())).rejects.toMatchObject({ retryable: false });
});

it("holds disk reads and publication behind the foreground identity gate", async () => {
  const cache = scope(); await seed(cache); const resume = pauseAuthRequests(); const pending = cache.readProject(projectId, signal());
  let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); await Promise.resolve();
  expect(settled).toBe(false); expect(() => cache.getAuthorizedProject(projectId)).toThrow(); resume(); expect((await pending)!.manifest.epoch).toBe(epoch);
});

it("re-reads hints for authorized projects and never relays hints or repeated content", async () => {
  const first = scope(); const second = scope(); await seed(first); await delta(second, []); const event = vi.fn(); second.subscribe(event); Channel.hints = [];
  await delta(first, [task(1, { version: 2n, updatedAt: later })]); await vi.waitFor(() => expect(second.getSummaryVersion(projectId, taskId(1))).toBe(2n));
  expect(Channel.hints).toHaveLength(1); expect(event).toHaveBeenCalled(); event.mockClear(); Channel.hints = [];
  await delta(first, [task(1, { version: 2n, updatedAt: later })]); expect(Channel.hints).toEqual([]); expect(event).not.toHaveBeenCalled();
});

it("exposes fenced detail transactions whose detail timestamps cannot advance the project maximum", async () => {
  const cache = scope(); await seed(cache); const ticket = await cache.beginSync(projectId, signal());
  const detail: TaskIntrinsicDetail = { type: "task", parentId: null, assignedTo: null, id: taskId(1), projectId, title: "Task 1", description: "Body", properties: { pullRequests: [] }, tags: [], version: 1n, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: later };
  await cache.detailTransaction(ticket, signal(), async (details, manifest, summaries) => {
    expect(summaries.get(taskId(1))!.version).toBe(1n);
    await details.put({ userId, projectId, taskId: taskId(1), userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration, detail, byteSize: 100, lastUsedAt: 1 });
  });
  expect((await cache.beginSync(projectId, signal())).maxUpdatedAt).toBe(time); const database = await inspect(); expect(await database.getAll("details")).toHaveLength(1);
  await delta(cache, [task(1)]); expect(await database.getAll("details")).toHaveLength(1);
  await delta(cache, [task(1, { version: 2n })]); expect(await database.getAll("details")).toEqual([]);
  await cache.invalidateProject(projectId, signal()); await expect(cache.detailTransaction(ticket, signal(), async () => {})).rejects.toMatchObject({ name: "AbortError" });
});

it("surfaces cold storage failures without a network-only fallback", async () => {
  vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } }); await expect(scope().beginSync(projectId, signal())).rejects.toBeDefined();
});

it("retains a valid memory snapshot while a corrupt persistent baseline awaits a full rebuild", async () => {
  const cache = scope(); const initial = await seed(cache); const ticket = await cache.beginSync(projectId, signal());
  const database = await inspect(); await database.delete("summaries", [userId, projectId, taskId(1)]);
  await expect(cache.applySync(ticket, response([]), signal())).rejects.toMatchObject({ category: "corrupt" });
  expect(cache.getAuthorizedProject(projectId)!.graph).toBe(initial.project.graph);
  await expect(cache.readProject(projectId, signal())).rejects.toMatchObject({ category: "corrupt" });
  const rebuilt = await cache.beginSync(projectId, signal()); expect(rebuilt.epoch).toBeNull();
  await cache.applySync(rebuilt, response([task(1, { version: 2n })], { mode: "snapshot" }), signal());
  expect(cache.getSummaryVersion(projectId, taskId(1))).toBe(2n);
});

it("reports a storage read error without classifying it as corruption or clearing valid rows", async () => {
  const cache = scope(); const initial = await seed(cache);
  const failure = vi.spyOn(fake.IDBIndex.prototype, "getAll").mockImplementation(() => { throw new DOMException("Disk unavailable", "UnknownError"); });
  await expect(cache.beginSync(projectId, signal())).rejects.toMatchObject({ category: "storage", cause: { name: "UnknownError" } });
  failure.mockRestore(); const database = await inspect();
  expect(await database.get("projects", [userId, projectId])).toEqual(initial.project.manifest);
  expect(await database.getAll("summaries")).toHaveLength(1);
});

it("aborts its lifetime synchronously and prevents a late cold bootstrap from creating rows", async () => {
  const cache = scope(); const bootstrap = cache.beginSync(projectId, signal()); const cleanup = cache.invalidateScope();
  expect(cache.signal.aborted).toBe(true); await expect(bootstrap).rejects.toMatchObject({ name: "AbortError" }); await cleanup;
  const database = await inspect(); expect(await database.getAll("summaries")).toEqual([]); expect(await database.getAll("projects")).toEqual([]);
  expect(await database.get("userScopes", userId)).toBeDefined();
});

it("notifies before closing when another scope rotates its fence and rejects old transactions", async () => {
  let old: TaskCacheScope;
  const mismatch = vi.fn(() => {
    expect(old.signal.aborted).toBe(false); expect(old.isInvalidated).toBe(false);
    expect(old.getAuthorizedProject(projectId)?.versions.get(taskId(1))).toBe(1n);
  });
  old = scope(userId, mismatch); const reset = scope(); await seed(old); const stale = await old.beginSync(projectId, signal());
  await reset.invalidateScope(); const current = scope(); await seed(current, [task(2)]);
  await expect(old.readProject(projectId, signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(mismatch).toHaveBeenCalled(); expect(old.isInvalidated).toBe(false);
  await expect(old.applySync(stale, response([task(1, { version: 2n })]), signal())).rejects.toMatchObject({ name: "AbortError" });
  expect((await current.readProject(projectId, signal()))!.graph.tasks[0]!.id).toBe(taskId(2));
});

it("keeps a replacement fence and its rows when the root invalidates the old scope", async () => {
  vi.spyOn(Channel.prototype, "postMessage").mockImplementation(() => {});
  let old: TaskCacheScope; let cleanup: Promise<void> | undefined;
  old = scope(userId, vi.fn(() => { cleanup = old.invalidateScope(); }));
  await seed(old); const stale = await old.beginSync(projectId, signal());
  const reset = scope(); await reset.invalidateScope();
  const current = scope(); await seed(current, [task(2)]);
  const database = await inspect(); const currentFence = await database.get("userScopes", userId);
  await expect(old.applySync(stale, response([task(1, { version: 2n })]), signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(cleanup).toBeDefined(); expect(old.signal.aborted).toBe(true); await cleanup;
  expect(await database.get("userScopes", userId)).toEqual(currentFence);
  expect((await current.readProject(projectId, signal()))!.graph.tasks.map(row => row.id)).toEqual([taskId(2)]);
});

it("rejects projection preparation on a changed fence even when the owner pauses", async () => {
  vi.spyOn(Channel.prototype, "postMessage").mockImplementation(() => {});
  let resume = () => {};
  const cache = scope(userId, () => { resume = pauseAuthRequests(); });
  await seed(cache); const database = await inspect();
  await database.put("userScopes", { userId, userFence: crypto.randomUUID() });
  try {
    await expect(cache.prepareProjection(signal())).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.signal.aborted).toBe(false); expect(cache.isInvalidated).toBe(false);
  } finally { resume(); }
  expect(cache.getAuthorizedProject(projectId)?.versions.get(taskId(1))).toBe(1n);
});

it("classifies invalid newly received dependencies as protocol data and preserves the valid baseline", async () => {
  const cache = scope(); const initial = await seed(cache);
  await expect(delta(cache, [task(2, { dependsOn: [taskId(3)] })], { dependencyStates: { [taskId(2)]: { taskVersion: 1n, blockedBy: [taskId(4)], ready: false } } })).rejects.toMatchObject({ kind: "protocol" });
  expect((await cache.readProject(projectId, signal()))!.manifest).toEqual(initial.project.manifest);
});

it("persists and publishes readiness-only patches, preserving details and ignoring another version", async () => {
  const first = scope(); const peer = scope();
  const successor = task(1, { dependsOn: [taskId(2)] });
  const initial = await seed(first, [successor]); await delta(peer, []);
  const ticket = await first.beginSync(projectId, signal());
  const detail = detailFixture(projectId, taskId(1), { dependsOn: [taskId(2)], blockedBy: [taskId(2)], ready: false });
  await first.detailTransaction(ticket, signal(), async (details, manifest) => {
    const { blockedBy: _blockedBy, ready: _ready, ...intrinsic } = detail;
    await details.put({ userId, projectId, taskId: taskId(1), userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration, detail: intrinsic, byteSize: 1, lastUsedAt: 1 });
  });
  const listener = vi.fn(); peer.subscribe(listener); Channel.hints = [];
  const update = await delta(first, [], { dependencyStates: { [taskId(1)]: { taskVersion: 1n, blockedBy: [], ready: true } } });
  expect(update.changed).toBe(true); expect(update.changedTaskIds).toEqual([taskId(1)]);
  expect(update.project.graph.tasks[0]).toMatchObject({ ready: true, blockedBy: [] });
  expect(update.project.index).not.toBe(initial.project.index);
  await vi.waitFor(() => expect(peer.getAuthorizedProject(projectId)?.graph.tasks[0]?.ready).toBe(true));
  expect(listener).toHaveBeenCalled(); expect(Channel.hints).toHaveLength(1);
  const database = await inspect();
  expect((await database.get("summaries", [userId, projectId, taskId(1)]))?.dependencyState).toEqual({ taskVersion: 1n, blockedBy: [], ready: true });
  expect(await database.getAll("details")).toHaveLength(1);
  const stale = await delta(first, [], { dependencyStates: { [taskId(1)]: { taskVersion: 2n, blockedBy: [taskId(2)], ready: false } } });
  expect(stale.changed).toBe(false); expect(stale.project.graph.tasks[0]?.ready).toBe(true);
  first.dispose(); expect((await scope().readProject(projectId, signal()))?.graph.tasks[0]?.ready).toBe(true);
});

it("keeps Goals in resource existence while replacing an epoch and rejects late responses", async () => {
  const cache = scope(); const initial = await seed(cache, [task(1)]);
  const stale = await cache.beginSync(projectId, signal());
  const goal = task(3, { type: "goal", allowAgents: false });
  const ticket = await cache.beginSync(projectId, signal());
  expect(await cache.observeHistory(ticket, nextEpoch, signal())).toBe("current");
  const result = await cache.applySync(ticket, response([goal], { mode: "snapshot", epoch: nextEpoch }), signal());
  expect(result.project.summaries.has(goal.id)).toBe(true); expect(result.project.index.nodes.has(goal.id)).toBe(false);
  expect(result.project.graph.tasks).toEqual([]); expect(result.project.manifest.cacheGeneration).not.toBe(initial.project.manifest.cacheGeneration);
  await expect(cache.applySync(stale, response([task(1)], { mode: "delta" }), signal())).rejects.toMatchObject({ name: "AbortError" });
});

it("reports an unexpected native transaction abort as storage failure with its original cause and retains all committed data", async () => {
  const cache = scope(); const initial = await seed(cache); const live = signal(); const put = fake.IDBObjectStore.prototype.put;
  const failure = vi.spyOn(fake.IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = put.apply(this, args);
    if (this.name === "projects") this.transaction.abort();
    return request;
  });
  const ticket = await cache.beginSync(projectId, live);
  const error = await cache.applySync(ticket, response([task(1, { version: 2n, updatedAt: later })]), live).catch((cause: unknown) => cause);
  expect(live.aborted).toBe(false);
  expect(cache.signal.aborted).toBe(false);
  expect(error).toMatchObject({ name: "TaskCacheError", category: "storage", cause: { name: "AbortError" } });
  failure.mockRestore();
  const database = await inspect(); expect(await database.get("projects", [userId, projectId])).toEqual(initial.project.manifest);
  expect((await database.get("summaries", [userId, projectId, taskId(1)]))!.summary.version).toBe(1n);
  expect(cache.getAuthorizedProject(projectId)!.graph).toBe(initial.project.graph);
});

it("preserves caller cancellation when its signal aborts an active native transaction", async () => {
  const cache = scope(); const initial = await seed(cache); const controller = new AbortController();
  const ticket = await cache.beginSync(projectId, controller.signal); const put = fake.IDBObjectStore.prototype.put;
  const cancellation = vi.spyOn(fake.IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = put.apply(this, args); if (this.name === "projects") controller.abort(); return request;
  });
  await expect(cache.applySync(ticket, response([task(1, { version: 2n, updatedAt: later })]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  cancellation.mockRestore(); expect(controller.signal.aborted).toBe(true);
  expect((await cache.readProject(projectId, signal()))!.manifest).toEqual(initial.project.manifest);
});

it.each([
  { epoch }, { maxUpdatedAt: time }, { project }, { taskCount: 1 }, { edgeCount: 1 },
  { cacheGeneration: "damaged" }, { userFence: "damaged" }, { invalidatedBy: null }, { state: "unknown" },
])("rebuilds a malformed invalidated manifest before constructing its next snapshot ticket %#", async (change) => {
  const cache = scope(); await seed(cache); await cache.invalidateProject(projectId, signal()); const database = await inspect();
  const previous = (await database.get("projects", [userId, projectId]))!;
  await database.put("projects", { ...previous, ...change } as typeof previous);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const ticket = await cache.beginSync(projectId, signal());
  expect(ticket).toMatchObject({ epoch: null, maxUpdatedAt: null }); expect(ticket.cacheGeneration).not.toBe(previous.cacheGeneration);
  expect(warning).toHaveBeenCalled();
  const result = await cache.applySync(ticket, response([task(1)], { mode: "snapshot" }), signal());
  expect(result.project.manifest).toMatchObject({ state: "active", epoch, taskCount: 1 });
});

const addStoredDetail = async (database: IDBPDatabase<TaskCacheSchema>, owner: string, ownerProject: string) => {
  const manifest = (await database.get("projects", [owner, ownerProject]))!;
  const { titlePreview: _preview, titleTruncated: _truncated, ...intrinsic } = task(1);
  await database.put("details", { userId: owner, projectId: ownerProject, taskId: taskId(1), userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration,
    detail: { ...intrinsic, projectId: ownerProject, title: "Task", description: "Body", properties: { pullRequests: [] } }, byteSize: 100, lastUsedAt: 1 });
};

it("repairs a cold user's damaged fence atomically across projects and four stores while preserving another user", async () => {
  const original = scope(); const other = scope(otherUser); await seed(original); await seed(original, [task(1)], { ...project, id: otherProject }); await seed(other);
  const database = await inspect(); await addStoredDetail(database, userId, projectId); await addStoredDetail(database, userId, otherProject); await addStoredDetail(database, otherUser, projectId);
  const otherBefore = await Promise.all([database.get("userScopes", otherUser), database.getAllFromIndex("projects", "by-user", otherUser), database.getAllFromIndex("summaries", "by-user", otherUser), database.getAllFromIndex("details", "by-user", otherUser)]);
  original.dispose(); await database.put("userScopes", { userId, userFence: "damaged" });
  const mismatch = vi.fn(); const cold = scope(userId, mismatch); const ticket = await cold.beginSync(projectId, signal());
  expect(ticket).toMatchObject({ epoch: null, maxUpdatedAt: null }); expect(ticket.userFence).not.toBe("damaged");
  expect(cold.signal.aborted).toBe(false); expect(mismatch).not.toHaveBeenCalled();
  expect(await database.getAllFromIndex("summaries", "by-user", userId)).toEqual([]); expect(await database.getAllFromIndex("details", "by-user", userId)).toEqual([]);
  expect(await database.get("projects", [userId, otherProject])).toMatchObject({ state: "invalidated", invalidatedBy: "corrupt", userFence: ticket.userFence, epoch: null });
  expect(await Promise.all([database.get("userScopes", otherUser), database.getAllFromIndex("projects", "by-user", otherUser), database.getAllFromIndex("summaries", "by-user", otherUser), database.getAllFromIndex("details", "by-user", otherUser)])).toEqual(otherBefore);
  await cold.applySync(ticket, response([task(2)], { mode: "snapshot" }), signal()); expect(cold.getSummaryVersion(projectId, taskId(2))).toBe(1n);
});

it("retires an old bound scope only after its damaged-fence replacement commits and fences another tab's outstanding ticket", async () => {
  let database: IDBPDatabase<TaskCacheSchema>;
  const observations: Array<{ userFence: string; state: string }> = [];
  const mismatch = vi.fn(() => { void database.get("userScopes", userId).then((user) => observations.push({ userFence: user!.userFence, state: "committed" })); });
  const bound = scope(userId, mismatch); const otherTab = scope(); await seed(bound); database = await inspect(); const late = await otherTab.beginSync(projectId, signal());
  const before = await bound.beginSync(projectId, signal()); await database.put("userScopes", { userId, userFence: "damaged" });
  await expect(bound.beginSync(projectId, signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(mismatch).toHaveBeenCalledOnce(); expect(bound.isInvalidated).toBe(false); expect(bound.signal.aborted).toBe(false);
  const user = (await database.get("userScopes", userId))!; expect(user.userFence).not.toBe(before.userFence); expect(user.userFence).not.toBe("damaged");
  expect(await database.get("projects", [userId, projectId])).toMatchObject({ state: "invalidated", userFence: user.userFence });
  await vi.waitFor(() => expect(observations).toEqual([{ userFence: user.userFence, state: "committed" }]));
  await expect(otherTab.applySync(late, response([task(2)]), signal())).rejects.toMatchObject({ name: "AbortError" });
  const fresh = scope(); const ticket = await fresh.beginSync(projectId, signal()); await fresh.applySync(ticket, response([task(2)], { mode: "snapshot" }), signal());
  expect((await database.getAllFromIndex("summaries", "by-user", userId)).map((row) => row.taskId)).toEqual([taskId(2)]);
});

it.each([["cold", "quota"], ["bound", "quota"], ["cold", "abort"], ["bound", "abort"]] as const)("rolls a failed %s/%s user repair back without rebinding or identity callbacks, then recovers on Retry", async (mode, fault) => {
  const mismatch = vi.fn(); const original = scope(userId, mismatch); await seed(original); const database = await inspect(); await addStoredDetail(database, userId, projectId);
  const old = await original.beginSync(projectId, signal()); await database.put("userScopes", { userId, userFence: "damaged" });
  if (mode === "cold") original.dispose();
  const repairing = mode === "cold" ? scope(userId, mismatch) : original;
  const before = await Promise.all([database.get("userScopes", userId), database.getAllFromIndex("projects", "by-user", userId), database.getAllFromIndex("summaries", "by-user", userId), database.getAllFromIndex("details", "by-user", userId)]);
  const update = fake.IDBCursor.prototype.update;
  const failure = vi.spyOn(fake.IDBCursor.prototype, "update").mockImplementation(function (this: IDBCursorWithValue, ...args) {
    if (this.source instanceof IDBIndex && this.source.objectStore.name === "projects") {
      if (fault === "quota") throw new DOMException("Quota exceeded", "QuotaExceededError");
      const request = update.apply(this, args); this.source.objectStore.transaction.abort(); return request;
    }
    return update.apply(this, args);
  });
  await expect(repairing.beginSync(projectId, signal())).rejects.toMatchObject({ category: "storage", cause: { name: fault === "quota" ? "QuotaExceededError" : "AbortError" } });
  expect(repairing.isInvalidated).toBe(false); expect(repairing.signal.aborted).toBe(false); expect(mismatch).not.toHaveBeenCalled();
  failure.mockRestore();
  expect(await Promise.all([database.get("userScopes", userId), database.getAllFromIndex("projects", "by-user", userId), database.getAllFromIndex("summaries", "by-user", userId), database.getAllFromIndex("details", "by-user", userId)])).toEqual(before);
  if (mode === "bound") {
    await expect(repairing.beginSync(projectId, signal())).rejects.toMatchObject({ name: "AbortError" }); expect(mismatch).toHaveBeenCalledOnce();
  } else {
    const ticket = await repairing.beginSync(projectId, signal()); expect(ticket.userFence).not.toBe(old.userFence); expect(ticket.epoch).toBeNull(); expect(mismatch).not.toHaveBeenCalled();
  }
});

it("validates invalidated lifecycle records at read, detail and apply boundaries before treating them as baselines", async () => {
  const cache = scope(); await seed(cache); await cache.invalidateProject(projectId, signal()); const ticket = await cache.beginSync(projectId, signal()); const database = await inspect();
  const manifest = (await database.get("projects", [userId, projectId]))!;
  await database.put("projects", { ...manifest, epoch });
  await expect(cache.readProject(projectId, signal())).rejects.toMatchObject({ category: "corrupt" });
  await expect(cache.detailTransaction(ticket, signal(), async () => {})).rejects.toMatchObject({ category: "corrupt" });
  await expect(cache.applySync(ticket, response([task(1)], { mode: "snapshot" }), signal())).rejects.toMatchObject({ category: "corrupt" });
  expect((await cache.beginSync(projectId, signal())).epoch).toBeNull();
});

it("repairs a missing user record without retaining orphaned private rows or malformed project keys", async () => {
  const original = scope(); await seed(original); const database = await inspect(); original.dispose();
  await database.delete("userScopes", userId);
  const manifest = (await database.get("projects", [userId, projectId]))!;
  await database.put("projects", { ...manifest, projectId: "malformed-project-key" });
  const fresh = scope(); const ticket = await fresh.beginSync(projectId, signal());
  expect(ticket.epoch).toBeNull(); expect(await database.getAllFromIndex("summaries", "by-user", userId)).toEqual([]);
  expect(await database.get("projects", [userId, "malformed-project-key"])).toBeUndefined();
  expect(await database.get("projects", [userId, projectId])).toMatchObject({ state: "invalidated", userFence: ticket.userFence });
});

it("replaces deleted properties across tabs and prevents late values from resurrecting them", async () => {
  const first = scope(); const second = scope();
  const original = task(1, { properties: { pullRequests: [{ url: "opaque", title: "PR" }], future: { version: 42 } } });
  await seed(first, [original]); await delta(second, []);
  const late = await second.beginSync(projectId, signal());
  await delta(first, [task(1, { version: 2n, updatedAt: later, properties: {} })]);
  await vi.waitFor(() => expect(second.getAuthorizedProject(projectId)!.summaries.get(taskId(1))!.properties).toEqual({}));
  const replay = await second.applySync(late, response([original]), signal());
  expect(replay.changed).toBe(false);
  expect(replay.project.summaries.get(taskId(1))!.properties).toEqual({});
  expect(replay.project.manifest.maxUpdatedAt).toBe(later);
  expect(replay.project.index.nodes.get(taskId(1))).not.toHaveProperty("properties");
  const database = await inspect();
  expect((await database.get("summaries", [userId, projectId, taskId(1)]))!.summary.properties).toEqual({});
});

it("keeps reordered equivalent properties write-free but rejects same-version property contradictions atomically", async () => {
  const cache = scope();
  const original = task(1, { properties: { future: { first: 1, second: ["a", "b"] }, pullRequests: [] } });
  const initial = await seed(cache, [original, task(2)]); const counts = putCounts(); Channel.hints = [];
  const duplicate = await delta(cache, [task(1, { properties: { pullRequests: [], future: { second: ["a", "b"], first: 1 } } })]);
  expect(duplicate.changed).toBe(false); expect([...counts]).toEqual([]); expect(Channel.hints).toEqual([]);
  expect(duplicate.project.summaries.get(taskId(1))).toBe(initial.project.summaries.get(taskId(1)));
  for (const properties of [{}, { pullRequests: [] }, { future: null }]) {
    await expect(delta(cache, [task(2, { version: 2n, updatedAt: later, properties: { changed: true } }), task(1, { properties })])).rejects.toMatchObject({ kind: "protocol" });
    const stored = (await cache.readProject(projectId, signal()))!;
    expect(stored.summaries.get(taskId(1))!.properties).toEqual(original.properties);
    expect(stored.summaries.get(taskId(2))!.version).toBe(1n);
    expect(stored.manifest).toEqual(initial.project.manifest);
  }
});

it("applies tag rename and deletion as scoped deltas and rejects same-version contradictions", async () => {
  const tag = { id: taskId(90), name: "Before" };
  const cache = scope(), other = scope(otherUser);
  const original = task(1, { tags: [tag] }), unaffected = task(2);
  const initial = await seed(cache, [original, unaffected]);
  await seed(cache, [original], { ...project, id: otherProject }); await seed(other, [original]);
  const database = await inspect();
  await addStoredDetail(database, userId, projectId); await addStoredDetail(database, userId, otherProject); await addStoredDetail(database, otherUser, projectId);
  const manifest = initial.project.manifest;
  await database.put("details", { userId, projectId, taskId: taskId(2), userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration,
    detail: { ...detailFixture(projectId, taskId(2)) }, byteSize: 100, lastUsedAt: 1 });
  const history: TaskCacheSchema["sessionHistory"]["value"] = { userId, projectId, taskId: taskId(1), userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration, requestToken: epoch, clearedToken: null, leaseExpiresAt: null, settled: "saved", paginationToken: null, page: { items: [], nextCursor: null }, confirmedCompleteEmpty: true, observedNonEmpty: false, byteSize: 0, lastUsedAt: 1 };
  await database.put("sessionHistory", history);
  await expect(delta(cache, [task(2, { version: 2n, updatedAt: later }), { ...original, tags: [{ ...tag, name: "After" }] }])).rejects.toMatchObject({ kind: "protocol" });
  expect((await cache.readProject(projectId, signal()))!.summaries.get(taskId(2))!.version).toBe(1n);
  const renamed = { ...original, version: 2n, updatedAt: later, tags: [{ ...tag, name: "After" }] };
  const result = await delta(cache, [renamed]);
  expect(result.changedTaskIds).toEqual([taskId(1)]); expect(result.project.manifest.epoch).toBe(epoch);
  expect(result.project.summaries.get(taskId(1))!.tags).toEqual(renamed.tags);
  expect(await database.get("details", [userId, projectId, taskId(1)])).toBeUndefined();
  expect(await database.get("details", [userId, projectId, taskId(2)])).toBeDefined();
  expect(await database.get("details", [userId, otherProject, taskId(1)])).toBeDefined();
  expect(await database.get("details", [otherUser, projectId, taskId(1)])).toBeDefined();
  expect(await database.get("sessionHistory", [userId, projectId, taskId(1)])).toEqual(history);
  const deleted = await delta(cache, [{ ...renamed, version: 3n, tags: [] }]);
  expect(deleted.changedTaskIds).toEqual([taskId(1)]); expect(deleted.project.summaries.get(taskId(1))!.tags).toEqual([]);
  expect((await other.readProject(projectId, signal()))!.summaries.get(taskId(1))!.tags).toEqual([tag]);
  expect((await cache.readProject(otherProject, signal()))!.summaries.get(taskId(1))!.tags).toEqual([tag]);
});

it("rolls property replacements and the watermark back together after a partial summary write hits quota", async () => {
  const cache = scope();
  const original = [task(1, { properties: { pullRequests: [] } }), task(2, { properties: { future: { saved: true } } })];
  const initial = await seed(cache, original); const put = fake.IDBObjectStore.prototype.put;
  const failure = vi.spyOn(fake.IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "summaries" && (args[0] as { taskId: string }).taskId === taskId(2)) throw new DOMException("Quota exceeded", "QuotaExceededError");
    return put.apply(this, args);
  });
  await expect(delta(cache, original.map((row) => ({ ...row, version: 2n, updatedAt: later, properties: {} })))).rejects.toMatchObject({ category: "storage", cause: { name: "QuotaExceededError" } });
  failure.mockRestore();
  const database = await inspect();
  expect((await database.get("summaries", [userId, projectId, taskId(1)]))!.summary.properties).toEqual(original[0]!.properties);
  expect((await database.get("summaries", [userId, projectId, taskId(2)]))!.summary.properties).toEqual(original[1]!.properties);
  expect(await database.get("projects", [userId, projectId])).toEqual(initial.project.manifest);
});

it("stores profile content only behind current online admission and retains it across task history replacement", async () => {
  const cache = scope(); const unadmitted = await cache.beginSync(projectId, signal());
  const profile = { userId: otherUser, version: "a".repeat(64), name: null, avatarUrl: "data:image/svg+xml;base64,PHN2Zy8+" };
  await expect(cache.readProfiles(unadmitted, signal())).rejects.toMatchObject({ name: "AbortError" });
  await seed(cache); const first = await cache.beginSync(projectId, signal());
  await cache.writeProfiles(first, [profile], signal());
  expect(await cache.readProfiles(first, signal())).toEqual([profile]);
  await cache.applySync(first, response([], { mode: "snapshot", epoch: nextEpoch }), signal());
  const next = await cache.beginSync(projectId, signal());
  expect(next.cacheGeneration).not.toBe(first.cacheGeneration);
  expect(await cache.readProfiles(next, signal())).toEqual([profile]);
  await expect(cache.writeProfiles(first, [{ ...profile, name: "Obsolete history" }], signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(await cache.readProfiles(next, signal())).toEqual([profile]);
});

it("purges profile content for project withdrawal and user invalidation while preserving another viewer", async () => {
  const cache = scope(); const other = scope(otherUser); await seed(cache); await seed(other);
  const profile = { userId: otherUser, version: "a".repeat(64), name: "Shared person", avatarUrl: null };
  const ticket = await cache.beginSync(projectId, signal()), otherTicket = await other.beginSync(projectId, signal());
  await cache.writeProfiles(ticket, [profile], signal()); await other.writeProfiles(otherTicket, [profile], signal());
  await cache.revokeProject(ticket, signal()); const database = await inspect();
  expect(await database.getAllFromIndex("profiles", "by-user", userId)).toEqual([]);
  expect(await other.readProfiles(otherTicket, signal())).toEqual([profile]);
  await seed(cache); const fresh = await cache.beginSync(projectId, signal()); await cache.writeProfiles(fresh, [profile], signal());
  await cache.invalidateScope(); expect(await database.getAllFromIndex("profiles", "by-user", userId)).toEqual([]);
  expect(await other.readProfiles(otherTicket, signal())).toEqual([profile]);
});

it("merges ownership within one epoch and replaces restored history without persisting access", async () => {
  const cache = scope(); const initial = await seed(cache);
  const ownership = { teamId: otherProject, version: 9_007_199_254_740_993n };
  const changed = await delta(cache, [], { project: { ...project, ownership } });
  expect(changed.changed).toBe(true);
  expect(changed.project.graph.project.ownership).toEqual(ownership);
  expect(changed.project.index).toBe(initial.project.index);
  const old = await delta(cache, [], { project: { ...project, updatedAt: later } });
  expect(old.project.graph.project.ownership).toEqual(ownership);
  await expect(delta(cache, [], { project: { ...project, ownership: { ...ownership, teamId: project.ownership.teamId } } })).rejects.toMatchObject({ kind: "protocol" });
  const next = await delta(cache, [], { mode: "snapshot", epoch: nextEpoch });
  expect(next.project.graph.project.ownership).toEqual(project.ownership);
  const database = await inspect();
  expect((await database.get("projects", [userId, projectId]))!.project).not.toHaveProperty("access");
  expect((await database.get("projects", [userId, projectId]))!.project).not.toHaveProperty("ownerTeam");
  expect(next.project.graph.project.settings).toEqual(project.settings);
});

it('publishes claim changes and removal only within the authorized user and project generation', async () => {
  const worker = (name: string, state: 'active' | 'completed') => ({ claimId: taskId(101), state, userId, workerId: taskId(102), machine: { id: taskId(103), name }, platform: 'linux', agent: 'codex', agentControlMode: 'web', worktreeId: taskId(104), phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time });
  const cache = scope();
  const initial = await seed(cache, [task(1, { status: 'in_progress', startedAt: time, properties: { worker: worker('first', 'active') } })]);
  expect(initial.project.workerMachines.get(taskId(1))?.machine.name).toBe('first');
  const stale = await cache.beginSync(projectId, signal());
  const changed = await delta(cache, [task(1, { version: 2n, allowAgents: false, properties: { worker: worker('finished', 'completed') } })]);
  expect(changed.project.workerMachines.get(taskId(1))).toMatchObject({ state: 'completed', machine: { name: 'finished' } });
  const late = await cache.applySync(stale, response([task(1, { status: 'in_progress', startedAt: time, properties: { worker: worker('first', 'active') } })]), signal());
  expect(late.project.workerMachines.get(taskId(1))?.machine.name).toBe('finished');
  const removed = await delta(cache, [task(1, { version: 3n, properties: {} })]);
  expect(removed.project.workerMachines.has(taskId(1))).toBe(false);
  const other = scope(otherUser);
  expect(other.getAuthorizedProject(projectId)).toBeNull();
  expect(cache.getAuthorizedProject(otherProject)).toBeNull();
  const ticket = await cache.beginSync(projectId, signal());
  expect(await cache.revokeProject(ticket, signal())).toBe(true);
  expect(cache.getAuthorizedProject(projectId)).toBeNull();
  await expect(cache.applySync(ticket, response([task(1, { version: 4n, properties: { worker: worker('late', 'active') } })]), signal())).rejects.toMatchObject({ name: 'AbortError' });
  expect(cache.getAuthorizedProject(projectId)).toBeNull();
});

it("releases existing admission waiters once after concurrent real principal mismatches", async () => {
  let resume = () => {}; const mismatch = vi.fn(); const cache = scope(userId, mismatch); await seed(cache);
  let release!: (response: Response) => void; const pendingResponse = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(pendingResponse));
  const first = getTask(projectId, taskId(1), signal(), { userId, onPrincipalMismatch: cache.principalMismatch });
  const second = getTask(projectId, taskId(1), signal(), { userId, onPrincipalMismatch: cache.principalMismatch });
  resume = pauseAuthRequests(); const waiting = cache.ready(signal());
  try {
    release(wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(otherUser) }));
    await expect(first).rejects.toMatchObject({ code: "principal_mismatch" });
    await expect(second).rejects.toMatchObject({ code: "principal_mismatch" });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError", retryable: false });
    expect(mismatch).toHaveBeenCalledOnce(); expect(cache.signal.aborted).toBe(false);
  } finally { resume(); }
});

it("aborts an in-flight durable write after a real principal mismatch", async () => {
  const cache = scope(); await seed(cache); const ticket = await cache.beginSync(projectId, signal());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(otherUser) })));
  const detail: TaskIntrinsicDetail = detailFixture(projectId, taskId(1));
  await expect(cache.detailTransaction(ticket, signal(), async (details, manifest) => {
    const write = details.put({ userId, projectId, taskId: taskId(1), userFence: manifest.userFence, cacheGeneration: manifest.cacheGeneration, detail, byteSize: 100, lastUsedAt: 1 });
    void write.catch(() => {});
    await expect(getTask(projectId, taskId(1), signal(), { userId, onPrincipalMismatch: cache.principalMismatch })).rejects.toMatchObject({ code: "principal_mismatch" });
    await write;
  })).rejects.toMatchObject({ retryable: false });
  const database = await inspect(); expect(await database.getAll("details")).toEqual([]);
  expect(cache.getAuthorizedProject(projectId)?.versions.get(taskId(1))).toBe(1n);
});

it("honors a peer's confirmed project withdrawal after retaining a mismatched scope", async () => {
  const retained = scope(); await seed(retained); const peer = scope();
  const ticket = await peer.beginSync(projectId, signal());
  await peer.applySync(ticket, response([]), signal());
  const denial = await peer.beginSync(projectId, signal());
  const events: { accessRevoked?: true }[] = []; retained.subscribe(event => events.push(event));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(otherUser) })));
  await expect(getTask(projectId, taskId(1), signal(), { userId, onPrincipalMismatch: retained.principalMismatch })).rejects.toMatchObject({ code: "principal_mismatch" });
  expect(retained.getAuthorizedProject(projectId)).not.toBeNull();
  expect(await peer.revokeProject(denial, signal())).toBe(true);
  await vi.waitFor(() => expect(events.some(event => event.accessRevoked)).toBe(true));
  expect(retained.getAuthorizedProject(projectId)).toBeNull(); expect(retained.signal.aborted).toBe(false);
});

it("withdraws matching peer directory generations after a retained mismatch", async () => {
  const peer = scope(); await seed(peer); const denial = await peer.beginSync(projectId, signal());
  const directory = scope(); const snapshot = await directory.prepareProjection(signal());
  const events: import('../src/features/task-cache/project-cache').CacheEvent[] = [];
  directory.subscribeProjection(event => events.push(event));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(wireResponse(detailFixture(projectId, taskId(1)), { headers: viewerHeaders(otherUser) })));
  await expect(getTask(projectId, taskId(1), signal(), { userId, onPrincipalMismatch: directory.principalMismatch })).rejects.toMatchObject({ code: "principal_mismatch" });
  expect(await peer.revokeProject(denial, signal())).toBe(true);
  await vi.waitFor(() => expect(events.some(event => event.accessRevoked && directory.projectionEventMatches(snapshot, event))).toBe(true));
});
