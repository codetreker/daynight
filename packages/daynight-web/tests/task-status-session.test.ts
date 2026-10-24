import { createTaskSessionWorld } from "./helpers/taskSessions";
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, setTaskStatus, setTaskAgentPermission, setTaskRequiredPlatform } from '../src/api/client';
import type { TaskDetail, TaskStatus } from '../src/api/types';
import { canSetStatus, canSetAgentPermission, canSetRequiredPlatform, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn(), getTask: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const otherProject = '10000000-0000-4000-8000-000000000002';
const task = '20000000-0000-4000-8000-000000000001';
const otherTask = '20000000-0000-4000-8000-000000000002';
const dependency = '20000000-0000-4000-8000-000000000003';
const version = 9007199254740993n;
const stamp = '2026-10-22T00:00:00Z'; const nextStamp = '2026-10-22T00:01:00Z';
const initial: TaskDetail = { requiredPlatform: 'linux', allowAgents: false, externalDependsOn: [dependency], startedAt: null, completedAt: null, id: task, projectId: project, version,
  title: 'Reviewed task', description: 'Complete original description', properties: { worker: null, pullRequests: [{ title: 'Original PR', url: 'https://example.com/pr/1' }] },
  status: 'todo', dependsOn: [dependency], blockedBy: [], ready: true, createdAt: stamp, updatedAt: stamp };
const source = (status: TaskStatus): TaskDetail => ({ ...initial, status, ready: status === 'todo', startedAt: status === 'todo' ? null : stamp, completedAt: status === 'done' ? stamp : null });
const result = (previous: TaskDetail, status: TaskStatus): TaskDetail => previous.status === status ? previous : ({ ...previous, status, ready: status === 'todo', version: previous.version + 1n, updatedAt: nextStamp,
  startedAt: status === 'in_progress' ? nextStamp : status === 'todo' || previous.status === 'todo' ? null : previous.startedAt,
  completedAt: status === 'done' ? nextStamp : null });
const reads = vi.mocked(getTask); const writes = vi.mocked(setTaskStatus); const permissions = vi.mocked(setTaskAgentPermission);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const prerequisite = (status: 'todo' | 'done'): TaskDetail => ({ ...initial, id: dependency, title: 'Prerequisite', version: status === 'done' ? 2n : 1n,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: status === 'todo', status, completedAt: status === 'done' ? stamp : null });
const synchronize = async (sessions: TaskDetailSessions, detail: TaskDetail, dependencyStatus: 'todo' | 'done' = 'done') => {
  const world = worlds.get(sessions)!;
  await world.sync([...(detail.dependsOn.includes(dependency) ? [{ ...prerequisite(dependencyStatus), projectId: detail.projectId }] : []), detail]);
  sessions.observe(detail.projectId, detail.id, world.node(detail.projectId, detail.id));
};
const open = async (sessions: TaskDetailSessions, detail: TaskDetail = initial, dependencyStatus: 'todo' | 'done' = 'done') => {
  await synchronize(sessions, detail, dependencyStatus); sessions.load(detail.projectId, detail.id, 1);
  await waitFor(() => expect(sessions.snapshot(detail.projectId, detail.id).status).toBe('ready'));
};
const submit = (sessions: TaskDetailSessions, target: TaskStatus = 'in_progress', expected = sessions.snapshot(project, task).detail!.version) => sessions.setStatus(project, task, target, expected);
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } worlds.clear(); });
beforeEach(() => { reads.mockReset().mockResolvedValue(initial); writes.mockReset(); permissions.mockReset(); vi.mocked(setTaskRequiredPlatform).mockReset(); });

describe('versioned status session', () => {
  it.each((['todo', 'in_progress', 'done'] as const).flatMap((from) => (['todo', 'in_progress', 'done'] as const).map((to) => ({ from, to }))))('confirms $from → $to using its exact delta and complete persisted material', async ({ from, to }) => {
    const previous = source(from); const saved = result(previous, to); reads.mockResolvedValueOnce(previous); writes.mockResolvedValueOnce(saved);
    const sessions = createSessions(); const refresh = vi.fn(); sessions.subscribeProject(project, refresh); await open(sessions, previous); submit(sessions, to);
    await synchronize(sessions, saved);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, task, to, version, expect.any(AbortSignal), expect.objectContaining({ userId: worlds.get(sessions)!.scope.userId, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(sessions.snapshot(project, task).detail).toEqual(saved); expect(refresh).toHaveBeenCalledOnce(); expect(canSetStatus(sessions.snapshot(project, task))).toBe(true);
    expect(saved.version - previous.version).toBe(from === to ? 0n : 1n);
  });
  it('accepts refreshed derived readiness in a same-state response without treating it as a stored-field mutation', async () => {
    const blocked = { ...initial, ready: false, blockedBy: [dependency] }; reads.mockResolvedValueOnce(blocked); writes.mockResolvedValueOnce(initial);
    const sessions = createSessions(); await open(sessions, blocked, 'todo'); submit(sessions, 'todo');
    await synchronize(sessions, initial);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(project, task).detail).toEqual(initial); expect(sessions.snapshot(project, task).detail?.version).toBe(version);
  });
  it('rejects a stale reviewed same-state version before dispatch', async () => {
    const sessions = createSessions(); await open(sessions); submit(sessions, 'todo', version - 1n); expect(writes).not.toHaveBeenCalled();
  });
  it.each([{ to: 'todo' as const, delta: 1n }, { to: 'in_progress' as const, delta: 0n }, { to: 'done' as const, delta: 2n }])('reads actual state when $to returns the wrong delta $delta', async ({ to, delta }) => {
    reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(result(initial, to)); writes.mockResolvedValueOnce({ ...result(initial, to), version: version + delta });
    const sessions = createSessions(); await open(sessions); submit(sessions, to);
    await synchronize(sessions, result(initial, to));
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).mutation.error).toMatchObject({ kind: 'protocol' }); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2);
  });
  it.each([
    { id: otherTask }, { projectId: otherProject }, { title: 'Unreviewed title' }, { description: 'Unreviewed content' }, { allowAgents: true }, { requiredPlatform: 'windows' as const },
    { externalDependsOn: [] }, { dependsOn: [] }, { properties: { worker: null, pullRequests: [] } }, { createdAt: nextStamp },
  ])('rejects a confirmed status write that changes unrelated material %#', async (changed) => {
    const saved = result(initial, 'in_progress'); reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(saved); writes.mockResolvedValueOnce({ ...saved, ...changed });
    const sessions = createSessions(); await open(sessions); submit(sessions);
    await synchronize(sessions, saved);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled')); expect(sessions.snapshot(project, task).mutation.error).toMatchObject({ kind: 'protocol' });
  });
  it.each([
    { from: 'todo' as const, to: 'todo' as const, patch: { updatedAt: nextStamp } },
    { from: 'todo' as const, to: 'todo' as const, patch: { startedAt: nextStamp } },
    { from: 'done' as const, to: 'todo' as const, patch: { startedAt: stamp } },
    { from: 'done' as const, to: 'todo' as const, patch: { completedAt: stamp } },
    { from: 'todo' as const, to: 'in_progress' as const, patch: { startedAt: null } },
    { from: 'todo' as const, to: 'in_progress' as const, patch: { completedAt: nextStamp } },
    { from: 'todo' as const, to: 'done' as const, patch: { startedAt: stamp } },
    { from: 'todo' as const, to: 'done' as const, patch: { completedAt: null } },
    { from: 'in_progress' as const, to: 'done' as const, patch: { startedAt: nextStamp } },
  ])('rejects contradictory persisted timing $from → $to %#', async ({ from, to, patch }) => {
    const previous = source(from); const saved = result(previous, to); reads.mockResolvedValueOnce(previous).mockResolvedValueOnce(saved); writes.mockResolvedValueOnce({ ...saved, ...patch });
    const sessions = createSessions(); await open(sessions, previous); submit(sessions, to); await synchronize(sessions, saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).mutation.error).toMatchObject({ kind: 'protocol' }); expect(writes).toHaveBeenCalledOnce();
  });
  it('keeps an unknown historical start when completing an in-progress task', async () => {
    const previous = { ...source('in_progress'), startedAt: null }; const saved = result(previous, 'done'); reads.mockResolvedValueOnce(previous); writes.mockResolvedValueOnce(saved);
    const sessions = createSessions(); await open(sessions, previous); submit(sessions, 'done'); await synchronize(sessions, saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
    expect(sessions.snapshot(project, task).detail?.startedAt).toBeNull();
  });
  it('cancels an obsolete view read and ignores its late data after a confirmed write', async () => {
    const stale = deferred<TaskDetail>(); const saved = result(initial, 'in_progress'); reads.mockResolvedValueOnce(initial).mockReturnValueOnce(stale.promise); writes.mockResolvedValueOnce(saved);
    const sessions = createSessions(); await open(sessions); sessions.load(project, task, 2, 'automatic'); await waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); const signal = reads.mock.calls[1]![2]; submit(sessions);
    await synchronize(sessions, saved);
    expect(signal.aborted).toBe(true); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed')); stale.resolve(initial);
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(sessions.snapshot(project, task).detail).toEqual(saved); expect(sessions.snapshot(project, task).error).toBeNull();
  });
  it('retains one write through release, reopening and another project without changing that identity', async () => {
    const sessions = createSessions(); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    const release = sessions.subscribe(project, task, vi.fn()); await open(sessions); submit(sessions); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); release(); sessions.load(project, task, 2); submit(sessions);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); expect(reads).toHaveBeenCalledOnce(); expect(writes.mock.calls[0]![4].aborted).toBe(false);
    const other = { ...initial, id: otherTask, projectId: otherProject, dependsOn: [], externalDependsOn: [] }; reads.mockResolvedValueOnce(other); await open(sessions, other);
    const saved = result(initial, 'in_progress'); await synchronize(sessions, saved); pending.resolve(saved); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(saved));
    expect(sessions.snapshot(otherProject, otherTask).detail?.status).toBe('todo');
  });
  it('keeps status and permission mutually exclusive while one status request is pending', async () => {
    const sessions = createSessions(); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise); await open(sessions); submit(sessions);
    submit(sessions, 'done'); sessions.setAgentPermission(project, task, true, version); sessions.setRequiredPlatform(project, task, 'macos', version);
    expect(setTaskRequiredPlatform).not.toHaveBeenCalled(); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); expect(permissions).not.toHaveBeenCalled(); expect(canSetStatus(sessions.snapshot(project, task))).toBe(false); expect(canSetAgentPermission(sessions.snapshot(project, task))).toBe(false); expect(canSetRequiredPlatform(sessions.snapshot(project, task))).toBe(false);
    await synchronize(sessions, result(initial, 'in_progress')); pending.resolve(result(initial, 'in_progress')); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
  });
  it('retains a refusal and only retries on another deliberate operation', async () => {
    const error = new ApiError('server', 409, 'dependency_unsatisfied', 'refusal'); writes.mockRejectedValueOnce(error).mockResolvedValueOnce(result(initial, 'in_progress'));
    const sessions = createSessions(); await open(sessions); submit(sessions); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('refused'));
    expect(sessions.snapshot(project, task).mutation.error).toBe(error); expect(reads).toHaveBeenCalledOnce(); expect(writes).toHaveBeenCalledOnce(); submit(sessions);
    await synchronize(sessions, result(initial, 'in_progress'));
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
  });
  it('rereads a same-state conflict without replay and requires a newly reviewed version', async () => {
    const changed = { ...initial, title: 'Changed material', version: version + 1n }; const error = new ApiError('server', 409, 'version_conflict', 'conflict');
    reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed); writes.mockRejectedValueOnce(error).mockResolvedValueOnce(changed);
    const sessions = createSessions(); await open(sessions); submit(sessions, 'todo'); await synchronize(sessions, changed); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(changed));
    expect(sessions.snapshot(project, task).mutation.phase).toBe('conflict'); expect(writes).toHaveBeenCalledOnce(); submit(sessions, 'todo', version); expect(writes).toHaveBeenCalledOnce(); submit(sessions, 'todo', changed.version);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed')); expect(writes.mock.calls[1]![3]).toBe(changed.version);
  });
  it.each([new ApiError('network'), new ApiError('protocol', 200), new ApiError('server', 500, 'internal_error', 'server-error')])('uses GET-only reconciliation for an uncertain response %#', async (error) => {
    const saved = result(initial, 'in_progress'); reads.mockResolvedValueOnce(initial).mockResolvedValueOnce(saved); writes.mockRejectedValueOnce(error);
    const sessions = createSessions(); await open(sessions); submit(sessions); await synchronize(sessions, saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).mutation.error).toBe(error); expect(sessions.snapshot(project, task).detail).toEqual(saved); expect(writes).toHaveBeenCalledOnce();
  });
  it.each([new ApiError('network'), new DOMException('Cancelled', 'AbortError')])('preserves both failures and blocks both writes until an explicit successful GET %#', async (readError) => {
    const writeError = new ApiError('protocol'); const saved = result(initial, 'in_progress'); reads.mockResolvedValueOnce(initial).mockRejectedValueOnce(readError).mockResolvedValueOnce(saved); writes.mockRejectedValueOnce(writeError);
    const sessions = createSessions(); await open(sessions); submit(sessions); await waitFor(() => expect(sessions.snapshot(project, task).mutation.reconciliationError).toBe(readError));
    expect(sessions.snapshot(project, task).mutation.error).toBe(writeError); expect(canSetStatus(sessions.snapshot(project, task))).toBe(false); expect(canSetAgentPermission(sessions.snapshot(project, task))).toBe(false); expect(canSetRequiredPlatform(sessions.snapshot(project, task))).toBe(false);
    sessions.load(project, task, 2); submit(sessions); sessions.setAgentPermission(project, task, true, version); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledOnce(); expect(permissions).not.toHaveBeenCalled();
    await synchronize(sessions, saved); sessions.reconcile(project, task); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled')); expect(sessions.snapshot(project, task).detail).toEqual(saved);
  });
  it('lets reconciliation finish after closing the last view', async () => {
    const sessions = createSessions(); const pending = deferred<TaskDetail>(); reads.mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise); writes.mockRejectedValueOnce(new ApiError('network'));
    const release = sessions.subscribe(project, task, vi.fn()); await open(sessions); submit(sessions); await waitFor(() => expect(sessions.snapshot(project, task).mutation.reconciling).toBe(true));
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); const readSignal = reads.mock.calls[1]![2]; release(); sessions.releaseRead(project, task); expect(readSignal.aborted).toBe(false); await synchronize(sessions, result(initial, 'in_progress')); pending.resolve(result(initial, 'in_progress'));
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
  });
  it('keeps the committed version floor through stale and failed reads', async () => {
    const saved = result(initial, 'in_progress'); const error = new ApiError('network'); reads.mockResolvedValueOnce(initial).mockRejectedValueOnce(error).mockResolvedValueOnce(initial).mockResolvedValueOnce(saved); writes.mockResolvedValueOnce(saved);
    const sessions = createSessions(); await open(sessions); submit(sessions); await synchronize(sessions, saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed')); sessions.load(project, task, 2);
    await waitFor(() => expect(sessions.snapshot(project, task).error).toBe(error)); sessions.load(project, task, 3); await waitFor(() => expect(sessions.snapshot(project, task).error).toMatchObject({ kind: 'protocol' }));
    expect(sessions.snapshot(project, task).detail).toEqual(saved); expect(canSetStatus(sessions.snapshot(project, task))).toBe(false); sessions.load(project, task, 4); await waitFor(() => expect(sessions.snapshot(project, task).error).toBeNull());
  });
  it('does not cancel an already submitted write when identity ownership is disposed', async () => {
    const sessions = createSessions(); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise); await open(sessions); submit(sessions); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); sessions.dispose();
    expect(writes.mock.calls[0]![4].aborted).toBe(false); pending.reject(new ApiError('network')); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('unknown')); expect(reads).toHaveBeenCalledOnce();
  });
});
