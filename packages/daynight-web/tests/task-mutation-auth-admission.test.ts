import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteTask, getTask, pauseAuthRequests } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { canDeleteTask, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { admitTaskGraph, createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual, deleteTask: vi.fn(), getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }) }; });
const project = '10000000-0000-4000-8000-000000000001'; const task = '20000000-0000-4000-8000-000000000001'; const sibling = '20000000-0000-4000-8000-000000000002';
const initial = detailFixture(project, task, { title: 'Reviewed task', version: 9n }); const restored = { ...initial, title: 'Restored task', version: 3n };
const reads = vi.mocked(getTask); const writes = vi.mocked(deleteTask);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>(); const cleanups = new Set<() => void>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const pause = () => { const resume = pauseAuthRequests(); cleanups.add(resume); return resume; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const open = async (sessions: TaskDetailSessions) => {
  const world = worlds.get(sessions)!; await world.sync([initial]); sessions.observe(project, task, world.node(project, task)); sessions.load(project, task, 1);
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(initial));
};
const replace = async (sessions: TaskDetailSessions, details: readonly TaskDetail[]) => {
  const world = worlds.get(sessions)!; const byId = new Map(details.map((detail) => [detail.id, detail]));
  await admitTaskGraph(world.scope, graphFixture(details), { epoch: crypto.randomUUID(), versionForTask: (node) => byId.get(node.id)!.version, propertiesForTask: (node) => byId.get(node.id)!.properties });
};
const holdTransaction = (sessions: TaskDetailSessions) => {
  const world = worlds.get(sessions)!; const entered = deferred<void>(); const release = deferred<void>(); let calls = 0; const transact = world.scope.detailTransaction.bind(world.scope);
  const held: typeof world.scope.detailTransaction = async <T,>(...args: Parameters<typeof transact<T>>): Promise<T> => {
    const result = await transact<T>(...args); if (++calls === 1) { entered.resolve(); await release.promise; } return result;
  };
  vi.spyOn(world.scope, 'detailTransaction').mockImplementation(held); cleanups.add(release.resolve); return { entered: entered.promise, release: release.resolve };
};
const restoredRead = async (sessions: TaskDetailSessions) => {
  const world = worlds.get(sessions)!; sessions.observe(project, task, world.node(project, task), true); reads.mockResolvedValue(restored); sessions.requireOpeningRead(project, task); sessions.load(project, task, 3, 'open');
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored));
};
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } for (const cleanup of cleanups) cleanup(); cleanups.clear(); worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); });

describe('task mutation admission across authentication pauses', () => {
  it.each([false, true].flatMap((observe) => [false, true].map((removeDepends) => ({ observe, removeDepends }))))('rechecks expired prepared intent after history/auth changes with observe=$observe and removeDepends=$removeDepends', async ({ observe, removeDepends }) => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const gate = holdTransaction(sessions);
    sessions.deleteTask(project, task, initial.version, removeDepends); await gate.entered; const sameVersion = { ...restored, version: initial.version }; await replace(sessions, [sameVersion]);
    if (observe) sessions.observe(project, task, world.node(project, task), true);
    const resume = pause(); gate.release(); await flush(); expect(writes).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce(); expect(sessions.snapshot(project, task).mutation.phase).toBe('pending');
    reads.mockResolvedValue(sameVersion); resume(); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(sameVersion));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('conflict'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true); expect(writes).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledTimes(2);
    const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, sameVersion.version, removeDepends); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); expect(writes.mock.calls[0]![3]).toBe(removeDepends);
    pending.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
  });
  it.each(['204', '410', 'network'] as const)('waits for authentication before reconciling a sent DELETE%s from another history', async (response) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, initial.version, true); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); writes.mock.calls[0]![5].onDispatch?.();
    await replace(sessions, [restored]); const world = worlds.get(sessions)!; sessions.observe(project, task, world.node(project, task), true); const resume = pause();
    if (response === '204') { writes.mock.calls[0]![5].onWriteConfirmed?.(); pending.resolve(); } else pending.reject(response === '410' ? new ApiError('server', 410, 'task_deleted') : new ApiError('network'));
    await flush(); expect(sessions.snapshot(project, task).mutation.phase).toBe(response === '204' ? 'confirmed' : response === '410' ? 'refused' : 'unknown'); expect(sessions.snapshot(project, task).status).not.toBe('deleted'); expect(reads).toHaveBeenCalledOnce();
    reads.mockResolvedValue(restored); resume(); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
  });
  it('reenters the authentication wait when a new pause begins after ready resolves', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const entered = deferred<void>(); const ready = world.scope.ready.bind(world.scope); let readyCalls = 0; let resumeSecond!: () => void;
    vi.spyOn(world.scope, 'ready').mockImplementation(async (signal) => { await ready(signal); if (++readyCalls === 2) { resumeSecond = pause(); entered.resolve(); } });
    const getter = vi.spyOn(world.scope, 'getAuthorizedProject'); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); const resumeFirst = pause(); sessions.deleteTask(project, task, initial.version, true); resumeFirst(); await entered.promise;
    getter.mockClear(); await flush(); expect(getter).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce();
    resumeSecond(); await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(project, task, initial.version, true, expect.any(AbortSignal), expect.anything())); pending.resolve();
    await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
  });
  it('discards a waiting preparation when the authenticated identity retires', async () => {
    const sessions = createSessions(); await open(sessions); const resume = pause(); sessions.deleteTask(project, task, initial.version, true); const world = worlds.get(sessions)!;
    void world.scope.invalidateScope(); resume(); await flush(); expect(world.scope.isInvalidated).toBe(true); expect(writes).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce();
  });
  it('settles cancelled preparation locally without dispatch or a read while paused', async () => {
    const sessions = createSessions(); await open(sessions); const resume = pause();
    sessions.deleteTask(project, task, initial.version, true);
    expect(sessions.snapshot(project, task).mutation.phase).toBe('pending');
    sessions.suspendForAccountRefresh();
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: 'refused', reconciling: false }));
    expect(sessions.snapshot(project, task)).toMatchObject({ status: 'ready', detail: initial });
    expect(writes).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce();
    resume();
    await flush(); expect(writes).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce();
  });
  it('settles a dispatched, unconfirmed cancellation as unknown without replay', async () => {
    const sessions = createSessions(); await open(sessions);
    const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetcher); writes.mockImplementationOnce(actual.deleteTask);
    sessions.deleteTask(project, task, initial.version, true); await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const resume = pause(); sessions.suspendForAccountRefresh();
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: 'unknown', reconciling: false }));
    expect(sessions.snapshot(project, task)).toMatchObject({ status: 'ready', detail: initial });
    expect(reads).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
    resume(); await flush(); expect(fetcher).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
  it('retains a trusted receipt when publication is cancelled before installation', async () => {
    const sessions = createSessions(); await open(sessions); const received = deferred<void>();
    writes.mockImplementationOnce((_project, _task, _version, _removeDepends, signal, admission) => {
      admission.onDispatch?.(); admission.onWriteConfirmed?.(); received.resolve();
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    sessions.deleteTask(project, task, initial.version, true); await received.promise;
    const resume = pause(); sessions.suspendForAccountRefresh();
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: 'confirmed', reconciling: false }));
    expect(sessions.snapshot(project, task)).toMatchObject({ status: 'ready', detail: initial });
    expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
    resume(); await flush(); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
  it.each([404, 410])('keeps task content when a sent write reports %s after cancellation', async (status) => {
    const sessions = createSessions(); await open(sessions); const dispatched = deferred<void>();
    writes.mockImplementationOnce((_project, _task, _version, _removeDepends, signal, admission) => {
      admission.onDispatch?.(); dispatched.resolve();
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ApiError('server', status, status === 404 ? 'not_found' : 'task_deleted')), { once: true }));
    });
    sessions.deleteTask(project, task, initial.version, true); await dispatched.promise;
    const resume = pause(); sessions.suspendForAccountRefresh();
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: 'unknown', reconciling: false }));
    expect(sessions.snapshot(project, task)).toMatchObject({ status: 'ready', detail: initial });
    expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
    resume(); await flush(); expect(sessions.snapshot(project, task).detail).toEqual(initial); expect(reads).toHaveBeenCalledOnce();
  });
  it('keeps a restored new owner intact when an old result waits through authentication', async () => {
    const sessions = createSessions(); await open(sessions); const oldResult = deferred<void>(); const newResult = deferred<void>(); writes.mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(newResult.promise);
    sessions.deleteTask(project, task, initial.version, true); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); await replace(sessions, [detailFixture(project, sibling)]); sessions.observe(project, task, undefined, true);
    await replace(sessions, [restored]); await restoredRead(sessions); sessions.deleteTask(project, task, restored.version, true); await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    const resume = pause(); oldResult.resolve(); await flush(); expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n, removeDepends: true }, phase: 'pending' });
    resume(); await flush(); expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n, removeDepends: true }, phase: 'pending' }); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledTimes(2);
    newResult.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
  });
  it('retains task content until a paused 404 can be admitted after authentication resumes', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const response = deferred<Response>(); const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
    sessions.subscribe(project, task, () => {}); const notices: string[] = []; world.scope.subscribe((event) => { if (event.taskNotFound) notices.push(event.projectId); });
    const fetcher = vi.fn().mockReturnValue(response.promise); vi.stubGlobal('fetch', fetcher); writes.mockImplementationOnce(actual.deleteTask); sessions.deleteTask(project, task, initial.version, true);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); const revoke = vi.spyOn(world.scope, 'revokeProject'); const resume = pause();
    response.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'No project access', requestId: 'paused-denied' } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) }));
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: 'refused', reconciling: false }));
    expect(sessions.snapshot(project, task)).toMatchObject({ status: 'ready', detail: initial }); expect(revoke).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce();
    expect(notices).toEqual([]); resume(); await waitFor(() => expect(notices).toEqual([project])); expect(sessions.snapshot(project, task).detail).toBeNull(); expect(world.scope.getAuthorizedProject(project)).not.toBeNull(); expect(writes).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
  });
});
