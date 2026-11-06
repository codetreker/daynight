import { waitForState as waitFor } from './helpers/waitForState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, pauseAuthRequests, setTaskAgentPermission, setTaskAssignedTo, setTaskRequiredPlatform, setTaskStatus, withdrawWorkerClaim } from '../src/api/client';
import type { TaskDetail, WorkerClaim } from '../src/api/types';
import { canSetAssignedTo, canSetAgentPermission, canSetRequiredPlatform, canSetStatus, TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { admitTaskGraph, createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskAssignedTo: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn(), withdrawWorkerClaim: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const person = '30000000-0000-4000-8000-000000000001';
const otherPerson = '30000000-0000-4000-8000-000000000002';
const stamp = '2026-10-24T00:00:00Z'; const nextStamp = '2026-10-24T00:01:00Z';
const initial = detailFixture(project, task, { assignedTo: null, version: 9007199254740993n, allowAgents: true, requiredPlatform: 'linux', properties: { pullRequests: [], future: { enabled: true } } });
const assigned = (before = initial, assignedTo: string | null = person): TaskDetail => before.assignedTo === assignedTo ? before : ({ ...before, assignedTo, version: before.version + 1n, allowAgents: false, updatedAt: nextStamp });
const reads = vi.mocked(getTask); const writes = vi.mocked(setTaskAssignedTo);
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const worlds = new Map<TaskDetailSessions, ReturnType<typeof createTaskSessionWorld>>(); const cleanups = new Set<() => void>();
const createSessions = () => { const world = createTaskSessionWorld(); const sessions = new TaskDetailSessions(world.scope); worlds.set(sessions, world); return sessions; };
const synchronize = async (sessions: TaskDetailSessions, detail: TaskDetail) => { const world = worlds.get(sessions)!; await world.sync([detail]); sessions.observe(project, task, world.node(project, task)); };
const open = async (sessions: TaskDetailSessions, detail = initial) => { reads.mockResolvedValueOnce(detail); await synchronize(sessions, detail); sessions.load(project, task, 1); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(detail)); };
const replace = async (sessions: TaskDetailSessions, detail: TaskDetail) => { const world = worlds.get(sessions)!; await admitTaskGraph(world.scope, graphFixture([detail]), { epoch: crypto.randomUUID(), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }); };
const pause = () => { const resume = pauseAuthRequests(); cleanups.add(resume); return resume; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const assertBlocked = (sessions: TaskDetailSessions) => { const state = sessions.snapshot(project, task); expect(canSetAssignedTo(state)).toBe(false); expect(canSetStatus(state)).toBe(false); expect(canSetAgentPermission(state)).toBe(false); expect(canSetRequiredPlatform(state)).toBe(false); };

beforeEach(() => { reads.mockReset(); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); vi.mocked(setTaskAgentPermission).mockReset(); vi.mocked(setTaskRequiredPlatform).mockReset(); vi.mocked(withdrawWorkerClaim).mockReset(); });
afterEach(() => { for (const [sessions, world] of worlds) { sessions.dispose(); world.dispose(); } for (const cleanup of cleanups) cleanup(); worlds.clear(); cleanups.clear(); });

describe('assignment mutation ownership', () => {
  it.each([{ previous: initial, target: person }, { previous: { ...initial, assignedTo: person }, target: null }, { previous: initial, target: null }, { previous: { ...initial, assignedTo: person }, target: person }])('confirms exact changed or equal assignment %#', async ({ previous, target }) => {
    const sessions = createSessions(); await open(sessions, previous); const saved = assigned(previous, target); writes.mockResolvedValueOnce(saved);
    sessions.setAssignedTo(project, task, target, previous.version); await synchronize(sessions, saved);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
    expect(writes).toHaveBeenCalledExactlyOnceWith(project, task, target, previous.version, expect.any(AbortSignal), expect.objectContaining({ userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(sessions.snapshot(project, task).detail).toEqual(saved); expect(saved.version - previous.version).toBe(previous.assignedTo === target ? 0n : 1n);
    expect(saved.allowAgents).toBe(previous.assignedTo === target ? previous.allowAgents : false); expect(canSetAssignedTo(sessions.snapshot(project, task))).toBe(true);
  });
  it('retains the confirmed old assignment and serializes every task write while a save is pending', async () => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setAssignedTo(project, task, person, initial.version); sessions.setAssignedTo(project, task, otherPerson, initial.version); sessions.setStatus(project, task, 'done', initial.version); sessions.setAgentPermission(project, task, false, initial.version); sessions.setRequiredPlatform(project, task, 'macos', initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce()); expect(sessions.snapshot(project, task).detail).toEqual(initial); assertBlocked(sessions);
    expect(setTaskStatus).not.toHaveBeenCalled(); expect(setTaskAgentPermission).not.toHaveBeenCalled(); expect(setTaskRequiredPlatform).not.toHaveBeenCalled();
    const saved = assigned(); await synchronize(sessions, saved); pending.resolve(saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
  });
  it('rejects stale reviewed versions and executing tasks before dispatch', async () => {
    const sessions = createSessions(); await open(sessions); sessions.setAssignedTo(project, task, person, initial.version - 1n); expect(writes).not.toHaveBeenCalled();
    const running: TaskDetail = { ...initial, status: 'in_progress', ready: false, startedAt: stamp, version: initial.version + 1n };
    reads.mockResolvedValueOnce(running); await synchronize(sessions, running); sessions.load(project, task, 2); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(running));
    sessions.setAssignedTo(project, task, person, running.version); expect(writes).not.toHaveBeenCalled(); expect(canSetAssignedTo(sessions.snapshot(project, task))).toBe(false);
  });
  it('keeps the submitted intent through closing and reopening the task', async () => {
    const sessions = createSessions(); const release = sessions.subscribe(project, task, vi.fn()); await open(sessions); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); release(); sessions.releaseRead(project, task); sessions.requireOpeningRead(project, task); sessions.load(project, task, 2, 'open');
    expect(writes.mock.calls[0]![4].aborted).toBe(false); expect(reads).toHaveBeenCalledOnce(); const saved = assigned(); await synchronize(sessions, saved); pending.resolve(saved);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed')); expect(writes).toHaveBeenCalledOnce();
  });
  it('reads a 409 conflict without replay and uses the newly reviewed version for another assignment', async () => {
    const sessions = createSessions(); await open(sessions);
    const current = assigned(initial, otherPerson); const saved = assigned(current, person);
    const error = new ApiError('server', 409, 'version_conflict', 'assignment-conflict');
    const response = deferred<TaskDetail>(); const readback = deferred<TaskDetail>(); const second = deferred<TaskDetail>();
    writes.mockReturnValueOnce(response.promise).mockReturnValueOnce(second.promise); reads.mockReturnValueOnce(readback.promise);
    sessions.setAssignedTo(project, task, person, initial.version);
    await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    response.reject(error);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation).toMatchObject({ phase: 'conflict', error, reconciling: true }));
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    expect(sessions.snapshot(project, task).detail).toEqual(initial);
    expect(writes).toHaveBeenCalledOnce();
    sessions.setAssignedTo(project, task, person, initial.version); expect(writes).toHaveBeenCalledOnce();
    await synchronize(sessions, current); readback.resolve(current);
    await waitFor(() => expect(sessions.snapshot(project, task)).toMatchObject({ detail: current, mutation: { phase: 'conflict', error, reconciling: false, reconciliationError: null } }));
    sessions.setAssignedTo(project, task, person, initial.version); expect(writes).toHaveBeenCalledOnce();
    sessions.setAssignedTo(project, task, person, current.version); await waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    expect(writes.mock.calls[1]![3]).toBe(current.version);
    await synchronize(sessions, saved); second.resolve(saved);
    await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'));
    expect(writes).toHaveBeenCalledTimes(2); expect(writes.mock.calls[1]![3]).toBe(current.version);
    expect(sessions.snapshot(project, task).detail).toEqual(saved);
  });
  it.each([
    { version: initial.version }, { version: initial.version + 2n }, { allowAgents: true }, { status: 'done' as const }, { requiredPlatform: 'macos' as const },
    { startedAt: stamp }, { completedAt: stamp }, { title: 'Unreviewed title' }, { description: 'Unreviewed content' }, { createdAt: nextStamp },
    { dependsOn: [task] }, { externalDependsOn: [task] }, { properties: { pullRequests: [] } }, { properties: { ...initial.properties, future: { enabled: false } } },
  ])('rejects a response that cannot prove the one assignment change %#', async (fields) => {
    const sessions = createSessions(); await open(sessions); const saved = assigned(); reads.mockResolvedValueOnce(saved); writes.mockResolvedValueOnce({ ...saved, ...fields });
    sessions.setAssignedTo(project, task, person, initial.version); await synchronize(sessions, saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).mutation.error).toMatchObject({ kind: 'protocol' }); expect(sessions.snapshot(project, task).detail).toEqual(saved); expect(writes).toHaveBeenCalledOnce();
  });
  it.each([{ version: initial.version + 1n }, { updatedAt: nextStamp }, { allowAgents: false }])('rejects a same-assignment response that changes persisted values %#', async (fields) => {
    const sessions = createSessions(); await open(sessions); reads.mockResolvedValueOnce(initial); writes.mockResolvedValueOnce({ ...initial, ...fields });
    sessions.setAssignedTo(project, task, null, initial.version); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).mutation.error).toMatchObject({ kind: 'protocol' }); expect(sessions.snapshot(project, task).detail).toEqual(initial);
  });
  it.each([new ApiError('network'), new ApiError('protocol', 200), new DOMException('Response lost', 'AbortError')])('uses one GET with the original version as its floor for an unconfirmed result %#', async (error) => {
    const sessions = createSessions(); await open(sessions); reads.mockResolvedValueOnce(initial); writes.mockRejectedValueOnce(error);
    sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).detail).toEqual(initial); expect(reads).toHaveBeenCalledTimes(2); expect(writes).toHaveBeenCalledOnce();
    await flush(); expect(writes).toHaveBeenCalledOnce();
  });
  it('accepts a higher current version after an unknown result without requiring its abandoned intent', async () => {
    const sessions = createSessions(); await open(sessions); const current = { ...initial, assignedTo: otherPerson, title: 'New current material', version: initial.version + 4n, updatedAt: nextStamp };
    const read = deferred<TaskDetail>(); reads.mockReturnValueOnce(read.promise); writes.mockRejectedValueOnce(new ApiError('network')); sessions.setAssignedTo(project, task, person, initial.version);
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); await synchronize(sessions, current); read.resolve(current); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled'));
    expect(sessions.snapshot(project, task).detail).toEqual(current); expect(canSetAssignedTo(sessions.snapshot(project, task))).toBe(true); expect(writes).toHaveBeenCalledOnce();
  });
  it.each([false, true])('uses the confirmed 200 floor even when its body is invalid, equal=%s', async (equal) => {
    const sessions = createSessions(); await open(sessions); const target = equal ? null : person;
    writes.mockImplementationOnce(async (_project, _task, _target, _version, _signal, admission) => { admission.onWriteConfirmed?.(); throw new ApiError('protocol', 200); }); reads.mockResolvedValueOnce(initial);
    sessions.setAssignedTo(project, task, target, initial.version);
    if (equal) { await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed')); await waitFor(() => expect(sessions.snapshot(project, task).requiresFreshRead).toBe(false)); expect(sessions.snapshot(project, task).mutation.reconciliationError).toBeNull(); }
    else { await waitFor(() => expect(sessions.snapshot(project, task).mutation.reconciliationError).toMatchObject({ kind: 'protocol' })); assertBlocked(sessions); const saved = assigned(); await synchronize(sessions, saved); reads.mockResolvedValueOnce(saved); sessions.reconcile(project, task); await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(saved)); }
    expect(sessions.snapshot(project, task).mutation.phase).toBe('confirmed'); expect(reads).toHaveBeenCalledTimes(equal ? 2 : 3); expect(writes).toHaveBeenCalledOnce();
  });
  it('keeps the old assignment uncertain when reconciliation fails and only a deliberate GET recovers it', async () => {
    const sessions = createSessions(); await open(sessions); const failure = new ApiError('network'); writes.mockRejectedValueOnce(failure); reads.mockRejectedValueOnce(failure);
    sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(sessions.snapshot(project, task).mutation.reconciliationError).toBe(failure));
    expect(sessions.snapshot(project, task).detail?.assignedTo).toBeNull(); assertBlocked(sessions); sessions.setAssignedTo(project, task, otherPerson, initial.version); expect(writes).toHaveBeenCalledOnce();
    reads.mockResolvedValueOnce(initial); sessions.reconcile(project, task); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled')); expect(writes).toHaveBeenCalledOnce();
  });
  it.each(['status', 'permission', 'platform', 'withdraw'] as const)('rejects $0 results that change the assignment', async (action) => {
    const worker: WorkerClaim = { claimId: otherPerson, state: 'active', userId: TEST_VIEWER_ID, workerId: person, machine: { id: person, name: 'Machine' }, platform: 'linux', agent: 'codex', agentControlMode: 'herdr', worktreeId: project, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: stamp };
    const previous: TaskDetail = action === 'withdraw' ? { ...initial, assignedTo: person, status: 'in_progress', ready: false, startedAt: stamp, properties: { ...initial.properties, worker } } : { ...initial, assignedTo: person };
    const sessions = createSessions(); await open(sessions, previous);
    const saved: TaskDetail = { ...previous, version: previous.version + 1n, updatedAt: nextStamp, ...(action === 'status' ? { status: 'done', ready: false, completedAt: nextStamp } : action === 'permission' ? { allowAgents: false } : action === 'platform' ? { requiredPlatform: 'macos' } : { status: 'todo', ready: true, allowAgents: false, startedAt: null, properties: initial.properties }) };
    const result = { ...saved, assignedTo: otherPerson }; reads.mockResolvedValueOnce(saved);
    if (action === 'status') { vi.mocked(setTaskStatus).mockResolvedValueOnce(result); sessions.setStatus(project, task, 'done', previous.version); }
    else if (action === 'permission') { vi.mocked(setTaskAgentPermission).mockResolvedValueOnce(result); sessions.setAgentPermission(project, task, false, previous.version); }
    else if (action === 'platform') { vi.mocked(setTaskRequiredPlatform).mockResolvedValueOnce(result); sessions.setRequiredPlatform(project, task, 'macos', previous.version); }
    else { vi.mocked(withdrawWorkerClaim).mockResolvedValueOnce(result); sessions.withdrawClaim(project, task, worker.claimId, previous.version); }
    await synchronize(sessions, saved); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled')); expect(sessions.snapshot(project, task).mutation.error).toMatchObject({ kind: 'protocol' }); expect(sessions.snapshot(project, task).detail?.assignedTo).toBe(person);
  });
});

describe('assignment admission through authentication and project histories', () => {
  it.each([false, true])('expires a prepared intent after replacement history with observe=%s', async (observe) => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const entered = deferred<void>(); const release = deferred<void>(); cleanups.add(release.resolve); const transact = world.scope.detailTransaction.bind(world.scope); let calls = 0;
    vi.spyOn(world.scope, 'detailTransaction').mockImplementation(async <T,>(...args: Parameters<typeof transact<T>>) => { const result = await transact<T>(...args); if (++calls === 1) { entered.resolve(); await release.promise; } return result; });
    sessions.setAssignedTo(project, task, person, initial.version); await entered.promise; const restored = { ...initial, assignedTo: otherPerson, title: 'Restored history' }; await replace(sessions, restored); if (observe) sessions.observe(project, task, world.node(project, task), true);
    const resume = pause(); release.resolve(); await flush(); expect(writes).not.toHaveBeenCalled(); reads.mockResolvedValueOnce(restored); resume();
    await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored)); expect(sessions.snapshot(project, task).mutation.phase).toBe('conflict'); expect(writes).not.toHaveBeenCalled();
  });
  it.each(['success', 'network', 'malformed200'] as const)('waits for identity before reconciling an old history $0 result', async (outcome) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise); sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    const restored = { ...initial, assignedTo: otherPerson, title: 'New history', version: 3n }; await replace(sessions, restored); const world = worlds.get(sessions)!; sessions.observe(project, task, world.node(project, task), true); const resume = pause();
    if (outcome === 'success') pending.resolve(assigned()); else { if (outcome === 'malformed200') writes.mock.calls[0]![5].onWriteConfirmed?.(); pending.reject(new ApiError(outcome === 'network' ? 'network' : 'protocol', outcome === 'network' ? null : 200)); }
    await flush(); expect(reads).toHaveBeenCalledOnce(); expect(sessions.snapshot(project, task).detail?.assignedTo).not.toBe(person); reads.mockResolvedValueOnce(restored); resume();
    await waitFor(() => expect(sessions.snapshot(project, task).detail).toEqual(restored)); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledTimes(2); expect(sessions.snapshot(project, task).mutation.phase).toBe('reconciled');
  });
  it.each([false, true])('retires a waiting assignment when identity is invalidated submitted=%s', async (submitted) => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise); const resume = submitted ? null : pause(); sessions.setAssignedTo(project, task, person, initial.version);
    if (submitted) await waitFor(() => expect(writes).toHaveBeenCalledOnce()); const world = worlds.get(sessions)!; void world.scope.invalidateScope(); resume?.(); pending.resolve(assigned()); await flush();
    expect(world.scope.isInvalidated).toBe(true); expect(writes).toHaveBeenCalledTimes(submitted ? 1 : 0); expect(reads).toHaveBeenCalledOnce(); expect(sessions.snapshot(project, task).detail?.assignedTo).not.toBe(person);
  });
  it('revokes project access for a trusted assignment 404 before paused identity admission resumes', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; const result = deferred<Response>(); const actual = await vi.importActual<typeof import('../src/api/client')>('../src/api/client');
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(result.promise)); writes.mockImplementationOnce(actual.setTaskAssignedTo); sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    const resume = pause(); const revoke = vi.spyOn(world.scope, 'revokeProject');
    result.resolve(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Project access withdrawn', requestId: 'assignment-denied' } }), { status: 404, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) }));
    await waitFor(() => expect(sessions.snapshot(project, task).detail).toBeNull()); expect(revoke).toHaveBeenCalledOnce(); expect(sessions.snapshot(project, task).error).toMatchObject({ status: 404, code: 'not_found', requestId: 'assignment-denied' }); expect(reads).toHaveBeenCalledOnce();
    resume(); expect(world.scope.getAuthorizedProject(project)).toBeNull(); expect(writes).toHaveBeenCalledOnce();
  });
  it('does not let an old history assignment 404 revoke its replacement project', async () => {
    const sessions = createSessions(); await open(sessions); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise); sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(writes).toHaveBeenCalledOnce());
    const restored = { ...initial, assignedTo: otherPerson, title: 'Replacement history', version: 3n }; await replace(sessions, restored); const world = worlds.get(sessions)!; const current = world.scope.getAuthorizedProject(project)!; sessions.observe(project, task, world.node(project, task), true); const revoke = vi.spyOn(world.scope, 'revokeProject');
    pending.reject(new ApiError('server', 404, 'not_found')); await waitFor(() => expect(sessions.snapshot(project, task).mutation.phase).toBe('refused'));
    expect(revoke).not.toHaveBeenCalled(); expect(world.scope.getAuthorizedProject(project)?.manifest.cacheGeneration).toBe(current.manifest.cacheGeneration); expect(world.scope.getAuthorizedProject(project)?.index.nodes.get(task)?.assignedTo).toBe(otherPerson); expect(writes).toHaveBeenCalledOnce();
  });
  it('accepts a trusted deletion receipt without replaying the assignment or revoking the parent project', async () => {
    const sessions = createSessions(); await open(sessions); const world = worlds.get(sessions)!; writes.mockRejectedValueOnce(new ApiError('server', 410, 'task_deleted'));
    sessions.setAssignedTo(project, task, person, initial.version); await waitFor(() => expect(sessions.snapshot(project, task).status).toBe('deleted'));
    expect(sessions.snapshot(project, task).detail).toBeNull(); expect(world.scope.getAuthorizedProject(project)).not.toBeNull(); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
});
