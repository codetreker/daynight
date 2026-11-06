import { IDBObjectStore, IDBTransaction } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as client from '../src/api/client';
import { pauseAuthRequests } from '../src/api/client';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { createTaskCacheScope, type CacheEvent, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const signal = () => new AbortController().signal;
const scopes: TaskCacheScope[] = [], connections: IDBPDatabase<TaskCacheSchema>[] = [];
class Channel {
  static channels: Channel[] = [];
  static messages: unknown[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { Channel.channels.push(this); }
  postMessage(value: unknown) { Channel.messages.push(value); }
  close() { Channel.channels = Channel.channels.filter(channel => channel !== this); }
}
const scope = () => { const result = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(result); return result; };
const apply = async (cache: TaskCacheScope) => {
  const detail = detailFixture(projectId, taskId), ticket = await cache.beginSync(projectId, signal());
  await cache.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { query: ticket.epoch === null ? {} : { epoch: ticket.epoch }, versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
};
const database = async () => { const result = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); connections.push(result); return result; };
const corruptHistory = async (db: IDBPDatabase<TaskCacheSchema>) => {
  const row = await db.get('projects', [TEST_VIEWER_ID, projectId]);
  await db.put('projects', { ...row!, generationAncestors: null as unknown as string[] });
};
const corruptGeneration = async (db: IDBPDatabase<TaskCacheSchema>) => {
  const row = await db.get('projects', [TEST_VIEWER_ID, projectId]);
  await db.put('projects', { ...row!, cacheGeneration: 'invalid' });
};
const negative = () => {
  const hint = Channel.messages.findLast(value => typeof value === 'object' && value !== null && 'revokedGeneration' in value);
  expect(hint).toBeDefined();
  return hint;
};
const deliver = (index: number, hint: unknown) => Channel.channels[index]!.onmessage?.({ data: hint } as MessageEvent<unknown>);
const failPurge = () => {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'projects' && (args[0] as { state?: string }).state === 'invalidated') throw new DOMException('Injected cleanup failure', 'QuotaExceededError');
    return original.apply(this, args);
  });
};
beforeEach(() => { Channel.channels = []; Channel.messages = []; vi.stubGlobal('BroadcastChannel', Channel); });
afterEach(() => { vi.restoreAllMocks(); scopes.splice(0).forEach(cache => cache.dispose()); connections.splice(0).forEach(connection => connection.close()); vi.unstubAllGlobals(); });

it('ignores a delayed incomparable negative hint after fresh access has been admitted', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptHistory(db);
  const old = await owner.beginSync(projectId, signal()); expect(old.unknownAncestors).toBe(true);
  await owner.revokeProject(old, signal()); const hint = negative();
  // A second corruption removes the old link; the new generation is admitted by a fresh sync.
  await corruptHistory(db); await apply(peer);
  const fresh = peer.getAuthorizedProject(projectId); expect(fresh).not.toBeNull();
  const snapshot = await peer.prepareProjection(signal()), events: CacheEvent[] = [];
  peer.subscribeProjection(event => events.push(event)); deliver(1, hint);
  await peer.prepareProjection(signal());
  expect(peer.getAuthorizedProject(projectId)).toBe(fresh);
  expect(events.some(event => event.accessRevoked && peer.projectionEventMatches(snapshot, event))).toBe(false);
});

it('withdraws an older visible generation when an incomparable denial still owns durable storage', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const oldVisible = peer.getAuthorizedProject(projectId)!; const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); expect(denied.unknownAncestors).toBe(true);
  expect(denied.generationAncestors).not.toContain(oldVisible.manifest.cacheGeneration);
  await owner.revokeProject(denied, signal()); const hint = negative();
  deliver(1, hint);
  await vi.waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
  expect(peer.canPreviewProject(projectId)).toBe(false);
});

it('retains the denial and reports a cleanup failure until a later retry succeeds', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); expect(denied.unknownAncestors).toBe(true);
  const events: CacheEvent[] = []; peer.subscribeProjection(event => events.push(event));
  const fault = failPurge(); await expect(owner.revokeProject(denied, signal())).rejects.toMatchObject({ category: 'storage' });
  deliver(1, negative());
  await vi.waitFor(() => expect(events.some(event => event.error !== undefined && (event.error as { category?: string }).category === 'storage')).toBe(true));
  expect(peer.getAuthorizedProject(projectId)).toBeNull(); expect(peer.canPreviewProject(projectId)).toBe(false);
  fault.mockRestore();
  const fresh = await peer.beginSync(projectId, signal()); expect(fresh.cacheGeneration).not.toBe(denied.cacheGeneration);
  await apply(peer); expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
});


it('withdraws an incomparable denial while foreground identity admission is paused', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const snapshot = await peer.prepareProjection(signal()), db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); expect(denied.unknownAncestors).toBe(true);
  await owner.revokeProject(denied, signal());
  const events: CacheEvent[] = []; peer.subscribeProjection(event => events.push(event));
  const resume = pauseAuthRequests();
  try {
    deliver(1, negative());
    expect(events.some(event => event.accessRevoked && peer.projectionEventMatches(snapshot, event))).toBe(true);
  } finally { resume(); }
  await vi.waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
});


it('restores a fresh incomparable admission after an old hint is checked following an identity pause', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptHistory(db);
  const old = await owner.beginSync(projectId, signal()); await owner.revokeProject(old, signal()); const hint = negative();
  await corruptHistory(db); await apply(peer);
  const fresh = peer.getAuthorizedProject(projectId), snapshot = await peer.prepareProjection(signal()), events: CacheEvent[] = [];
  expect(fresh).not.toBeNull(); peer.subscribeProjection(event => events.push(event));
  const resume = pauseAuthRequests();
  try {
    deliver(1, hint);
    expect(events.some(event => event.accessRevoked && peer.projectionEventMatches(snapshot, event))).toBe(true);
  } finally { resume(); }
  await peer.prepareProjection(signal());
  expect(peer.getAuthorizedProject(projectId)).toBe(fresh);
  expect(events.some(event => event.accessRestored && event.projectId === projectId)).toBe(true);
});


it.each(['current denial', 'obsolete denial', 'scope invalidated'] as const)('resumes an interrupted durable check for %s', async scenario => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  let snapshot = await peer.prepareProjection(signal());
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); expect(denied.unknownAncestors).toBe(true);
  await owner.revokeProject(denied, signal()); const hint = negative();
  if (scenario === 'obsolete denial') { await corruptGeneration(db); await apply(peer); snapshot = await peer.prepareProjection(signal()); }
  const admitted = peer.getAuthorizedProject(projectId); expect(admitted).not.toBeNull();
  const events: CacheEvent[] = [];
  peer.subscribeProjection(event => events.push(event));
  const gotRead = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>();
  let resumeSecond: (() => void) | undefined, invalidation: Promise<void> | undefined, armed = true;
  const get = IDBObjectStore.prototype.get, abort = IDBTransaction.prototype.abort;
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = get.apply(this, args);
    if (this.name === 'projects' && armed) {
      armed = false;
      request.addEventListener('success', () => { resumeSecond = pauseAuthRequests(); gotRead.resolve(); }, { once: true });
    }
    return request;
  });
  vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation(function (this: IDBTransaction) {
    try { return abort.call(this); } finally { aborted.resolve(); }
  });
  const resumeFirst = pauseAuthRequests();
  try {
    deliver(1, hint);
    expect(peer.isProjectSuspended(projectId)).toBe(true);
    expect(events.some(event => event.accessRevoked && peer.projectionEventMatches(snapshot, event))).toBe(true);
    resumeFirst(); await gotRead.promise; await aborted.promise;
    expect(peer.isProjectSuspended(projectId)).toBe(true);
    expect(events.some(event => event.accessRestored)).toBe(false);
    if (scenario === 'scope invalidated') invalidation = peer.invalidateScope();
  } finally { resumeFirst(); resumeSecond?.(); }
  if (invalidation !== undefined) {
    await invalidation; expect(peer.isInvalidated).toBe(true);
    expect(events.some(event => event.accessRestored)).toBe(false); return;
  }
  await vi.waitFor(() => expect(peer.isProjectSuspended(projectId)).toBe(false));
  if (scenario === 'current denial') {
    expect(peer.getAuthorizedProject(projectId)).toBeNull(); expect(peer.canPreviewProject(projectId)).toBe(false);
  } else {
    expect(peer.getAuthorizedProject(projectId)).toBe(admitted);
    expect(events.some(event => event.accessRestored && event.projectId === projectId)).toBe(true);
  }
});

it.each(['current denial', 'obsolete denial', 'scope invalidated'] as const)('isolates an in-flight unknown hint on a later identity pause for %s', async scenario => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  let snapshot = await peer.prepareProjection(signal());
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal()); const hint = negative();
  if (scenario === 'obsolete denial') { await corruptGeneration(db); await apply(peer); snapshot = await peer.prepareProjection(signal()); }
  const admitted = peer.getAuthorizedProject(projectId); expect(admitted).not.toBeNull();
  const events: CacheEvent[] = []; peer.subscribeProjection(event => events.push(event));
  const unsubscribed = vi.fn(), subscribe = client.subscribeAuthPause;
  vi.spyOn(client, 'subscribeAuthPause').mockImplementation(listener => { const unsubscribe = subscribe(listener); return () => { unsubscribe(); unsubscribed(); }; });
  const read = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const aborted = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const resumes: (() => void)[] = []; let readCount = 0, abortCount = 0, invalidation: Promise<void> | undefined;
  const get = IDBObjectStore.prototype.get, abort = IDBTransaction.prototype.abort;
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = get.apply(this, args);
    if (this.name === 'projects' && readCount < 2) {
      const index = readCount++;
      request.addEventListener('success', () => { resumes[index] = pauseAuthRequests(); read[index]!.resolve(); }, { once: true });
    }
    return request;
  });
  vi.spyOn(IDBTransaction.prototype, 'abort').mockImplementation(function (this: IDBTransaction) {
    try { return abort.call(this); } finally { aborted[abortCount++]?.resolve(); }
  });
  try {
    deliver(1, hint); await read[0]!.promise;
    expect(peer.isProjectSuspended(projectId)).toBe(true);
    expect(events.some(event => event.accessRevoked && peer.projectionEventMatches(snapshot, event))).toBe(true);
    await aborted[0]!.promise;
    if (scenario === 'scope invalidated') invalidation = peer.invalidateScope();
    else {
      resumes[0]!(); await read[1]!.promise;
      expect(peer.isProjectSuspended(projectId)).toBe(true);
      expect(events.some(event => event.accessRestored)).toBe(false);
      await aborted[1]!.promise;
    }
  } finally { for (const resume of resumes) resume?.(); }
  if (invalidation !== undefined) {
    await invalidation; expect(peer.isInvalidated).toBe(true);
    await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledOnce());
    const count = events.length, resume = pauseAuthRequests(); resume();
    expect(events).toHaveLength(count); return;
  }
  await vi.waitFor(() => expect(peer.isProjectSuspended(projectId)).toBe(false));
  if (scenario === 'current denial') {
    expect(peer.getAuthorizedProject(projectId)).toBeNull(); expect(peer.canPreviewProject(projectId)).toBe(false);
  } else {
    expect(peer.getAuthorizedProject(projectId)).toBe(admitted);
    expect(events.some(event => event.accessRestored)).toBe(true);
  }
  await vi.waitFor(() => expect(unsubscribed).toHaveBeenCalledOnce());
  const count = events.length, resume = pauseAuthRequests(); resume();
  expect(events).toHaveLength(count);
});
