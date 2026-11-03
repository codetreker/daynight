import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteTask, getTask, setTaskAgentPermission, setTaskRequiredPlatform, setTaskStatus } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { canDeleteTask, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { admitTaskGraph, createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), deleteTask: vi.fn(), getTask: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const sibling = '20000000-0000-4000-8000-000000000002';
const initial = detailFixture(project, task, { title: 'Backed-up live task', version: 9n });
const surviving = detailFixture(project, sibling);
const reads = vi.mocked(getTask); const writes = vi.mocked(deleteTask);
const gone = () => new ApiError('server', 410, 'task_deleted', 'old-history-delete');
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const open = async (sessions: TaskDetailSessions) => {
  const world = worlds.get(sessions)!; await world.sync([initial]); sessions.observe(project, task, world.node(project, task)); sessions.load(project, task, 1);
  await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('ready'));
};
const replace = async (sessions: TaskDetailSessions, details: readonly TaskDetail[]) => {
  const world = worlds.get(sessions)!; const byId = new Map(details.map((detail) => [detail.id, detail]));
  await admitTaskGraph(world.scope, graphFixture(details), { epoch: crypto.randomUUID(), versionForTask: (node) => byId.get(node.id)!.version, propertiesForTask: (node) => byId.get(node.id)!.properties });
};
const confirmDelete = async (sessions: TaskDetailSessions) => {
  writes.mockImplementationOnce(async (_project, _task, _version, _removeDepends, _signal, admission) => { admission.onWriteConfirmed?.(); });
  sessions.deleteTask(project, task, initial.version, true); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
};
const reopen = async (sessions: TaskDetailSessions, restored: TaskDetail) => {
  const world = worlds.get(sessions)!; reads.mockResolvedValue(restored);
  expect(sessions.observe(project, task, world.node(project, task), true)).toBe(true);
  expect(sessions.snapshot(project, task).detail).toBeNull(); expect(sessions.snapshot(project, task).requiresFreshRead).toBe(true);
  sessions.requireOpeningRead(project, task); sessions.load(project, task, 3, 'open');
  await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored));
  expect(sessions.snapshot(project, task).status).toBe('ready'); expect(sessions.snapshot(project, task).error).toBeNull(); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true);
};
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); vi.mocked(setTaskAgentPermission).mockReset(); vi.mocked(setTaskRequiredPlatform).mockReset(); });

describe('task deletion across authoritative history replacement', () => {
  it.each([9n, 3n])('loads a restored task at version%s after a deleted and then absent epoch', async (version) => {
    const sessions = createSessions(); await open(sessions); await confirmDelete(sessions);
    await replace(sessions, [surviving]); sessions.observe(project, task, undefined, true);
    expect(sessions.snapshot(project, task).status).toBe('deleted');
    const restored = { ...initial, title: 'Task restored from backup', version };
    await replace(sessions, [restored, surviving]); await reopen(sessions, restored);
    expect(sessions.snapshot(project, task).mutation.phase).toBe('idle'); expect(sessions.snapshot(project, task).mutation.operation).toBeNull(); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledOnce();
  });
  it('keeps the deletion terminal for a retained same-history live graph and for an unadmitted replacement', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; await confirmDelete(sessions);
    expect(sessions.observe(project, task, world.node(project, task), true)).toBe(false); sessions.load(project, task, 2);
    expect(sessions.snapshot(project, task).status).toBe('deleted'); expect(reads).toHaveBeenCalledOnce();
    const restored = { ...initial, version: 3n }; await replace(sessions, [restored]);
    expect(sessions.observe(project, task, world.node(project, task), false)).toBe(false); sessions.load(project, task, 2);
    expect(sessions.snapshot(project, task).status).toBe('deleted'); expect(reads).toHaveBeenCalledOnce();
    await reopen(sessions, restored); expect(reads).toHaveBeenCalledTimes(2);
  });
  it.each([{ response: '204', observeFirst: false }, { response: '410', observeFirst: false }, { response: '204', observeFirst: true }, { response: '410', observeFirst: true }] as const)('reconciles a late DELETE$response with the current live history and observeFirst=$observeFirst', async ({ response, observeFirst }) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, initial.version, true);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); const restored = { ...initial, title: 'Restored task', version: 3n }; const world = worlds.get(sessions)!;
    await replace(sessions, [restored, surviving]);
    if (observeFirst) {
      sessions.observe(project, task, world.node(project, task), true); sessions.load(project, task, 3, 'open');
      expect(sessions.snapshot(project, task).mutation.phase).toBe('pending'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(false); expect(reads).toHaveBeenCalledOnce();
    }
    reads.mockResolvedValue(restored);
    if (response === '204') { writes.mock.calls[0]![5].onWriteConfirmed?.(); pending.resolve(); } else pending.reject(gone());
    await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored));
    expect(sessions.snapshot(project, task).status).toBe('ready'); expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true);
    expect(world.scope.getAuthorizedProject(project)?.index.nodes.has(task)).toBe(true); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
  });
  it('ignores an old ordinary GET410 even when the replacement has not reached observe yet', async () => {
    const sessions = createSessions(); await open(sessions); const probe = deferred<TaskDetail>(); reads.mockReturnValueOnce(probe.promise); sessions.load(project, task, 2);
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); const world = worlds.get(sessions)!; const revoke = vi.spyOn(world.scope, 'revokeProject');
    const restored = { ...initial, version: 3n }; await replace(sessions, [restored, surviving]); probe.reject(gone());
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(sessions.snapshot(project, task).status).not.toBe('deleted');
    await reopen(sessions, restored); expect(revoke).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledTimes(3); expect(writes).not.toHaveBeenCalled();
  });
  it('ignores an aborted old GET410 after observe has started the restored read', async () => {
    const sessions = createSessions(); await open(sessions); const probe = deferred<TaskDetail>(); reads.mockReturnValueOnce(probe.promise); sessions.load(project, task, 2);
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); const oldSignal = reads.mock.calls[1]![2]; const restored = { ...initial, version: 3n };
    await replace(sessions, [restored]); await reopen(sessions, restored); expect(oldSignal.aborted).toBe(true); probe.reject(gone());
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(sessions.snapshot(project, task).detail).toEqual(restored); expect(sessions.snapshot(project, task).status).toBe('ready'); expect(reads).toHaveBeenCalledTimes(3);
  });
  it.each(['status', 'allowAgents', 'requiredPlatform'] as const)('settles an obsolete %s mutation410 and permits a fresh read of restored history', async (action) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<TaskDetail>();
    const mutate = action === 'status' ? vi.mocked(setTaskStatus) : action === 'allowAgents' ? vi.mocked(setTaskAgentPermission) : vi.mocked(setTaskRequiredPlatform);
    mutate.mockReturnValueOnce(pending.promise);
    if (action === 'status') sessions.setStatus(project, task, 'done', initial.version);
    else if (action === 'allowAgents') sessions.setAgentPermission(project, task, true, initial.version);
    else sessions.setRequiredPlatform(project, task, 'linux', initial.version);
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce()); const world = worlds.get(sessions)!; const restored = { ...initial, title: 'Restored task', version: 3n };
    await replace(sessions, [restored, surviving]); sessions.observe(project, task, world.node(project, task), true);
    reads.mockResolvedValue(restored); pending.reject(gone()); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored));
    expect(sessions.snapshot(project, task).status).toBe('ready'); expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(true);
    expect(mutate).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2); expect(writes).not.toHaveBeenCalled();
  });
  it.each(['204', '410'] as const)('preserves new removeDepends=true ownership after an old removeDepends=false DELETE%s result', async (response) => {
    const sessions = createSessions(); await open(sessions); const oldWrite = deferred<void>(); const newWrite = deferred<void>(); writes.mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
    sessions.deleteTask(project, task, initial.version, false); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    await replace(sessions, [surviving]); sessions.observe(project, task, undefined, true); expect(sessions.snapshot(project, task).status).toBe('deleted');
    const restored = { ...initial, title: 'Restored task', version: 3n }; await replace(sessions, [restored]); await reopen(sessions, restored);
    sessions.deleteTask(project, task, restored.version, true); await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    expect(writes.mock.calls[0]![3]).toBe(false); expect(writes.mock.calls[1]![3]).toBe(true);
    if (response === '204') { writes.mock.calls[0]![5].onWriteConfirmed?.(); oldWrite.resolve(); } else oldWrite.reject(gone());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(project, task).detail).toEqual(restored); expect(sessions.snapshot(project, task).status).toBe('ready');
    expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n, removeDepends: true }, phase: 'pending' });
    writes.mock.calls[1]![5].onWriteConfirmed?.(); newWrite.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
    expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n, removeDepends: true }, phase: 'confirmed' }); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledTimes(2);
  });
  it.each(['200', 'network', '410', '404'] as const)('preserves a new deletion when an old status%s arrives across deleted and restored histories', async (response) => {
    const sessions = createSessions(); await open(sessions); const oldStatus = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(oldStatus.promise);
    sessions.setStatus(project, task, 'done', initial.version); await waitFor(() => expect(setTaskStatus).toHaveBeenCalledOnce());
    await replace(sessions, [surviving]); sessions.observe(project, task, undefined, true); expect(sessions.snapshot(project, task).status).toBe('deleted');
    const restored = { ...initial, title: 'Restored task', version: 3n }; await replace(sessions, [restored, surviving]); await reopen(sessions, restored);
    const newDeletion = deferred<void>(); writes.mockReturnValueOnce(newDeletion.promise); sessions.deleteTask(project, task, restored.version, true); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    if (response === '200') {
      vi.mocked(setTaskStatus).mock.calls[0]![5].onWriteConfirmed?.();
      oldStatus.resolve({ ...initial, status: 'done', ready: false, version: 10n, completedAt: '2026-10-22T11:00:00Z', updatedAt: '2026-10-22T11:00:00Z' });
    } else oldStatus.reject(response === 'network' ? new ApiError('network') : response === '410' ? gone() : new ApiError('server', 404, 'not_found'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(project, task).detail).toEqual(restored); expect(sessions.snapshot(project, task).status).toBe('ready');
    expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n, removeDepends: true }, phase: 'pending' });
    writes.mock.calls[0]![5].onWriteConfirmed?.(); newDeletion.resolve(); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
    expect(sessions.snapshot(project, task).mutation).toMatchObject({ operation: { action: 'delete', version: 3n, removeDepends: true }, phase: 'confirmed' }); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledOnce();
  });
  it('retains the pending deletion lock through a sibling deletion epoch and settles with a current GET410', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; await world.sync([surviving]);
    const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, initial.version, true); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    await replace(sessions, [initial]); sessions.observe(project, task, world.node(project, task), true);
    expect(sessions.snapshot(project, task).mutation.phase).toBe('pending'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(false);
    sessions.deleteTask(project, task, initial.version, true); sessions.setStatus(project, task, 'done', initial.version); sessions.load(project, task, 3, 'open');
    expect(writes).toHaveBeenCalledOnce(); expect(setTaskStatus).not.toHaveBeenCalled(); expect(reads).toHaveBeenCalledOnce();
    const revoke = vi.spyOn(world.scope, 'revokeProject'); reads.mockRejectedValueOnce(gone()); writes.mock.calls[0]![5].onWriteConfirmed?.(); pending.resolve();
    await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledOnce(); expect(revoke).not.toHaveBeenCalled(); expect(world.scope.getAuthorizedProject(project)).not.toBeNull();
  });
  it('retains the unknown deletion lock through a sibling deletion epoch until a deliberate GET410', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const probe = deferred<TaskDetail>();
    writes.mockRejectedValueOnce(new ApiError('network')); reads.mockReturnValueOnce(probe.promise); sessions.deleteTask(project, task, initial.version, true); await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    await replace(sessions, [initial]); sessions.observe(project, task, world.node(project, task), true);
    expect(sessions.snapshot(project, task).mutation.phase).toBe('unknown'); expect(canDeleteTask(sessions.snapshot(project, task))).toBe(false);
    sessions.deleteTask(project, task, initial.version, true); sessions.load(project, task, 3, 'automatic'); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
    probe.resolve(initial); reads.mockRejectedValueOnce(gone()); sessions.reconcile(project, task); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'); expect(reads).toHaveBeenCalledTimes(3); expect(writes).toHaveBeenCalledOnce();
  });
  it.each(['204', '410'] as const)('keeps a disposed owner from applying an old DELETE%s to restored history', async (response) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, initial.version, true);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); sessions.dispose(); const restored = { ...initial, version: 3n }; await replace(sessions, [restored]);
    if (response === '204') pending.resolve(); else pending.reject(gone()); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(project, task).status).not.toBe('deleted'); expect(worlds.get(sessions)!.scope.getSummaryVersion(project, task)).toBe(3n); expect(reads).toHaveBeenCalledOnce();
  });
  it.each(['204', '410'] as const)('does not publish a DELETE%s after identity retirement', async (response) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); sessions.deleteTask(project, task, initial.version, true);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); const world = worlds.get(sessions)!; const listener = vi.fn(); sessions.subscribe(project, task, listener); void world.scope.invalidateScope(); listener.mockClear();
    if (response === '204') pending.resolve(); else pending.reject(gone()); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessions.snapshot(project, task).status).not.toBe('deleted'); expect(listener).not.toHaveBeenCalled(); expect(world.scope.isInvalidated).toBe(true); expect(reads).toHaveBeenCalledOnce();
  });
});
