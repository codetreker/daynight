import { createTaskSessionWorld } from "./helpers/taskSessions";
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setTaskStatus, getTask, setTaskAgentPermission, setTaskRequiredPlatform } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { canSetStatus, canSetAgentPermission, canSetRequiredPlatform, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const initial: TaskDetail = { id, projectId: project, title: 'Task', description: '', status: 'todo', version: 9007199254740993n,
  allowAgents: false, requiredPlatform: null, ready: true, dependsOn: [], externalDependsOn: [], blockedBy: [], properties: { worker: null, pullRequests: [] }, startedAt: null, completedAt: null,
  createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
const changed: TaskDetail = { ...initial, requiredPlatform: 'linux', version: initial.version + 1n };
const reads = vi.mocked(getTask); const writes = vi.mocked(setTaskRequiredPlatform);
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
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); vi.mocked(setTaskAgentPermission).mockReset(); });

describe('platform mutation ownership', () => {
  it('retains confirmed platform and serializes permission, platform and status writes', async () => {
    const sessions = createSessions(); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setRequiredPlatform(project, id, 'linux', initial.version);
    sessions.setRequiredPlatform(project, id, 'windows', initial.version); sessions.setAgentPermission(project, id, true, initial.version); sessions.setStatus(project, id, 'in_progress', initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, id, 'linux', initial.version, expect.any(AbortSignal), expect.objectContaining({ userId: worlds.get(sessions)!.scope.userId, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(setTaskAgentPermission).not.toHaveBeenCalled(); expect(setTaskStatus).not.toHaveBeenCalled();
    expect(sessions.snapshot(project, id).detail?.requiredPlatform).toBeNull();
    expect(canSetRequiredPlatform(sessions.snapshot(project, id))).toBe(false);
    await synchronize(sessions, changed); pending.resolve(changed); await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
    await waitFor(() => expect(sessions.snapshot(project, id).detail).toEqual(changed));
    expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(true);
  });
  it('clears a platform with an explicit null', async () => {
    reads.mockResolvedValueOnce(changed); const sessions = createSessions(); await open(sessions, changed);
    const cleared = { ...changed, requiredPlatform: null, version: changed.version + 1n }; writes.mockResolvedValueOnce(cleared);
    sessions.setRequiredPlatform(project, id, null, changed.version);
    await synchronize(sessions, cleared);
    await waitFor(() => expect(sessions.snapshot(project, id).detail).toEqual(cleared));
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, id, null, changed.version, expect.any(AbortSignal), expect.objectContaining({ userId: worlds.get(sessions)!.scope.userId, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
  });
  it('rejects same-value, stale-version and executing changes before dispatch', async () => {
    const sessions = createSessions(); await open(sessions);
    sessions.setRequiredPlatform(project, id, null, initial.version); sessions.setRequiredPlatform(project, id, 'linux', initial.version - 1n);
    const running: TaskDetail = { ...initial, status: 'in_progress', ready: false, startedAt: '2026-10-24T00:01:00Z', version: initial.version + 1n };
    reads.mockResolvedValueOnce(running); await synchronize(sessions, running); sessions.load(project, id, 2);
    await waitFor(() => expect(sessions.snapshot(project, id).detail?.status).toBe('in_progress'));
    sessions.setRequiredPlatform(project, id, 'linux', initial.version);
    expect(canSetRequiredPlatform(sessions.snapshot(project, id))).toBe(false); expect(writes).not.toHaveBeenCalled();
  });
  it('keeps a submitted write through closing, re-opening and another task', async () => {
    const sessions = createSessions(); const release = sessions.subscribe(project, id, vi.fn()); await open(sessions);
    const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setRequiredPlatform(project, id, 'linux', initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); release(); sessions.load(project, id, 2);
    expect(reads).toHaveBeenCalledTimes(1); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); expect(writes.mock.calls[0]![4].aborted).toBe(false);
    expect(sessions.snapshot(project, 'other').detail).toBeNull();
    await synchronize(sessions, changed); pending.resolve(changed); await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(project, 'other').detail).toBeNull();
  });
  it('blocks platform saves while a permission or status write owns the task', async () => {
    for (const action of ['permission', 'status']) {
      const sessions = createSessions(); await open(sessions); const pending = deferred<TaskDetail>();
      if (action === 'permission') { vi.mocked(setTaskAgentPermission).mockReturnValueOnce(pending.promise); sessions.setAgentPermission(project, id, true, initial.version); }
      else { vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise); sessions.setStatus(project, id, 'in_progress', initial.version); }
      sessions.setRequiredPlatform(project, id, 'linux', initial.version); expect(writes).not.toHaveBeenCalled();
      const saved: TaskDetail = { ...initial, version: initial.version + 1n, ...(action === 'permission' ? { allowAgents: true } : { status: 'in_progress' as const, ready: false, startedAt: '2026-10-24T00:01:00Z' }) };
      await synchronize(sessions, saved); pending.resolve(saved);
      await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed')); sessions.dispose();
    }
  });
  it('preserves a refusal until a new explicit save', async () => {
    const failure = new ApiError('server', 403, 'forbidden', 'platform-refusal'); const sessions = createSessions(); await open(sessions);
    writes.mockRejectedValueOnce(failure).mockResolvedValueOnce(changed); sessions.setRequiredPlatform(project, id, 'linux', initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('refused'));
    expect(sessions.snapshot(project, id).detail?.requiredPlatform).toBeNull(); expect(writes).toHaveBeenCalledTimes(1);
    sessions.setRequiredPlatform(project, id, 'linux', initial.version); await synchronize(sessions, changed); await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('confirmed'));
  });
  it.each([new ApiError('network'), new ApiError('server', 409, 'version_conflict')])('reconciles an unknown or conflicting result without resubmitting %#', async (failure) => {
    reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); const sessions = createSessions(); await open(sessions);
    writes.mockRejectedValueOnce(failure); sessions.setRequiredPlatform(project, id, 'linux', initial.version);
    await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, id).detail).toEqual(changed));
    expect(writes).toHaveBeenCalledTimes(1); expect(sessions.snapshot(project, id).mutation.error).toBe(failure);
  });
  it('keeps all mutation gates closed when reconciliation fails, until an explicit check succeeds', async () => {
    const failure = new ApiError('network'); reads.mockResolvedValueOnce(initial).mockRejectedValueOnce(failure);
    const sessions = createSessions(); await open(sessions); writes.mockRejectedValueOnce(new ApiError('protocol'));
    sessions.setRequiredPlatform(project, id, 'linux', initial.version);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.reconciliationError).toBe(failure));
    expect(canSetStatus(sessions.snapshot(project, id))).toBe(false); expect(canSetAgentPermission(sessions.snapshot(project, id))).toBe(false); expect(canSetRequiredPlatform(sessions.snapshot(project, id))).toBe(false);
    reads.mockResolvedValueOnce(changed); await synchronize(sessions, changed); sessions.reconcile(project, id);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled')); expect(writes).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...changed, status: 'done' as const }, { ...changed, allowAgents: true }, { ...changed, requiredPlatform: 'windows' as const }, { ...changed, version: initial.version }])('reconciles a response that changes unrelated state or cannot prove the save %#', async (result) => {
    reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); const sessions = createSessions(); await open(sessions);
    writes.mockResolvedValueOnce(result); sessions.setRequiredPlatform(project, id, 'linux', initial.version);
    await synchronize(sessions, changed);
    await waitFor(() => expect(sessions.snapshot(project, id).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, id).mutation.error).toMatchObject({ kind: 'protocol' }); expect(writes).toHaveBeenCalledTimes(1);
  });
});
