import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { useTaskGraph } from '../src/features/projects/useTaskGraph';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { projectTaskScope } from '../src/features/task-graph/scope';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { taskSyncQuery, taskSyncResponse, TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const firstGoal = '30000000-0000-4000-8000-000000000001';
const secondGoal = '30000000-0000-4000-8000-000000000002';
const first = detailFixture(project, firstGoal, { type: 'goal', ready: false });
const second = detailFixture(project, secondGoal, { type: 'goal', ready: false });
const original = detailFixture(project, task, { parentId: firstGoal, status: 'done', ready: false });
const moved = { ...original, parentId: secondGoal, version: original.version + 1n };
let scope: ReturnType<typeof createTaskCacheScope>;
let sessions: TaskDetailSessions | null = null;
const Probe = ({ mode = 'summary' }: { readonly mode?: 'summary' | 'direct' }) => {
  const graph = useTaskGraph(project); const owner = useTaskDetailSessions(); sessions = owner;
  useEffect(() => owner.subscribeProject(project, graph.refresh), [owner, graph.refresh]);
  const snapshot = graph.snapshot;
  useEffect(() => { if (mode === 'summary' && snapshot !== null) owner.observe(project, task, snapshot.index.nodes.get(task)); }, [owner, snapshot, mode]);
  return <><output data-testid="projection">{snapshot === null ? 'unavailable' : `${snapshot.index.nodes.get(task)?.parentId}:${projectTaskScope(snapshot.index, firstGoal).progress.done}:${projectTaskScope(snapshot.index, secondGoal).progress.done}`}</output><output data-testid="goal-status">{snapshot?.summaries.get(firstGoal)?.status ?? 'unavailable'}</output><output data-testid="error">{graph.error === null ? 'none' : 'error'}</output></>;
};
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); });
afterEach(() => { scope.dispose(); sessions = null; vi.unstubAllGlobals(); });

it.each([
  { mode: 'summary', sync: 'pending' }, { mode: 'summary', sync: 'failed' },
  { mode: 'direct', sync: 'pending' }, { mode: 'direct', sync: 'failed' },
] as const)('shows updated Goal progress with a $mode owner while project sync is $sync', async ({ mode, sync }) => {
  let committed = false;
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (committed) return sync === 'pending' ? pending : Promise.reject(new Error('offline'));
      const details = [original, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PATCH') { committed = true; return Promise.resolve(resourceResponse(moved, TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(committed ? moved : original, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe mode={mode} /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  act(() => { if (mode === 'direct') sessions!.openDirect(project, task); else { sessions!.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions!.load(project, task, 1, 'open'); } });
  await waitFor(() => expect(sessions!.snapshot(project, task).requiresFreshRead).toBe(false));
  act(() => sessions!.setParent(project, task, secondGoal, original.version));
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${secondGoal}:0:1`));
  if (sync === 'failed') await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
});

it('does not publish an old Parent receipt after project history changes', async () => {
  const replacementEpoch = '40000000-0000-4000-8000-000000000004';
  let finishWrite!: (response: Response) => void; let dispatched = false; let rotated = false;
  const write = new Promise<Response>(resolve => { finishWrite = resolve; });
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (rotated) return pending;
      const details = [original, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PATCH') { dispatched = true; return write; }
    return Promise.resolve(resourceResponse(original, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  act(() => { sessions!.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions!.load(project, task, 1, 'open'); });
  await waitFor(() => expect(sessions!.snapshot(project, task).requiresFreshRead).toBe(false));
  act(() => sessions!.setParent(project, task, secondGoal, original.version));
  await waitFor(() => expect(dispatched).toBe(true));
  const ticket = await scope.beginSync(project, scope.signal); rotated = true;
  await act(async () => { expect(await scope.observeHistory(ticket, replacementEpoch, scope.signal)).toBe('retired'); });
  await act(async () => { finishWrite(resourceResponse(moved, TEST_VIEWER_ID)); await write; });
  expect(screen.getByTestId('projection')).toHaveTextContent('unavailable');
});

it.each(['older', 'conflicting', 'newer'] as const)('handles a subsequent %s project observation without silently rolling back the Parent receipt', async kind => {
  const later = { ...moved, parentId: firstGoal, version: kind === 'newer' ? moved.version + 1n : moved.version };
  const next = kind === 'older' ? original : later;
  let committed = false; let syncUrl: URL | null = null; let finishSync!: (response: Response) => void;
  const heldSync = new Promise<Response>(resolve => { finishSync = resolve; });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (committed) { syncUrl = parsed; return heldSync; }
      const details = [original, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PATCH') { committed = true; return Promise.resolve(resourceResponse(moved, TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(committed ? moved : original, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  act(() => { sessions!.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions!.load(project, task, 1, 'open'); });
  await waitFor(() => expect(sessions!.snapshot(project, task).requiresFreshRead).toBe(false));
  act(() => sessions!.setParent(project, task, secondGoal, original.version));
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${secondGoal}:0:1`));
  await waitFor(() => expect(syncUrl).not.toBeNull());
  const details = [next, first, second];
  await act(async () => { finishSync(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(syncUrl!), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties })); await heldSync; });
  if (kind === 'older') {
    await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${secondGoal}:0:1`));
  } else if (kind === 'newer') {
    await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  } else {
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
  }
});

it('updates the Goal status from its confirmed receipt while project sync is delayed', async () => {
  const after = { ...first, status: 'done' as const, completedAt: first.updatedAt, version: first.version + 1n };
  let committed = false;
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (committed) return pending;
      const details = [original, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PUT') { committed = true; return Promise.resolve(resourceResponse(after, TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(parsed.pathname.endsWith(firstGoal) ? committed ? after : first : original, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('goal-status')).toHaveTextContent('todo'));
  act(() => { sessions!.openDirect(project, firstGoal); });
  await waitFor(() => expect(sessions!.snapshot(project, firstGoal).requiresFreshRead).toBe(false));
  act(() => sessions!.setStatus(project, firstGoal, 'done', first.version));
  await waitFor(() => expect(screen.getByTestId('goal-status')).toHaveTextContent('done'));
});

it('updates Goal progress from a confirmed Task status and exposes a failed sync', async () => {
  const before = { ...original, status: 'todo' as const, ready: true };
  const after = { ...before, status: 'done' as const, ready: false, completedAt: before.updatedAt, version: before.version + 1n };
  let committed = false;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (committed) return Promise.reject(new Error('offline'));
      const details = [before, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PUT') { committed = true; return Promise.resolve(resourceResponse(after, TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(committed ? after : before, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:0:0`));
  act(() => { sessions!.observe(project, task, scope.getAuthorizedProject(project)!.index.nodes.get(task)); sessions!.load(project, task, 1, 'open'); });
  await waitFor(() => expect(sessions!.snapshot(project, task).requiresFreshRead).toBe(false));
  act(() => sessions!.setStatus(project, task, 'done', before.version));
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
});

it.each(['parent', 'goal-status'] as const)('does not publish a late %s receipt into a reopened direct session', async kind => {
  const target = kind === 'parent' ? task : firstGoal;
  const before = kind === 'parent' ? original : first;
  const saved = kind === 'parent' ? moved : { ...first, status: 'done' as const, completedAt: first.updatedAt, version: first.version + 1n };
  const reopened = { ...before, title: 'Newer session', version: before.version + 2n };
  let dispatched = false; let reopenedRead = false; let finishWrite!: (response: Response) => void;
  const write = new Promise<Response>(resolve => { finishWrite = resolve; });
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (dispatched) return pending;
      const details = [original, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PATCH' || init?.method === 'PUT') { dispatched = true; return write; }
    return Promise.resolve(resourceResponse(reopenedRead ? reopened : before, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe mode="direct" /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  const unsubscribe = sessions!.subscribe(project, target, () => {});
  act(() => sessions!.openDirect(project, target));
  await waitFor(() => expect(sessions!.snapshot(project, target).detail).toEqual(before));
  act(() => { if (kind === 'parent') sessions!.setParent(project, target, secondGoal, before.version); else sessions!.setStatus(project, target, 'done', before.version); });
  await waitFor(() => expect(dispatched).toBe(true));
  act(() => { unsubscribe(); reopenedRead = true; sessions!.subscribe(project, target, () => {}); sessions!.openDirect(project, target); });
  await waitFor(() => expect(sessions!.snapshot(project, target).detail).toEqual(reopened));
  await act(async () => { finishWrite(resourceResponse(saved, TEST_VIEWER_ID)); await write; });
  expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`);
  expect(screen.getByTestId('goal-status')).toHaveTextContent('todo');
  expect(sessions!.snapshot(project, target).detail).toEqual(reopened);
});

it('publishes the Parent receipt to project progress after the direct detail is closed', async () => {
  let committed = false; let dispatched = false; let finishWrite!: (response: Response) => void;
  const write = new Promise<Response>(resolve => { finishWrite = resolve; });
  const pending = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (dispatched) return pending;
      const details = [original, first, second];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PATCH') { dispatched = true; return write; }
    return Promise.resolve(resourceResponse(committed ? moved : original, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe mode="direct" /></TaskDetailSessionProvider></TaskCacheProvider>);
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${firstGoal}:1:0`));
  const unsubscribe = sessions!.subscribe(project, task, () => {});
  act(() => sessions!.openDirect(project, task));
  await waitFor(() => expect(sessions!.snapshot(project, task).detail).toEqual(original));
  act(() => sessions!.setParent(project, task, secondGoal, original.version));
  await waitFor(() => expect(dispatched).toBe(true));
  act(() => unsubscribe());
  await act(async () => { committed = true; finishWrite(resourceResponse(moved, TEST_VIEWER_ID)); await write; });
  await waitFor(() => expect(screen.getByTestId('projection')).toHaveTextContent(`${secondGoal}:0:1`));
});
