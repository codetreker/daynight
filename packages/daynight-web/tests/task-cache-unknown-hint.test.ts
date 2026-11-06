import { IDBObjectStore, IDBTransaction } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as client from '../src/api/client';
import { pauseAuthRequests } from '../src/api/client';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, TaskCacheError, type TaskCacheSchema } from '../src/features/task-cache/database';
import { createTaskCacheScope, type CacheEvent, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { directAccessFixture, taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { wireResponse } from './helpers/wireJson';

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

it('fences direct task reads during an unknown withdrawal and permits healthy projects', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const old = await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
  const hint = negative(), resume = pauseAuthRequests();
  try {
    deliver(1, hint);
    expect(peer.isProjectSuspended(projectId)).toBe(true);
    expect(peer.isTaskReadCurrent(old, true)).toBe(false);
    expect(peer.isTaskHistoryPossiblyCurrent(old)).toBe(true);
    expect(peer.captureTaskHistoryFence(projectId, taskId, 1, 2)).toBeNull();
  } finally { resume(); }
  await peer.prepareProjection(signal());
  expect(peer.isTaskReadCurrent(old, true)).toBe(false);
  const healthyProject = '10000000-0000-4000-8000-000000000002';
  const healthy = await peer.beginTaskRead(healthyProject, taskId, 1, 1, signal());
  expect(peer.isTaskReadCurrent(healthy)).toBe(true);
});

it('refuses direct readmission while withdrawal cleanup fails and accepts a fresh observation after recovery', async () => {
  const cache = scope(); await apply(cache);
  const old = await cache.beginTaskRead(projectId, taskId, 1, 1, signal());
  const ticket = await cache.beginSync(projectId, signal()), fault = failPurge();
  await expect(cache.revokeProject(ticket, signal())).rejects.toMatchObject({ category: 'storage' });
  expect(cache.isTaskReadCurrent(old, true)).toBe(false);
  await expect(cache.beginTaskRead(projectId, taskId, 1, 2, signal())).rejects.toMatchObject({ category: 'storage' });
  fault.mockRestore();
  const fresh = await cache.beginTaskRead(projectId, taskId, 2, 1, signal());
  expect(cache.isTaskReadCurrent(old, true)).toBe(false);
  expect(cache.isTaskReadCurrent(fresh)).toBe(true);
  expect(await cache.observeHistory(fresh, ticket.epoch!, signal())).toBe('current');
});

it('preserves a committed access tombstone when an older history purge resumes', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const denied = await owner.beginSync(projectId, signal());
  const first = await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  expect(await peer.observeHistory(first, denied.epoch!, signal())).toBe('current');
  const next = await peer.beginTaskRead(projectId, taskId, 1, 2, signal());
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const original = Reflect.get(peer, 'ensureHistoryPurged').bind(peer);
  const intercept = vi.spyOn(peer as unknown as { ensureHistoryPurged: (id: string) => Promise<void> }, 'ensureHistoryPurged').mockImplementation(id => {
    started.resolve(); return finish.promise.then(() => original(id));
  });
  const retirement = peer.observeHistory(next, '30000000-0000-4000-8000-000000000022', signal());
  try {
    await started.promise;
    expect(await owner.revokeProject(denied, signal(), false)).toBe(true);
    const db = await database(), before = await db.get('projects', [TEST_VIEWER_ID, projectId]);
    expect(before).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' });
    expect(before?.generationAncestors?.[0]).toBe(denied.cacheGeneration);
    finish.resolve(); expect(await retirement).toBe('retired');
    expect(await db.get('projects', [TEST_VIEWER_ID, projectId])).toEqual(before);
  } finally { finish.resolve(); intercept.mockRestore(); }
});

it('keeps a fresh direct GET when an older denial hint arrives after the committed tombstone', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal());
  const denied = await owner.beginSync(projectId, signal());
  expect(await owner.revokeProject(denied, signal())).toBe(true); const hint = negative();
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  const events: CacheEvent[] = []; peer.subscribeProjection(event => events.push(event));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/access')
    ? wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
    : wireResponse(detailFixture(projectId, taskId, { title: 'Fresh direct task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } })));
  try {
    sessions.openDirect(projectId, taskId);
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Fresh direct task'));
    deliver(1, hint); await peer.prepareProjection(signal());
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Fresh direct task'));
    expect(events.some(event => event.accessRevoked && event.revokedGeneration === denied.cacheGeneration)).toBe(true);
    expect(peer.isProjectSuspended(projectId)).toBe(false);
  } finally { sessions.dispose(); }
});

it('does not publish an in-flight old direct GET after a new durable withdrawal', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal());
  const denied = await owner.beginSync(projectId, signal()), pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
  vi.stubGlobal('fetch', fetcher);
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await owner.revokeProject(denied, signal());
    pending.resolve(wireResponse(detailFixture(projectId, taskId, { title: 'Old private task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } }));
    await vi.waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1));
    expect(sessions.snapshot(projectId, taskId).detail).toBeNull();
    deliver(1, negative()); await peer.prepareProjection(signal()); expect(sessions.snapshot(projectId, taskId).detail).toBeNull();
  } finally { sessions.dispose(); }
});

it('still withdraws an admitted direct GET when the denial is new', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal());
  const denied = await owner.beginSync(projectId, signal());
  let revoked = false;
  vi.stubGlobal('fetch', vi.fn(async () => revoked
    ? wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
    : wireResponse(detailFixture(projectId, taskId, { title: 'Initially authorized' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } })));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Initially authorized'));
    await owner.revokeProject(denied, signal()); revoked = true; deliver(1, negative());
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail).toBeNull());
  } finally { sessions.dispose(); }
});

it('rechecks a second denial for the same generation after fresh direct admission', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal());
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal()); const hint = negative();
  let revoked = false, accessReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/access')) {
      accessReads++;
      return revoked ? wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
        : wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    }
    return wireResponse(detailFixture(projectId, taskId, { title: 'Reauthorized task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } });
  }));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Reauthorized task'));
    deliver(1, hint); await vi.waitFor(() => expect(accessReads).toBe(1));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Reauthorized task'));
    revoked = true; deliver(1, hint);
    await vi.waitFor(() => expect(accessReads).toBe(2));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail).toBeNull());
  } finally { sessions.dispose(); }
});

it('rechecks a real denial from an older generation while a newer graph and direct view coexist', async () => {
  const owner = scope(), peer = scope(); await apply(owner); const old = await owner.beginSync(projectId, signal());
  const replacement = await peer.beginSync(projectId, signal());
  const newEpoch = '30000000-0000-4000-8000-000000000022';
  await peer.applySync(replacement, taskSyncFromGraph(graphFixture([detailFixture(projectId, taskId)]), { query: {}, epoch: newEpoch, versionForTask: () => 1n }), signal());
  let revoked = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (revoked) return wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    return url.endsWith('/access') ? wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
      : wireResponse(detailFixture(projectId, taskId, { title: 'New graph task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': newEpoch } });
  }));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('New graph task'));
    expect(await owner.revokeProject(old, signal())).toBe(true); revoked = true; deliver(1, negative());
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail).toBeNull());
    await vi.waitFor(() => expect(peer.getAuthorizedProject(projectId)).toBeNull());
  } finally { sessions.dispose(); }
});

it('purges the matching durable generation when the sender cleanup failed and direct reads coexist', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  const denied = await owner.beginSync(projectId, signal()), fault = failPurge();
  await expect(owner.revokeProject(denied, signal())).rejects.toMatchObject({ category: 'storage' });
  fault.mockRestore();
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  try {
    deliver(1, negative());
    const db = await database();
    await vi.waitFor(async () => expect(await db.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' }));
    const tombstone = await db.get('projects', [TEST_VIEWER_ID, projectId]);
    expect(tombstone?.generationAncestors?.[0]).toBe(denied.cacheGeneration);
    const cold = scope(); expect(await cold.readProject(projectId, signal())).toBeNull();
  } finally { pending.resolve(wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })); }
});

it('purges a confirmed unknown denial after sender cleanup fails with an incomparable direct graph', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const epoch = peer.getAuthorizedProject(projectId)!.manifest.epoch!;
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(detailFixture(projectId, taskId, { title: 'Private task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': epoch } })));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  const events: CacheEvent[] = []; peer.subscribe(event => events.push(event));
  try {
    sessions.openDirect(projectId, taskId);
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Private task'));
    const db = await database(); await corruptGeneration(db);
    const denied = await owner.beginSync(projectId, signal()), fault = failPurge();
    expect(denied.unknownAncestors).toBe(true);
    await expect(owner.revokeProject(denied, signal())).rejects.toMatchObject({ category: 'storage' });
    fault.mockRestore(); const offline = vi.fn(async () => { throw new Error('offline'); }); vi.stubGlobal('fetch', offline);
    deliver(1, negative());
    await vi.waitFor(async () => expect(await db.get('projects', [TEST_VIEWER_ID, projectId])).toMatchObject({ state: 'invalidated', invalidatedBy: 'access' }));
    const tombstone = await db.get('projects', [TEST_VIEWER_ID, projectId]);
    expect(tombstone?.generationAncestors?.[0]).toBe(denied.cacheGeneration);
    await vi.waitFor(() => expect(events.some(event => event.directAccessRecheck && event.error !== undefined)).toBe(true));
    expect(offline).toHaveBeenCalled();
    expect(peer.getAuthorizedProject(projectId)).toBeNull();
    expect(sessions.snapshot(projectId, taskId)).toMatchObject({ status: 'error', detail: null });
  } finally { sessions.dispose(); }
});

it('hides an incomparable graph and direct view when an unknown hint cannot read durable state', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const epoch = peer.getAuthorizedProject(projectId)!.manifest.epoch!;
  let offline = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (offline) throw new Error('offline');
    return url.endsWith('/access')
      ? wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
      : wireResponse(detailFixture(projectId, taskId, { title: 'Private task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': epoch } });
  }));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  const events: CacheEvent[] = []; peer.subscribe(event => events.push(event));
  try {
    sessions.openDirect(projectId, taskId);
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Private task'));
    const db = await database(); await corruptGeneration(db);
    const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
    const internals = peer as unknown as { userTransaction: (...args: unknown[]) => Promise<unknown> };
    const original = internals.userTransaction.bind(peer); let storageFailed = true;
    vi.spyOn(internals, 'userTransaction').mockImplementation((...args) => storageFailed ? Promise.reject(new TaskCacheError('storage')) : original(...args));
    offline = true; deliver(1, negative());
    await vi.waitFor(() => expect(events.some(event => event.accessRevoked && (event.error as { category?: string } | undefined)?.category === 'storage')).toBe(true));
    expect(peer.getAuthorizedProject(projectId)).toBeNull();
    expect(peer.canPreviewProject(projectId)).toBe(false);
    expect(sessions.snapshot(projectId, taskId).detail).toBeNull();
    const healthy = await peer.beginTaskRead('10000000-0000-4000-8000-000000000002', taskId, 1, 1, signal());
    expect(peer.isTaskReadCurrent(healthy)).toBe(true);
    storageFailed = false;
    await vi.waitFor(() => expect(events.some(event => event.directAccessRecheck && event.error !== undefined)).toBe(true));
    expect(peer.canPreviewProject(projectId)).toBe(false);
    offline = false; sessions.openDirect(projectId, taskId);
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Private task'));
  } finally { sessions.dispose(); }
});

it('does not withdraw a fresh graph admitted while an old unknown hint read fails', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
  const admission = await peer.beginSync(projectId, signal());
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<never>();
  const internals = peer as unknown as { userTransaction: (...args: unknown[]) => Promise<unknown> };
  vi.spyOn(internals, 'userTransaction').mockImplementationOnce(() => { started.resolve(); return finish.promise; });
  const events: CacheEvent[] = []; peer.subscribe(event => events.push(event));
  vi.stubGlobal('fetch', vi.fn(async () => wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })));
  try {
    deliver(1, negative()); await started.promise;
    const detail = detailFixture(projectId, taskId);
    await peer.applySync(admission, taskSyncFromGraph(graphFixture([detail]), { query: {}, versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
    const fresh = peer.getAuthorizedProject(projectId); expect(fresh).not.toBeNull();
    finish.reject(new TaskCacheError('storage'));
    await vi.waitFor(() => expect(events.some(event => event.directAccessRecheck)).toBe(true));
    expect(peer.getAuthorizedProject(projectId)).toBe(fresh);
  } finally { finish.reject(new TaskCacheError('storage')); }
});

it('restores a mounted direct view after an exact matching old hint is rechecked', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const denied = await owner.beginSync(projectId, signal()); let tasks = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/access')) return wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    tasks++; return wireResponse(detailFixture(projectId, taskId, { title: 'Reauthorized task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } });
  }));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Reauthorized task'));
    await owner.revokeProject(denied, signal()); deliver(1, negative());
    await vi.waitFor(() => expect(tasks).toBeGreaterThan(1));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Reauthorized task'));
  } finally { sessions.dispose(); }
});

it('keeps direct content hidden after cleanup failure and allows a later user retry', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const denied = await owner.beginSync(projectId, signal());
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/access')
    ? wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
    : wireResponse(detailFixture(projectId, taskId, { title: 'Fresh direct task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } })));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  let fault: ReturnType<typeof failPurge> | undefined;
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).status).toBe('ready'));
    fault = failPurge(); await expect(owner.revokeProject(denied, signal())).rejects.toMatchObject({ category: 'storage' });
    deliver(1, negative());
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId)).toMatchObject({ status: 'error', detail: null }));
    fault.mockRestore();
    sessions.openDirect(projectId, taskId);
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Fresh direct task'));
  } finally { fault?.mockRestore(); sessions.dispose(); }
});

it('hides an incomparable graph as soon as its unknown denial is durable, before access recheck completes', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
  const pending = Promise.withResolvers<Response>(), events: CacheEvent[] = [];
  peer.subscribe(event => events.push(event)); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  try {
    deliver(1, negative());
    await vi.waitFor(() => expect(events.some(event => event.accessRevoked && event.unknownAncestors)).toBe(true));
    expect(peer.getAuthorizedProject(projectId)).toBeNull();
  } finally { pending.resolve(wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })); }
});

it('keeps a superseded access recheck silent until the later hint resolves', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal()); await peer.beginTaskRead(projectId, taskId, 1, 1, signal());
  const db = await database(); await corruptGeneration(db);
  const first = await owner.beginSync(projectId, signal()); await owner.revokeProject(first, signal()); const firstHint = negative();
  await corruptGeneration(db); const second = await owner.beginSync(projectId, signal()); await owner.revokeProject(second, signal()); const secondHint = negative();
  const firstAccess = Promise.withResolvers<Response>(), secondHintGate = Promise.withResolvers<void>(); let accesses = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ++accesses === 1 ? firstAccess.promise : wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })));
  const events: CacheEvent[] = []; peer.subscribe(event => events.push(event));
  try {
    deliver(1, firstHint); await vi.waitFor(() => expect(accesses).toBe(1));
    const internals = peer as unknown as { userTransaction: (...args: unknown[]) => Promise<unknown> };
    const original = internals.userTransaction.bind(peer);
    vi.spyOn(internals, 'userTransaction').mockImplementationOnce((...args) => secondHintGate.promise.then(() => original(...args)));
    deliver(1, secondHint);
    firstAccess.resolve(wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
    await Promise.resolve(); await Promise.resolve();
    expect(events.some(event => event.directAccessRecheck)).toBe(false);
    secondHintGate.resolve();
    await vi.waitFor(() => expect(events.some(event => event.directAccessRecheck && event.error === undefined)).toBe(true));
    expect(events.filter(event => event.directAccessRecheck)).toHaveLength(1);
  } finally { secondHintGate.resolve(); firstAccess.resolve(wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })); }
});

it('keeps reopened direct reads behind the pending project access recheck', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal());
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal()); const hint = negative();
  const pending = Promise.withResolvers<Response>(); let tasks = 0, accesses = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/access')) { accesses++; return pending.promise; }
    tasks++; return wireResponse(detailFixture(projectId, taskId, { title: 'Fresh direct task' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } });
  }));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).status).toBe('ready'));
    deliver(1, hint); await vi.waitFor(() => expect(accesses).toBe(1));
    sessions.releaseRead(projectId, taskId); sessions.openDirect(projectId, taskId);
    await Promise.resolve(); expect(tasks).toBe(1); expect(sessions.snapshot(projectId, taskId).detail).toBeNull();
    pending.resolve(wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Fresh direct task'));
    expect(tasks).toBe(2);
  } finally { pending.resolve(wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })); sessions.dispose(); }
});

it.each(['old hint', 'confirmed denial'] as const)('keeps an admitted direct write exclusive through %s and fresh access', async scenario => {
  const owner = scope(), peer = scope(); await apply(owner); await peer.prepareProjection(signal());
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal()); const hint = negative();
  const write = Promise.withResolvers<Response>(); let writes = 0, reads = 0, accessReads = 0, revoked = scenario === 'confirmed denial', committed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') { writes++; return write.promise; }
    if (url.endsWith('/access')) {
      accessReads++;
      return revoked ? wireResponse({ error: { code: 'not_found', message: 'not found', requestId: 'missing' } }, { status: 404, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } })
        : wireResponse(directAccessFixture(projectId, TEST_VIEWER_ID), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    }
    reads++;
    const detail = detailFixture(projectId, taskId, committed ? { title: 'After write', version: 2n, status: 'in_progress', ready: false, startedAt: '2026-10-22T10:00:00Z' } : { title: 'Fresh direct task' });
    return wireResponse(detail, { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } });
  }));
  const sessions = new TaskDetailSessions(peer); sessions.subscribe(projectId, taskId, () => {});
  try {
    sessions.openDirect(projectId, taskId); await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).status).toBe('ready'));
    sessions.setStatus(projectId, taskId, 'in_progress', 1n); await vi.waitFor(() => expect(writes).toBe(1));
    deliver(1, hint); await vi.waitFor(() => expect(accessReads).toBeGreaterThan(0));
    if (revoked) {
      await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail).toBeNull());
      revoked = false; sessions.openDirect(projectId, taskId);
    }
    await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
    await vi.waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.title).toBe('Fresh direct task'));
    expect(sessions.directRequiresFreshRead(projectId, taskId)).toBe(true);
    sessions.setStatus(projectId, taskId, 'in_progress', 1n); expect(writes).toBe(1);
    committed = true;
    write.resolve(wireResponse(detailFixture(projectId, taskId, { title: 'After write', version: 2n, status: 'in_progress', ready: false, startedAt: '2026-10-22T10:00:00Z' }), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } }));
    await vi.waitFor(() => expect(sessions.directRequiresFreshRead(projectId, taskId)).toBe(false));
    expect(writes).toBe(1);
  } finally { write.resolve(wireResponse(detailFixture(projectId, taskId), { headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': denied.epoch! } })); sessions.dispose(); }
});

it('cancels a direct read without cancelling the project withdrawal it is waiting for', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const revoke = peer.revokeProject.bind(peer);
  vi.spyOn(peer, 'revokeProject').mockImplementation((...args) => {
    const operation = revoke(...args); started.resolve();
    return (async () => { const result = await operation; await finish.promise; return result; })();
  });
  try {
    deliver(1, negative()); await started.promise;
    const healthy = await peer.beginTaskRead('10000000-0000-4000-8000-000000000002', taskId, 1, 1, signal());
    expect(peer.isTaskReadCurrent(healthy)).toBe(true);
    const controller = new AbortController();
    const read = peer.beginTaskRead(projectId, taskId, 1, 1, controller.signal);
    controller.abort(); await expect(read).rejects.toMatchObject({ name: 'AbortError' });
  } finally { finish.resolve(); }
  await peer.prepareProjection(signal()); expect(peer.canPreviewProject(projectId)).toBe(false);
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

it('does not re-isolate a resolved denial when identity pauses during cleanup', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
  const hint = negative(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const unsubscribe = vi.fn(), subscribe = client.subscribeAuthPause;
  vi.spyOn(client, 'subscribeAuthPause').mockImplementation(listener => { const stop = subscribe(listener); return () => { stop(); unsubscribe(); }; });
  const revoke = peer.revokeProject.bind(peer);
  vi.spyOn(peer, 'revokeProject').mockImplementation((...args) => {
    const result = revoke(...args); started.resolve();
    return (async () => { const value = await result; await finish.promise; return value; })();
  });
  try {
    deliver(1, hint); await started.promise;
    const resume = pauseAuthRequests();
    try { expect(peer.isProjectSuspended(projectId)).toBe(false); expect(unsubscribe).toHaveBeenCalledOnce(); } finally { resume(); }
  } finally { finish.resolve(); }
  await peer.prepareProjection(signal());
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(peer.getAuthorizedProject(projectId)).toBeNull();
  await apply(peer);
  expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
  expect(peer.isProjectSuspended(projectId)).toBe(false);
});

it('stops pause observation before reporting a terminal durable-read failure', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptGeneration(db);
  const denied = await owner.beginSync(projectId, signal()); await owner.revokeProject(denied, signal());
  const hint = negative(), failed = Promise.withResolvers<void>();
  const unsubscribe = vi.fn(), subscribe = client.subscribeAuthPause;
  vi.spyOn(client, 'subscribeAuthPause').mockImplementation(listener => { const stop = subscribe(listener); return () => { stop(); unsubscribe(); }; });
  let resume: (() => void) | undefined, armed = true;
  const get = IDBObjectStore.prototype.get;
  vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'projects' && armed) { armed = false; throw new DOMException('Injected durable-read failure', 'UnknownError'); }
    return get.apply(this, args);
  });
  peer.subscribeProjection(event => {
    if (resume === undefined && (event.error as { category?: string } | undefined)?.category === 'storage') {
      resume = pauseAuthRequests(); failed.resolve();
    }
  });
  try {
    deliver(1, hint); await failed.promise;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(peer.isProjectSuspended(projectId)).toBe(false);
  } finally { resume?.(); }
  await peer.prepareProjection(signal());
  expect(unsubscribe).toHaveBeenCalledOnce();
  await apply(peer); expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
});

it.each(['shared isolation', 'already paused', 'independent suspension'] as const)('preserves revision ownership for overlapping unknown hints with %s', async scenario => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptGeneration(db);
  const old = await owner.beginSync(projectId, signal()); expect(old.unknownAncestors).toBe(true);
  await owner.revokeProject(old, signal()); const oldHint = negative();
  await corruptGeneration(db);
  const current = await owner.beginSync(projectId, signal()); expect(current.unknownAncestors).toBe(true);
  expect(current.cacheGeneration).not.toBe(old.cacheGeneration);
  await owner.revokeProject(current, signal()); const currentHint = negative();
  const revision = peer.getProjectRevision(projectId);
  const revoke = vi.spyOn(peer, 'revokeProject');
  let resume: () => void;
  if (scenario === 'already paused') { resume = pauseAuthRequests(); deliver(1, oldHint); deliver(1, currentHint); }
  else { deliver(1, oldHint); deliver(1, currentHint); resume = pauseAuthRequests(); }
  try {
    expect(peer.isProjectSuspended(projectId)).toBe(true);
    expect(peer.getProjectRevision(projectId)).toBe(revision + 1);
    if (scenario === 'independent suspension') { peer.suspendProject(projectId); peer.resumeProject(projectId); }
  } finally { resume(); }
  await peer.prepareProjection(signal());
  expect(peer.isProjectSuspended(projectId)).toBe(false);
  if (scenario !== 'independent suspension') {
    expect(peer.getAuthorizedProject(projectId)).toBeNull();
    expect(peer.canPreviewProject(projectId)).toBe(false);
  } else {
    const results = await Promise.all(revoke.mock.results.map(result => result.value));
    expect(results).toContain(false);
    await apply(peer); expect(peer.getAuthorizedProject(projectId)).not.toBeNull();
  }
});

it('keeps a fresh authorized generation when two older hints join the same later pause', async () => {
  const owner = scope(), peer = scope(); await apply(owner); await apply(peer);
  const db = await database(); await corruptGeneration(db);
  const old = await owner.beginSync(projectId, signal()); await owner.revokeProject(old, signal()); const oldHint = negative();
  await corruptGeneration(db);
  const current = await owner.beginSync(projectId, signal()); await owner.revokeProject(current, signal()); const currentHint = negative();
  const ticket = await peer.beginSync(projectId, signal());
  const before = peer.getAdmissionRevision(projectId), ready = peer.ready.bind(peer);
  const pending = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let blocking = true, count = 0;
  vi.spyOn(peer, 'ready').mockImplementation(async readSignal => {
    if (blocking) { if (++count === 2) entered.resolve(); await pending.promise; }
    await ready(readSignal);
  });
  try {
    deliver(1, oldHint); deliver(1, currentHint); await entered.promise;
    blocking = false;
    const detail = detailFixture(projectId, taskId);
    await peer.applySync(ticket, taskSyncFromGraph(graphFixture([detail]), { query: {}, versionForTask: () => detail.version, propertiesForTask: () => detail.properties }), signal());
    const fresh = peer.getAuthorizedProject(projectId); expect(fresh).not.toBeNull();
    expect(peer.getAdmissionRevision(projectId)).toBeGreaterThan(before);
    const resume = pauseAuthRequests();
    try { expect(peer.isProjectSuspended(projectId)).toBe(true); } finally { resume(); }
    pending.resolve(); await peer.prepareProjection(signal());
    expect(peer.isProjectSuspended(projectId)).toBe(false);
    expect(peer.getAuthorizedProject(projectId)).toBe(fresh); expect(peer.canPreviewProject(projectId)).toBe(true);
  } finally { pending.resolve(); }
});
