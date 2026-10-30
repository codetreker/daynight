import { openDB, type IDBPDatabase } from "idb";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskDetail } from "../src/api/types";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from "../src/features/task-cache/database";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { DETAIL_CACHE_LIMITS, detailByteSize, materializeDetail, readCachedDetail, saveDetail } from "../src/features/task-detail/detail-cache";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_VIEWER_ID } from "./helpers/taskSync";

const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const body = (n = 1, changes: Partial<TaskDetail> = {}) => detailFixture(projectId, taskId(n), { title: `Task ${n}`, ...changes });
const bytes = ({ ready: _ready, blockedBy: _blockedBy, ...detail }: TaskDetail) => detailByteSize(detail);
const scopes: TaskCacheScope[] = [];
const connections: IDBPDatabase<TaskCacheSchema>[] = [];
const seed = async (details: readonly TaskDetail[]) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const graph = graphFixture(details);
  await scope.applySync(await scope.beginSync(projectId, signal()), taskSyncFromGraph(graph, { versionForTask: (task) => details.find((detail) => detail.id === task.id)!.version, propertiesForTask: (task) => details.find((detail) => detail.id === task.id)!.properties }), signal());
  return scope;
};
const inspect = async () => { const connection = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); connections.push(connection); return connection; };
const record = async (n = 1) => (await inspect()).get("details", [TEST_VIEWER_ID, projectId, taskId(n)]);
afterEach(() => { scopes.splice(0).forEach((scope) => scope.dispose()); connections.splice(0).forEach((connection) => connection.close()); });

it("stores only intrinsic complete content and exact bigint, without advancing the project watermark", async () => {
  const detail = body(1, { version: 9_007_199_254_740_993n, description: "汉字🙂", properties: { pullRequests: [{ url: "https://example.test/1", title: "PR" }] } });
  const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal());
  expect(await saveDetail(scope, ticket, detail, signal())).toMatchObject({ kind: "matching" });
  const saved = (await record())!;
  expect(saved.detail).not.toHaveProperty("ready"); expect(saved.detail).not.toHaveProperty("blockedBy");
  expect(saved.detail.version).toBe(detail.version); expect(saved.detail.description).toBe(detail.description);
  expect(saved.byteSize).toBe(detailByteSize(saved.detail));
  expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(ticket.maxUpdatedAt);
  expect(materializeDetail(saved.detail, { ...scope.getAuthorizedProject(projectId)!.index.nodes.get(detail.id)!, ready: false, blockedBy: [taskId(2)] })).toMatchObject({ ready: false, blockedBy: [taskId(2)] });
});

it("does not rewrite matching repeated content and touches LRU only on an explicit cached read", async () => {
  const detail = body(); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal());
  vi.spyOn(Date, "now").mockReturnValue(100); await saveDetail(scope, ticket, detail, signal());
  vi.mocked(Date.now).mockReturnValue(200); await saveDetail(scope, ticket, detail, signal());
  expect((await record())!.lastUsedAt).toBe(100);
  expect(await readCachedDetail(scope, ticket, detail.id, signal())).toEqual((await record())!.detail);
  expect((await record())!.lastUsedAt).toBe(200);
});

it("rejects old/newer and contradictory same-version bodies without changing summaries or watermark", async () => {
  const detail = body(1, { version: 5n }); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal());
  expect(await saveDetail(scope, ticket, { ...detail, version: 4n }, signal())).toEqual({ kind: "older" });
  expect(await saveDetail(scope, ticket, { ...detail, version: 6n }, signal())).toEqual({ kind: "newer" });
  await expect(saveDetail(scope, ticket, { ...detail, title: "Other" }, signal())).rejects.toMatchObject({ kind: "protocol" });
  await saveDetail(scope, ticket, detail, signal());
  await expect(saveDetail(scope, ticket, { ...detail, description: "Other" }, signal())).rejects.toMatchObject({ kind: "protocol" });
  expect((await record())!.detail.description).toBe(detail.description);
  expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(ticket.maxUpdatedAt);
});

it("evicts the least recently used row at 32, preserving explicitly reopened content", async () => {
  const details = Array.from({ length: 33 }, (_, index) => body(index + 1)); const scope = await seed(details); const ticket = await scope.beginSync(projectId, signal());
  const clock = vi.spyOn(Date, "now");
  for (const [index, detail] of details.slice(0, 32).entries()) { clock.mockReturnValue(index + 1); await saveDetail(scope, ticket, detail, signal()); }
  clock.mockReturnValue(100); await readCachedDetail(scope, ticket, taskId(1), signal());
  await saveDetail(scope, ticket, details[32]!, signal());
  expect(await record(1)).toBeDefined(); expect(await record(2)).toBeUndefined();
  expect(await (await inspect()).countFromIndex("details", "by-project", [TEST_VIEWER_ID, projectId])).toBe(32);
});

it("enforces the byte budget and accepts an exact 2 MiB row while leaving oversize success unpersisted", async () => {
  const exact = (n: number) => {
    const detail = body(n); const size = bytes(detail);
    return { ...detail, description: "x".repeat(DETAIL_CACHE_LIMITS.recordBytes - size) };
  };
  const details = Array.from({ length: 5 }, (_, index) => exact(index + 1));
  const oversized = { ...body(6), description: "🙂".repeat(DETAIL_CACHE_LIMITS.recordBytes / 4) };
  const scope = await seed([...details, oversized]); const ticket = await scope.beginSync(projectId, signal()); const clock = vi.spyOn(Date, "now");
  expect(bytes(details[0]!)).toBe(DETAIL_CACHE_LIMITS.recordBytes);
  for (const [index, detail] of details.entries()) { clock.mockReturnValue(index + 1); await saveDetail(scope, ticket, detail, signal()); }
  expect(await record(1)).toBeUndefined(); expect(await record(2)).toBeDefined();
  const rows = await (await inspect()).getAllFromIndex("details", "by-project", [TEST_VIEWER_ID, projectId]);
  expect(rows.reduce((sum, row) => sum + row.byteSize, 0)).toBe(DETAIL_CACHE_LIMITS.totalBytes);
  expect(await saveDetail(scope, ticket, oversized, signal())).toMatchObject({ kind: "matching", detail: { description: oversized.description } });
  expect(await record(6)).toBeUndefined();
});

it("rejects captured tickets after snapshot rotation or project invalidation", async () => {
  const detail = body(); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal());
  await scope.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { epoch: "30000000-0000-4000-8000-000000000002", versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
  await expect(saveDetail(scope, ticket, detail, signal())).rejects.toMatchObject({ name: "AbortError" });
  const active = await scope.beginSync(projectId, signal()); await scope.invalidateProject(projectId, signal());
  await expect(saveDetail(scope, active, detail, signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(await record()).toBeUndefined();
});

it("rejects malformed cached PR data before publishing it and clears the corrupted details", async () => {
  const detail = body(); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal()); await saveDetail(scope, ticket, detail, signal());
  const saved = (await record())!;
  const malformed = { ...saved.detail, properties: { ...saved.detail.properties, pullRequests: [{ url: 1, title: "Invalid" }] } };
  await (await inspect()).put("details", { ...saved, detail: malformed, byteSize: detailByteSize(malformed) });
  await expect(readCachedDetail(scope, ticket, detail.id, signal())).rejects.toMatchObject({ category: "corrupt" });
  expect(await record()).toBeUndefined();
  expect(await readCachedDetail(scope, ticket, detail.id, signal())).toBeNull();
});

it("exposes malformed stored records rather than publishing a private body", async () => {
  const detail = body(); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal()); await saveDetail(scope, ticket, detail, signal());
  const saved = (await record())!; await (await inspect()).put("details", { ...saved, byteSize: saved.byteSize + 1 });
  await expect(readCachedDetail(scope, ticket, detail.id, signal())).rejects.toMatchObject({ category: "corrupt" });
  expect(await record()).toBeUndefined();
  expect(await readCachedDetail(scope, ticket, detail.id, signal())).toBeNull();
  await saveDetail(scope, ticket, detail, signal()); expect(await record()).toBeDefined();
});

it("rolls LRU eviction back on quota failure and preserves summaries and watermark for Retry", async () => {
  const details = Array.from({ length: 33 }, (_, index) => body(index + 1)); const scope = await seed(details); const ticket = await scope.beginSync(projectId, signal());
  for (const detail of details.slice(0, 32)) await saveDetail(scope, ticket, detail, signal());
  const { IDBObjectStore } = await import("fake-indexeddb"); const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "details") throw new DOMException("Injected quota", "QuotaExceededError"); return original.apply(this, args);
  });
  await expect(saveDetail(scope, ticket, details[32]!, signal())).rejects.toMatchObject({ category: "storage", cause: { name: "QuotaExceededError" } });
  expect(await record(1)).toBeDefined(); expect(await record(33)).toBeUndefined();
  expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(ticket.maxUpdatedAt);
  fault.mockRestore(); await saveDetail(scope, ticket, details[32]!, signal()); expect(await record(33)).toBeDefined();
});

it("keeps corrupt-detail cleanup atomic when storage fails, then exposes a recoverable original error", async () => {
  const detail = body(); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal()); await saveDetail(scope, ticket, detail, signal());
  const saved = (await record())!; await (await inspect()).put("details", { ...saved, byteSize: saved.byteSize + 1 });
  const { IDBCursor } = await import("fake-indexeddb");
  const fault = vi.spyOn(IDBCursor.prototype, "delete").mockImplementation(function (this: IDBCursor) { throw new DOMException("Injected cleanup failure", "QuotaExceededError"); });
  await expect(readCachedDetail(scope, ticket, detail.id, signal())).rejects.toMatchObject({ category: "storage" }); expect(await record()).toBeDefined();
  fault.mockRestore();
  await expect(readCachedDetail(scope, ticket, detail.id, signal())).rejects.toMatchObject({ category: "corrupt" }); expect(await record()).toBeUndefined();
  expect(await readCachedDetail(scope, ticket, detail.id, signal())).toBeNull();
});


it("treats equivalent timestamp precision as the same intrinsic content", async () => {
  const detail = body(); const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal());
  await saveDetail(scope, ticket, detail, signal()); const first = (await record())!;
  expect(await saveDetail(scope, ticket, { ...detail, updatedAt: detail.updatedAt.replace("Z", ".000000000Z") }, signal())).toMatchObject({ kind: "matching" });
  expect(await record()).toEqual(first);
});

it("checks same-version detail properties against complete summaries while accepting object-key reordering", async () => {
  const detail = body(1, { properties: { future: { first: 1, second: ["a", "b"] }, pullRequests: [] } });
  const scope = await seed([detail]); const ticket = await scope.beginSync(projectId, signal());
  const equivalent = { ...detail, properties: { pullRequests: [], future: { second: ["a", "b"], first: 1 } } };
  await expect(saveDetail(scope, ticket, equivalent, signal())).resolves.toMatchObject({ kind: "matching" });
  const saved = (await record())!;
  await expect(saveDetail(scope, ticket, { ...detail, properties: {} }, signal())).rejects.toMatchObject({ kind: "protocol" });
  expect(await record()).toEqual(saved);
  expect((await scope.beginSync(projectId, signal())).maxUpdatedAt).toBe(ticket.maxUpdatedAt);
});
