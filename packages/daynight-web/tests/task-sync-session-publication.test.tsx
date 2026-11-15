import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { ApiError, getTaskSync, pauseAuthRequests } from '../src/api/client';
import type { TaskSync, TaskSyncRead, WorkerClaim } from '../src/api/types';
import { useTaskGraph } from '../src/features/projects/useTaskGraph';
import { TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { createTaskCacheScope, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA, type TaskCacheSchema } from '../src/features/task-cache/database';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph, taskSyncReadFixture, TEST_VIEWER_ID } from './helpers/taskSync';
import { observationFor } from '../src/features/task-session-summary/project-observations';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTaskSync: vi.fn() }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const worker: WorkerClaim = { claimId: '30000000-0000-4000-8000-000000000001', state: 'active', userId: TEST_VIEWER_ID,
  workerId: '30000000-0000-4000-8000-000000000002', worktreeId: '30000000-0000-4000-8000-000000000003',
  machine: { id: '30000000-0000-4000-8000-000000000002', name: 'Test' }, platform: 'linux', agent: 'codex',
  agentControlMode: 'web', phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: '2026-10-22T10:00:00Z' };
const task = detailFixture(projectId, taskId, { status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', properties: { worker: { ...worker } } });
const graph = graphFixture([task]);
const sync = (sessions: TaskSync['sessions'], query: { readonly epoch?: string; readonly since?: string } = {}) => taskSyncFromGraph(graph, {
  sessions, query, versionForTask: () => 1n, propertiesForTask: () => task.properties,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
};
const scopes: TaskCacheScope[] = [];
const cache = () => { const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(scope); return scope; };
const mount = (scope: TaskCacheScope) => renderHook(() => useTaskGraph(projectId), {
  wrapper: ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>,
});
beforeEach(() => { vi.mocked(getTaskSync).mockReset(); });
afterEach(() => scopes.splice(0).forEach((scope) => scope.dispose()));

it('distinguishes a missing or mismatched observation from a confirmed failure and expiration', async () => {
  const missing = { ...sync({}), taskObservations: {} };
  vi.mocked(getTaskSync).mockResolvedValueOnce(taskSyncReadFixture(missing));
  const view = mount(cache());
  const displayed = () => observationFor(view.result.current.observationStore.snapshot(), task);
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  expect(displayed()).toEqual({ state: 'unobserved', needsAttention: null, canOpen: false });
  const failed = { taskVersion: 1n, state: 'unavailable' as const, observedAt: null, freshUntil: null, needsAttention: null, canOpen: false };
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture({ ...sync({}, query), tasks: [], taskObservations: { [taskId]: failed } }));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(displayed()?.state).toBe('unavailable'));
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture({ ...sync({}, query), tasks: [], taskObservations: { [taskId]: { ...failed, taskVersion: 2n } } }));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(displayed()?.state).toBe('unobserved'));
  const expired = { taskVersion: 1n, state: 'working' as const, observedAt: '2026-10-22T09:59:00Z', freshUntil: '2026-10-22T09:59:30Z', needsAttention: false, canOpen: true };
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture({ ...sync({}, query), tasks: [], taskObservations: { [taskId]: expired } }));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(displayed()).toEqual({ state: 'expired', needsAttention: null, canOpen: false }));
  view.unmount();
});

it('marks a failed project read unavailable, withdraws its Session entrance and recovers on success', async () => {
  const live = { taskVersion: 1n, state: 'working' as const, observedAt: '2026-10-22T10:00:00Z', freshUntil: '2026-10-22T10:00:30Z', needsAttention: false, canOpen: true };
  const withLive = (query: { readonly epoch?: string; readonly since?: string } = {}) => ({ ...sync({}, query), taskObservations: { [taskId]: live } });
  vi.mocked(getTaskSync).mockResolvedValueOnce(taskSyncReadFixture(withLive()));
  const view = mount(cache());
  await waitFor(() => expect(view.result.current.observationStore.snapshot().get(taskId)?.canOpen).toBe(true));
  vi.mocked(getTaskSync).mockRejectedValueOnce(new ApiError('network'));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.observationStore.snapshot().get(taskId)).toEqual({ state: 'unavailable', needsAttention: null, canOpen: false }));
  expect(view.result.current.observationStore.matches(view.result.current.snapshot!.summaries.get(taskId)!)).toBe(true);
  expect(view.result.current.error).toMatchObject({ kind: 'network' });
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture({ ...withLive(query), tasks: [] }));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.observationStore.snapshot().get(taskId)).toEqual({ state: 'working', needsAttention: false, canOpen: true }));
  expect(view.result.current.error).toBeNull();
  view.unmount();
});

it.each(['no worker', 'completed worker'] as const)('rejects a readable Session on a same-version delta with %s', async (kind) => {
  const properties = kind === 'no worker' ? {} : { worker: { ...worker, state: 'completed' as const } };
  const restarted = { ...task, properties };
  const base = (query: { readonly epoch?: string; readonly since?: string } = {}) => taskSyncFromGraph(graphFixture([restarted]), {
    query, versionForTask: () => 1n, propertiesForTask: () => properties,
    taskObservations: { [taskId]: { taskVersion: 1n, state: 'no_session', observedAt: '2026-10-22T10:00:00Z', freshUntil: '2026-10-22T10:00:30Z', needsAttention: null, canOpen: false } },
  });
  vi.mocked(getTaskSync).mockResolvedValueOnce(taskSyncReadFixture(base()));
  const scope = cache(); const view = mount(scope);
  await waitFor(() => expect(view.result.current.observationStore.snapshot().get(taskId)?.state).toBe('no_session'));
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture({ ...base(query), tasks: [],
    taskObservations: { [taskId]: { taskVersion: 1n, state: 'working', observedAt: '2026-10-22T10:00:00Z', freshUntil: '2026-10-22T10:00:30Z', needsAttention: false, canOpen: true } },
  }));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.error).toMatchObject({ kind: 'protocol' }));
  expect(view.result.current.observationStore.snapshot().get(taskId)?.canOpen).not.toBe(true);
  expect(view.result.current.snapshot?.summaries.get(taskId)?.properties).toEqual(properties);
  view.unmount();
});

it('publishes a readable active herdr Session even when its activity is unavailable', async () => {
  const herdr: WorkerClaim = { ...worker, agentControlMode: 'herdr', herdr: { session: 'session', workspaceId: 'workspace', paneId: 'pane' } };
  const running = { ...task, properties: { worker: herdr } };
  const response = taskSyncFromGraph(graphFixture([running]), { versionForTask: () => 1n, propertiesForTask: () => running.properties,
    taskObservations: { [taskId]: { taskVersion: 1n, state: 'unavailable', observedAt: '2026-10-22T10:00:00Z', freshUntil: '2026-10-22T10:00:30Z', needsAttention: null, canOpen: true } },
  });
  vi.mocked(getTaskSync).mockResolvedValueOnce(taskSyncReadFixture(response));
  const view = mount(cache());
  await waitFor(() => expect(view.result.current.observationStore.snapshot().get(taskId)).toEqual({ state: 'unavailable', needsAttention: null, canOpen: true }));
  expect(view.result.current.error).toBeNull();
  view.unmount();
});

it('persists a hidden background Task update without publishing its Session', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.mocked(getTaskSync).mockImplementationOnce(async () => taskSyncReadFixture(sync({ [taskId]: 'working' })));
  const scope = cache();
  const applied = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const applySync = scope.applySync.bind(scope); let applications = 0;
  vi.spyOn(scope, 'applySync').mockImplementation((...args) => {
    const result = applySync(...args); const index = applications++;
    void result.then(() => applied[index]?.resolve(), (error) => applied[index]?.reject(error));
    return result;
  });
  const view = mount(scope);
  act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await act(async () => { await applied[0]!.promise; });
  expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working');
  const changed = { ...task, title: 'Background update', version: 2n, updatedAt: '2026-10-22T10:00:01Z' };
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(taskSyncFromGraph(graphFixture([changed]), {
    query, sessions: { [taskId]: 'notice' }, versionForTask: () => 2n, propertiesForTask: () => changed.properties,
  })));
  act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  expect(view.result.current.sessionStore.snapshot().size).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  await act(async () => { await applied[1]!.promise; });
  expect(view.result.current.snapshot?.summaries.get(taskId)?.version).toBe(2n);
  expect(view.result.current.snapshot?.index.nodes.get(taskId)?.titlePreview).toBe('Background update');
  expect(view.result.current.sessionStore.snapshot().size).toBe(0);
  const database = await openDB<TaskCacheSchema>(TASK_CACHE_DATABASE, TASK_CACHE_SCHEMA);
  try {
    expect((await database.get('summaries', [TEST_VIEWER_ID, projectId, taskId]))?.summary).toMatchObject({ titlePreview: 'Background update', version: 2n });
  } finally { database.close(); view.unmount(); }
});

it('only publishes this page producer and accepts Session-only empty deltas', async () => {
  vi.mocked(getTaskSync).mockImplementation(async (_project, query) => taskSyncReadFixture(sync({ [taskId]: 'working' }, query)));
  const scope = cache(); const view = mount(scope);
  act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await waitFor(() => expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working'));
  const ticket = await scope.beginSync(projectId, new AbortController().signal);
  await act(async () => { await scope.applySync(ticket, { ...sync({ [taskId]: 'warning' }, { epoch: ticket.epoch! }), tasks: [] }, new AbortController().signal); });
  expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working');
  const project = scope.getAuthorizedProject(projectId)!;
  vi.mocked(getTaskSync).mockImplementation(async (_project, query) => taskSyncReadFixture({ ...sync({ [taskId]: 'notice' }, query), tasks: [] }));
  act(() => view.result.current.refresh());
  await waitFor(() => expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('notice'));
  expect(scope.getAuthorizedProject(projectId)?.graph).toBe(project.graph); expect(scope.getAuthorizedProject(projectId)?.index).toBe(project.index);
  vi.mocked(getTaskSync).mockImplementation(async (_project, query) => taskSyncReadFixture({ ...sync({}, query), tasks: [] }));
  act(() => view.result.current.refresh()); await waitFor(() => expect(view.result.current.sessionStore.snapshot().size).toBe(0));
});

it.each([12_000, 31_000])('keeps the API body receipt across %s ms of cache application', async (delay) => {
  let now = 0; const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const scope = cache(); const application = scope.applySync.bind(scope);
  vi.spyOn(scope, 'applySync').mockImplementationOnce(async (...args) => {
    const result = await application(...args); now = delay; return result;
  });
  vi.mocked(getTaskSync).mockResolvedValueOnce({ sync: sync({ [taskId]: 'pending' }), receivedMonotonic: 0 }).mockImplementation(() => new Promise(() => {}));
  const view = mount(scope); act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  expect(view.result.current.snapshot?.receivedMonotonic).toBe(0);
  expect(view.result.current.sessionStore.snapshot().has(taskId)).toBe(delay <= 30_000);
  now = 30_001; act(() => view.result.current.sessionStore.setActive(true));
  expect(view.result.current.sessionStore.snapshot().size).toBe(0);
  view.unmount(); clock.mockRestore();
});

it.each(['success', 'failure'] as const)('ignores a superseded %s after a newer Session observation is accepted', async (outcome) => {
  vi.mocked(getTaskSync).mockImplementationOnce(async () => taskSyncReadFixture(sync({ [taskId]: 'working' })));
  const scope = cache(); const view = mount(scope); act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await waitFor(() => expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working'));
  const old = deferred<TaskSyncRead>(); vi.mocked(getTaskSync).mockReturnValueOnce(old.promise);
  act(() => view.result.current.refresh()); await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  const oldSignal = vi.mocked(getTaskSync).mock.calls[1]![3];
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(sync({ [taskId]: 'notice' }, query)));
  act(() => view.result.current.refresh()); await waitFor(() => expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('notice'));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => { if (outcome === 'success') old.resolve(taskSyncReadFixture(sync({}))); else old.reject(new ApiError('network')); });
  expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('notice'); expect(view.result.current.error).toBeNull();
});

it('preserves a valid Session while reading and clears it only when the current read fails', async () => {
  vi.mocked(getTaskSync).mockImplementationOnce(async () => taskSyncReadFixture(sync({ [taskId]: 'working' })));
  const scope = cache(); const view = mount(scope); act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await waitFor(() => expect(view.result.current.sessionStore.snapshot().has(taskId)).toBe(true));
  const pending = deferred<TaskSyncRead>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  act(() => view.result.current.refresh()); await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working');
  const error = new ApiError('network'); await act(async () => pending.reject(error));
  await waitFor(() => expect(view.result.current.error).toBe(error));
  expect(view.result.current.snapshot).not.toBeNull(); expect(view.result.current.sessionStore.snapshot().size).toBe(0);
});

it.each([false, true])('keeps an in-flight C1 Session observation bound to C1 after the cache accepts C2 (old rows: %s)', async (returnedOldRows) => {
  vi.mocked(getTaskSync).mockImplementationOnce(async () => taskSyncReadFixture(sync({ [taskId]: 'working' })));
  const scope = cache(); const view = mount(scope); act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await waitFor(() => expect(view.result.current.sessionStore.snapshot().has(taskId)).toBe(true));
  const pending = deferred<TaskSyncRead>(); vi.mocked(getTaskSync).mockReturnValueOnce(pending.promise);
  act(() => view.result.current.refresh()); await waitFor(() => expect(getTaskSync).toHaveBeenCalledTimes(2));
  const oldQuery = vi.mocked(getTaskSync).mock.calls[1]![1]; const old = sync({ [taskId]: 'notice' }, oldQuery);
  const changed = { ...task, version: 2n, updatedAt: '2026-10-22T10:00:01Z', properties: { worker: { ...worker, claimId: '30000000-0000-4000-8000-000000000004' } } };
  const changedGraph = graphFixture([changed]); const ticket = await scope.beginSync(projectId, new AbortController().signal);
  const current = taskSyncFromGraph(changedGraph, { query: { epoch: ticket.epoch! }, sessions: { [taskId]: 'warning' }, versionForTask: () => 2n, propertiesForTask: () => changed.properties });
  await act(async () => { await scope.applySync(ticket, current, new AbortController().signal); });
  expect(view.result.current.sessionStore.snapshot().has(taskId)).toBe(false);
  await act(async () => { pending.resolve(taskSyncReadFixture({ ...old, tasks: returnedOldRows ? old.tasks : [] })); });
  await waitFor(() => expect(view.result.current.refreshing).toBe(false));
  expect(scope.getAuthorizedProject(projectId)?.summaries.get(taskId)?.version).toBe(2n);
  expect(view.result.current.sessionStore.snapshot().has(taskId)).toBe(false);
  vi.mocked(getTaskSync).mockImplementationOnce(async () => taskSyncReadFixture({ ...current, sessions: { [taskId]: 'working' }, tasks: [] }));
  act(() => view.result.current.refresh()); await waitFor(() => expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working'));
});

it('does not republish a pre-pause Session after cache application resumes, while retaining the Task update', async () => {
  vi.mocked(getTaskSync).mockImplementationOnce(async () => taskSyncReadFixture(sync({ [taskId]: 'working' })));
  const scope = cache(); const view = mount(scope); act(() => view.result.current.sessionStore.setChain('chain', [taskId], true));
  await waitFor(() => expect(view.result.current.sessionStore.snapshot().has(taskId)).toBe(true));
  const changed = { ...task, title: 'Updated during sync', version: 2n, updatedAt: '2026-10-22T10:00:01Z' };
  const changedGraph = graphFixture([changed]);
  const applied = deferred<void>(); const release = deferred<void>(); const application = scope.applySync.bind(scope);
  vi.spyOn(scope, 'applySync').mockImplementationOnce(async (...args) => {
    const result = await application(...args); applied.resolve(); await release.promise; return result;
  });
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture(taskSyncFromGraph(changedGraph, {
    query, sessions: { [taskId]: 'notice' }, versionForTask: () => 2n, propertiesForTask: () => changed.properties,
  })));
  act(() => view.result.current.refresh()); await act(async () => { await applied.promise; });
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); }); expect(view.result.current.sessionStore.snapshot().size).toBe(0);
  act(() => resume()); await act(async () => release.resolve());
  await waitFor(() => expect(view.result.current.refreshing).toBe(false));
  expect(view.result.current.snapshot?.index.nodes.get(taskId)?.titlePreview).toBe('Updated during sync');
  expect(scope.getAuthorizedProject(projectId)?.summaries.get(taskId)?.version).toBe(2n);
  expect(view.result.current.sessionStore.snapshot().size).toBe(0);
  vi.mocked(getTaskSync).mockImplementationOnce(async (_project, query) => taskSyncReadFixture({ ...taskSyncFromGraph(changedGraph, {
    query, sessions: { [taskId]: 'working' }, versionForTask: () => 2n, propertiesForTask: () => changed.properties,
  }), tasks: [] }));
  act(() => view.result.current.refresh()); await waitFor(() => expect(view.result.current.sessionStore.snapshot().get(taskId)?.indicator).toBe('working'));
});
