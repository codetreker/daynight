import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { useTaskRelations } from '../src/features/task-detail/useTaskRelations';
import { detailFixture, graphFixture, resourceResponse } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const nextId = '20000000-0000-4000-8000-000000000002';
const parent = detailFixture(projectId, taskId, { title: 'Parent' });
const graph = (title: string) => graphFixture([parent, detailFixture(projectId, nextId, { title, dependsOn: [taskId] })]);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
let sessions: TaskDetailSessions;
function Harness() {
  sessions = useTaskDetailSessions();
  const subscribe = useCallback((listener: () => void) => sessions.subscribe(projectId, taskId, listener), [sessions]);
  const state = useSyncExternalStore(subscribe, () => sessions.snapshot(projectId, taskId));
  const history = sessions.historyGeneration(projectId);
  useEffect(() => { sessions.openDirect(projectId, taskId); return () => sessions.releaseRead(projectId, taskId); }, []);
  const value = useTaskRelations(projectId, taskId, history, state.status === 'ready' && state.detail !== null);
  return <><span data-testid="status">{state.status}:{String(state.error)}</span><span data-testid="successor">{value.relations?.nodes.get(nextId)?.titlePreview ?? 'none'}</span><span data-testid="error">{value.error === null ? 'none' : 'error'}</span><button onClick={value.refresh}>Retry</button></>;
}
const mount = () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const view = renderWithLocale(<TaskDetailSessionProvider><Harness /></TaskDetailSessionProvider>, { locale: 'en', taskCache: { scope } });
  return { scope, view };
};
const timers = () => {
  let tick = () => {};
  const original = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 15_000) tick = handler as () => void;
    return original(handler, delay, ...args);
  }) as typeof setInterval);
  return () => act(() => tick());
};
const deadlines = () => {
  let expire: (() => void) | null = null;
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000) { expire = handler as () => void; return 0; }
    return original(handler, delay, ...args);
  }) as typeof setTimeout);
  return () => { expect(expire).not.toBeNull(); act(() => expire!()); };
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('refreshes remote relations independently and retains them on failure', async () => {
  const tick = timers(); const held = deferred<Response>(); let graphReads = 0; const paths: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    paths.push(url);
    if (url.includes('/task-graph')) { graphReads++; return graphReads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID)) : graphReads === 2 ? held.promise : Promise.resolve(resourceResponse(graph('New'), TEST_VIEWER_ID)); }
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    tick(); await waitFor(() => expect(graphReads).toBe(2)); tick(); expect(graphReads).toBe(2);
    act(() => sessions.load(projectId, taskId, 1, 'automatic'));
    await waitFor(() => expect(paths.filter(path => path.endsWith(`/tasks/${taskId}`))).toHaveLength(2));
    await act(async () => held.resolve(wireResponse({ error: { code: 'internal_error', message: 'unavailable', requestId: 'failed' } }, { status: 503, headers: viewerHeaders(TEST_VIEWER_ID) })));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(screen.getByTestId('successor')).toHaveTextContent('Old');
    tick(); await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('New'));
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(paths.some(path => path.includes('/task-sync'))).toBe(false);
  } finally { view.unmount(); scope.dispose(); }
});

it('accepts a relation refresh across a newer Task receipt in the same opening', async () => {
  const tick = timers(); const held = deferred<Response>(); let graphReads = 0; let taskReads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/task-graph')) return ++graphReads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID)) : held.promise;
    taskReads++; return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    tick(); await waitFor(() => expect(graphReads).toBe(2));
    act(() => sessions.load(projectId, taskId, 1, 'automatic'));
    await waitFor(() => expect(taskReads).toBe(2));
    await waitFor(() => expect(sessions.snapshot(projectId, taskId).refreshing).toBe(false));
    await act(async () => held.resolve(resourceResponse(graph('New'), TEST_VIEWER_ID)));
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('New'));
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  } finally { view.unmount(); scope.dispose(); }
});

it('pauses hidden reads and discards results after access retirement', async () => {
  let visibility: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const tick = timers(); const held = deferred<Response>(); let reads = 0; const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/task-graph')) { reads++; signals.push(init!.signal!); return reads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID)) : held.promise; }
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    tick(); expect(reads).toBe(1);
    act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByTestId('successor')).toHaveTextContent('Old');
    act(() => scope.suspendProject(projectId));
    await waitFor(() => expect(signals[1]!.aborted).toBe(true));
    await act(async () => held.resolve(resourceResponse(graph('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('successor')).toHaveTextContent('none');
  } finally { view.unmount(); scope.dispose(); }
});

it('waits for identity verification before refreshing and does not restore retired history', async () => {
  const tick = timers(); const held = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/task-graph')) return ++reads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID)) : held.promise;
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount(); let resume: (() => void) | undefined;
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    act(() => { resume = pauseAuthRequests(); });
    tick(); await act(async () => { await Promise.resolve(); }); expect(reads).toBe(1);
    act(() => { resume?.(); resume = undefined; }); await waitFor(() => expect(reads).toBe(2));
    const fence = await scope.beginTaskRead(projectId, taskId, 0, 0, scope.signal);
    await act(async () => { expect(await scope.observeHistory(fence, '30000000-0000-4000-8000-000000000002', scope.signal)).toBe('retired'); });
    await act(async () => held.resolve(resourceResponse(graph('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('successor')).not.toHaveTextContent('Late');
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});

it('withdraws retained relations on a trusted access denial', async () => {
  const tick = timers(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/task-graph')) return ++reads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID))
      : Promise.resolve(wireResponse({ error: { code: 'not_found', message: 'unavailable', requestId: 'denied' } }, { status: 404, headers: viewerHeaders(TEST_VIEWER_ID) }));
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    tick(); await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(screen.getByTestId('successor')).toHaveTextContent('none');
  } finally { view.unmount(); scope.dispose(); }
});

it('withdraws a trusted denial during identity verification without waiting for the gate', async () => {
  const tick = timers(); const held = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/task-graph')) return ++reads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID)) : held.promise;
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount(); let resume: (() => void) | undefined;
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    tick(); await waitFor(() => expect(reads).toBe(2));
    act(() => { resume = pauseAuthRequests(); });
    await act(async () => held.resolve(wireResponse({ error: { code: 'forbidden', message: 'denied', requestId: 'denied' } }, { status: 403, headers: viewerHeaders(TEST_VIEWER_ID) })));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(screen.getByTestId('successor')).toHaveTextContent('none');
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});

it('lets manual retry replace a hung automatic read and ignores its late response', async () => {
  const tick = timers(); const held = deferred<Response>(); let reads = 0; const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/task-graph')) {
      reads++; signals.push(init!.signal!);
      return reads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID))
        : reads === 2 ? Promise.resolve(wireResponse({ error: { code: 'internal_error', message: 'unavailable', requestId: 'failed' } }, { status: 503, headers: viewerHeaders(TEST_VIEWER_ID) }))
        : reads === 3 ? held.promise : Promise.resolve(resourceResponse(graph('New'), TEST_VIEWER_ID));
    }
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    tick(); await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    tick(); await waitFor(() => expect(reads).toBe(3));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('New'));
    expect(signals[2]!.aborted).toBe(true); expect(reads).toBe(4);
    await act(async () => held.resolve(resourceResponse(graph('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('successor')).toHaveTextContent('New');
  } finally { view.unmount(); scope.dispose(); }
});

it.each([false, true])('times out a hung relation read and recovers on a later poll (refresh: %s)', async (refresh) => {
  const tick = timers(); const expire = deadlines(); const held = deferred<Response>(); let reads = 0;
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/task-graph')) {
      reads++; signals.push(init!.signal!);
      if (refresh && reads === 1) return Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID));
      return reads === (refresh ? 2 : 1) ? held.promise : Promise.resolve(resourceResponse(graph('New'), TEST_VIEWER_ID));
    }
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount();
  try {
    if (refresh) { await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old')); tick(); }
    await waitFor(() => expect(reads).toBe(refresh ? 2 : 1));
    expire(); await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(signals[refresh ? 1 : 0]!.aborted).toBe(true);
    expect(screen.getByTestId('successor')).toHaveTextContent(refresh ? 'Old' : 'none');
    tick();
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('New'));
    await act(async () => held.resolve(resourceResponse(graph('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('successor')).toHaveTextContent('New');
  } finally { view.unmount(); scope.dispose(); }
});

it('retains the timeout across an identity pause and hidden page until visible again', async () => {
  let visibility: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const tick = timers(); const expire = deadlines(); const held = deferred<Response>(); const retry = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/task-graph')) return ++reads === 1 ? Promise.resolve(resourceResponse(graph('Old'), TEST_VIEWER_ID)) : reads === 2 ? held.promise : retry.promise;
    return Promise.resolve(resourceResponse(parent, TEST_VIEWER_ID));
  }));
  const { scope, view } = mount(); let resume: (() => void) | undefined;
  try {
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('Old'));
    tick(); await waitFor(() => expect(reads).toBe(2));
    act(() => { resume = pauseAuthRequests(); }); expire();
    act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { resume?.(); resume = undefined; });
    act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads).toBe(3));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(screen.getByTestId('successor')).toHaveTextContent('Old');
    await act(async () => retry.resolve(resourceResponse(graph('New'), TEST_VIEWER_ID)));
    await waitFor(() => expect(screen.getByTestId('successor')).toHaveTextContent('New'));
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    await act(async () => held.resolve(resourceResponse(graph('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('successor')).toHaveTextContent('New');
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});
