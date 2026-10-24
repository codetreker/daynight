import { createTaskSessionWorld } from "./helpers/taskSessions";
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const synchronize = async (sessions: TaskDetailSessions, detail: TaskDetail) => {
  const world = worlds.get(sessions)!; await world.sync([detail]); sessions.observe(detail.projectId, detail.id, world.node(detail.projectId, detail.id));
};
const open = async (sessions: TaskDetailSessions, detail: TaskDetail = initial) => {
  await synchronize(sessions, detail); sessions.load(project, id, 1); await waitFor(() => expect(sessions.snapshot(project, id).status).toBe('ready'));
};
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); });

describe('shared task mutation ownership', () => {
  it('retains the saved flag until one confirmed write and blocks both duplicate permission and status writes', async () => {
    const sessions = createSessions(); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setAgentPermission(project, id, true, initial.version);
    sessions.setAgentPermission(project, id, true, initial.version); sessions.setStatus(project, id, 'in_progress', initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, id, true, initial.version, expect.any(AbortSignal), expect.objectContaining({ userId: worlds.get(sessions)!.scope.userId, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(setTaskStatus).not.toHaveBeenCalled();
    expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(false);
    expect(canSetStatus(sessions.snapshot(project, id))).toBe(false);
    await synchronize(sessions, changed); pending.resolve(changed);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
    await waitFor(() => expect(sessions.snapshot(project, id).detail).toEqual(changed));
    expect(sessions.snapshot(project, id).detail?.status).toBe('todo');
  });
  it('keeps a submitted permission write through view release and does not change another task', async () => {
    const sessions = createSessions(); const release = sessions.subscribe(project, id, vi.fn()); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setAgentPermission(project, id, true, initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); release();
    sessions.load(project, id, 2);
    expect(reads).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes.mock.calls[0]![4].aborted).toBe(false);
    expect(sessions.snapshot(project, 'other').detail).toBeNull();
    await synchronize(sessions, changed); pending.resolve(changed);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(true));
    expect(sessions.snapshot(project, 'other').detail).toBeNull();
  });
  it('blocks permission while an status write owns the same task', async () => {
    const sessions = createSessions(); await open(sessions);
    const pending = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise);
    sessions.setStatus(project, id, 'in_progress', initial.version); sessions.setAgentPermission(project, id, true, initial.version);
    expect(writes).not.toHaveBeenCalled();
    const running: TaskDetail = { ...initial, status: 'in_progress', ready: false, startedAt: '2026-10-24T00:01:00Z', version: initial.version + 1n };
    await synchronize(sessions, running); pending.resolve(running);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false);
  });
  it('rejects stale, same-value and executing permission requests before dispatch', async () => {
    const sessions = createSessions(); await open(sessions);
    sessions.setAgentPermission(project, id, true, initial.version - 1n);
    sessions.setAgentPermission(project, id, false, initial.version);
    expect(writes).not.toHaveBeenCalled();
    const running: TaskDetail = { ...initial, status: 'in_progress', ready: false, startedAt: '2026-10-24T00:01:00Z', version: initial.version + 1n };
    reads.mockResolvedValueOnce(running); await synchronize(sessions, running); sessions.load(project, id, 2);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.status).toBe('in_progress'));
    sessions.setAgentPermission(project, id, true, initial.version);
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });
  it('preserves a refusal and retries only after a fresh explicit operation', async () => {
    const sessions = createSessions(); await open(sessions);
    const refusal = new ApiError('server', 403, 'forbidden', 'refused'); writes.mockRejectedValueOnce(refusal).mockResolvedValueOnce(changed);
    sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('refused'));
    expect(sessions.snapshot(project, id).mutation.error).toBe(refusal);
    expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);
    sessions.setAgentPermission(project, id, true, initial.version);
    await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
  });
  it.each([new ApiError('network'), new ApiError('server', 409, 'version_conflict')])('reconciles uncertain/conflicted outcomes without resubmitting %#', async (failure) => {
    const sessions = createSessions(); reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); await open(sessions);
    writes.mockRejectedValueOnce(failure); sessions.setAgentPermission(project, id, true, initial.version);
    await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.allowAgents).toBe(true));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(sessions.snapshot(project, id).mutation.error).toBe(failure);
    expect(sessions.snapshot(project, id).mutation.phase).toBe(failure.kind === 'network' ? 'reconciled' : 'conflict');
  });
  it('keeps both mutation gates closed while reconciliation fails', async () => {
    const sessions = createSessions(); const readError = new ApiError('network');
    reads.mockResolvedValueOnce(initial).mockRejectedValueOnce(readError); await open(sessions);
    writes.mockRejectedValueOnce(new ApiError('protocol')); sessions.setAgentPermission(project, id, true, initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.reconciliationError).toBe(readError));
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false);
    expect(canSetStatus(sessions.snapshot(project, id))).toBe(false);
    reads.mockResolvedValueOnce(changed); await synchronize(sessions, changed); sessions.reconcile(project, id);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled'));
    expect(writes).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...changed, status: 'done' as const }, { ...changed, allowAgents: false }, { ...changed, version: initial.version }])('treats a contradictory confirmed result as unknown and checks actual state %#', async (result) => {
    const sessions = createSessions(); reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); await open(sessions);
    writes.mockResolvedValueOnce(result); sessions.setAgentPermission(project, id, true, initial.version);
    await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, id).mutation.error).toMatchObject({ kind: 'protocol' });
    expect(writes).toHaveBeenCalledTimes(1);
  });
});
