import { IDBObjectStore } from "fake-indexeddb";
import { openDB, type IDBPDatabase } from "idb";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, pauseAuthRequests } from "../src/api/client";
import type { TaskDetail } from "../src/api/types";
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from "../src/features/task-cache/database";
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
  return cache.applySync(ticket, taskSyncFromGraph(graphFixture([value]), { query: snapshot || ticket.epoch === null ? {} : { epoch: ticket.epoch }, ...(snapshot ? { epoch: "30000000-0000-4000-8000-000000000002" } : {}), versionForTask: () => value.version, propertiesForTask: () => value.properties }), signal());
};
const inspect = async () => { const connection = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); connections.push(connection); return connection; };
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
  await expect(cache.applySync(ticket, taskSyncFromGraph(graphFixture([value]), { query: { epoch: ticket.epoch! }, versionForTask: () => value.version, propertiesForTask: () => value.properties }), signal())).rejects.toMatchObject({ name: "AbortError" });
  expect(revoke).not.toBeNull(); await revoke; expect(cache.getAuthorizedProject(projectId)).toBeNull(); expect(await (await inspect()).countFromIndex("summaries", "by-project", [TEST_VIEWER_ID, projectId])).toBe(0);
});


it("does not return a private detail transaction result if access is withdrawn before its commit completes", async () => {
  const cache = scope(); const value = detail(); await apply(cache); const ticket = await cache.beginSync(projectId, signal()); await saveDetail(cache, ticket, value, signal()); let revoke: Promise<boolean> | null = null;
  await expect(cache.detailTransaction(ticket, signal(), async (store) => {
    const row = await store.get([TEST_VIEWER_ID, projectId, taskId]); revoke = cache.revokeProject(ticket, signal()); return row!.detail;
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(revoke).not.toBeNull(); await revoke; expect(cache.getAuthorizedProject(projectId)).toBeNull();
});

it('fences old in-flight cache publication synchronously on a negative hint', async () => {
  const owner = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  const peer = scope(); const cold = await peer.beginSync(projectId, signal());
  const injector = new Channel('daynight-task-cache'); const original = IDBObjectStore.prototype.put;
  let sent = false;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'summaries' && !sent) { sent = true; injector.postMessage({ userId: TEST_VIEWER_ID, projectId, userFence: old.userFence, revokedGeneration: old.cacheGeneration }); }
    return original.apply(this, args);
  });
  const changed = detail({ version: 2n });
  await expect(peer.applySync(cold, taskSyncFromGraph(graphFixture([changed]), { query: { epoch: cold.epoch! }, versionForTask: () => 2n }), signal())).rejects.toMatchObject({ name: 'AbortError' });
  expect(peer.getAuthorizedProject(projectId)).toBeNull();
  injector.close();
});

it('does not withdraw a fresh independent observation on a delayed older denial', async () => {
  const owner = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  await owner.revokeProject(old, signal(), false);
  await apply(owner);
  const peer = scope(); const captured = await peer.prepareProjection(signal());
  expect(captured.get(projectId)).not.toBe(old.cacheGeneration);
  const events: import('../src/features/task-cache/project-cache').CacheEvent[] = [];
  peer.subscribeProjection(event => events.push(event));
  const injector = new Channel('daynight-task-cache');
  injector.postMessage({ userId: TEST_VIEWER_ID, projectId, userFence: old.userFence, revokedGeneration: old.cacheGeneration,
    generationAncestors: old.generationAncestors ?? [], unknownAncestors: old.unknownAncestors ?? false });
  await Promise.resolve();
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(event => !peer.projectionEventMatches(captured, event))).toBe(true);
  injector.close();
});

it('withdraws an older independent observation after a real snapshot replacement and later denial', async () => {
  const owner = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  const peer = scope(); const captured = await peer.prepareProjection(signal()); expect(captured.get(projectId)).toBe(old.cacheGeneration);
  const events: unknown[] = []; peer.subscribeProjection((event) => events.push(event));
  await apply(owner, detail({ description: 'new snapshot' }), true);
  const replacement = await owner.beginSync(projectId, signal()); expect(replacement.cacheGeneration).not.toBe(old.cacheGeneration);
  await owner.revokeProject(replacement, signal());
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ accessRevoked: true, revokedGeneration: old.cacheGeneration })));
});

it('isolates an invalid project generation without blocking other independent projections', async () => {
  const cache = scope(); await cache.beginSync(projectId, signal());
  const database = await inspect(); const row = await database.get('projects', [TEST_VIEWER_ID, projectId]);
  await database.put('projects', { ...row!, cacheGeneration: 'invalid' });
  const snapshot = await cache.prepareProjection(signal());
  expect(snapshot.has(projectId)).toBe(false);
  expect(cache.isProjectionDenied(projectId)).toBe(true);
  expect(cache.isProjectionDenied('10000000-0000-4000-8000-000000000099')).toBe(false);
  expect(cache.projectionError).toMatchObject({ category: 'corrupt' });
});

it('recovers generation ancestry from durable state when the replacement hint was lost', async () => {
  const owner = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  const peer = scope(); const captured = await peer.prepareProjection(signal()); const events: unknown[] = [];
  peer.subscribeProjection(event => events.push(event));
  const muted = vi.spyOn(Channel.prototype, 'postMessage').mockImplementation(() => {});
  await apply(owner, detail({ description: 'replacement' }), true); muted.mockRestore();
  const reader = scope(); const newer = await reader.beginSync(projectId, signal());
  expect(newer.generationAncestors).toContain(old.cacheGeneration);
  await reader.revokeProject(newer, signal());
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ accessRevoked: true, revokedGeneration: captured.get(projectId) })));
});

it('withdraws an older local projection when a current descendant is denied', async () => {
  const owner = scope(); await apply(owner);
  const peer = scope(); await apply(peer);
  const old = peer.getAuthorizedProject(projectId)!;
  const muted = vi.spyOn(Channel.prototype, 'postMessage').mockImplementation(() => {});
  await apply(owner, detail({ description: 'replacement' }), true);
  muted.mockRestore();
  const ticket = await peer.beginSync(projectId, signal());
  expect(ticket.generationAncestors).toContain(old.manifest.cacheGeneration);
  expect(peer.canRevokeProject(ticket)).toBe(true);
  await peer.revokeProject(ticket, signal());
  expect(peer.getAuthorizedProject(projectId)).toBeNull();
});

it('isolates an unknown corrupted predecessor while protecting a later admitted history', async () => {
  const owner = scope(); await apply(owner);
  const peer = scope(); await peer.readProject(projectId, signal());
  const old = await peer.prepareProjection(signal()); const events: import('../src/features/task-cache/project-cache').CacheEvent[] = [];
  peer.subscribeProjection(event => events.push(event)); const ordinary: unknown[] = []; peer.subscribe(event => ordinary.push(event));
  const db = await inspect(); const row = await db.get('projects', [TEST_VIEWER_ID, projectId]);
  await db.put('projects', { ...row!, cacheGeneration: 'invalid' });
  const repaired = await owner.beginSync(projectId, signal()); expect(repaired.unknownAncestors).toBe(true);
  await owner.revokeProject(repaired, signal());
  await waitFor(() => expect(events.some(event => event.unknownAncestors && peer.projectionEventMatches(old, event))).toBe(true));
  expect(ordinary).toContainEqual(expect.objectContaining({ accessRevoked: true }));
  const fresh = await peer.prepareProjection(signal());
  const event = events.find(item => item.unknownAncestors)!;
  expect(peer.projectionEventMatches(fresh, event)).toBe(false);
});

it('withdraws a cold Session history preview immediately when another tab denies its generation', async () => {
  const owner = scope(); await apply(owner); const ownerTicket = await owner.beginSync(projectId, signal());
  const peer = scope(); const previewTicket = await peer.beginSync(projectId, signal());
  expect(await peer.sessionHistoryTransaction(previewTicket, signal(), async () => 'private history')).toBe('private history');
  expect(peer.getAuthorizedProject(projectId)).toBeNull();
  expect(peer.isSessionHistoryTicketCurrent(previewTicket)).toBe(true);
  const events: unknown[] = []; peer.subscribe(event => events.push(event));
  const revoke = owner.revokeProject(ownerTicket, signal());
  await Promise.resolve();
  expect(events).toContainEqual(expect.objectContaining({ projectId, accessRevoked: true }));
  expect(peer.isSessionHistoryTicketCurrent(previewTicket)).toBe(false);
  await expect(peer.sessionHistoryTransaction(previewTicket, signal(), async () => 'private history')).rejects.toMatchObject({ name: 'AbortError' });
  await revoke;
});

it('preserves a newer Session history preview when an older denial hint arrives', async () => {
  const owner = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  await apply(owner, detail({ description: 'new history' }), true);
  const peer = scope(); const previewTicket = await peer.beginSync(projectId, signal());
  expect(previewTicket.cacheGeneration).not.toBe(old.cacheGeneration);
  await peer.sessionHistoryTransaction(previewTicket, signal(), async () => 'new history');
  const events: unknown[] = []; peer.subscribe(event => events.push(event));
  const injector = new Channel('daynight-task-cache');
  injector.postMessage({ userId: TEST_VIEWER_ID, projectId, userFence: old.userFence, revokedGeneration: old.cacheGeneration });
  await Promise.resolve();
  expect(peer.isSessionHistoryTicketCurrent(previewTicket)).toBe(true);
  expect(events).not.toContainEqual(expect.objectContaining({ projectId, accessRevoked: true }));
  injector.close();
});

it('rejects a denial from before project suspension after the project resumes', async () => {
  const cache = scope(); await apply(cache); const old = await cache.beginSync(projectId, signal());
  cache.suspendProject(projectId);
  const suspended = await cache.prepareProjection(signal());
  expect(cache.projectionSnapshotDenied(suspended, projectId)).toBe(true);
  cache.resumeProject(projectId);
  expect(cache.projectionSnapshotDenied(suspended, projectId)).toBe(true);
  expect(cache.projectionSnapshotDenied(await cache.prepareProjection(signal()), projectId)).toBe(false);
  expect(cache.canPreviewProject(projectId)).toBe(false);
  expect(cache.canRevokeProject(old)).toBe(false);
  expect(await cache.revokeProject(old, signal())).toBe(false);
  const current = await cache.beginSync(projectId, signal());
  expect(current.scopeRevision).not.toBe(old.scopeRevision);
  expect(cache.canRevokeProject(current)).toBe(true);
  await apply(cache);
  expect(cache.canPreviewProject(projectId)).toBe(true);
});

it('retains the predecessor when Session history marker cleanup rotates a project generation', async () => {
  const owner = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  const peer = scope(); const captured = await peer.prepareProjection(signal()); const events: unknown[] = [];
  peer.subscribeProjection(event => events.push(event));
  await owner.sessionHistoryTransaction(old, signal(), async store => {
    await store.put({ userId: TEST_VIEWER_ID, projectId, taskId, userFence: old.userFence, cacheGeneration: old.cacheGeneration,
      requestToken: '30000000-0000-4000-8000-000000000081', clearedToken: '30000000-0000-4000-8000-000000000082',
      leaseExpiresAt: null, settled: 'cancelled', paginationToken: null, page: null, confirmedCompleteEmpty: false,
      observedNonEmpty: false, byteSize: 0, lastUsedAt: Date.now() });
  });
  expect(await owner.rotateSessionHistoryGeneration(old, 1, signal())).toBe(true);
  const replacement = await owner.beginSync(projectId, signal());
  expect(replacement.generationAncestors).toContain(old.cacheGeneration);
  await owner.revokeProject(replacement, signal());
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining({ accessRevoked: true, revokedGeneration: captured.get(projectId) })));
});

it('retains the denied durable generation for retry when a peer displays its ancestor', async () => {
  const owner = scope(); await apply(owner);
  const peer = scope(); await apply(peer);
  const displayed = peer.getAuthorizedProject(projectId)!;
  await apply(owner, detail({ description: 'new history' }), true);
  const denied = await owner.beginSync(projectId, signal());
  expect(denied.generationAncestors).toContain(displayed.manifest.cacheGeneration);
  const events: unknown[] = []; peer.subscribeProjection(event => events.push(event));
  const fault = failPurge();
  await expect(owner.revokeProject(denied, signal())).rejects.toMatchObject({ category: 'storage' });
  await waitFor(() => expect(events.some(event => (event as { error?: { category?: string } }).error?.category === 'storage')).toBe(true));
  fault.mockRestore();
  const fresh = await peer.beginSync(projectId, signal());
  expect(fresh.cacheGeneration).not.toBe(denied.cacheGeneration);
  await expect(peer.applySync(fresh, taskSyncFromGraph(graphFixture([detail()]), { query: {}, versionForTask: () => 1n }), signal())).resolves.toBeDefined();
});

it('treats a null ancestry as corruption and withdraws incomparable older projections', async () => {
  const owner = scope(); await apply(owner);
  const peer = scope(); const captured = await peer.prepareProjection(signal());
  await apply(owner, detail({ description: 'new history' }), true);
  const db = await inspect(); const row = await db.get('projects', [TEST_VIEWER_ID, projectId]);
  await db.put('projects', { ...row!, generationAncestors: null as unknown as string[] });
  const corrupt = await peer.prepareProjection(signal());
  expect(peer.projectionSnapshotDenied(corrupt, projectId)).toBe(true);
  const events: import('../src/features/task-cache/project-cache').CacheEvent[] = []; peer.subscribeProjection(event => events.push(event));
  const recovered = await owner.beginSync(projectId, signal());
  expect(recovered.unknownAncestors).toBe(true);
  await owner.revokeProject(recovered, signal());
  await waitFor(() => expect(events.some(event => event.unknownAncestors && peer.projectionEventMatches(captured, event))).toBe(true));
});

it('rejects an incomparable old denial after the same scope admits a restored history', async () => {
  const cache = scope(); await apply(cache);
  const db = await inspect(); const current = await db.get('projects', [TEST_VIEWER_ID, projectId]);
  await db.put('projects', { ...current!, cacheGeneration: 'invalid' });
  const old = await cache.beginSync(projectId, signal()); expect(old.unknownAncestors).toBe(true);
  const baseline = await db.get('projects', [TEST_VIEWER_ID, projectId]);
  await db.put('projects', { ...baseline!, cacheGeneration: crypto.randomUUID(), generationAncestors: [], unknownAncestors: false });
  await apply(cache);
  const admitted = cache.getAuthorizedProject(projectId);
  expect(admitted).not.toBeNull();
  expect(cache.canRevokeProject(old)).toBe(false);
  expect(await cache.revokeProject(old, signal())).toBe(false);
  expect(cache.getAuthorizedProject(projectId)).toBe(admitted);
});
