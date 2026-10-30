import * as fake from "fake-indexeddb";
import { openDB, type IDBPDatabase } from "idb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pauseAuthRequests } from "../src/api/client";
import type { Project, TaskSummary, TaskSync } from "../src/api/types";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema, type TaskIntrinsicDetail } from "../src/features/task-cache/database";

const userId = "10000000-0000-0000-0000-000000000001";
const otherUser = "10000000-0000-0000-0000-000000000002";
const projectId = "20000000-0000-0000-0000-000000000001";
const otherProject = "20000000-0000-0000-0000-000000000002";
const epoch = "30000000-0000-0000-0000-000000000001";
const nextEpoch = "30000000-0000-0000-0000-000000000002";
const taskId = (n: number) => `40000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
const time = "2026-10-20T12:00:00.123456789Z";
const later = "2026-10-20T12:00:01.000000001Z";
const project: Project = { id: projectId, name: "Project", repoUrl: "git@example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const task = (n: number, changes: Partial<TaskSummary> = {}): TaskSummary => ({ id: taskId(n), version: 1n, titlePreview: `Task ${n}`, titleTruncated: false, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, createdAt: time, updatedAt: time, ...changes });
const response = (tasks: readonly TaskSummary[], changes: Partial<TaskSync> = {}): TaskSync => ({ mode: "delta", epoch, project, observedAt: later, tasks, ...changes });
const signal = () => new AbortController().signal;
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
const scope = (identity = userId, onIdentityMismatch = vi.fn()) => {
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

it("atomically saves four-store data and reopens the exact maximum without granting local access", async () => {
  const first = scope(); const result = await seed(first, [task(1), task(2, { updatedAt: later, version: 9_007_199_254_740_993n })]);
  const database = await inspect();
  expect([...database.objectStoreNames]).toEqual(["details", "projects", "summaries", "userScopes"]);
  const manifest = await database.get("projects", [userId, projectId]);
  expect(manifest).toMatchObject({ state: "active", epoch, maxUpdatedAt: later, taskCount: 2, edgeCount: 0 });
  expect(result.project.versions.get(taskId(2))).toBe(9_007_199_254_740_993n); first.dispose();
  const reopened = scope();
  expect(await reopened.beginSync(projectId, signal())).toMatchObject({ epoch, maxUpdatedAt: later, cacheGeneration: manifest!.cacheGeneration });
  expect((await reopened.readProject(projectId, signal()))!.graph.tasks).toHaveLength(2);
  expect(reopened.getAuthorizedProject(projectId)).toBeNull();
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
  await database.put("summaries", { userId, projectId, taskId: taskId(1), summary: task(1, { dependsOn: [taskId(2)] }) });
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

it("invalidates a principal mismatch before the root identity check", async () => {
  const mismatch = vi.fn(); const cache = scope(userId, mismatch); await seed(cache); cache.principalMismatch();
  expect(mismatch).toHaveBeenCalledOnce(); expect(() => cache.getAuthorizedProject(projectId)).toThrow(); await cache.invalidateScope();
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
  const detail: TaskIntrinsicDetail = { id: taskId(1), projectId, title: "Task 1", description: "Body", properties: { pullRequests: [] }, version: 1n, status: "todo", dependsOn: [], externalDependsOn: [], allowAgents: true, requiredPlatform: null, startedAt: null, completedAt: null, createdAt: time, updatedAt: later };
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

it("rechecks identity when another scope rotates its captured fence and preserves the new scope's rows", async () => {
  const mismatch = vi.fn(); const old = scope(userId, mismatch); const reset = scope(); await seed(old);
  await reset.invalidateScope(); const current = scope(); await seed(current, [task(2)]);
  await expect(old.readProject(projectId, signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(mismatch).toHaveBeenCalledOnce(); expect(old.isInvalidated).toBe(true);
  expect((await current.readProject(projectId, signal()))!.graph.tasks[0]!.id).toBe(taskId(2));
});

it("classifies invalid newly received dependencies as protocol data and preserves the valid baseline", async () => {
  const cache = scope(); const initial = await seed(cache);
  await expect(delta(cache, [task(2, { dependsOn: [taskId(3)] })])).rejects.toMatchObject({ kind: "protocol", cause: { name: "GraphDataError" } });
  expect((await cache.readProject(projectId, signal()))!.manifest).toEqual(initial.project.manifest);
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
  expect(mismatch).toHaveBeenCalledOnce(); expect(bound.isInvalidated).toBe(true);
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
