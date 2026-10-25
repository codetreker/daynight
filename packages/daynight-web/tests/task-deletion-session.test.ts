import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteTask, getTask, setTaskAgentPermission, setTaskRequiredPlatform, setTaskStatus } from '../src/api/client';
import type { TaskDetail, TaskStatus } from '../src/api/types';
import { canDeleteTask, canSetAgentPermission, canSetRequiredPlatform, canSetStatus, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { admitTaskGraph, createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), deleteTask: vi.fn(), getTask: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const sibling = '20000000-0000-4000-8000-000000000002';
const initial = detailFixture(project, task, { title: 'Delete reviewed task', version: 9_007_199_254_740_993n });
const source = (status: TaskStatus): TaskDetail => ({ ...initial, status, ready: status === 'todo', startedAt: status === 'todo' ? null : initial.createdAt, completedAt: status === 'done' ? initial.createdAt : null });
const reads = vi.mocked(getTask); const writes = vi.mocked(deleteTask);
const deleted = () => new ApiError('server', 410, 'task_deleted', 'deleted-request');
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const open = async (sessions: TaskDetailSessions, detail = initial) => {
  const world = worlds.get(sessions)!; await world.sync([detail]); sessions.observe(project, task, world.node(project, task)); sessions.load(project, task, 1);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
};
const remove = (sessions: TaskDetailSessions, version = initial.version) => sessions.deleteTask(project, task, version);
const expectDeleted = async (sessions: TaskDetailSessions) => {
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
  expect(sessions.snapshot(project, task).detail).toBeNull();
  expect(canDeleteTask(sessions.snapshot(project, task))).toBe(false); expect(canSetStatus(sessions.snapshot(project, task))).toBe(false);
};
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); vi.mocked(setTaskAgentPermission).mockReset(); vi.mocked(setTaskRequiredPlatform).mockReset(); });

describe('task-local soft-delete ownership', () => {
  it.each(['todo', 'in_progress', 'done'] as const)('deletes an unclaimed %s task once using the reviewed version and refreshes its project', async (status) => {
    const detail = source(status); reads.mockResolvedValue(detail); writes.mockResolvedValueOnce();
    const sessions = createSessions(); const refresh = vi.fn(); sessions.subscribeProject(project, refresh); await open(sessions, detail);
    expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true); remove(sessions); await expectDeleted(sessions);
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, task, initial.version, expect.any(AbortSignal), expect.objectContaining({ userId: worlds.get(sessions)!.scope.userId, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'); expect(refresh).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
  it('does not dispatch a stale reviewed version', async () => {
    const sessions = createSessions(); await open(sessions); remove(sessions, initial.version - 1n); expect(writes).not.toHaveBeenCalled(); expect(sessions.snapshot(project, task).detail).toEqual(initial);
  });
  it('excludes every other mutation while deletion is pending', async () => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); remove(sessions); remove(sessions);
    sessions.setStatus(project, task, 'done', initial.version); sessions.setAgentPermission(project, task, true, initial.version); sessions.setRequiredPlatform(project, task, 'linux', initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); const state = sessions.snapshot(project, task);
    expect(canDeleteTask(state)).toBe(false); expect(canSetStatus(state)).toBe(false); expect(canSetAgentPermission(state)).toBe(false); expect(canSetRequiredPlatform(state)).toBe(false);
    expect(setTaskStatus).not.toHaveBeenCalled(); expect(setTaskAgentPermission).not.toHaveBeenCalled(); expect(setTaskRequiredPlatform).not.toHaveBeenCalled();
    pending.resolve(); await expectDeleted(sessions);
  });
  it.each(['dependency_unsatisfied', 'invalid_transition'] as const)('preserves the task and explicit %s refusal without retry', async (code) => {
    const sessions = createSessions(); await open(sessions); const failure = new ApiError('server', 409, code, 'refused'); writes.mockRejectedValueOnce(failure); remove(sessions);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('refused')); expect(sessions.snapshot(project, task).detail).toEqual(initial); expect(sessions.snapshot(project, task).mutation.error).toBe(failure);
    expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
  it('reconciles a lost deletion response by GET410 without revoking project access', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const revoke = vi.spyOn(world.scope, 'revokeProject'); const refresh = vi.fn(); sessions.subscribeProject(project, refresh);
    writes.mockRejectedValueOnce(new ApiError('network')); reads.mockRejectedValueOnce(deleted()); remove(sessions); await expectDeleted(sessions);
    expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2); expect(revoke).not.toHaveBeenCalled(); expect(world.scope.getAuthorizedProject(project)).not.toBeNull(); expect(refresh).toHaveBeenCalled();
  });
  it('treats an explicit already-deleted response as task-local disappearance', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const revoke = vi.spyOn(world.scope, 'revokeProject'); writes.mockRejectedValueOnce(deleted()); remove(sessions); await expectDeleted(sessions);
    expect(revoke).not.toHaveBeenCalled(); expect(world.scope.getAuthorizedProject(project)).not.toBeNull(); expect(writes).toHaveBeenCalledOnce();
  });
  it('clears a remotely deleted task during ordinary refresh without hiding its sibling', async () => {
    const sessions = createSessions(); const world = worlds.get(sessions)!; const surviving = detailFixture(project, sibling, { title: 'Surviving task' }); await world.sync([surviving]); await open(sessions);
    const revoke = vi.spyOn(world.scope, 'revokeProject'); reads.mockRejectedValueOnce(deleted()); sessions.load(project, task, 2); await expectDeleted(sessions);
    expect(revoke).not.toHaveBeenCalled(); expect(world.scope.getAuthorizedProject(project)?.index.nodes.has(sibling)).toBe(true); expect(writes).not.toHaveBeenCalled();
  });
  it('retains both uncertain failures and prevents mutation until a deliberate GET succeeds', async () => {
    const sessions = createSessions(); await open(sessions); const writeFailure = new ApiError('network'); const readFailure = new ApiError('network'); writes.mockRejectedValueOnce(writeFailure); reads.mockRejectedValueOnce(readFailure); remove(sessions);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.reconciliationError).toBe(readFailure));
    const state = sessions.snapshot(project, task); expect(state.mutation.error).toBe(writeFailure); expect(canDeleteTask(state)).toBe(false); remove(sessions); sessions.load(project, task, 3); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
    reads.mockRejectedValueOnce(deleted()); sessions.reconcile(project, task); await expectDeleted(sessions); expect(reads).toHaveBeenCalledTimes(3); expect(writes).toHaveBeenCalledOnce();
  });
  it('accepts live task reconciliation without automatically replaying the deletion', async () => {
    const sessions = createSessions(); await open(sessions); writes.mockRejectedValueOnce(new ApiError('network')); reads.mockResolvedValueOnce(initial); remove(sessions);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled')); expect(sessions.snapshot(project, task).detail).toEqual(initial); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
  });
  it('keeps an already submitted deletion alive after closing its last view', async () => {
    const sessions = createSessions(); const release = sessions.subscribe(project, task, vi.fn()); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); remove(sessions);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); const requestSignal = writes.mock.calls[0]![3]; release(); sessions.releaseRead(project, task); expect(requestSignal.aborted).toBe(false);
    pending.resolve(); await expectDeleted(sessions); expect(writes).toHaveBeenCalledOnce();
  });
  it('keeps terminal deletion through an epoch replacement and never reloads retained data', async () => {
    const sessions = createSessions(); await open(sessions); writes.mockResolvedValueOnce(); remove(sessions); await expectDeleted(sessions);
    const world = worlds.get(sessions)!; const surviving = detailFixture(project, sibling);
    await admitTaskGraph(world.scope, graphFixture([surviving]), { epoch: crypto.randomUUID(), versionForTask: () => 1n });
    sessions.observe(project, task, undefined); sessions.load(project, task, 2, 'automatic'); sessions.requireOpeningRead(project, task); sessions.load(project, task, 3, 'open');
    expect(sessions.snapshot(project, task).status).toBe('deleted'); expect(sessions.snapshot(project, task).detail).toBeNull(); expect(reads).toHaveBeenCalledOnce(); expect(world.scope.getAuthorizedProject(project)?.index.nodes.has(sibling)).toBe(true);
  });
  it('settles an unknown deletion from the replacement snapshot while its GET is in flight', async () => {
    const sessions = createSessions(); await open(sessions); const probe = deferred<TaskDetail>();
    writes.mockRejectedValueOnce(new ApiError('network')); reads.mockReturnValueOnce(probe.promise); remove(sessions);
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('unknown'); expect(sessions.snapshot(project, task).mutation.reconciling).toBe(true);
    const readSignal = reads.mock.calls[1]![2]; const world = worlds.get(sessions)!; const revoke = vi.spyOn(world.scope, 'revokeProject');
    const surviving = detailFixture(project, sibling);
    await admitTaskGraph(world.scope, graphFixture([surviving]), { epoch: crypto.randomUUID(), versionForTask: () => 1n });
    sessions.observe(project, task, undefined, true); await expectDeleted(sessions);
    expect(readSignal.aborted).toBe(true); expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(sessions.snapshot(project, task).mutation.reconciling).toBe(false);
    expect(revoke).not.toHaveBeenCalled(); expect(world.scope.getAuthorizedProject(project)?.index.nodes.has(sibling)).toBe(true);
    probe.resolve(initial); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(project, task).status).toBe('deleted'); expect(sessions.snapshot(project, task).detail).toBeNull(); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
  });
  it('keeps disappearance settled when the pending DELETE later loses its response', async () => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); remove(sessions);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); const world = worlds.get(sessions)!;
    await admitTaskGraph(world.scope, graphFixture([detailFixture(project, sibling)]), { epoch: crypto.randomUUID(), versionForTask: () => 1n });
    sessions.observe(project, task, undefined, true); await expectDeleted(sessions);
    pending.reject(new ApiError('network')); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(project, task).status).toBe('deleted'); expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(sessions.snapshot(project, task).mutation.reconciling).toBe(false);
    expect(reads).toHaveBeenCalledOnce(); expect(writes).toHaveBeenCalledOnce(); expect(world.scope.getAuthorizedProject(project)?.index.nodes.has(sibling)).toBe(true);
  });
  it('does not expose a late write result after the authenticated scope retires', async () => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); remove(sessions); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    const world = worlds.get(sessions)!; void world.scope.invalidateScope(); pending.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(world.scope.isInvalidated).toBe(true); expect(sessions.snapshot(project, task).status).not.toBe('deleted'); expect(writes).toHaveBeenCalledOnce();
  });
});
