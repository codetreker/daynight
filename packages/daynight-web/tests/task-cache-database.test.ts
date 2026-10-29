import * as fake from "fake-indexeddb";
import { openDB, unwrap } from "idb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, TaskCacheDatabase, type TaskCacheSchema } from "../src/features/task-cache/database";

const databases: TaskCacheDatabase[] = [];
const cache = (onFailure = vi.fn(), version = 1) => { const database = new TaskCacheDatabase(onFailure, version); databases.push(database); return database; };
beforeEach(() => {
  for (const [name, value] of Object.entries(fake)) if (name !== "default" && name !== "indexedDB") vi.stubGlobal(name, value);
  vi.stubGlobal("indexedDB", new fake.IDBFactory());
});
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

it("shares one opening connection and rejects opens after release", async () => {
  const database = cache(); const a = database.open(); const b = database.open(); expect(a).toBe(b);
  const connection = await a; expect(await database.open()).toBe(connection); database.close();
  await expect(database.open()).rejects.toMatchObject({ name: "AbortError" });
});

it('upgrades the historical cache through the production schema and removes incompatible task records', async () => {
  const legacy = cache(); await legacy.open(); legacy.close();
  const old = await openDB(TASK_CACHE_DATABASE, 1);
  const userId = '10000000-0000-0000-0000-000000000001';
  await old.put('userScopes', { userId, userFence: 'old-fence' });
  for (const store of ['projects', 'summaries', 'details']) {
    await old.put(store, { userId, projectId: 'project', taskId: 'task', format: 'without signaling' });
  }
  old.close();
  const current = new TaskCacheDatabase(); databases.push(current);
  const connection = await current.open();
  expect(connection.version).toBe(TASK_CACHE_SCHEMA);
  expect((await connection.get('userScopes', userId))!.userFence).not.toBe('old-fence');
  for (const store of ['projects', 'summaries', 'details'] as const) expect(await connection.getAll(store)).toEqual([]);
});

it("closes on schema versionchange and rotates fences while clearing rebuildable stores", async () => {
  const failure = vi.fn(); const database = cache(failure); const connection = await database.open();
  const userId = "10000000-0000-0000-0000-000000000001";
  const userFence = "20000000-0000-0000-0000-000000000001";
  await connection.put("userScopes", { userId, userFence });
  const upgraded = cache(vi.fn(), 2); const next = await upgraded.open();
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: "versionchange" }));
  expect((await next.get("userScopes", userId))!.userFence).not.toBe(userFence);
  expect(await next.getAll("projects")).toEqual([]);
  await expect(database.open()).rejects.toMatchObject({ category: "storage", cause: { name: "VersionError" } });
});

it("reports abnormal close and reopens a usable connection on retry", async () => {
  const failure = vi.fn(); const database = cache(failure); const connection = await database.open();
  fake.forceCloseDatabase(unwrap(connection) as unknown as Parameters<typeof fake.forceCloseDatabase>[0]);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: "closed" })));
  expect(await database.open()).not.toBe(connection);
});

it("reports blocked upgrades at 5000ms and closes an eventual late connection", async () => {
  const initial = cache(); await initial.open(); initial.close();
  const blocker = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, 1);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const opening = cache(vi.fn(), 2).open();
  const rejected = expect(opening).rejects.toMatchObject({ category: "blocked" });
  // IndexedDB events use their own task queue; advance only the cache's blocked deadline.
  for (let turn = 0; turn < 20 && vi.getTimerCount() === 0; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(5_000); await rejected; blocker.close();
  vi.useRealTimers();
  const check = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, 3); check.close();
});

it("cleans up a connection that opens after its owner has unmounted", async () => {
  const database = cache(); const opening = database.open(); database.close();
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  const next = await openDB(TASK_CACHE_DATABASE, 2); next.close();
});

it("classifies synchronous open failures as storage errors", async () => {
  vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } });
  await expect(cache().open()).rejects.toMatchObject({ category: "storage", cause: { name: "SecurityError" } });
});

it("reports an actual upgrade transaction abort as storage failure while its owner remains live", async () => {
  const open = indexedDB.open.bind(indexedDB);
  vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
    const request = open(name, version);
    request.addEventListener("upgradeneeded", () => { queueMicrotask(() => request.transaction!.abort()); }, { once: true });
    return request;
  });
  await expect(cache().open()).rejects.toMatchObject({ name: "TaskCacheError", category: "storage", cause: { name: "AbortError" } });
});
