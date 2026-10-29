import { IDBObjectStore } from "fake-indexeddb";
import { openDB, type IDBPDatabase } from "idb";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, pauseAuthRequests } from "../src/api/client";
import type { TaskDetail } from "../src/api/types";
import { TASK_CACHE_DATABASE, type TaskCacheSchema } from "../src/features/task-cache/database";
import { createTaskCacheScope, type TaskCacheScope } from "../src/features/task-cache/project-cache";
import { saveDetail } from "../src/features/task-detail/detail-cache";
import { detailFixture, graphFixture } from "./helpers/taskDetail";
import { taskSyncFromGraph, TEST_VIEWER_ID } from "./helpers/taskSync";
const projectId = "10000000-0000-4000-8000-000000000001";
const taskId = "20000000-0000-4000-8000-000000000001";
const signal = () => new AbortController().signal;
const detail = (changes: Partial<TaskDetail> = {}) => detailFixture(projectId, taskId, changes);
const scopes: TaskCacheScope[] = []; const connections: IDBPDatabase<TaskCacheSchema>[] = [];
class Channel {
  static channels = new Set<Channel>(); static messages: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { Channel.channels.add(this); }
  postMessage(value: unknown) { Channel.messages.push(value); for (const peer of Channel.channels) if (peer !== this) queueMicrotask(() => peer.onmessage?.({ data: value } as MessageEvent<unknown>)); }
  close() { Channel.channels.delete(this); }
}
const scope = (userId = TEST_VIEWER_ID) => { const cache = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(cache); return cache; };
const apply = async (cache: TaskCacheScope, value = detail(), snapshot = false) => {
  const ticket = await cache.beginSync(value.projectId, signal());
  return cache.applySync(ticket, taskSyncFromGraph(graphFixture([value]), { query: snapshot || ticket.epoch === null ? {} : { epoch: ticket.epoch }, ...(snapshot ? { epoch: "30000000-0000-4000-8000-000000000002" } : {}), versionForTask: () => value.version }), signal());
};
const inspect = async () => { const connection = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE); connections.push(connection); return connection; };
const failPurge = () => {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "projects" && (args[0] as { state?: string }).state === "invalidated") throw new DOMException("Injected access purge failure", "QuotaExceededError");
    return original.apply(this, args);
  });
};
beforeEach(() => { vi.stubGlobal("BroadcastChannel", Channel); Channel.channels.clear(); Channel.messages = []; });
afterEach(() => { scopes.splice(0).forEach((cache) => cache.dispose()); connections.splice(0).forEach((connection) => connection.close()); });

it("withdraws access synchronously and purges the captured project beyond a view abort", async () => {
  const cache = scope(); const value = detail(); await apply(cache, value); const ticket = await cache.beginSync(projectId, signal()); await saveDetail(cache, ticket, value, signal());
  const events: unknown[] = []; cache.subscribe((event) => events.push(event));
  const reason = new ApiError("server", 404, "not_found", "resource-denied-id");
  const controller = new AbortController(); const revoke = cache.revokeProject(ticket, controller.signal, true, reason);
  expect(events).toContainEqual(expect.objectContaining({ accessRevoked: true, error: reason }));
  expect(cache.getAuthorizedProject(projectId)).toBeNull(); controller.abort(); expect(await revoke).toBe(true);
  const database = await inspect(); expect(await database.get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined(); expect(await database.countFromIndex("summaries", "by-project", [TEST_VIEWER_ID, projectId])).toBe(0);
  await expect(cache.detailTransaction(ticket, signal(), async () => "old")).rejects.toMatchObject({ name: "AbortError" });
  const reset = await cache.beginSync(projectId, signal()); expect(reset.epoch).toBeNull(); expect(reset.cacheGeneration).not.toBe(ticket.cacheGeneration);
});

it("retains local denial after an atomic purge failure and retries storage before issuing a fresh sync ticket", async () => {
  const cache = scope(); const otherProject = detail({ projectId: "10000000-0000-4000-8000-000000000002" }); await apply(cache); await apply(cache, otherProject);
  const ticket = await cache.beginSync(projectId, signal()); await saveDetail(cache, ticket, detail(), signal()); const fault = failPurge();
  await expect(cache.revokeProject(ticket, signal())).rejects.toMatchObject({ category: "storage" }); expect(cache.getAuthorizedProject(projectId)).toBeNull(); expect(cache.getAuthorizedProject(otherProject.projectId)).not.toBeNull();
  expect(cache.canPreviewProject(projectId)).toBe(false); expect(cache.canPreviewProject(otherProject.projectId)).toBe(true);
  await expect(cache.readProject(projectId, signal())).rejects.toMatchObject({ name: "AbortError" }); await expect(cache.beginSync(projectId, signal())).rejects.toMatchObject({ category: "storage" });
  expect(await (await inspect()).get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeDefined();
  await expect(cache.applySync(ticket, taskSyncFromGraph(graphFixture([detail()]), { query: { epoch: ticket.epoch! }, versionForTask: () => 1n }), signal())).rejects.toMatchObject({ name: "AbortError" });
  fault.mockRestore(); const retry = await cache.beginSync(projectId, signal()); expect(retry.epoch).toBeNull(); expect(await (await inspect()).get("details", [TEST_VIEWER_ID, projectId, taskId])).toBeUndefined();
  expect(cache.canPreviewProject(projectId)).toBe(false);
  await apply(cache); expect(cache.getAuthorizedProject(projectId)).not.toBeNull(); expect(cache.canPreviewProject(projectId)).toBe(true);
});

it("ignores an old generation's 404 and negative hint after a new history is admitted", async () => {
  const cache = scope(); await apply(cache); const old = await cache.beginSync(projectId, signal()); await apply(cache, detail({ description: "E2" }), true); const current = cache.getAuthorizedProject(projectId);
  expect(await cache.revokeProject(old, signal())).toBe(false); expect(cache.getAuthorizedProject(projectId)).toBe(current); expect(cache.canPreviewProject(projectId)).toBe(true);
  const injector = new Channel("daynight-task-cache"); injector.postMessage({ userId: TEST_VIEWER_ID, projectId, userFence: old.userFence, revokedGeneration: old.cacheGeneration }); await Promise.resolve();
  expect(cache.getAuthorizedProject(projectId)).toBe(current); injector.close();
});

it("fences a cold peer's in-flight old sync even when both project purges fail", async () => {
  const owner = scope(); await apply(owner); const ticket = await owner.beginSync(projectId, signal()); const peer = scope(); const coldTicket = await peer.beginSync(projectId, signal()); expect(peer.getAuthorizedProject(projectId)).toBeNull();
  const events: unknown[] = []; peer.subscribe((event) => events.push(event)); const fault = failPurge();
  await expect(owner.revokeProject(ticket, signal())).rejects.toMatchObject({ category: "storage" }); await waitFor(() => expect(events.some((event) => (event as { error?: { category?: string } }).error?.category === "storage")).toBe(true));
  await expect(peer.applySync(coldTicket, taskSyncFromGraph(graphFixture([detail()]), { query: { epoch: coldTicket.epoch! }, versionForTask: () => 1n }), signal())).rejects.toMatchObject({ name: "AbortError" });
  await expect(peer.detailTransaction(coldTicket, signal(), async () => "private")).rejects.toMatchObject({ name: "AbortError" }); expect(peer.getAuthorizedProject(projectId)).toBeNull(); fault.mockRestore();
});

it("records negative access evidence while foreground identity checking pauses positive cache work", async () => {
  const cache = scope(); await apply(cache); const ticket = await cache.beginSync(projectId, signal()); const events: unknown[] = []; cache.subscribe((event) => events.push(event)); const resume = pauseAuthRequests();
  const revoke = cache.revokeProject(ticket, signal()); expect(events).toContainEqual(expect.objectContaining({ projectId, accessRevoked: true })); resume(); await revoke;
  expect(cache.getAuthorizedProject(projectId)).toBeNull(); await expect(cache.detailTransaction(ticket, signal(), async () => "private")).rejects.toMatchObject({ name: "AbortError" });
});

it("keeps a newer failed denial's purge descriptor when an older negative hint arrives", async () => {
  const cache = scope(); await apply(cache); const first = await cache.beginSync(projectId, signal()); await apply(cache, detail({ version: 2n }), true); const second = await cache.beginSync(projectId, signal()); const fault = failPurge();
  await expect(cache.revokeProject(second, signal())).rejects.toMatchObject({ category: "storage" });
  const injector = new Channel("daynight-task-cache"); injector.postMessage({ userId: TEST_VIEWER_ID, projectId, userFence: first.userFence, revokedGeneration: first.cacheGeneration }); await Promise.resolve();
  fault.mockRestore(); const retry = await cache.beginSync(projectId, signal()); expect(retry.epoch).toBeNull(); expect(retry.cacheGeneration).not.toBe(second.cacheGeneration); injector.close();
});

it("rejects publication of an in-flight delta that commits after its ticket is revoked", async () => {
  const cache = scope(); await apply(cache); const ticket = await cache.beginSync(projectId, signal()); const value = detail({ version: 2n }); let revoke: Promise<boolean> | null = null; const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "summaries" && revoke === null) revoke = cache.revokeProject(ticket, signal()); return original.apply(this, args);
  });
  await expect(cache.applySync(ticket, taskSyncFromGraph(graphFixture([value]), { query: { epoch: ticket.epoch! }, versionForTask: () => value.version }), signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(revoke).not.toBeNull(); await revoke; expect(cache.getAuthorizedProject(projectId)).toBeNull(); expect(await (await inspect()).countFromIndex("summaries", "by-project", [TEST_VIEWER_ID, projectId])).toBe(0);
});


it("does not return a private detail transaction result if access is withdrawn before its commit completes", async () => {
  const cache = scope(); const value = detail(); await apply(cache); const ticket = await cache.beginSync(projectId, signal()); await saveDetail(cache, ticket, value, signal()); let revoke: Promise<boolean> | null = null;
  await expect(cache.detailTransaction(ticket, signal(), async (store) => {
    const row = await store.get([TEST_VIEWER_ID, projectId, taskId]); revoke = cache.revokeProject(ticket, signal()); return row!.detail;
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(revoke).not.toBeNull(); await revoke; expect(cache.getAuthorizedProject(projectId)).toBeNull();
});
