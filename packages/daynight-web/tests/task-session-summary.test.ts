import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { aggregateSessionIndicators, sessionIndicator } from '../src/features/task-session-summary/summary';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import type { TaskSessionSnapshot } from './helpers/session';

const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')) as TaskSessionSnapshot;
const projectId = original.identity.projectId;
const taskId = original.identity.taskId;
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const worker = (claimId = original.claimId): WorkerClaim => ({ claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: original.identity.workerId,
  machine: { id: id(90), name: 'test' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: original.identity.worktreeId,
  phase: 'executing', herdr: null, nativeSessionId: 'native-thread-1', claimedAt: '2026-10-22T10:00:00Z' });
const task = (taskId = original.identity.taskId, claimId = original.claimId): TaskDetail => detailFixture(projectId, taskId, {
  status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', properties: { worker: { ...worker(claimId) } },
});
const snapshot = (changes: Partial<TaskSessionSnapshot> = {}): TaskSessionSnapshot => ({ ...original, activity: 'working', operations: { canSend: false, canRespond: false, canCancel: false }, ...changes });
const response = (s = snapshot(), userId = TEST_VIEWER_ID) => resourceResponse({ status: 'registered', session: s }, userId);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const scopes: TaskCacheScope[] = []; const stores: TaskSessionSummaryStore[] = [];
async function apply(scope: TaskCacheScope, tasks: readonly TaskDetail[]) {
  const signal = new AbortController().signal;
  const ticket = await scope.beginSync(projectId, signal);
  return scope.applySync(ticket, taskSyncFromGraph(graphFixture(tasks), { query: ticket.epoch ? { epoch: ticket.epoch } : {},
    versionForTask: (node) => tasks.find((t) => t.id === node.id)!.version, propertiesForTask: (node) => tasks.find((t) => t.id === node.id)!.properties }), signal);
}
async function fixture(tasks: readonly TaskDetail[] = [task()]) {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); await apply(scope, tasks);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const store = new TaskSessionSummaryStore(scope, projectId); stores.push(store); store.start();
  return { scope, store };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
afterEach(() => { stores.splice(0).forEach((s) => s.dispose()); scopes.splice(0).forEach((s) => s.dispose()); });

describe('Session summary semantics', () => {
  it.each([
    [{ activity: 'working' }, 'working'], [{ activity: 'waiting_input' }, 'notice'], [{ activity: 'idle' }, 'warning'],
    [{ activity: 'stopped' }, 'warning'], [{ lifecycle: 'archived' }, 'warning'], [{ lifecycle: 'draining' }, 'warning'],
    [{ connectionState: 'disconnected', activity: 'waiting_input' }, 'warning'], [{ synchronized: false }, null],
    [{ connectionState: 'synchronizing' }, null], [{ activity: 'initializing' }, null], [{ activity: 'unknown' }, null],
  ] as const)('maps only reliable session state %j', (changes, indicator) => {
    expect(sessionIndicator(snapshot(changes))).toBe(indicator);
  });
  it('does not mistake the ability to respond for a pending interaction', () => {
    expect(sessionIndicator(snapshot({ activity: 'idle', operations: { canSend: true, canCancel: false, canRespond: true } }))).toBe('warning');
  });
  it('recomputes the highest current indicator instead of retaining a historical maximum', () => {
    expect(aggregateSessionIndicators(['working', 'notice', 'warning', null])).toBe('warning');
    expect(aggregateSessionIndicators(['working', 'notice', null])).toBe('notice');
    expect(aggregateSessionIndicators(['working', null])).toBe('working');
    expect(aggregateSessionIndicators([null, null])).toBeNull();
  });
});

describe('Session summary scheduling and fencing', () => {
  it('shares reads across visible chains, ignores unobserved tasks and refreshes five seconds after completion', async () => {
    const { store } = await fixture([task(), task(id(2))]); const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(pending.promise).mockImplementation(() => response()); vi.stubGlobal('fetch', fetch);
    store.setChain('first', [taskId], true); store.setChain('second', [taskId], true);
    expect(store.snapshot().size).toBe(0); expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000); pending.resolve(response()); await settle();
    expect(store.snapshot().get(taskId)?.indicator).toBe('working');
    await vi.advanceTimersByTimeAsync(4999); expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => url.endsWith('/sessions/current'))).toBe(true);
    store.removeChain('first'); expect(store.snapshot().has(taskId)).toBe(true);
    store.removeChain('second'); expect(store.snapshot().size).toBe(0);
  });
  it('caps concurrent requests at four and releases slots only when requests settle', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task(id(i + 1))); const { store } = await fixture(tasks);
    const calls: { pending: ReturnType<typeof deferred<Response>>; signal: AbortSignal }[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => { const pending = deferred<Response>(); calls.push({ pending, signal: init.signal! }); return pending.promise; }); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', tasks.map((t) => t.id), true); expect(fetch).toHaveBeenCalledTimes(4);
    const first = calls[0]!; first.pending.resolve(response(snapshot({ identity: { ...original.identity, taskId: tasks[0]!.id } }))); await settle();
    expect(fetch).toHaveBeenCalledTimes(5);
    store.setChain('chain', [], false); expect(calls.slice(1).every((c) => c.signal.aborted)).toBe(true);
    store.setChain('chain', tasks.map((t) => t.id), true); expect(fetch).toHaveBeenCalledTimes(5);
    calls[1]!.pending.resolve(response()); await settle(); expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('eventually reads every visible member when slow refreshes compete with unread members', async () => {
    const tasks = Array.from({ length: 9 }, (_, i) => task(id(i + 1)));
    const { store } = await fixture(tasks);
    const readIds: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const currentTask = url.split('/tasks/')[1]!.split('/')[0]!;
      readIds.push(currentTask);
      return new Promise<Response>((resolve) => setTimeout(() => resolve(response(snapshot({
        identity: { ...original.identity, taskId: currentTask }, activity: currentTask === id(9) ? 'idle' : 'working',
      }))), 6000));
    }));
    store.setChain('chain', tasks.map((item) => item.id), true);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(new Set(readIds)).toEqual(new Set(tasks.map((item) => item.id)));
    expect(store.snapshot().get(id(9))?.indicator).toBe('warning');
  });
  it('hides failures and expired reads while preserving a readable initializing entry', async () => {
    const { store } = await fixture(); const stalled = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(snapshot({ activity: 'initializing' }))).mockReturnValue(stalled.promise); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true); await settle();
    expect(store.snapshot().get(taskId)).toMatchObject({ sessionId: original.sessionId, indicator: null });
    await vi.advanceTimersByTimeAsync(15_001); expect(store.snapshot().has(taskId)).toBe(false);
    stalled.reject(new Error('offline HTTP')); await settle(); expect(store.snapshot().has(taskId)).toBe(false);
    fetch.mockResolvedValue(response(snapshot({ activity: 'waiting_input' }))); await vi.advanceTimersByTimeAsync(5000);
    expect(store.snapshot().get(taskId)?.indicator).toBe('notice');
  });
  it('invalidates an old claim synchronously and rejects its late response', async () => {
    const { scope, store } = await fixture(); const old = deferred<Response>(); const current = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockReturnValue(current.promise); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true);
    const next = { ...task(taskId, id(50)), version: 2n, updatedAt: '2026-10-22T10:00:01Z' };
    await apply(scope, [next]); expect(store.snapshot().has(taskId)).toBe(false);
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true); expect(fetch).toHaveBeenCalledOnce();
    old.resolve(response()); await settle(); expect(store.snapshot().has(taskId)).toBe(false);
    current.resolve(response(snapshot({ claimId: id(50), activity: 'waiting_input' }))); await settle();
    expect(store.snapshot().get(taskId)?.indicator).toBe('notice');
    await apply(scope, [{ ...next, version: 3n, status: 'done', completedAt: '2026-10-22T10:00:02Z', updatedAt: '2026-10-22T10:00:02Z' }]);
    expect(store.snapshot().has(taskId)).toBe(false);
  });
  it('rejects mismatched task, project and claim identities', async () => {
    const { store } = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(response(snapshot({ claimId: id(50) })))
      .mockResolvedValueOnce(response(snapshot({ identity: { ...original.identity, taskId: id(2) } })))
      .mockResolvedValueOnce(response(snapshot({ identity: { ...original.identity, projectId: id(3) } }))); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true); await settle(); expect(store.snapshot().size).toBe(0);
    await vi.advanceTimersByTimeAsync(5000); expect(store.snapshot().size).toBe(0);
    await vi.advanceTimersByTimeAsync(5000); expect(store.snapshot().size).toBe(0);
  });
  it('clears and cancels hidden pages, then immediately refreshes on return', async () => {
    const { store } = await fixture(); const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise).mockImplementation(() => response()); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true); await settle(); await vi.advanceTimersByTimeAsync(5000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    expect(store.snapshot().size).toBe(0); expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
    pending.resolve(response()); await settle(); await vi.advanceTimersByTimeAsync(30_000); expect(fetch).toHaveBeenCalledTimes(2);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); await settle();
    expect(fetch).toHaveBeenCalledTimes(3); expect(store.snapshot().get(taskId)?.indicator).toBe('working');
  });
  it('invalidates project access and scope identity without publishing late reads', async () => {
    const { scope, store } = await fixture(); const pending = deferred<Response>(); const fetch = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true);
    await scope.invalidateProject(projectId, new AbortController().signal);
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
    pending.resolve(response()); await settle(); expect(store.snapshot().size).toBe(0);
    scope.dispose(); expect(store.snapshot().size).toBe(0);
  });
  it('clears data during authentication revalidation and waits before starting a new read', async () => {
    const { store } = await fixture(); const fetch = vi.fn().mockImplementation(() => response()); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true); await settle(); const resume = pauseAuthRequests();
    try { await vi.advanceTimersByTimeAsync(250); expect(store.snapshot().size).toBe(0); await vi.advanceTimersByTimeAsync(6000); expect(fetch).toHaveBeenCalledOnce(); }
    finally { resume(); }
    await vi.advanceTimersByTimeAsync(250); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('hides unknown, missing registration and denied reads without inventing offline warnings', async () => {
    const { store } = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(response(snapshot({ activity: 'unknown' })))
      .mockResolvedValueOnce(resourceResponse({ status: 'not_registered', claimId: original.claimId, agentControlMode: 'web' }, TEST_VIEWER_ID))
      .mockResolvedValueOnce(resourceResponse({ status: 'not_applicable', claimId: original.claimId, agentControlMode: 'herdr' }, TEST_VIEWER_ID))
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce(response(snapshot({ connectionState: 'disconnected', activity: 'unknown' })));
    vi.stubGlobal('fetch', fetch); store.setChain('chain', [taskId], true); await settle(); expect(store.snapshot().size).toBe(0);
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(5000); expect(store.snapshot().size).toBe(0); }
    await vi.advanceTimersByTimeAsync(5000); expect(store.snapshot().get(taskId)?.indicator).toBe('warning');
  });
  it('rejects a response served under another account and invalidates the account scope', async () => {
    const { scope, store } = await fixture();
    const fetch = vi.fn().mockImplementation(() => response(snapshot(), id(80))); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId], true); await settle(); expect(scope.isInvalidated).toBe(true); expect(store.snapshot().size).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000); expect(fetch).toHaveBeenCalledOnce();
  });
  it('never reads missing, herdr, todo or done tasks', async () => {
    const { store } = await fixture([task(), { ...task(id(2)), properties: {} }, { ...task(id(3)), status: 'todo' }, { ...task(id(4)), status: 'done' },
      { ...task(id(5)), properties: { worker: { ...worker(), agentControlMode: 'herdr' } } }]);
    const fetch = vi.fn().mockImplementation(() => response()); vi.stubGlobal('fetch', fetch);
    store.setChain('chain', [taskId, id(2), id(3), id(4), id(5)], true); await settle(); expect(fetch).toHaveBeenCalledOnce();
  });
});
