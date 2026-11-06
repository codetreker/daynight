import { waitForState as waitFor } from './helpers/waitForState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, setTaskStatus, unpauseTask } from '../src/api/client';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { canSetStatus, canUnpause, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), unpauseTask: vi.fn(), setTaskStatus: vi.fn() }; });
const project = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:00:00Z';
const worker: WorkerClaim = {
  claimId: '30000000-0000-4000-8000-000000000001', workerId: '40000000-0000-4000-8000-000000000001',
  userId: TEST_VIEWER_ID, state: 'active', machine: { id: project, name: 'Machine' }, platform: 'linux', agent: 'codex',
  agentControlMode: 'herdr', worktreeId: project, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time,
};
const initial = detailFixture(project, taskId, { status: 'in_progress', allowAgents: true, ready: false, startedAt: time, version: 9_007_199_254_740_993n,
  properties: { paused: true, worker, pullRequests: [{ title: 'Delivery', url: 'https://example.com/pull/42' }], future: { enabled: true } } });
const changed: TaskDetail = { ...initial, properties: { ...initial.properties, paused: false }, version: initial.version + 1n, updatedAt: '2026-10-24T00:01:00Z' };
const reads = vi.mocked(getTask); const writes = vi.mocked(unpauseTask);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const synchronize = async (sessions: TaskDetailSessions, detail: TaskDetail) => { const world = worlds.get(sessions)!; await world.sync([detail]); sessions.observe(project, detail.id, world.node(project, detail.id)); };
const open = async (sessions: TaskDetailSessions, detail = initial) => {
  reads.mockResolvedValue(detail); await synchronize(sessions, detail); sessions.load(project, taskId, 1);
  await waitFor(() => expect(sessions.snapshot(project, taskId).detail).toEqual(detail));
};
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });
beforeEach(() => { reads.mockReset(); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); });

describe('unpause mutation ownership', () => {
  it('unpauses an executing task once while preserving claim, materials, timings and permission', async () => {
    const sessions = createSessions(); await open(sessions); expect(canUnpause(sessions.snapshot(project, taskId))).toBe(true);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.unpause(project, taskId, initial.version); sessions.unpause(project, taskId, initial.version); sessions.setStatus(project, taskId, 'done', initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(project, taskId, initial.version, expect.any(AbortSignal), expect.objectContaining({ userId: TEST_VIEWER_ID, onWriteConfirmed: expect.any(Function) })));
    expect(setTaskStatus).not.toHaveBeenCalled(); expect(canUnpause(sessions.snapshot(project, taskId))).toBe(false);
    expect(sessions.snapshot(project, taskId).detail).toEqual(initial);
    await synchronize(sessions, changed); pending.resolve(changed);
    await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(project, taskId).detail).toEqual(changed); expect(canUnpause(sessions.snapshot(project, taskId))).toBe(false);
    sessions.unpause(project, taskId, changed.version); expect(writes).toHaveBeenCalledOnce();
  });
  it.each([{}, { paused: false }])('does not dispatch when the current task is not paused: %j', async (properties) => {
    const sessions = createSessions(); await open(sessions, { ...initial, properties });
    expect(canUnpause(sessions.snapshot(project, taskId))).toBe(false); sessions.unpause(project, taskId, initial.version); expect(writes).not.toHaveBeenCalled();
  });
  it('rejects a reviewed old version and remains blocked while a status write owns the task', async () => {
    const sessions = createSessions(); await open(sessions); sessions.unpause(project, taskId, initial.version - 1n); expect(writes).not.toHaveBeenCalled();
    const pending = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise);
    sessions.setStatus(project, taskId, 'done', initial.version); sessions.unpause(project, taskId, initial.version);
    expect(canUnpause(sessions.snapshot(project, taskId))).toBe(false); expect(writes).not.toHaveBeenCalled();
  });
  it('keeps a refusal visible and permits a new explicit unpause', async () => {
    const sessions = createSessions(); await open(sessions); const failure = new ApiError('server', 403, 'forbidden');
    writes.mockRejectedValueOnce(failure).mockResolvedValueOnce(changed); sessions.unpause(project, taskId, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.phase).toBe('refused'));
    expect(sessions.snapshot(project, taskId).mutation.error).toBe(failure); expect(canUnpause(sessions.snapshot(project, taskId))).toBe(true);
    sessions.unpause(project, taskId, initial.version); await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.phase).toBe('confirmed')); expect(writes).toHaveBeenCalledTimes(2);
  });
  it.each([new ApiError('network'), new ApiError('server', 409, 'version_conflict')])('reconciles an unknown or conflicting outcome without replaying the write %#', async (failure) => {
    const sessions = createSessions(); await open(sessions); reads.mockResolvedValueOnce(changed); writes.mockRejectedValueOnce(failure);
    sessions.unpause(project, taskId, initial.version); await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, taskId).detail).toEqual(changed));
    await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.reconciling).toBe(false));
    expect(sessions.snapshot(project, taskId).mutation.phase).toBe(failure.code === 'version_conflict' ? 'conflict' : 'reconciled');
    expect(sessions.snapshot(project, taskId).detail).toEqual(changed); expect(sessions.snapshot(project, taskId).mutation.error).toBe(failure); expect(writes).toHaveBeenCalledOnce();
  });
  it('blocks further writes after an unknown outcome until a fresh state check succeeds', async () => {
    const sessions = createSessions(); await open(sessions); const failure = new ApiError('network'); reads.mockRejectedValueOnce(failure); writes.mockRejectedValueOnce(failure);
    sessions.unpause(project, taskId, initial.version); await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.reconciliationError).toBe(failure));
    expect(canUnpause(sessions.snapshot(project, taskId))).toBe(false); expect(canSetStatus(sessions.snapshot(project, taskId))).toBe(false);
    sessions.unpause(project, taskId, initial.version); expect(writes).toHaveBeenCalledOnce();
    reads.mockResolvedValueOnce(changed); await synchronize(sessions, changed); sessions.reconcile(project, taskId);
    await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.phase).toBe('reconciled')); expect(writes).toHaveBeenCalledOnce();
  });
  it.each([
    { status: 'done' as const }, { allowAgents: false }, { startedAt: null }, { title: 'Replaced' }, { assignedTo: taskId },
    { properties: { ...changed.properties, future: {} } }, { properties: { ...changed.properties, worker: { ...worker, phase: 'waiting' } } }, { version: initial.version },
  ])('reconciles responses that change unrelated state or cannot prove the property mutation %#', async (fields) => {
    const sessions = createSessions(); await open(sessions); reads.mockResolvedValueOnce(changed); writes.mockResolvedValueOnce({ ...changed, ...fields });
    sessions.unpause(project, taskId, initial.version); await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, taskId).mutation.error).toMatchObject({ kind: 'protocol' }); expect(sessions.snapshot(project, taskId).detail).toEqual(changed); expect(writes).toHaveBeenCalledOnce();
  });
  it('keeps the submitted intent through view closure without affecting another task', async () => {
    const sessions = createSessions(); const close = sessions.subscribe(project, taskId, vi.fn()); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise); sessions.unpause(project, taskId, initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); close(); sessions.releaseRead(project, taskId); sessions.unpause(project, taskId, initial.version);
    const other = detailFixture(project, '20000000-0000-4000-8000-000000000002'); await synchronize(sessions, other); expect(sessions.snapshot(project, other.id).detail).toBeNull();
    await synchronize(sessions, changed); pending.resolve(changed); await waitFor(() => expect(sessions.snapshot(project, taskId).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(project, other.id).detail).toBeNull(); expect(writes).toHaveBeenCalledOnce();
  });
});
