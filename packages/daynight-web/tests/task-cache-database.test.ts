import * as fake from "fake-indexeddb";
import { openDB, unwrap } from "idb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { detailFixture } from "./helpers/taskDetail";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, TaskCacheDatabase, type TaskCacheSchema } from "../src/features/task-cache/database";

const databases: TaskCacheDatabase[] = [];
const cache = (onFailure = vi.fn(), version = TASK_CACHE_SCHEMA) => { const database = new TaskCacheDatabase(onFailure, version); databases.push(database); return database; };
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

it("closes on schema versionchange and rotates fences while clearing rebuildable stores", async () => {
  const failure = vi.fn(); const database = cache(failure, 1); const connection = await database.open();
  const userId = "10000000-0000-0000-0000-000000000001";
  const userFence = "20000000-0000-0000-0000-000000000001";
  await connection.put("userScopes", { userId, userFence });
  const upgraded = cache(vi.fn(), 2); const next = await upgraded.open();
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: "versionchange" }));
  expect((await next.get("userScopes", userId))!.userFence).not.toBe(userFence);
  expect(await next.getAll("projects")).toEqual([]);
  await expect(database.open()).rejects.toMatchObject({ category: "storage", cause: { name: "VersionError" } });
});

it("clears persisted null-ownership details before admitting the same task version in the new model", async () => {
  const userId = "10000000-0000-0000-0000-000000000001";
  const projectId = "20000000-0000-0000-0000-000000000001";
  const taskId = "30000000-0000-0000-0000-000000000001";
  const userFence = "40000000-0000-0000-0000-000000000001";
  const old = cache(vi.fn(), 1);
  const connection = await old.open();
  await connection.put("userScopes", { userId, userFence });
  const detail = detailFixture(projectId, taskId, { properties: { pullRequests: [], worker: null } });
  await connection.put("details", { userId, projectId, taskId, userFence, cacheGeneration: userFence, detail, byteSize: 100, lastUsedAt: 1 });
  expect((await connection.get("details", [userId, projectId, taskId]))!.detail.properties).toHaveProperty("worker", null);
  const current = await cache().open();
  expect(TASK_CACHE_SCHEMA).toBe(8);
  expect(await current.getAll("details")).toEqual([]);
  expect((await current.get("userScopes", userId))!.userFence).not.toBe(userFence);
});

it("reports abnormal close and reopens a usable connection on retry", async () => {
  const failure = vi.fn(); const database = cache(failure); const connection = await database.open();
  fake.forceCloseDatabase(unwrap(connection) as unknown as Parameters<typeof fake.forceCloseDatabase>[0]);
  await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: "closed" })));
  expect(await database.open()).not.toBe(connection);
});

it("reports blocked upgrades at 5000ms and closes an eventual late connection", async () => {
  const initial = cache(vi.fn(), 1); await initial.open(); initial.close();
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
  const next = await openDB(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); next.close();
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

it.each([1, 2, 3, 4])("rebuilds schema %i project and task formats before admitting ownership-bearing snapshots", async (oldVersion) => {
  const userId = "10000000-0000-4000-8000-000000000001";
  const projectId = "20000000-0000-4000-8000-000000000001";
  const taskId = "30000000-0000-4000-8000-000000000001";
  const userFence = "40000000-0000-4000-8000-000000000001";
  const failure = vi.fn(); const old = cache(failure, oldVersion); const connection = await old.open();
  const detail = detailFixture(projectId, taskId);
  const { projectId: _owner, title, description: _body, properties: _properties, assignedTo: _assignedTo, ready: _ready, blockedBy: _blockedBy, ...intrinsic } = detail;
  const project = { id: projectId, name: "Project", repoUrl: "https://example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
  await connection.put("userScopes", { userId, userFence });
  await connection.put("projects", { userId, projectId, userFence, cacheGeneration: userFence, state: "active", invalidatedBy: null,
    epoch: userFence, project, maxUpdatedAt: detail.updatedAt, taskCount: 1, edgeCount: 0 } as unknown as TaskCacheSchema["projects"]["value"]);
  // Project ownership is absent in every older schema; assignment first appears in schema 4.
  const legacy = { userId, projectId, taskId, summary: { ...intrinsic, ...(oldVersion >= 3 ? { properties: detail.properties } : {}), ...(oldVersion === 4 ? { assignedTo: detail.assignedTo } : {}), titlePreview: title, titleTruncated: false } };
  await connection.put("summaries", legacy as unknown as TaskCacheSchema["summaries"]["value"]);
  const { assignedTo: _legacyAssignment, ...legacyDetail } = detail;
  const legacyRecord = { userId, projectId, taskId, userFence, cacheGeneration: userFence, detail: oldVersion === 4 ? detail : legacyDetail, byteSize: 100, lastUsedAt: 1 };
  await connection.put("details", legacyRecord as unknown as TaskCacheSchema["details"]["value"]);
  expect((await connection.get("projects", [userId, projectId]))!.project).not.toHaveProperty("ownership");
  if (oldVersion < 4) expect((await connection.get("details", [userId, projectId, taskId]))!.detail).not.toHaveProperty("assignedTo");
  const current = await cache().open();
  expect(TASK_CACHE_SCHEMA).toBe(8);
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ category: "versionchange" }));
  expect((await current.get("userScopes", userId))!.userFence).not.toBe(userFence);
  for (const store of ["projects", "summaries", "details"] as const) expect(await current.getAll(store)).toEqual([]);
});

it("adds persistent profiles to the shipped ownership-bearing schema 5 without rebuilding task data or fences", async () => {
  const old = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, 5, { upgrade(database) {
    database.createObjectStore("userScopes", { keyPath: "userId" });
    database.createObjectStore("projects", { keyPath: ["userId", "projectId"] }).createIndex("by-user", "userId");
    for (const name of ["summaries", "details"] as const) {
      const store = database.createObjectStore(name, { keyPath: ["userId", "projectId", "taskId"] });
      store.createIndex("by-user", "userId"); store.createIndex("by-project", ["userId", "projectId"]);
    }
  } });
  const userId = "10000000-0000-4000-8000-000000000001", userFence = "20000000-0000-4000-8000-000000000001";
  const projectId = "30000000-0000-4000-8000-000000000001", taskId = "40000000-0000-4000-8000-000000000001";
  const detail = detailFixture(projectId, taskId);
  const project = { ownership: { teamId: "50000000-0000-4000-8000-000000000001", version: 9_007_199_254_740_993n },
    id: projectId, name: "Project", repoUrl: "https://example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
  const manifest: TaskCacheSchema["projects"]["value"] = { userId, projectId, userFence, cacheGeneration: userFence, state: "active", invalidatedBy: null,
    epoch: userFence, project, maxUpdatedAt: detail.updatedAt, taskCount: 1, edgeCount: 0 };
  const { ready: _ready, blockedBy: _blockedBy, ...intrinsicDetail } = detail;
  const { projectId: _owner, title, description: _body, ...summaryFields } = intrinsicDetail;
  const summary: TaskCacheSchema["summaries"]["value"] = { userId, projectId, taskId, summary: { ...summaryFields, titlePreview: title, titleTruncated: false } };
  const detailRecord = { userId, projectId, taskId, userFence, cacheGeneration: userFence, detail: intrinsicDetail, byteSize: 100, lastUsedAt: 1 };
  await old.put("userScopes", { userId, userFence });
  await old.put("projects", manifest); await old.put("summaries", summary); await old.put("details", detailRecord);
  expect([...old.objectStoreNames]).not.toContain("profiles");
  old.close();
  const current = await cache().open();
  expect([...current.objectStoreNames]).toContain("profiles");
  expect(await current.get("userScopes", userId)).toEqual({ userId, userFence });
  expect(await current.get("projects", [userId, projectId])).toEqual(manifest);
  expect(await current.get("summaries", [userId, projectId, taskId])).toEqual(summary);
  expect(await current.get("details", [userId, projectId, taskId])).toEqual(detailRecord);
});

it("adds session history to schema 6 without changing compatible task and profile data", async () => {
  const old = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, 6, { upgrade(database) {
    database.createObjectStore("userScopes", { keyPath: "userId" });
    database.createObjectStore("projects", { keyPath: ["userId", "projectId"] }).createIndex("by-user", "userId");
    for (const name of ["summaries", "details"] as const) {
      const store = database.createObjectStore(name, { keyPath: ["userId", "projectId", "taskId"] });
      store.createIndex("by-user", "userId"); store.createIndex("by-project", ["userId", "projectId"]);
    }
    const profiles = database.createObjectStore("profiles", { keyPath: ["userId", "projectId", "profileUserId"] });
    profiles.createIndex("by-user", "userId"); profiles.createIndex("by-project", ["userId", "projectId"]);
  } });
  const userId = "10000000-0000-4000-8000-000000000001", userFence = "20000000-0000-4000-8000-000000000001";
  const projectId = "30000000-0000-4000-8000-000000000001", taskId = "40000000-0000-4000-8000-000000000001";
  const detail = detailFixture(projectId, taskId);
  const detailRow = { userId, projectId, taskId, userFence, cacheGeneration: userFence, detail, byteSize: 10, lastUsedAt: 1 };
  const profileRow = { userId, projectId, profileUserId: taskId, userFence, profile: { userId: taskId, version: "a".repeat(64), name: null, avatarUrl: null } };
  await old.put("userScopes", { userId, userFence }); await old.put("details", detailRow); await old.put("profiles", profileRow);
  old.close();
  const current = await cache().open();
  expect([...current.objectStoreNames]).toContain("sessionHistory");
  expect(await current.get("userScopes", userId)).toEqual({ userId, userFence });
  expect(await current.get("details", [userId, projectId, taskId])).toEqual(detailRow);
  expect(await current.get("profiles", [userId, projectId, taskId])).toEqual(profileRow);
});

it("discards schema 7 history without modifying compatible task and profile data", async () => {
  const old = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, 7, { upgrade(database) {
    database.createObjectStore("userScopes", { keyPath: "userId" });
    database.createObjectStore("projects", { keyPath: ["userId", "projectId"] }).createIndex("by-user", "userId");
    for (const name of ["summaries", "details", "sessionHistory"] as const) {
      const store = database.createObjectStore(name, { keyPath: ["userId", "projectId", "taskId"] });
      store.createIndex("by-user", "userId"); store.createIndex("by-project", ["userId", "projectId"]);
    }
    const profiles = database.createObjectStore("profiles", { keyPath: ["userId", "projectId", "profileUserId"] });
    profiles.createIndex("by-user", "userId"); profiles.createIndex("by-project", ["userId", "projectId"]);
  } });
  const userId = "10000000-0000-4000-8000-000000000001", userFence = "20000000-0000-4000-8000-000000000001";
  const projectId = "30000000-0000-4000-8000-000000000001", taskId = "40000000-0000-4000-8000-000000000001";
  const detail = detailFixture(projectId, taskId);
  const project = { ownership: { teamId: "50000000-0000-4000-8000-000000000001", version: 1n }, id: projectId, name: "Project",
    repoUrl: "https://example.test/project", settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: detail.createdAt, updatedAt: detail.updatedAt };
  const manifest: TaskCacheSchema["projects"]["value"] = { userId, projectId, userFence, cacheGeneration: userFence, state: "active", invalidatedBy: null,
    epoch: userFence, project, maxUpdatedAt: detail.updatedAt, taskCount: 1, edgeCount: 0 };
  const { projectId: _owner, title, description: _description, ready: _ready, blockedBy: _blockedBy, ...summaryFields } = detail;
  const summary: TaskCacheSchema["summaries"]["value"] = { userId, projectId, taskId, summary: { ...summaryFields, titlePreview: title, titleTruncated: false } };
  const detailRow = { userId, projectId, taskId, userFence, cacheGeneration: userFence, detail, byteSize: 10, lastUsedAt: 1 };
  const profileRow = { userId, projectId, profileUserId: taskId, userFence, profile: { userId: taskId, version: "a".repeat(64), name: null, avatarUrl: null } };
  await old.put("userScopes", { userId, userFence }); await old.put("projects", manifest); await old.put("summaries", summary);
  await old.put("details", detailRow); await old.put("profiles", profileRow);
  await old.put("sessionHistory", { userId, projectId, taskId, userFence, cacheGeneration: userFence, requestToken: userFence, clearedToken: null,
    leaseExpiresAt: null, settled: "saved", page: { items: [], nextCursor: "next" }, byteSize: 0, lastUsedAt: 1 } as unknown as TaskCacheSchema["sessionHistory"]["value"]);
  old.close();
  const current = await cache().open();
  expect(await current.getAll("sessionHistory")).toEqual([]);
  expect(await current.get("userScopes", userId)).toEqual({ userId, userFence });
  expect(await current.get("projects", [userId, projectId])).toEqual(manifest);
  expect(await current.get("summaries", [userId, projectId, taskId])).toEqual(summary);
  expect(await current.get("details", [userId, projectId, taskId])).toEqual(detailRow);
  expect(await current.get("profiles", [userId, projectId, taskId])).toEqual(profileRow);
});
