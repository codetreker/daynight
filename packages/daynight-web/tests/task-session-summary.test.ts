import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, pauseAuthRequests } from '../src/api/client';
import type { TaskDetail, TaskSync, WorkerClaim } from '../src/api/types';
import { createTaskCacheScope, type CachedProject, type TaskCacheScope, type TaskSyncTicket } from '../src/features/task-cache/project-cache';
import { deriveTaskSyncBindings, taskExecutionBinding } from '../src/features/task-cache/execution-binding';
import { TaskSessionSummaryStore } from '../src/features/task-session-summary/store';
import { aggregateSessionIndicators, sessionIndicator } from '../src/features/task-session-summary/summary';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, TEST_VIEWER_ID } from './helpers/taskSync';
import type { TaskSessionSnapshot } from './helpers/session';

const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')) as TaskSessionSnapshot;
const projectId = original.identity.projectId;
const taskId = original.identity.taskId;
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const worker = (changes: Partial<WorkerClaim> = {}): WorkerClaim => ({ claimId: original.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: original.identity.workerId,
  machine: { id: id(90), name: 'test' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: original.identity.worktreeId,
  phase: 'executing', herdr: null, nativeSessionId: 'native-thread-1', claimedAt: '2026-10-22T10:00:00Z', ...changes });
const task = (taskId = original.identity.taskId, changes: Partial<TaskDetail> = {}): TaskDetail => detailFixture(projectId, taskId, {
  status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', properties: { worker: { ...worker() } }, ...changes,
});
const snapshot = (changes: Partial<TaskSessionSnapshot> = {}): TaskSessionSnapshot => ({ ...original, activity: 'working', operations: { canSend: false, canRespond: false, canCancel: false }, ...changes });
const scopes: TaskCacheScope[] = [];
const stores: TaskSessionSummaryStore[] = [];
type Read = { readonly ticket: TaskSyncTicket; readonly sync: TaskSync };
async function read(scope: TaskCacheScope, tasks: readonly TaskDetail[], sessions: TaskSync['sessions'] = {}): Promise<Read> {
  const ticket = await scope.beginSync(projectId, new AbortController().signal);
  const sync = taskSyncFromGraph(graphFixture(tasks), { query: ticket.epoch ? { epoch: ticket.epoch } : {}, sessions,
    versionForTask: (node) => tasks.find((t) => t.id === node.id)!.version, propertiesForTask: (node) => tasks.find((t) => t.id === node.id)!.properties });
  return { ticket, sync };
}
const apply = (scope: TaskCacheScope, value: Read) => scope.applySync(value.ticket, value.sync, new AbortController().signal);
const publish = (store: TaskSessionSummaryStore, value: Read, project: CachedProject, receivedMonotonic = performance.now()) =>
  store.replace({ project, observedBindings: deriveTaskSyncBindings(value.ticket, value.sync), sessions: value.sync.sessions, receivedMonotonic });
async function fixture(tasks: readonly TaskDetail[] = [task()]) {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const initial = await read(scope, tasks); await apply(scope, initial);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  const store = new TaskSessionSummaryStore(scope, projectId); stores.push(store); store.start();
  store.setChain('chain', tasks.map((item) => item.id), true);
  return { scope, store };
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose()); scopes.splice(0).forEach((scope) => scope.dispose());
});

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
  it('recomputes the highest current indicator after contributions disappear', () => {
    expect(aggregateSessionIndicators(['working', 'notice', 'warning', null])).toBe('warning');
    expect(aggregateSessionIndicators(['working', 'notice', null])).toBe('notice');
    expect(aggregateSessionIndicators(['working', null])).toBe('working');
    expect(aggregateSessionIndicators([null, null])).toBeNull();
  });
});

describe('Session snapshot admission and expiry', () => {
  it('publishes all four states, retains pending access and never schedules HTTP', async () => {
    const tasks = [task(), task(id(2)), task(id(3)), task(id(4))];
    const { scope, store } = await fixture(tasks); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const value = await read(scope, tasks, { [taskId]: 'working', [id(2)]: 'notice', [id(3)]: 'warning', [id(4)]: 'pending' });
    const result = await apply(scope, value); publish(store, value, result.project);
    expect([...store.snapshot().values()].map((entry) => entry.indicator)).toEqual(['working', 'notice', 'warning', null]);
    store.setChain('second', tasks.map((item) => item.id), true); store.removeChain('chain');
    await vi.advanceTimersByTimeAsync(30_001);
    expect(store.snapshot().size).toBe(0); expect(fetch).not.toHaveBeenCalled();
  });
  it('applies a complete map even when the Task delta is empty and removes matching omissions', async () => {
    const tasks = [task(), task(id(2))]; const { scope, store } = await fixture(tasks);
    const first = await read(scope, tasks, { [taskId]: 'working', [id(2)]: 'notice' }); publish(store, first, (await apply(scope, first)).project);
    const next = await read(scope, tasks, { [taskId]: 'warning' }); const empty = { ...next, sync: { ...next.sync, tasks: [] } };
    publish(store, empty, (await apply(scope, empty)).project);
    expect(store.snapshot().get(taskId)?.indicator).toBe('warning'); expect(store.snapshot().has(id(2))).toBe(false);
    const absent = { ...next, sync: { ...next.sync, tasks: [], sessions: {} } }; publish(store, absent, (await apply(scope, absent)).project);
    expect(store.snapshot().size).toBe(0);
  });
  it('renews an unchanged state only on an accepted body receipt', async () => {
    const { scope, store } = await fixture(); const first = await read(scope, [task()], { [taskId]: 'working' });
    const project = (await apply(scope, first)).project; publish(store, first, project, 0);
    await vi.advanceTimersByTimeAsync(15_000); publish(store, first, project, 15_000);
    await vi.advanceTimersByTimeAsync(15_001); expect(store.snapshot().has(taskId)).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999); expect(store.snapshot().has(taskId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(store.snapshot().has(taskId)).toBe(false);
  });
  it('keeps the body receipt through delayed decoding and cache application', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'pending' });
    const receivedMonotonic = performance.now();
    await vi.advanceTimersByTimeAsync(12_000);
    publish(store, value, (await apply(scope, value)).project, receivedMonotonic);
    expect(store.snapshot().get(taskId)).toEqual({ indicator: null });
    await vi.advanceTimersByTimeAsync(18_000); expect(store.snapshot().has(taskId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(store.snapshot().has(taskId)).toBe(false);
  });
  it.each(['working', undefined] as const)('rejects an already expired value or omission (%s) before publishing', async (state) => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'notice' }); const project = (await apply(scope, value)).project;
    await vi.advanceTimersByTimeAsync(20_000); publish(store, value, project, 20_000);
    const listener = vi.fn(); store.subscribe(listener);
    await vi.advanceTimersByTimeAsync(11_000);
    store.replace({ project, observedBindings: deriveTaskSyncBindings(value.ticket, value.sync), sessions: state === undefined ? {} : { [taskId]: state }, receivedMonotonic: 0 });
    expect(store.snapshot().get(taskId)?.indicator).toBe('notice'); expect(listener).not.toHaveBeenCalled();
  });
  it('rechecks expiry before restoring a hidden document even when its background timer was delayed', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); publish(store, value, (await apply(scope, value)).project, 0);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));
    expect(store.snapshot().size).toBe(0);
    vi.clearAllTimers(); vi.spyOn(performance, 'now').mockReturnValue(31_001);
    visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(store.snapshot().size).toBe(0);
  });
  it('restores a valid contribution after a presentation change without renewing its receipt', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); publish(store, value, (await apply(scope, value)).project, 0);
    store.setActive(false); expect(store.snapshot().size).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000); store.setActive(true); expect(store.snapshot().has(taskId)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001); expect(store.snapshot().size).toBe(0);
  });
  it('preserves valid contributions while an ordinary sync is in flight and clears a confirmed read failure', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); publish(store, value, (await apply(scope, value)).project);
    await scope.beginSync(projectId, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000); expect(store.snapshot().get(taskId)?.indicator).toBe('working');
    store.clear(); expect(store.snapshot().size).toBe(0);
    publish(store, value, scope.getAuthorizedProject(projectId)!, performance.now()); expect(store.snapshot().has(taskId)).toBe(true);
  });
  it.each(['value', 'omission'] as const)('does not let a late old-claim %s modify or renew the new execution', async (kind) => {
    const { scope, store } = await fixture(); const old = await read(scope, [task()], kind === 'value' ? { [taskId]: 'warning' } : {});
    const changed = task(taskId, { version: 2n, updatedAt: '2026-10-22T10:00:01Z', properties: { worker: { ...worker({ claimId: id(50) }) } } });
    const newer = await read(scope, [changed], { [taskId]: 'working' });
    await vi.advanceTimersByTimeAsync(1000); publish(store, newer, (await apply(scope, newer)).project, 1000);
    await vi.advanceTimersByTimeAsync(19_000); publish(store, old, (await apply(scope, old)).project, 20_000);
    expect(store.snapshot().get(taskId)?.indicator).toBe('working');
    await vi.advanceTimersByTimeAsync(11_001); expect(store.snapshot().has(taskId)).toBe(false);
  });
  it.each([
    ['claim', { properties: { worker: { ...worker({ claimId: id(50) }) } } }],
    ['worker', { properties: { worker: { ...worker({ workerId: id(51) }) } } }],
    ['worktree', { properties: { worker: { ...worker({ worktreeId: id(52) }) } } }],
    ['mode', { properties: { worker: { ...worker({ agentControlMode: 'herdr' }) } } }],
    ['state', { properties: { worker: { ...worker({ state: 'completed' }) } } }],
    ['status', { status: 'done', completedAt: '2026-10-22T10:00:01Z', properties: { worker: { ...worker({ state: 'completed' }) } } }],
    ['missing worker', { properties: {} }],
  ] satisfies readonly (readonly [string, Partial<TaskDetail>])[])('revokes a contribution after its %s changes through the ordinary cache', async (_label, changes) => {
    const { scope, store } = await fixture(); const old = await read(scope, [task()], { [taskId]: 'working' }); publish(store, old, (await apply(scope, old)).project);
    const changed = task(taskId, { version: 2n, updatedAt: '2026-10-22T10:00:01Z', ...changes }); const next = await read(scope, [changed]);
    await apply(scope, next); expect(store.snapshot().size).toBe(0);
    publish(store, old, scope.getAuthorizedProject(projectId)!); expect(store.snapshot().size).toBe(0);
  });
  it('does not publish a status inconsistent with its observed Task binding', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); const project = (await apply(scope, value)).project;
    expect(() => store.replace({ project, observedBindings: new Map(), sessions: value.sync.sessions, receivedMonotonic: performance.now() })).toThrow(ApiError);
    expect(() => store.replace({ project, observedBindings: new Map([[taskId, { ...taskExecutionBinding(project.summaries.get(taskId)!), worker: null }]]), sessions: value.sync.sessions, receivedMonotonic: performance.now() })).toThrow(ApiError);
    expect(store.snapshot().size).toBe(0);
  });
  it('rejects a late result from another manifest generation without clearing a current contribution', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); const project = (await apply(scope, value)).project; publish(store, value, project);
    const listener = vi.fn(); store.subscribe(listener);
    const stale = { ...project, manifest: { ...project.manifest, cacheGeneration: id(99) } };
    publish(store, { ...value, sync: { ...value.sync, sessions: {} } }, stale);
    expect(store.snapshot().get(taskId)?.indicator).toBe('working'); expect(listener).not.toHaveBeenCalled();
  });
  it('clears synchronously during auth pause and requires a fresh accepted observation after resume', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); const project = (await apply(scope, value)).project; publish(store, value, project);
    const resume = pauseAuthRequests();
    try { expect(store.snapshot().size).toBe(0); publish(store, value, project); expect(store.snapshot().size).toBe(0); }
    finally { resume(); }
    expect(store.snapshot().size).toBe(0);
    publish(store, value, scope.getAuthorizedProject(projectId)!, performance.now()); expect(store.snapshot().has(taskId)).toBe(true);
  });
  it('clears revoked access and disposed scopes and rejects their late observations', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); const project = (await apply(scope, value)).project; publish(store, value, project);
    await scope.invalidateProject(projectId, new AbortController().signal); expect(store.snapshot().size).toBe(0);
    publish(store, value, project); expect(store.snapshot().size).toBe(0);
    scope.dispose(); publish(store, value, project); expect(store.snapshot().size).toBe(0);
  });
  it('publishes Session-only changes without Task persistence, notifications or graph replacement', async () => {
    const { scope, store } = await fixture(); const value = await read(scope, [task()], { [taskId]: 'working' }); const result = await apply(scope, value);
    const events = vi.fn(); const unsubscribe = scope.subscribe(events); const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction'); transaction.mockClear();
    publish(store, value, result.project); publish(store, { ...value, sync: { ...value.sync, sessions: { [taskId]: 'notice' } } }, result.project);
    expect(store.snapshot().get(taskId)?.indicator).toBe('notice'); expect(transaction).not.toHaveBeenCalled(); expect(events).not.toHaveBeenCalled();
    expect(scope.getAuthorizedProject(projectId)?.graph).toBe(result.project.graph); expect(scope.getAuthorizedProject(projectId)?.index).toBe(result.project.index);
    expect(scope.getAuthorizedProject(projectId)?.summaries.get(taskId)?.version).toBe(1n); unsubscribe();
  });
});
