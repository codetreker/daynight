import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, setTaskStatus, withdrawWorkerClaim } from '../src/api/client';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { canSetStatus, canWithdrawClaim, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async (original) => ({
  ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskStatus: vi.fn(), withdrawWorkerClaim: vi.fn(),
}));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const claimId = '30000000-0000-4000-8000-000000000001';
const workerId = '40000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:00:00Z';
const worker: WorkerClaim = {
  claimId, state: 'active', userId: TEST_VIEWER_ID, workerId, machine: { id: workerId, name: 'Machine' },
  platform: 'macos', agent: 'codex', agentControlMode: 'herdr', worktreeId: projectId, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time,
};
const initial: TaskDetail = {
  id: taskId, projectId, title: 'Keep the delivery', description: 'Existing task materials', status: 'in_progress', version: 9_007_199_254_740_993n,
  allowAgents: true, requiredPlatform: 'macos', ready: false, dependsOn: [], externalDependsOn: [], blockedBy: [],
  properties: { worker, pullRequests: [{ title: 'Implementation', url: 'https://example.com/pull/42' }] },
  startedAt: time, completedAt: null, createdAt: time, updatedAt: time,
};
const reset: TaskDetail = { ...initial, status: 'todo', allowAgents: false, ready: true, properties: { ...initial.properties, worker: null },
  startedAt: null, completedAt: null, version: initial.version + 1n, updatedAt: '2026-10-24T00:01:00Z' };
const reads = vi.mocked(getTask);
const writes = vi.mocked(withdrawWorkerClaim);
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const createSessions = () => {
  const world = createTaskSessionWorld();
  const sessions = new TaskDetailSessions(world.scope);
  worlds.set(sessions, world);
  return sessions;
};
const synchronize = async (sessions: TaskDetailSessions, detail: TaskDetail) => {
  const world = worlds.get(sessions)!;
  await world.sync([detail]);
  sessions.observe(projectId, taskId, world.node(projectId, taskId));
};
const open = async (sessions: TaskDetailSessions, detail = initial) => {
  reads.mockResolvedValueOnce(detail);
  await synchronize(sessions, detail);
  sessions.load(projectId, taskId, 1);
  await waitFor(() => expect(sessions.snapshot(projectId, taskId).status).toBe('ready'));
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
beforeEach(() => { reads.mockReset(); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); });
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });

describe('worker claim withdrawal mutation ownership', () => {
  it('keeps the existing claim visible until one confirmed reset and excludes concurrent writes', async () => {
    const sessions = createSessions();
    await open(sessions);
    const pending = deferred<TaskDetail>();
    writes.mockReturnValueOnce(pending.promise);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    sessions.setStatus(projectId, taskId, 'todo', initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes).toHaveBeenCalledExactlyOnceWith(projectId, taskId, claimId, initial.version, expect.any(AbortSignal), expect.objectContaining({
      userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function),
    }));
    expect(setTaskStatus).not.toHaveBeenCalled();
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(initial);
    expect(canWithdrawClaim(sessions.snapshot(projectId, taskId))).toBe(false);
    await synchronize(sessions, reset);
    pending.resolve(reset);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(reset);
    expect(canWithdrawClaim(sessions.snapshot(projectId, taskId))).toBe(false);
    expect(canSetStatus(sessions.snapshot(projectId, taskId))).toBe(true);
  });

  it('rejects a stale reviewed version or different execution before dispatch', async () => {
    const sessions = createSessions();
    await open(sessions);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version - 1n);
    sessions.withdrawClaim(projectId, taskId, workerId, initial.version);
    expect(writes).not.toHaveBeenCalled();
    expect(canWithdrawClaim(sessions.snapshot(projectId, taskId))).toBe(true);
  });

  it('withdraws a released claim without requiring an in-progress task', async () => {
    const sessions = createSessions();
    const released: TaskDetail = { ...initial, status: 'todo', ready: true, startedAt: null, properties: { ...initial.properties, worker: { ...worker, state: 'released' } } };
    await open(sessions, released);
    expect(canWithdrawClaim(sessions.snapshot(projectId, taskId))).toBe(true);
    const pending = deferred<TaskDetail>();
    writes.mockReturnValueOnce(pending.promise);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    await synchronize(sessions, reset);
    pending.resolve(reset);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(reset);
  });

  it.each([null, { ...worker, state: 'completed' as const }])('refuses withdrawal without an unfinished claim %#', async (claim) => {
    const sessions = createSessions();
    const detail: TaskDetail = { ...initial, status: 'todo', ready: true, startedAt: null, properties: { ...initial.properties, worker: claim } };
    await open(sessions, detail);
    expect(canWithdrawClaim(sessions.snapshot(projectId, taskId))).toBe(false);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    expect(writes).not.toHaveBeenCalled();
  });

  it('retains a permission refusal and the original claim without automatic retry', async () => {
    const sessions = createSessions();
    await open(sessions);
    const failure = new ApiError('server', 403, 'forbidden', 'withdrawal-denied');
    writes.mockRejectedValueOnce(failure);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe('refused'));
    expect(sessions.snapshot(projectId, taskId).mutation.error).toBe(failure);
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(initial);
    expect(writes).toHaveBeenCalledOnce();
    expect(reads).toHaveBeenCalledOnce();
  });

  it.each([new ApiError('network'), new ApiError('server', 409, 'version_conflict')])('checks unknown/conflicted outcomes using GET without another POST %#', async (failure) => {
    const sessions = createSessions();
    await open(sessions);
    reads.mockResolvedValueOnce(reset);
    writes.mockRejectedValueOnce(failure);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    await synchronize(sessions, reset);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).detail?.properties.worker).toBeNull());
    expect(reads).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenCalledOnce();
    expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe(failure.kind === 'network' ? 'reconciled' : 'conflict');
    expect(sessions.snapshot(projectId, taskId).mutation.error).toBe(failure);
  });

  it('blocks further writes while the outcome and current task cannot be read', async () => {
    const sessions = createSessions();
    await open(sessions);
    const readFailure = new ApiError('network');
    reads.mockRejectedValueOnce(readFailure);
    writes.mockRejectedValueOnce(new ApiError('network'));
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.reconciliationError).toBe(readFailure));
    expect(canWithdrawClaim(sessions.snapshot(projectId, taskId))).toBe(false);
    expect(canSetStatus(sessions.snapshot(projectId, taskId))).toBe(false);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    expect(writes).toHaveBeenCalledOnce();
    reads.mockResolvedValueOnce(reset);
    await synchronize(sessions, reset);
    sessions.reconcile(projectId, taskId);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(reset);
    expect(writes).toHaveBeenCalledOnce();
  });

  it.each([
    { ...reset, title: 'Replaced title' },
    { ...reset, description: '' },
    { ...reset, properties: { worker: null, pullRequests: [] } },
    { ...reset, requiredPlatform: null },
    { ...reset, allowAgents: true },
  ])('rejects a response that changes materials outside the reset %#', async (contradiction) => {
    const sessions = createSessions();
    await open(sessions);
    reads.mockResolvedValueOnce(reset);
    writes.mockResolvedValueOnce(contradiction);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    await synchronize(sessions, reset);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(projectId, taskId).mutation.error).toMatchObject({ kind: 'protocol' });
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(reset);
    expect(writes).toHaveBeenCalledOnce();
  });

  it('lets a submitted withdrawal finish after its view releases the read', async () => {
    const sessions = createSessions();
    const unsubscribe = sessions.subscribe(projectId, taskId, vi.fn());
    await open(sessions);
    const pending = deferred<TaskDetail>();
    writes.mockReturnValueOnce(pending.promise);
    sessions.withdrawClaim(projectId, taskId, claimId, initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    unsubscribe();
    expect(writes.mock.calls[0]![4].aborted).toBe(false);
    await synchronize(sessions, reset);
    pending.resolve(reset);
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(projectId, taskId).detail).toEqual(reset);
  });
});
