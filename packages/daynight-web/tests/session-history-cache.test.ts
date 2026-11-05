import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, expect, it, vi } from 'vitest';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { beginSessionHistoryPagination, beginSessionHistoryRefresh, clearSessionHistory, getSessionHistoryToken, isSessionHistoryClearCurrent, readCachedSessionHistory, readSessionHistoryPaginationState, releaseSessionHistoryRefresh, saveSessionHistory, completeSessionHistoryPagination, SESSION_HISTORY_CACHE_LIMITS } from '../src/features/task-agent-session/session-history-cache';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const signal = () => new AbortController().signal;
const scopes: TaskCacheScope[] = [];
const databases: IDBPDatabase<TaskCacheSchema>[] = [];
const detail = (n: number) => detailFixture(projectId, taskId(n));
const seed = async (count = 1) => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const details = Array.from({ length: count }, (_, n) => detail(n + 1));
  const sync = taskSyncFromGraph(graphFixture(details), { versionForTask: () => 1n });
  await scope.applySync(await scope.beginSync(projectId, signal()), sync, signal());
  return scope;
};
const inspect = async () => { const db = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA); databases.push(db); return db; };
const empty = { items: [], nextCursor: null };
const incomplete = { items: [], nextCursor: 'next' };
const mustLease = (value: Awaited<ReturnType<typeof beginSessionHistoryRefresh>>) => {
  if (value === null || value.kind !== 'lease') throw new Error('Expected a lease.');
  return value;
};
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); databases.splice(0).forEach(db => db.close()); });

it('retains confirmed and incomplete empty pages across scopes and rejects superseded responses', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toBeNull();
  const first = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).token;
  expect(await saveSessionHistory(scope, ticket, taskId(1), empty, first, signal())).toBe(true);
  const reopened = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(reopened);
  const reopenedTicket = await reopened.beginSync(projectId, signal());
  const second = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  expect(await beginSessionHistoryRefresh(reopened, reopenedTicket, taskId(1), signal())).toEqual({ ...second, acquired: false });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(second.expiresAt);
  const newer = mustLease(await beginSessionHistoryRefresh(reopened, reopenedTicket, taskId(1), signal())).token;
  expect(await getSessionHistoryToken(scope, ticket, taskId(1), signal())).toBe(newer);
  expect(await saveSessionHistory(scope, ticket, taskId(1), incomplete, newer, signal())).toBe(true);
  expect(await saveSessionHistory(scope, ticket, taskId(1), empty, second.token, signal())).toBe(false);
  clock.mockRestore();
  expect(await readCachedSessionHistory(reopened, reopenedTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: false });
});

it('releases failed and cancelled leases and prevents their late responses from winning', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const events = vi.fn(); scope.subscribe(events);
  const failed = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  expect(failed.acquired).toBe(true);
  expect(await releaseSessionHistoryRefresh(scope, ticket, taskId(1), failed.token, 'failed', signal())).toBe(true);
  expect(events).toHaveBeenCalledWith({ projectId, sessionHistorySettled: { taskId: taskId(1), token: failed.token, outcome: 'failed' } });
  expect(await saveSessionHistory(scope, ticket, taskId(1), empty, failed.token, signal())).toBe(false);
  const next = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  expect(next.acquired).toBe(true); expect(next.token).not.toBe(failed.token);
  expect(await clearSessionHistory(scope, ticket, taskId(1), failed.token, signal())).toBe(false);
  expect(await releaseSessionHistoryRefresh(scope, ticket, taskId(1), next.token, 'cancelled', signal())).toBe(true);
  expect(events).toHaveBeenCalledWith({ projectId, sessionHistorySettled: { taskId: taskId(1), token: next.token, outcome: 'cancelled' } });
});

it('provides an atomic pagination snapshot that changes across a concurrent refresh', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const initial = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, initial.token, signal());
  expect(await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal())).toEqual({ token: initial.token, paginationToken: null, refreshing: false, leaseExpiresAt: null, page: incomplete, confirmedCompleteEmpty: false });
  const next = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  expect(await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal())).toEqual({ token: next.token, paginationToken: null, refreshing: true, leaseExpiresAt: next.expiresAt, page: incomplete, confirmedCompleteEmpty: false });
  await saveSessionHistory(scope, ticket, taskId(1), empty, next.token, signal());
  expect(await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal())).toEqual({ token: next.token, paginationToken: null, refreshing: false, leaseExpiresAt: null, page: empty, confirmedCompleteEmpty: false });
});

it('retains a complete-empty proof separately from the original first-page cursor and fences stale pagination', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const first = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, first.token, signal());
  const firstPagination = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!.paginationToken!;
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, first.token, firstPagination, true, signal())).toBe(true);
  const reopened = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(reopened);
  const otherTicket = await reopened.beginSync(projectId, signal());
  expect(await readCachedSessionHistory(reopened, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
  const next = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, first.token, firstPagination, true, signal())).toBe(false);
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, next.token, signal());
  expect(await readCachedSessionHistory(reopened, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
  const nextPagination = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!.paginationToken!;
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, next.token, nextPagination, null, signal())).toBe(true);
  expect(await readCachedSessionHistory(reopened, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, next.token, nextPagination, false, signal())).toBe(false);
  const followingPagination = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!.paginationToken!;
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, next.token, followingPagination, false, signal())).toBe(true);
  expect(await readCachedSessionHistory(reopened, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: false });
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, next.token, followingPagination, true, signal())).toBe(false);
  const later = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, later.token, signal(), true);
  expect(await readCachedSessionHistory(reopened, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
  const changed = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), empty, changed.token, signal());
  expect(await readCachedSessionHistory(reopened, otherTicket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
  await expect(completeSessionHistoryPagination(scope, ticket, taskId(1), empty, changed.token, nextPagination, true, signal())).rejects.toMatchObject({ kind: 'protocol' });
});

it.each(['before touch', 'after failed touch'])('rechecks a changed proof %s before publishing a cached page', async (phase) => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, lease.token, signal());
  const pagination = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!.paginationToken!;
  const other = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(other);
  const otherTicket = await other.beginSync(projectId, signal());
  const actual = scope.sessionHistoryTransaction.bind(scope); let calls = 0;
  if (phase === 'after failed touch') {
    const { IDBObjectStore } = await import('fake-indexeddb'); const original = IDBObjectStore.prototype.put; let failed = false;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'sessionHistory' && !failed) { failed = true; throw new DOMException('Injected quota', 'QuotaExceededError'); }
      return original.apply(this, args);
    });
  }
  const update = () => completeSessionHistoryPagination(other, otherTicket, taskId(1), incomplete, lease.token, pagination, true, signal());
  vi.spyOn(scope, 'sessionHistoryTransaction').mockImplementation((async (...args: Parameters<typeof scope.sessionHistoryTransaction>) => {
    const number = ++calls;
    try {
      const value = await actual(...args);
      if (phase === 'before touch' && number === 1) expect(await update()).toBe(true);
      return value;
    } catch (error) {
      if (phase === 'after failed touch' && number === 2) expect(await update()).toBe(true);
      throw error;
    }
  }) as typeof scope.sessionHistoryTransaction);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
});

it('rejects pagination responses superseded by a newer pagination request', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, lease.token, signal());
  const older = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!;
  const newer = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!;
  expect(older.paginationToken).not.toBe(newer.paginationToken);
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, lease.token, newer.paginationToken!, true, signal())).toBe(true);
  expect(await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, lease.token, older.paginationToken!, false, signal())).toBe(false);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
  expect(await clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), older.paginationToken!)).toBe(false);
  expect(await scope.reportHistoryUncertain(ticket, taskId(1), lease.token, signal(), false, older.paginationToken!)).toBe(false);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
  const completedToken = (await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal()))!.paginationToken!;
  expect(completedToken).not.toBe(newer.paginationToken);
  expect(await clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), completedToken)).toBe(true);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toBeNull();
});

it('binds a storage-failure denial hint to the current pagination request', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, lease.token, signal());
  const older = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!.paginationToken!;
  const newer = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!.paginationToken!;
  const events = vi.fn(); scope.subscribe(events);
  const { IDBObjectStore } = await import('fake-indexeddb'); const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'sessionHistory') throw new DOMException('Injected quota', 'QuotaExceededError');
    return original.apply(this, args);
  });
  expect(await clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), older)).toBe(false);
  await expect(clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), newer)).rejects.toMatchObject({ category: 'storage' });
  expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: lease.token, expectedPaginationToken: newer } });
  fault.mockRestore();
});

it('ignores a cross-tab denial hint for an older pagination request', async () => {
  class Channel {
    static instances: Channel[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor() { Channel.instances.push(this); }
    postMessage() {}
    close() { Channel.instances = Channel.instances.filter(item => item !== this); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const first = await seed(); const ticket = await first.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  await saveSessionHistory(first, ticket, taskId(1), incomplete, lease.token, signal());
  const second = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(second);
  const otherTicket = await second.beginSync(projectId, signal());
  await readCachedSessionHistory(second, otherTicket, taskId(1), signal());
  const old = (await beginSessionHistoryPagination(first, ticket, taskId(1), signal()))!.paginationToken!;
  const current = (await beginSessionHistoryPagination(first, ticket, taskId(1), signal()))!.paginationToken!;
  const events = vi.fn(); second.subscribe(events);
  const send = (paginationToken: string) => Channel.instances.at(-1)!.onmessage?.({ data: {
    userId: TEST_VIEWER_ID, projectId, userFence: ticket.userFence, cacheGeneration: ticket.cacheGeneration,
    sessionHistoryUncertain: { taskId: taskId(1), expectedToken: lease.token, expectedPaginationToken: paginationToken },
  } } as MessageEvent<unknown>);
  send(old); await new Promise(resolve => setTimeout(resolve, 20));
  expect(events).not.toHaveBeenCalled();
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: false });
  send(current);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: lease.token, expectedPaginationToken: current } }));
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toBeNull();
});

it('rejects a complete-empty proof when the persisted first page does not support it', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), empty, lease.token, signal());
  const db = await inspect(); const row = (await db.get('sessionHistory', [TEST_VIEWER_ID, projectId, taskId(1)]))!;
  await db.put('sessionHistory', { ...row, confirmedCompleteEmpty: true });
  await expect(readCachedSessionHistory(scope, ticket, taskId(1), signal())).rejects.toMatchObject({ category: 'corrupt' });
  expect(await db.getAll('sessionHistory')).toEqual([]);
});

it('isolates users and tasks and refuses a ticket after snapshot replacement', async () => {
  const scope = await seed(2); const ticket = await scope.beginSync(projectId, signal());
  const token = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).token;
  await saveSessionHistory(scope, ticket, taskId(1), empty, token, signal());
  expect(await readCachedSessionHistory(scope, ticket, taskId(2), signal())).toBeNull();
  const other = createTaskCacheScope({ userId: '00000000-0000-4000-8000-000000000202', onIdentityMismatch: vi.fn() }); scopes.push(other);
  const sync = taskSyncFromGraph(graphFixture([detail(1)]), { versionForTask: () => 1n });
  await other.applySync(await other.beginSync(projectId, signal()), sync, signal());
  expect(await readCachedSessionHistory(other, await other.beginSync(projectId, signal()), taskId(1), signal())).toBeNull();
  await scope.applySync(ticket, taskSyncFromGraph(graphFixture([detail(2)]), { versionForTask: () => 1n, epoch: '00000000-0000-4000-8000-000000000901' }), signal());
  await expect(saveSessionHistory(scope, ticket, taskId(1), empty, token, signal())).rejects.toMatchObject({ name: 'AbortError' });
  expect(await (await inspect()).get('sessionHistory', [TEST_VIEWER_ID, projectId, taskId(1)])).toBeUndefined();
});

it('surfaces quota failure without replacing the previously committed directory', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const initial = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).token;
  await saveSessionHistory(scope, ticket, taskId(1), empty, initial, signal());
  const token = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).token;
  const { IDBObjectStore } = await import('fake-indexeddb'); const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'sessionHistory') throw new DOMException('Injected quota', 'QuotaExceededError');
    return original.apply(this, args);
  });
  await expect(saveSessionHistory(scope, ticket, taskId(1), incomplete, token, signal())).rejects.toMatchObject({ category: 'storage' });
  fault.mockRestore();
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
});

it('keeps a verified cached page and a read-only token snapshot when the LRU write fails', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const initial = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, initial.token, signal());
  const { IDBObjectStore } = await import('fake-indexeddb'); const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'sessionHistory') throw new DOMException('Injected quota', 'QuotaExceededError');
    return original.apply(this, args);
  });
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: false });
  await expect(beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).rejects.toMatchObject({ category: 'storage' });
  const snapshot = (await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal()))!;
  expect(snapshot).toMatchObject({ token: initial.token, paginationToken: null, refreshing: false });
  const events = vi.fn(); scope.subscribe(events);
  await expect(clearSessionHistory(scope, ticket, taskId(1), snapshot.token, signal(), snapshot.paginationToken)).rejects.toMatchObject({ category: 'storage' });
  expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: initial.token, expectedPaginationToken: null } });
  fault.mockRestore();
  expect(await clearSessionHistory(scope, ticket, taskId(1), snapshot.token, signal(), snapshot.paginationToken)).toBe(true);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toBeNull();
});

it('does not clear a newer pagination result when the earlier snapshot had no pagination token', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const initial = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, initial.token, signal());
  const snapshot = (await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal()))!;
  expect(snapshot.paginationToken).toBeNull();
  const newer = (await beginSessionHistoryPagination(scope, ticket, taskId(1), signal()))!;
  await completeSessionHistoryPagination(scope, ticket, taskId(1), incomplete, initial.token, newer.paginationToken!, true, signal());
  expect(await clearSessionHistory(scope, ticket, taskId(1), snapshot.token, signal(), snapshot.paginationToken)).toBe(false);
  expect(await scope.reportHistoryUncertain(ticket, taskId(1), snapshot.token, signal(), false, snapshot.paginationToken)).toBe(false);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: true });
});

it('allows a verified denial with explicit null tokens when no cache row exists', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  expect(await readSessionHistoryPaginationState(scope, ticket, taskId(1), signal())).toBeNull();
  expect(await clearSessionHistory(scope, ticket, taskId(1), null, signal(), null)).toBe(true);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toBeNull();
});

it('accepts a matching expired-lease snapshot but rejects it after the same token settles', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const lease = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  clock.mockReturnValue(lease.expiresAt);
  expect(await clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), null)).toBe(false);
  expect(await clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), null, lease.expiresAt)).toBe(true);
  clock.mockReturnValue(2_000);
  const newer = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  await saveSessionHistory(scope, ticket, taskId(1), incomplete, newer.token, signal());
  expect(await clearSessionHistory(scope, ticket, taskId(1), newer.token, signal(), null, newer.expiresAt)).toBe(false);
  expect(await scope.reportHistoryUncertain(ticket, taskId(1), newer.token, signal(), false, null, newer.expiresAt)).toBe(false);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: false });
});

it('includes an explicit lease snapshot in conservative hints when clearing fails', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  const events = vi.fn(); scope.subscribe(events);
  const { IDBObjectStore } = await import('fake-indexeddb'); const original = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'sessionHistory') throw new DOMException('Injected quota', 'QuotaExceededError');
    return original.apply(this, args);
  });
  await expect(clearSessionHistory(scope, ticket, taskId(1), lease.token, signal(), null, lease.expiresAt)).rejects.toMatchObject({ category: 'storage' });
  expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: lease.token, expectedPaginationToken: null, expectedLeaseExpiresAt: lease.expiresAt } });
  fault.mockRestore();
});

it('ignores a delayed denial hint after the same lease has successfully settled', async () => {
  class Channel {
    static instances: Channel[] = []; static messages: unknown[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor() { Channel.instances.push(this); }
    postMessage(value: unknown) { Channel.messages.push(value); }
    close() { Channel.instances = Channel.instances.filter(item => item !== this); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const first = await seed(); const ticket = await first.beginSync(projectId, signal());
  const lease = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  const second = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(second);
  const otherTicket = await second.beginSync(projectId, signal());
  await readSessionHistoryPaginationState(second, otherTicket, taskId(1), signal());
  const events = vi.fn(); second.subscribe(events); Channel.messages = [];
  expect(await first.reportHistoryUncertain(ticket, taskId(1), lease.token, signal(), false, null, lease.expiresAt)).toBe(true);
  const hint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistoryUncertain' in value)!;
  expect(await saveSessionHistory(second, otherTicket, taskId(1), empty, lease.token, signal())).toBe(true);
  Channel.instances.at(-1)!.onmessage?.({ data: hint } as MessageEvent<unknown>);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ sessionHistoryUncertain: expect.anything() }));
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
});

it('fences old content in both tabs if a trusted denial cannot be persisted', async () => {
  class Channel {
    static instances: Channel[] = []; static messages: unknown[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor() { Channel.instances.push(this); }
    postMessage(value: unknown) { Channel.messages.push(value); }
    close() { Channel.instances = Channel.instances.filter(item => item !== this); }
    static deliver(value: unknown) { for (const channel of Channel.instances) channel.onmessage?.({ data: value } as MessageEvent<unknown>); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const first = await seed(); const ticket = await first.beginSync(projectId, signal());
  const initial = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  await saveSessionHistory(first, ticket, taskId(1), incomplete, initial.token, signal());
  const second = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(second);
  const otherTicket = await second.beginSync(projectId, signal());
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toEqual({ ...incomplete, confirmedCompleteEmpty: false });
  const events = vi.fn(); second.subscribe(events); Channel.messages = [];
  const pending = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  const { IDBObjectStore } = await import('fake-indexeddb'); const originalPut = IDBObjectStore.prototype.put;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'sessionHistory') throw new DOMException('Injected quota', 'QuotaExceededError');
    return originalPut.apply(this, args);
  });
  await expect(clearSessionHistory(first, ticket, taskId(1), pending.token, signal())).rejects.toMatchObject({ category: 'storage' });
  const hint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistoryUncertain' in value)!;
  Channel.deliver(hint);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: pending.token } }));
  fault.mockRestore();
  expect(await readCachedSessionHistory(first, ticket, taskId(1), signal())).toBeNull();
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toBeNull();
  expect(await saveSessionHistory(first, ticket, taskId(1), empty, pending.token, signal())).toBe(false);
  await releaseSessionHistoryRefresh(first, ticket, taskId(1), pending.token, 'cancelled', signal());
  const retry = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  expect(await first.inspectHistoryUncertain(ticket, taskId(1), pending.token, signal())).toEqual({ current: true, refreshing: true });
  await saveSessionHistory(first, ticket, taskId(1), empty, retry.token, signal());
  expect(await first.inspectHistoryUncertain(ticket, taskId(1), pending.token, signal())).toEqual({ current: false, refreshing: false });
  const saved = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistorySettled' in value &&
    (value as { sessionHistorySettled: { token: string } }).sessionHistorySettled.token === retry.token)!;
  Channel.deliver(saved);
  await vi.waitFor(async () => expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false }));
  events.mockClear(); Channel.deliver(hint);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ sessionHistoryUncertain: expect.anything() }));
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
  const originalGet = IDBObjectStore.prototype.get;
  const readFault = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'sessionHistory') throw new DOMException('Denied', 'SecurityError');
    return originalGet.apply(this, args);
  });
  Channel.instances.at(-1)!.onmessage?.({ data: hint } as MessageEvent<unknown>);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: pending.token } }));
  readFault.mockRestore();
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toBeNull();
});

it('broadcasts an unbound denial using an observed ticket when beginSync cannot access storage', async () => {
  class Channel {
    static instances: Channel[] = []; static messages: unknown[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor() { Channel.instances.push(this); }
    postMessage(value: unknown) { Channel.messages.push(value); }
    close() { Channel.instances = Channel.instances.filter(item => item !== this); }
    static deliver(value: unknown) { for (const channel of Channel.instances) channel.onmessage?.({ data: value } as MessageEvent<unknown>); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const first = await seed(); const ticket = await first.beginSync(projectId, signal());
  expect(first.getObservedHistoryTicket(projectId)).toMatchObject({ cacheGeneration: ticket.cacheGeneration });
  const initial = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  await saveSessionHistory(first, ticket, taskId(1), incomplete, initial.token, signal());
  const pending = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  const second = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(second);
  const otherTicket = await second.beginSync(projectId, signal());
  await readCachedSessionHistory(second, otherTicket, taskId(1), signal());
  expect(second.getAuthorizedProject(projectId)).toBeNull();
  expect(second.getObservedHistoryTicket(projectId)).toMatchObject({ cacheGeneration: ticket.cacheGeneration });
  const unknown = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(unknown);
  expect(unknown.getObservedHistoryTicket(projectId)).toBeNull();
  const events = vi.fn(); second.subscribe(events); Channel.messages = [];
  const fault = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
  await expect(first.beginSync(projectId, signal())).rejects.toMatchObject({ category: 'storage' });
  const observed = first.getObservedHistoryTicket(projectId)!;
  expect(await first.reportHistoryUncertain(observed, taskId(1), null, signal(), true)).toBe(true);
  const hint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistoryUncertain' in value)!;
  Channel.deliver(hint);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryUncertain: { taskId: taskId(1), expectedToken: null, unbound: true } }));
  expect(first.isHistoryUncertain(ticket, taskId(1))).toBe(true);
  expect(second.isHistoryUncertain(otherTicket, taskId(1))).toBe(true);
  fault.mockRestore();
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toBeNull();
  expect(await saveSessionHistory(first, ticket, taskId(1), empty, pending.token, signal())).toBe(false);
  await releaseSessionHistoryRefresh(first, ticket, taskId(1), pending.token, 'cancelled', signal());
  const retry = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  expect(await saveSessionHistory(first, ticket, taskId(1), empty, retry.token, signal())).toBe(true);
  expect(await readCachedSessionHistory(first, ticket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toBeNull();
  const secondRetry = mustLease(await beginSessionHistoryRefresh(second, otherTicket, taskId(1), signal()));
  expect(await saveSessionHistory(second, otherTicket, taskId(1), empty, secondRetry.token, signal())).toBe(true);
  expect(await readCachedSessionHistory(second, otherTicket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
});

it('clears on denial and fences outstanding responses, generation changes and user scope cleanup', async () => {
  const scope = await seed(); const ticket = await scope.beginSync(projectId, signal());
  const token = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).token;
  await saveSessionHistory(scope, ticket, taskId(1), empty, token, signal());
  await clearSessionHistory(scope, ticket, taskId(1), token, signal());
  expect(await saveSessionHistory(scope, ticket, taskId(1), empty, token, signal())).toBe(false);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toBeNull();
  const next = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal())).token;
  await saveSessionHistory(scope, ticket, taskId(1), empty, next, signal());
  await scope.invalidateProject(projectId, signal());
  await expect(readCachedSessionHistory(scope, ticket, taskId(1), signal())).rejects.toMatchObject({ name: 'AbortError' });
  expect(await (await inspect()).getAll('sessionHistory')).toEqual([]);
  await scope.invalidateScope();
});

it('verifies a clear marker across tabs and ignores forged and obsolete hints', async () => {
  class Channel {
    static instances: Channel[] = [];
    static messages: unknown[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor() { Channel.instances.push(this); }
    postMessage(value: unknown) { Channel.messages.push(value); }
    close() { Channel.instances = Channel.instances.filter(item => item !== this); }
    static deliver(value: unknown) { for (const channel of Channel.instances) channel.onmessage?.({ data: value } as MessageEvent<unknown>); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const first = await seed(); const ticket = await first.beginSync(projectId, signal());
  const second = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(second);
  const otherTicket = await second.beginSync(projectId, signal());
  await second.applySync(otherTicket, taskSyncFromGraph(graphFixture([detail(1)]), { versionForTask: () => 1n, query: { epoch: otherTicket.epoch! } }), signal());
  const events = vi.fn(); second.subscribe(events); Channel.messages = [];
  const original = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal())).token;
  await saveSessionHistory(first, ticket, taskId(1), empty, original, signal());
  const savedHint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistorySettled' in value)!;
  Channel.deliver(savedHint);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistorySettled: { taskId: taskId(1), token: original, outcome: 'saved' } }));
  events.mockClear();
  await clearSessionHistory(first, ticket, taskId(1), original, signal());
  const hint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistoryCleared' in value)! as { sessionHistoryCleared: { taskId: string; token: string } };
  // An unrelated reservation must not erase the denial proof before it is observed.
  const next = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal())).token;
  Channel.deliver({ ...hint, sessionHistoryCleared: { taskId: taskId(1), token: '30000000-0000-4000-8000-000000000001' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(events).not.toHaveBeenCalled();
  Channel.deliver(hint);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistoryCleared: hint.sessionHistoryCleared }));
  expect(await isSessionHistoryClearCurrent(second, otherTicket, taskId(1), hint.sessionHistoryCleared.token, signal())).toEqual({ current: true, refreshing: true });
  events.mockClear();
  await saveSessionHistory(first, ticket, taskId(1), incomplete, next, signal());
  expect(await isSessionHistoryClearCurrent(second, otherTicket, taskId(1), hint.sessionHistoryCleared.token, signal())).toEqual({ current: false, refreshing: false });
  Channel.deliver(hint);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(events).not.toHaveBeenCalled();
  const failing = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal()));
  await releaseSessionHistoryRefresh(first, ticket, taskId(1), failing.token, 'failed', signal());
  const failedHint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistorySettled' in value &&
    (value as { sessionHistorySettled: { token: string } }).sessionHistorySettled.token === failing.token)!;
  Channel.deliver(failedHint);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, sessionHistorySettled: { taskId: taskId(1), token: failing.token, outcome: 'failed' } }));
});

it('preserves clear markers under capacity pressure and rotates the project before accepting another task', async () => {
  const scope = await seed(33); const ticket = await scope.beginSync(projectId, signal());
  const events = vi.fn(); scope.subscribe(events);
  for (let n = 1; n <= 32; n++) expect(await clearSessionHistory(scope, ticket, taskId(n), null, signal())).toBe(true);
  const recovering = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(1), signal()));
  expect(await beginSessionHistoryRefresh(scope, ticket, taskId(33), signal())).toEqual({ kind: 'capacity', expiresAt: recovering.expiresAt });
  await releaseSessionHistoryRefresh(scope, ticket, taskId(1), recovering.token, 'cancelled', signal());
  await expect(beginSessionHistoryRefresh(scope, ticket, taskId(33), signal())).rejects.toMatchObject({ name: 'AbortError' });
  expect(events).toHaveBeenCalledWith({ projectId, cacheGenerationChanged: true });
  expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ accessRevoked: true }));
  expect(await (await inspect()).getAll('sessionHistory')).toEqual([]);
  const rebuilt = await scope.beginSync(projectId, signal());
  expect(scope.getAuthorizedProject(projectId)?.manifest.cacheGeneration).toBe(rebuilt.cacheGeneration);
  expect(mustLease(await beginSessionHistoryRefresh(scope, rebuilt, taskId(33), signal())).acquired).toBe(true);
});

it('does not rotate or revoke the project when markers share capacity with live leases', async () => {
  const scope = await seed(33); const ticket = await scope.beginSync(projectId, signal());
  expect(await clearSessionHistory(scope, ticket, taskId(1), null, signal())).toBe(true);
  for (let n = 2; n <= 32; n++) expect(mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(n), signal())).acquired).toBe(true);
  const events = vi.fn(); scope.subscribe(events);
  expect(await beginSessionHistoryRefresh(scope, ticket, taskId(33), signal())).toEqual({ kind: 'capacity', expiresAt: expect.any(Number) });
  expect(scope.getAuthorizedProject(projectId)?.manifest.cacheGeneration).toBe(ticket.cacheGeneration);
  expect(events).not.toHaveBeenCalled();
  const token = (await getSessionHistoryToken(scope, ticket, taskId(2), signal()))!;
  await releaseSessionHistoryRefresh(scope, ticket, taskId(2), token, 'cancelled', signal());
  expect(events).toHaveBeenCalledWith({ projectId, sessionHistorySettled: { taskId: taskId(2), token, outcome: 'cancelled' } });
  expect(mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(33), signal())).acquired).toBe(true);
});

it('delivers verified clear and generation hints to a cache preview without granting project access', async () => {
  class Channel {
    static instances: Channel[] = []; static messages: unknown[] = [];
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor() { Channel.instances.push(this); }
    postMessage(value: unknown) { Channel.messages.push(value); }
    close() { Channel.instances = Channel.instances.filter(item => item !== this); }
    static deliver(value: unknown) { for (const channel of Channel.instances) channel.onmessage?.({ data: value } as MessageEvent<unknown>); }
  }
  vi.stubGlobal('BroadcastChannel', Channel);
  const first = await seed(); const ticket = await first.beginSync(projectId, signal());
  const token = mustLease(await beginSessionHistoryRefresh(first, ticket, taskId(1), signal())).token;
  await saveSessionHistory(first, ticket, taskId(1), empty, token, signal());
  const preview = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(preview);
  let previewTicket = await preview.beginSync(projectId, signal());
  expect(await readCachedSessionHistory(preview, previewTicket, taskId(1), signal())).toEqual({ ...empty, confirmedCompleteEmpty: false });
  expect(preview.getAuthorizedProject(projectId)).toBeNull();
  expect(preview.isSessionHistoryTicketCurrent(previewTicket)).toBe(true);
  const events = vi.fn(); preview.subscribe(events); Channel.messages = [];
  await clearSessionHistory(first, ticket, taskId(1), token, signal());
  const clearHint = Channel.messages.find(value => typeof value === 'object' && value !== null && 'sessionHistoryCleared' in value)!;
  Channel.deliver(clearHint);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ projectId, sessionHistoryCleared: expect.objectContaining({ taskId: taskId(1) }) })));
  events.mockClear(); Channel.messages = [];
  const { IDBObjectStore } = await import('fake-indexeddb'); const original = IDBObjectStore.prototype.get;
  const fault = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === 'projects') throw new DOMException('Denied', 'SecurityError');
    return original.apply(this, args);
  });
  Channel.instances.at(-1)!.onmessage?.({ data: { userId: TEST_VIEWER_ID, projectId } } as MessageEvent<unknown>);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ projectId, cacheGenerationChanged: true, error: expect.any(Error) })));
  expect(preview.isSessionHistoryTicketCurrent(previewTicket)).toBe(false);
  fault.mockRestore();
  previewTicket = await preview.beginSync(projectId, signal());
  await readCachedSessionHistory(preview, previewTicket, taskId(1), signal());
  expect(preview.isSessionHistoryTicketCurrent(previewTicket)).toBe(true);
  events.mockClear(); Channel.messages = [];
  await first.applySync(ticket, taskSyncFromGraph(graphFixture([detail(1)]), { versionForTask: () => 1n, epoch: '00000000-0000-4000-8000-000000000901' }), signal());
  Channel.deliver(Channel.messages.find(value => typeof value === 'object' && value !== null && 'projectId' in value)!);
  await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ projectId, cacheGenerationChanged: true }));
  expect(preview.isSessionHistoryTicketCurrent(previewTicket)).toBe(false);
  expect(preview.getAuthorizedProject(projectId)).toBeNull();
});

it('keeps bounded LRU metadata and never admits malformed persisted content', async () => {
  const scope = await seed(33); const ticket = await scope.beginSync(projectId, signal());
  const clock = vi.spyOn(Date, 'now');
  for (let n = 1; n <= 33; n++) {
    clock.mockReturnValue(n); const token = mustLease(await beginSessionHistoryRefresh(scope, ticket, taskId(n), signal())).token;
    await saveSessionHistory(scope, ticket, taskId(n), empty, token, signal());
  }
  const db = await inspect();
  expect(await db.countFromIndex('sessionHistory', 'by-project', [TEST_VIEWER_ID, projectId])).toBe(SESSION_HISTORY_CACHE_LIMITS.records);
  expect(await readCachedSessionHistory(scope, ticket, taskId(1), signal())).toBeNull();
  const row = (await db.get('sessionHistory', [TEST_VIEWER_ID, projectId, taskId(2)]))!;
  await db.put('sessionHistory', { ...row, page: { items: [], nextCursor: 1 } } as unknown as TaskCacheSchema['sessionHistory']['value']);
  await expect(readCachedSessionHistory(scope, ticket, taskId(2), signal())).rejects.toMatchObject({ category: 'corrupt' });
  expect(await db.getAll('sessionHistory')).toEqual([]);
});
