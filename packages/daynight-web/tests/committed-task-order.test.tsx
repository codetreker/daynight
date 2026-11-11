import { act, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { useTaskGraph } from '../src/features/projects/useTaskGraph';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { taskSyncQuery, taskSyncResponse, TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const goalId = '30000000-0000-4000-8000-000000000001';
const goal = detailFixture(project, goalId, { type: 'goal', ready: false });
let scope: ReturnType<typeof createTaskCacheScope>;
let sessions: TaskDetailSessions | null = null;
let rendered: string[] = [];

const Probe = ({ direct }: { readonly direct: boolean }) => {
  const graph = useTaskGraph(project);
  const owner = useTaskDetailSessions(); sessions = owner;
  const subscribe = useCallback((listener: () => void) => owner.subscribe(project, task, listener), [owner]);
  const get = useCallback(() => owner.snapshot(project, task), [owner]);
  const detail = useSyncExternalStore(subscribe, get);
  const opened = useRef(false);
  useEffect(() => owner.subscribeProject(project, graph.refresh), [owner, graph.refresh]);
  useEffect(() => {
    if (direct || graph.snapshot === null) return;
    owner.observe(project, task, graph.snapshot.index.nodes.get(task));
    if (!opened.current) { opened.current = true; owner.load(project, task, 1, 'open'); }
  }, [owner, graph.snapshot, direct]);
  const pair = `${graph.snapshot?.index.nodes.get(task)?.status ?? 'loading'}:${detail.detail?.status ?? 'loading'}`;
  useLayoutEffect(() => { rendered.push(pair); }, [pair]);
  return <output data-testid="status-pair">{pair}</output>;
};

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); rendered = []; });
afterEach(() => { scope.dispose(); sessions = null; vi.unstubAllGlobals(); });

it.each(['summary', 'direct'] as const)('publishes the %s Goal Task detail before its status projection', async mode => {
  const before = detailFixture(project, task, { parentId: goalId, status: 'todo', ready: true });
  const after = { ...before, status: 'done' as const, ready: false, completedAt: before.updatedAt, version: before.version + 1n };
  let committed = false;
  const held = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (committed) return held;
      const details = [before, goal];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PUT') { committed = true; return Promise.resolve(resourceResponse(after, TEST_VIEWER_ID)); }
    return committed ? held : Promise.resolve(resourceResponse(before, TEST_VIEWER_ID));
  }));
  render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe direct={mode === 'direct'} /></TaskDetailSessionProvider></TaskCacheProvider>);
  if (mode === 'direct') {
    await waitFor(() => expect(screen.getByTestId('status-pair')).toHaveTextContent('todo:loading'));
    act(() => sessions!.openDirect(project, task));
  }
  await waitFor(() => expect(screen.getByTestId('status-pair')).toHaveTextContent('todo:todo'));
  act(() => sessions!.setStatus(project, task, 'done', before.version));
  await waitFor(() => expect(screen.getByTestId('status-pair')).toHaveTextContent('done:done'));
  expect(rendered).not.toContain('done:todo');
  if (mode === 'direct') expect(sessions!.snapshot(project, task).requiresFreshRead).toBe(true);
});

it.each(['summary', 'direct-closed'] as const)('keeps the unassigned Task snapshot until sync after %s status change', async mode => {
  const before = detailFixture(project, task, { parentId: null, status: 'todo', ready: true });
  const after = { ...before, status: 'done' as const, ready: false, completedAt: before.updatedAt, version: before.version + 1n };
  let committed = false; let reconcileStarted = false; let resolveWrite!: (response: Response) => void;
  const write = new Promise<Response>(resolve => { resolveWrite = resolve; });
  const held = new Promise<Response>(() => {});
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname.endsWith('/task-sync')) {
      if (committed) return held;
      const details = [before, goal];
      return Promise.resolve(taskSyncResponse(graphFixture(details), { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(parsed), versionForTask: item => details.find(value => value.id === item.id)!.version, propertiesForTask: item => details.find(value => value.id === item.id)!.properties }));
    }
    if (init?.method === 'PUT') { committed = true; return write; }
    if (committed) { reconcileStarted = true; return held; }
    return Promise.resolve(resourceResponse(before, TEST_VIEWER_ID));
  }));
  const view = render(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Probe direct={mode === 'direct-closed'} /></TaskDetailSessionProvider></TaskCacheProvider>);
  if (mode === 'direct-closed') {
    await waitFor(() => expect(screen.getByTestId('status-pair')).toHaveTextContent('todo:loading'));
    act(() => sessions!.openDirect(project, task));
  }
  await waitFor(() => expect(screen.getByTestId('status-pair')).toHaveTextContent('todo:todo'));
  act(() => sessions!.setStatus(project, task, 'done', before.version));
  await waitFor(() => expect(committed).toBe(true));
  if (mode === 'direct-closed') {
    // Drop the detail subscription while retaining the project graph owner.
    act(() => sessions!.releaseRead(project, task));
  }
  await act(async () => { resolveWrite(resourceResponse(after, TEST_VIEWER_ID)); await write; });
  if (mode === 'direct-closed') await waitFor(() => expect(reconcileStarted).toBe(true));
  else await waitFor(() => expect(sessions!.snapshot(project, task).mutation.phase).toBe('confirmed'));
  await waitFor(() => expect(screen.getByTestId('status-pair').textContent).toMatch(/^todo:/));
  expect(rendered.some(pair => pair.startsWith('done:'))).toBe(false);
  view.unmount();
});
