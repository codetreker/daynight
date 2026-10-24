import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setTaskStatus, getTask, setTaskAgentPermission } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { canSetStatus, canSetAgentPermission, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const initial: TaskDetail = { requiredPlatform: 'macos', id, projectId: project, title: 'Task', description: '', status: 'todo', version: 9007199254740993n,
  allowAgents: false, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], properties: { worker: null, pullRequests: [] }, startedAt: null, completedAt: null,
  createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
const changed = { ...initial, allowAgents: true, version: initial.version + 1n };
const reads = vi.mocked(getTask); const writes = vi.mocked(setTaskAgentPermission);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const open = async (sessions: TaskDetailSessions) => { sessions.load(project, id, 1); await waitFor(() => expect(sessions.snapshot(project, id).status).toBe('ready')); };
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); });

describe('shared task mutation ownership', () => {
  it('retains the saved flag until one confirmed write and blocks both duplicate permission and status writes', async () => {
    const sessions = new TaskDetailSessions(); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setAgentPermission(project, id, true, initial.version);
    sessions.setAgentPermission(project, id, true, initial.version); sessions.setStatus(project, id, 'in_progress', initial.version);
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, id, true, initial.version, expect.any(AbortSignal));
    expect(setTaskStatus).not.toHaveBeenCalled();
    expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(false);
    expect(canSetStatus(sessions.snapshot(project, id))).toBe(false);
    pending.resolve(changed);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(project, id).detail).toEqual(changed);
    expect(sessions.snapshot(project, id).detail?.status).toBe('todo');
  });
  it('keeps a submitted permission write through view release and does not change another task', async () => {
    const sessions = new TaskDetailSessions(); const release = sessions.subscribe(project, id, vi.fn()); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setAgentPermission(project, id, true, initial.version); release();
    sessions.load(project, id, 2);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![4].aborted).toBe(false);
    expect(sessions.snapshot(project, 'other').detail).toBeNull();
    pending.resolve(changed);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(true));
    expect(sessions.snapshot(project, 'other').detail).toBeNull();
  });
  it('blocks permission while an status write owns the same task', async () => {
    const sessions = new TaskDetailSessions(); await open(sessions);
    const pending = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise);
    sessions.setStatus(project, id, 'in_progress', initial.version); sessions.setAgentPermission(project, id, true, initial.version);
    expect(writes).not.toHaveBeenCalled();
    pending.resolve({ ...initial, status: 'in_progress', ready: false, startedAt: '2026-10-24T00:01:00Z', version: initial.version + 1n });
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false);
  });
  it('rejects stale, same-value and executing permission requests before dispatch', async () => {
    const sessions = new TaskDetailSessions(); await open(sessions);
    sessions.setAgentPermission(project, id, true, initial.version - 1n);
    sessions.setAgentPermission(project, id, false, initial.version);
    expect(writes).not.toHaveBeenCalled();
    reads.mockResolvedValueOnce({ ...initial, status: 'in_progress' }); sessions.load(project, id, 2);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.status).toBe('in_progress'));
    sessions.setAgentPermission(project, id, true, initial.version);
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });
  it('preserves a refusal and retries only after a fresh explicit operation', async () => {
    const sessions = new TaskDetailSessions(); await open(sessions);
    const refusal = new ApiError('server', 403, 'forbidden', 'refused'); writes.mockRejectedValueOnce(refusal).mockResolvedValueOnce(changed);
    sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('refused'));
    expect(sessions.snapshot(project, id).mutation.error).toBe(refusal);
    expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);
    sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
  });
  it.each([new ApiError('network'), new ApiError('server', 409, 'version_conflict')])('reconciles uncertain/conflicted outcomes without resubmitting %#', async (failure) => {
    const sessions = new TaskDetailSessions(); reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); await open(sessions);
    writes.mockRejectedValueOnce(failure); sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(true));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(sessions.snapshot(project, id).mutation.error).toBe(failure);
    expect(sessions.snapshot(project, id).mutation.phase).toBe(failure.kind === 'network' ? 'reconciled' : 'conflict');
  });
  it('keeps both mutation gates closed while reconciliation fails', async () => {
    const sessions = new TaskDetailSessions(); const readError = new ApiError('network');
    reads.mockResolvedValueOnce(initial).mockRejectedValueOnce(readError); await open(sessions);
    writes.mockRejectedValueOnce(new ApiError('protocol')); sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.reconciliationError).toBe(readError));
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false);
    expect(canSetStatus(sessions.snapshot(project, id))).toBe(false);
    reads.mockResolvedValueOnce(changed); sessions.reconcile(project, id);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled'));
    expect(writes).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...changed, status: 'done' as const }, { ...changed, allowAgents: false }, { ...changed, version: initial.version }])('treats a contradictory confirmed result as unknown and checks actual state %#', async (result) => {
    const sessions = new TaskDetailSessions(); reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); await open(sessions);
    writes.mockResolvedValueOnce(result); sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, id).mutation.error).toMatchObject({ kind: 'protocol' });
    expect(writes).toHaveBeenCalledTimes(1);
  });
});
