import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import { browserNavigation } from '../src/app/navigation';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { useGoalDependencies } from '../src/features/goal-detail/useGoalDependencies';
import { markGoalDependencyDeparture, rememberGoalDependencyReading } from '../src/features/goal-detail/goal-dependency-reading';
import { detailFixture, resourceResponse } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

const projectId = '10000000-0000-4000-8000-000000000001';
const peerId = '10000000-0000-4000-8000-000000000002';
const goalId = '20000000-0000-4000-8000-000000000001';
const parent = detailFixture(projectId, goalId, { type: 'goal', title: 'Release client', ready: false });
const relation = (title: string, project = peerId) => ({ projectId: project, projectName: 'Identity', goalId: '20000000-0000-4000-8000-000000000002', title, status: 'in_progress', kind: project === projectId ? 'internal' : 'external' });
const page = (title: string, cursor: string | null = null) => ({ goalId, canEdit: false, completionBlocked: true, prerequisites: [{ target: relation(title) }], successors: [relation(`${title} downstream`)], nextCursor: cursor });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const sourceDenied = vi.fn();
let sessions: TaskDetailSessions;
let dependencies: ReturnType<typeof useGoalDependencies>;
const Harness = ({ active = true }: { readonly active?: boolean }) => {
  sessions = useTaskDetailSessions();
  const subscribe = useCallback((listener: () => void) => sessions.subscribe(projectId, goalId, listener), [sessions]);
  const state = useSyncExternalStore(subscribe, () => sessions.snapshot(projectId, goalId));
  const history = sessions.historyGeneration(projectId);
  useEffect(() => { sessions.openDirect(projectId, goalId); return () => sessions.releaseRead(projectId, goalId); }, []);
  const value = useGoalDependencies(projectId, goalId, history, active && state.status === 'ready', sourceDenied);
  dependencies = value;
  return <><span data-testid="goal">{value.page?.prerequisites[0]?.target?.title ?? 'none'}</span>
    <span data-testid="successors">{value.page?.successors.map(item => item.title).join(',') ?? 'none'}</span>
    <span data-testid="error">{value.error === null ? 'none' : 'error'}</span><span data-testid="unavailable">{String(value.unavailable)}</span>
    <button onClick={value.refresh}>Retry</button><button onClick={value.next} disabled={value.pending || value.page?.nextCursor == null}>Next</button>
    <button onClick={value.previous} disabled={value.pending || !value.hasPrevious}>Previous</button></>;
};
const mount = (existingScope?: ReturnType<typeof createTaskCacheScope>) => {
  const scope = existingScope ?? createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const view = renderWithLocale(<TaskDetailSessionProvider><Harness /></TaskDetailSessionProvider>, { locale: 'en', taskCache: { scope } });
  return { scope, view };
};
const timers = () => {
  let tick = () => {}; const original = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 15_000) tick = handler as () => void;
    return original(handler, delay, ...args);
  }) as typeof setInterval);
  return () => act(() => tick());
};
const respond = (body: unknown) => Promise.resolve(resourceResponse(body, TEST_VIEWER_ID));
const failure = (status = 503, code = 'internal_error') => wireResponse({ error: { code, message: 'Unavailable', requestId: 'failure' } }, { status, headers: viewerHeaders(TEST_VIEWER_ID) });
afterEach(() => { cleanup(); browserNavigation().dispose(); sourceDenied.mockClear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('refreshes independently of source versions, retaining visible relations on transient failure', async () => {
  const tick = timers(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/goal-dependencies')
    ? ++reads === 1 ? respond(page('Original')) : reads === 2 ? Promise.resolve(failure()) : respond(page('Updated')) : respond(parent)));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Original'));
    tick(); await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(screen.getByTestId('goal')).toHaveTextContent('Original');
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Updated'));
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(sessions.snapshot(projectId, goalId).detail?.version).toBe(1n);
  } finally { view.unmount(); scope.dispose(); }
});

it('refreshes the selected downstream cursor and navigates its previous cursor', async () => {
  const tick = timers(); const cursors: (string | null)[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (!url.includes('/goal-dependencies')) return respond(parent);
    const cursor = new URL(url, location.origin).searchParams.get('cursor'); cursors.push(cursor);
    return respond(page(cursor === null ? 'First' : 'Second', cursor === null ? 'page-2' : null));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('First'));
    fireEvent.click(screen.getByText('Next')); await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Second'));
    tick(); await waitFor(() => expect(cursors).toEqual([null, 'page-2', 'page-2']));
    await waitFor(() => expect(screen.getByText('Previous')).toBeEnabled());
    fireEvent.click(screen.getByText('Previous')); await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('First'));
    expect(cursors.at(-1)).toBeNull();
  } finally { view.unmount(); scope.dispose(); }
});

it('withdraws a revoked peer immediately and rejects a late read containing previously unseen peers', async () => {
  const tick = timers(), held = deferred<Response>(); let reads = 0; const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (!url.includes('/goal-dependencies')) return respond(parent);
    signals.push(options!.signal!); return ++reads === 1 ? respond(page('Private')) : held.promise;
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Private'));
    tick(); await waitFor(() => expect(reads).toBe(2));
    act(() => scope.suspendProject(peerId));
    expect(screen.getByTestId('goal')).toHaveTextContent('none'); expect(screen.getByTestId('successors')).toHaveTextContent('');
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => held.resolve(resourceResponse(page('Late private'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('goal')).toHaveTextContent('none');
  } finally { view.unmount(); scope.dispose(); }
});

it('suppresses hidden and inactive reads while preserving the previous display', async () => {
  const tick = timers(); let reads = 0, visible = true;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible ? 'visible' : 'hidden');
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/goal-dependencies') ? (reads++, respond(page('Original'))) : respond(parent)));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Original'));
    act(() => { visible = false; document.dispatchEvent(new Event('visibilitychange')); }); tick(); expect(reads).toBe(1);
    view.rerender(<TaskDetailSessionProvider><Harness active={false} /></TaskDetailSessionProvider>);
    act(() => { visible = true; document.dispatchEvent(new Event('visibilitychange')); }); tick(); expect(reads).toBe(1);
    expect(screen.getByTestId('goal')).toHaveTextContent('Original');
  } finally { view.unmount(); scope.dispose(); }
});

it('waits for the identity gate and rejects stale source history', async () => {
  const tick = timers(), held = deferred<Response>(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/goal-dependencies') ? ++reads === 1 ? respond(page('Original')) : held.promise : respond(parent)));
  const { scope, view } = mount(); let resume: (() => void) | undefined;
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Original'));
    act(() => { resume = pauseAuthRequests(); }); tick(); await act(async () => { await Promise.resolve(); }); expect(reads).toBe(1);
    act(() => { resume?.(); resume = undefined; }); await waitFor(() => expect(reads).toBe(2));
    act(() => scope.suspendProject(projectId));
    await act(async () => held.resolve(resourceResponse(page('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('goal')).toHaveTextContent('none');
  } finally { resume?.(); view.unmount(); scope.dispose(); }
});

it('keeps peer permission withdrawal active while another Goal tab is selected', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => !url.includes('/goal-dependencies') ? respond(parent)
    : ++reads === 1 ? respond(page('Private')) : Promise.resolve(failure())));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Private'));
    view.rerender(<TaskDetailSessionProvider><Harness active={false} /></TaskDetailSessionProvider>);
    act(() => scope.suspendProject(peerId));
    expect(screen.getByTestId('goal')).toHaveTextContent('none');
    view.rerender(<TaskDetailSessionProvider><Harness /></TaskDetailSessionProvider>);
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    expect(screen.getByTestId('goal')).toHaveTextContent('none');
  } finally { view.unmount(); scope.dispose(); }
});

it('aborts replaced reads and ignores their late response', async () => {
  const tick = timers(), held = deferred<Response>(); let reads = 0; const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
    if (!url.includes('/goal-dependencies')) return respond(parent);
    signals.push(options!.signal!); return ++reads === 1 ? respond(page('Original')) : reads === 2 ? held.promise : respond(page('Replacement'));
  }));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Original'));
    tick(); await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Replacement'));
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => held.resolve(resourceResponse(page('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('goal')).toHaveTextContent('Replacement');
  } finally { view.unmount(); scope.dispose(); }
});

it('times out a hung read and recovers without waiting for the old transport', async () => {
  const tick = timers(), held = deferred<Response>(); let reads = 0; let timeout: (() => void) | null = null;
  const original = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000) { timeout = handler as () => void; return 0; }
    return original(handler, delay, ...args);
  }) as typeof setTimeout);
  vi.stubGlobal('fetch', vi.fn((url: string) => !url.includes('/goal-dependencies') ? respond(parent) : ++reads === 1 ? held.promise : respond(page('Recovered'))));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(timeout).not.toBeNull()); act(() => timeout!());
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
    tick(); await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Recovered'));
    await act(async () => held.resolve(resourceResponse(page('Late'), TEST_VIEWER_ID)));
    expect(screen.getByTestId('goal')).toHaveTextContent('Recovered');
  } finally { view.unmount(); scope.dispose(); }
});

it('keeps old-router unavailability separate from an authenticated access denial', async () => {
  const tick = timers(); let reads = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => !url.includes('/goal-dependencies') ? respond(parent) : ++reads === 1
    ? Promise.resolve(wireResponse({ error: { code: 'not_found', message: 'Not Found', requestId: 'old-router' } }, { status: 404 }))
    : Promise.resolve(failure(404, 'not_found'))));
  const { scope, view } = mount();
  try {
    await waitFor(() => expect(screen.getByTestId('unavailable')).toHaveTextContent('true'));
    expect(sourceDenied).not.toHaveBeenCalled(); expect(sessions.snapshot(projectId, goalId).detail?.title).toBe(parent.title);
    tick(); await waitFor(() => expect(sourceDenied).toHaveBeenCalledOnce());
    expect(screen.getByTestId('goal')).toHaveTextContent('none');
  } finally { view.unmount(); scope.dispose(); }
});

it.each([false, true])('reauthorizes a remembered downstream page after remount without retaining its old rows (failure: %s)', async failureOnReturn => {
  const requests: (string | null)[] = [], held = deferred<Response>(); let returning = false, retried = false;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (!url.includes('/goal-dependencies')) return respond(parent);
    const cursor = new URL(url, location.origin).searchParams.get('cursor'); requests.push(cursor);
    if (returning && !retried) return held.promise;
    return respond(page(returning ? 'Authorized return' : cursor === null ? 'First' : 'Second', cursor === null ? 'page-2' : null));
  }));
  const first = mount(); let second: ReturnType<typeof mount> | undefined;
  try {
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('First'));
    fireEvent.click(screen.getByText('Next')); await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Second'));
    const entryId = browserNavigation().snapshot().entryId!, href = `/projects/${peerId}/tasks/${goalId}?tab=description`;
    rememberGoalDependencyReading(first.scope, entryId, dependencies.position, href);
    markGoalDependencyDeparture(first.scope, entryId, href);
    first.view.unmount(); returning = true;
    second = mount(first.scope);
    await waitFor(() => expect(requests).toEqual([null, 'page-2', 'page-2']));
    expect(screen.getByTestId('goal')).toHaveTextContent('none');
    if (failureOnReturn) {
      await act(async () => held.resolve(failure()));
      await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('error'));
      expect(screen.getByTestId('goal')).toHaveTextContent('none');
      retried = true; fireEvent.click(screen.getByText('Retry'));
    } else await act(async () => held.resolve(resourceResponse(page('Authorized return'), TEST_VIEWER_ID)));
    await waitFor(() => expect(screen.getByTestId('goal')).toHaveTextContent('Authorized return'));
    expect(requests.every((cursor, index) => index === 0 || cursor === 'page-2')).toBe(true);
    expect(screen.getByText('Previous')).toBeEnabled();
  } finally { second?.view.unmount(); first.view.unmount(); first.scope.dispose(); }
});
