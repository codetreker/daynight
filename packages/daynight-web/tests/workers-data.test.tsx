import { act, fireEvent, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import type { CacheEvent } from '../src/features/task-cache/project-cache';
import { TaskCacheError } from '../src/features/task-cache/database';
import { useWorker } from '../src/features/workers/useWorker';
import { useWorkers } from '../src/features/workers/useWorkers';
import { WorkersPage } from '../src/features/workers/WorkersPage';
import { renderWithLocale } from './helpers/renderWithLocale';
import { isWorkerOnline, isWorkerRecent, sortWorkers, workerServerMilliseconds } from '../src/features/workers/observation';
import { WORKER_TIME, WORKER_USER, workerDetail, workerError, workerId, workerPage, workerResponse, workerSummary } from './helpers/workers';

vi.mock('../src/features/workers/useWorkerMonitoring', () => ({
  useWorkerMonitoringSummaries: () => ({ snapshot: null, status: 'loading', refreshing: false, error: null, stale: false, serverMilliseconds: null, refresh: () => {} }),
}));

const scopes: TaskCacheScope[] = [];
let monotonic: number;
let visibility: DocumentVisibilityState;
const makeScope = (userId = WORKER_USER, onIdentityMismatch = vi.fn()) => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch });
  vi.spyOn(scope, 'prepareProjection').mockResolvedValue(new Map());
  scopes.push(scope); return scope;
};
const wrapper = (scope: TaskCacheScope) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); });
const advance = async (milliseconds: number) => {
  monotonic += milliseconds;
  await act(async () => { vi.advanceTimersByTime(milliseconds); for (let n = 0; n < 30; n++) await Promise.resolve(); });
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
};
const setVisibility = async (value: DocumentVisibilityState) => {
  visibility = value;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] }); monotonic = 0; visibility = 'visible';
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); invalidateAuthRequests(); vi.useRealTimers(); });

describe('Worker observation time', () => {
  it.each([
    ['2026-11-04T10:00:00.001Z', false],
    ['2026-11-04T10:00:00.000Z', true],
    ['2026-11-04T09:58:00.001Z', true],
    ['2026-11-04T09:58:00.000Z', false],
    ['2026-11-04T09:57:59.999Z', false],
  ])('classifies a report at %s relative to server observation', (lastReportedAt, online) => {
    expect(isWorkerOnline({ lastReportedAt }, Date.parse('2026-11-04T10:00:00.000Z'))).toBe(online);
  });
  it('uses server and monotonic time for119/120 seconds and72-hour visibility without mutating input', () => {
    const now = Date.parse(WORKER_TIME), current = workerSummary(1), old = workerSummary(2);
    current.lastReportedAt = new Date(now - 119_000).toISOString();
    old.lastReportedAt = new Date(now - 72 * 3_600_000).toISOString();
    expect(isWorkerOnline(current, now)).toBe(true); expect(isWorkerOnline(current, now + 1_000)).toBe(false);
    expect(isWorkerRecent(old, now)).toBe(true); expect(isWorkerRecent(old, now + 1)).toBe(false);
    const tie = { ...current, workerId: workerId(3) }, input = [old, tie, current];
    expect(sortWorkers(input, now).map(worker => worker.workerId)).toEqual([tie.workerId, current.workerId, old.workerId]);
    expect(input).toEqual([old, tie, current]);
    expect(workerServerMilliseconds({ observedAt: WORKER_TIME, receivedMonotonic: 100 }, 200)).toBe(now + 100);
  });
  it('keeps service creation order within each online group independently of report age or ID', () => {
    const now = Date.parse(WORKER_TIME);
    // Creation order differs from both UUID order and report recency.
    const items = Object.freeze([9, 3, 7, 1, 5].map((id, index) => Object.freeze({ ...workerSummary(id),
      lastReportedAt: new Date(now - [150_000, 119_000, 10_000, 130_000, 20_000][index]!).toISOString() })));
    const ids = (time: number) => sortWorkers(items, time).map(worker => worker.workerId);
    expect(ids(now)).toEqual([3, 7, 5, 9, 1].map(workerId));
    expect(ids(now + 1_000)).toEqual([7, 5, 9, 3, 1].map(workerId));
    expect(ids(now + 120_000)).toEqual([9, 3, 7, 1, 5].map(workerId));
    expect(sortWorkers([], now)).toEqual([]);
    expect(items.map(worker => worker.workerId)).toEqual([9, 3, 7, 1, 5].map(workerId));
  });
  it('advances one page clock across online and recent boundaries while a read remains in flight', async () => {
    const now = Date.parse(WORKER_TIME), recent = workerSummary(1), old = workerSummary(2), pending = deferred<Response>();
    recent.lastReportedAt = new Date(now - 119_000).toISOString(); old.lastReportedAt = new Date(now - 72 * 3_600_000).toISOString();
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage([recent, old]))).mockImplementation(() => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, unmount } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush();
    expect(result.current.serverMilliseconds).toBe(now); expect(vi.getTimerCount()).toBe(2);
    vi.setSystemTime(new Date('1900-01-01T00:00:00Z'));
    await advance(1_000);
    expect(result.current.serverMilliseconds).toBe(now + 1_000);
    expect(isWorkerOnline(recent, result.current.serverMilliseconds!)).toBe(false);
    expect(isWorkerRecent(old, result.current.serverMilliseconds!)).toBe(false);
    await advance(28_999); expect(fetch).toHaveBeenCalledOnce();
    await advance(1); expect(fetch).toHaveBeenCalledTimes(2);
    unmount(); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(workerResponse(workerPage([]))); await flush();
  });
});

describe('complete Worker list reads', () => {
  it('regroups a complete paged snapshot on local expiry and refresh without losing creation order or focus', async () => {
    const now = Date.parse(WORKER_TIME), a = workerSummary(9), b = workerSummary(3), c = workerSummary(7);
    a.lastReportedAt = new Date(now - 150_000).toISOString();
    b.lastReportedAt = new Date(now - 119_000).toISOString();
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage([a, b], 'next')))
      .mockImplementationOnce(() => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const view = renderWithLocale(<TaskCacheProvider scope={makeScope()}><WorkersPage readEnabled /></TaskCacheProvider>, { locale: 'en' });
    const order = () => within(screen.getByRole('list', { name: 'Worker list' })).getAllByRole('link').map(link => link.getAttribute('href'));
    const links = (...ids: number[]) => ids.map(id => `/workers/${workerId(id)}`);
    await flush(); expect(screen.getByText('Loading Workers')).toBeInTheDocument(); expect(screen.queryByRole('list')).toBeNull();
    pending.resolve(workerResponse(workerPage([c]))); await flush();
    expect(order()).toEqual(links(3, 7, 9));
    const focused = screen.getByRole('link', { name: 'View Worker 3' }); focused.focus();
    vi.setSystemTime(new Date('1900-01-01T00:00:00Z'));
    await advance(1_000);
    expect(order()).toEqual(links(7, 9, 3)); expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('link', { name: 'View Worker 3' })).toBe(focused); expect(focused).toHaveFocus();
    for (let attempt = 0; attempt < 2; attempt++) {
      const observedAt = new Date(now + 2_000 + attempt * 1_000).toISOString();
      // A recovers online; C reports more recently, then A does. Neither changes creation order.
      const updatedA = { ...a, lastReportedAt: attempt === 0 ? WORKER_TIME : observedAt, taskObservationState: 'observed' as const, taskObservedAt: observedAt, activeTaskCount: attempt + 2 };
      const updatedC = { ...c, lastReportedAt: attempt === 0 ? observedAt : WORKER_TIME, taskObservationState: 'observed' as const, taskObservedAt: observedAt, activeTaskCount: attempt + 4 };
      const lastPage = deferred<Response>();
      fetch.mockResolvedValueOnce(workerResponse(workerPage([updatedA, b], 'next', observedAt))).mockImplementationOnce(() => lastPage.promise);
      act(() => { screen.getByRole('button', { name: 'Refresh' }).click(); }); await flush();
      expect(order()).toEqual(attempt === 0 ? links(7, 9, 3) : links(9, 7, 3));
      expect(screen.queryByRole('alert')).toBeNull(); expect(focused).toHaveFocus();
      lastPage.resolve(workerResponse(workerPage([updatedC], null, observedAt))); await flush();
      expect(order()).toEqual(links(9, 7, 3)); expect(focused).toHaveFocus();
      expect(screen.getByRole('link', { name: 'View Worker 3' })).toBe(focused);
    }
    fireEvent.click(focused); expect(window.location.pathname).toBe(`/workers/${b.workerId}`);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('publishes all pages atomically and anchors every row to the final response', async () => {
    const next = deferred<Response>(), secondTime = '2026-10-29T12:00:01.123456789Z';
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage([workerSummary(1)], 'next'))).mockImplementationOnce(() => next.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.status).toBe('loading'); expect(result.current.snapshot).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/me/workers?limit=50', '/api/v1/me/workers?limit=50&cursor=next']);
    monotonic = 300;
    next.resolve(workerResponse(workerPage([workerSummary(2)], null, secondTime))); await flush();
    expect(result.current.snapshot?.items).toHaveLength(2); expect(result.current.snapshot?.observedAt).toBe(secondTime);
    expect(result.current.serverMilliseconds).toBe(Date.parse(secondTime)); expect(result.current.status).toBe('ready');
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
  it('retains the old complete set if any refreshed page fails, freezes time and retries from the first cursor', async () => {
    const next = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage([workerSummary(1)], 'next'))).mockResolvedValueOnce(workerResponse(workerPage([workerSummary(2)]))).mockResolvedValueOnce(workerResponse(workerPage([workerSummary(3)], 'new'))).mockImplementationOnce(() => next.promise).mockResolvedValueOnce(workerResponse(workerPage([workerSummary(4)])));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); await advance(1_000);
    const snapshot = result.current.snapshot, time = result.current.serverMilliseconds;
    act(() => result.current.refresh()); await flush();
    expect(result.current.snapshot).toBe(snapshot); expect(result.current.refreshing).toBe(true);
    monotonic += 500;
    next.reject(new Error('offline')); await flush();
    expect(result.current.snapshot).toBe(snapshot); expect(result.current.stale).toBe(true); expect(result.current.error).toMatchObject({ kind: 'network' });
    expect(result.current.serverMilliseconds).toBe(time);
    await advance(1_000); expect(result.current.serverMilliseconds).toBe(time);
    act(() => result.current.refresh()); await flush();
    expect(result.current.snapshot?.items.map(worker => worker.workerId)).toEqual([workerId(4)]); expect(result.current.stale).toBe(false); expect(result.current.error).toBeNull();
    expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/me/workers?limit=50');
  });
  it.each(['cursor', 'worker'])('reports repeated %s values without publishing a partial list', async duplicate => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage([workerSummary(1)], 'next'))).mockResolvedValueOnce(workerResponse(workerPage([workerSummary(duplicate === 'worker' ? 1 : 2)], duplicate === 'cursor' ? 'next' : null)));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.status).toBe('error'); expect(result.current.snapshot).toBeNull(); expect(result.current.error).toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps only one automatic or explicit read in flight', async () => {
    const pending = deferred<Response>(), fetch = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => { result.current.refresh(); result.current.refresh(); }); await advance(20_000);
    expect(fetch).toHaveBeenCalledOnce(); expect(result.current.refreshing).toBe(true);
    pending.resolve(workerResponse(workerPage([]))); await flush(); expect(result.current.status).toBe('ready'); expect(result.current.snapshot?.items).toEqual([]);
  });
  it('keeps the refresh button focused and unchanged during a background read, then coalesces an explicit click', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockImplementationOnce(() => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const view = renderWithLocale(<TaskCacheProvider scope={makeScope()}><WorkersPage readEnabled /></TaskCacheProvider>, { locale: 'en' });
    await flush();
    const button = screen.getByRole('button', { name: 'Refresh' }); button.focus();
    await advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(button).toHaveFocus(); expect(button).toBeEnabled(); expect(button).toHaveTextContent('Refresh');
    fireEvent.click(button); await flush();
    expect(button).toBeDisabled(); expect(button).toHaveTextContent('Refreshing'); expect(fetch).toHaveBeenCalledTimes(2);
    pending.resolve(workerResponse(workerPage())); await flush();
    expect(button).toBeEnabled(); expect(button).toHaveTextContent('Refresh'); expect(fetch).toHaveBeenCalledTimes(2);
    view.unmount();
  });
  it('queues one explicit refresh while identity admission is closed and performs it only after reopening', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockImplementationOnce(() => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, rerender, unmount } = renderHook(({ enabled }) => useWorkers({ readEnabled: enabled }), { wrapper: wrapper(makeScope()), initialProps: { enabled: true } });
    await flush(); expect(fetch).toHaveBeenCalledOnce();
    rerender({ enabled: false });
    act(() => { result.current.refresh(); result.current.refresh(); }); await flush();
    expect(fetch).toHaveBeenCalledOnce(); expect(result.current.refreshing).toBe(true);
    rerender({ enabled: true }); await flush();
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.refreshing).toBe(true);
    pending.resolve(workerResponse(workerPage())); await flush();
    expect(result.current.refreshing).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
  });
  it('does not carry a queued refresh into a different account scope', async () => {
    const first = makeScope(), nextUser = workerId(999), next = makeScope(nextUser);
    const fetch = vi.fn(async () => workerResponse(workerPage(), nextUser)); vi.stubGlobal('fetch', fetch);
    const view = renderWithLocale(<TaskCacheProvider scope={first}><WorkersPage readEnabled={false} /></TaskCacheProvider>, { locale: 'en' });
    await flush(); fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await flush();
    expect(fetch).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    view.rerender(<TaskCacheProvider scope={next}><WorkersPage readEnabled /></TaskCacheProvider>); await flush();
    expect(fetch).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    view.unmount();
  });
  it('schedules the next automatic read 30 seconds after manual refresh', async () => {
    const fetch = vi.fn(async () => workerResponse(workerPage())); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); await advance(29_000);
    act(() => result.current.refresh()); await flush(); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(29_999); expect(fetch).toHaveBeenCalledTimes(2);
    await advance(1); expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('Worker read lifetimes', () => {
  it('withdraws a suspended Project and resumes only from a new Worker read', async () => {
    const scope = makeScope(), target = workerId(301), healthy = workerId(302), old = deferred<Response>(), suspended = deferred<Response>();
    const initial = workerDetail(), other = { ...initial.worker.tasks[0]!, projectId: healthy, taskId: workerId(501), title: 'Other task' };
    initial.worker.tasks.push(other); initial.worker.activeTaskCount = 2;
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(initial)).mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(workerResponse(initial)).mockImplementationOnce(() => suspended.promise).mockResolvedValueOnce(workerResponse(initial));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorker(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    act(() => result.current.refresh()); await flush();
    act(() => scope.suspendProject(target)); await flush();
    expect(result.current.snapshot?.worker.tasks.map(task => task.title)).toEqual(['Other task']); expect(result.current.snapshot?.worker.activeTaskCount).toBe(1);
    old.resolve(workerResponse(initial)); await flush(); expect(result.current.snapshot?.worker.tasks.map(task => task.title)).toEqual(['Other task']);
    act(() => result.current.refresh()); await flush();
    act(() => scope.resumeProject(target)); await flush(); expect(result.current.snapshot?.worker.tasks).toHaveLength(2);
    suspended.resolve(workerResponse(initial)); await flush(); expect(result.current.snapshot?.worker.tasks).toHaveLength(2); expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('makes list counts unknown during suspension until an authorized reread', async () => {
    const scope = makeScope(), target = workerId(301), suspended = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockImplementationOnce(() => suspended.promise).mockResolvedValueOnce(workerResponse(workerPage()));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    act(() => scope.suspendProject(target)); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBeNull();
    act(() => scope.resumeProject(target)); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBe(1);
    suspended.resolve(workerResponse(workerPage())); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBe(1);
  });
  it('withdraws detail rows and fences a late poll while preserving telemetry and unrelated tasks', async () => {
    const scope = makeScope(), project = workerId(301), other = workerId(302), old = deferred<Response>(), fresh = deferred<Response>();
    let publish!: (event: CacheEvent) => void;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.mocked(scope.prepareProjection).mockResolvedValue(new Map([[project, 'generation-a']]));
    const initial = workerDetail(), secondTask = { ...initial.worker.tasks[0]!, projectId: other, taskId: workerId(501), title: 'Other task' };
    initial.worker.tasks.push(secondTask); initial.worker.activeTaskCount = 2;
    const filtered = workerDetail(); filtered.worker.tasks = [secondTask]; filtered.worker.activeTaskCount = 1;
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(initial)).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorker(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) });
    await flush(); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: project, accessRevoked: true, revokedGeneration: 'generation-a' })); await flush();
    expect(result.current.snapshot?.worker.tasks.map(task => task.title)).toEqual(['Other task']);
    expect(result.current.snapshot?.worker.activeTaskCount).toBe(1); expect(result.current.snapshot?.worker.telemetry).toEqual(initial.worker.telemetry);
    old.resolve(workerResponse(initial)); await flush(); expect(result.current.snapshot?.worker.tasks.map(task => task.title)).toEqual(['Other task']);
    fresh.resolve(workerResponse(filtered)); await flush(); expect(result.current.snapshot?.worker.tasks).toEqual([secondTask]);
    vi.mocked(scope.prepareProjection).mockResolvedValue(new Map([[project, 'generation-b']]));
    fetch.mockResolvedValueOnce(workerResponse(initial)); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: project, accessRevoked: true, revokedGeneration: 'generation-a' }));
    expect(result.current.snapshot?.worker.tasks).toHaveLength(2);
  });
  it('invalidates opaque list counts until a fresh complete observation arrives', async () => {
    const scope = makeScope(), project = workerId(301), old = deferred<Response>(), fresh = deferred<Response>();
    let publish!: (event: CacheEvent) => void;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.mocked(scope.prepareProjection).mockResolvedValue(new Map([[project, 'generation-a']]));
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage([workerSummary(1)]))).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(scope) });
    await flush(); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: project, accessRevoked: true, revokedGeneration: 'generation-a' })); await flush();
    expect(result.current.snapshot?.items[0]).toMatchObject({ machine: { name: 'Worker 1' }, taskObservationState: 'unavailable', activeTaskCount: null });
    old.resolve(workerResponse(workerPage([workerSummary(1)]))); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBeNull();
    const updated = { ...workerSummary(1), taskObservationState: 'observed' as const, taskObservedAt: WORKER_TIME, activeTaskCount: 0 };
    fresh.resolve(workerResponse(workerPage([updated]))); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBe(0);
  });
  it('keeps task counts unavailable and reports a failed purge across a fresh read', async () => {
    const scope = makeScope(), project = workerId(301), error = new TaskCacheError('storage'); let denied = true;
    let publish!: (event: CacheEvent) => void;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.spyOn(scope, 'hasProjectionDenials', 'get').mockImplementation(() => denied);
    vi.spyOn(scope, 'isProjectionDenied').mockImplementation(id => denied && id === project);
    vi.stubGlobal('fetch', vi.fn(async () => workerResponse(workerPage([workerSummary(1)]))));
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    act(() => publish({ projectId: project, accessRevoked: true, error }));
    expect(result.current.snapshot?.items[0]?.activeTaskCount).toBeNull(); expect(result.current.error).toBe(error);
    act(() => result.current.refresh()); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBeNull(); expect(result.current.error).toBe(error);
    denied = false; act(() => result.current.refresh()); await flush(); expect(result.current.snapshot?.items[0]?.activeTaskCount).toBe(1); expect(result.current.error).toBeNull();
  });
  it('retains Worker identity and telemetry without private tasks when projection storage is unavailable', async () => {
    const scope = makeScope(), failure = new TaskCacheError('storage'), pending = deferred<Response>(); let failed = false;
    vi.spyOn(scope, 'projectionError', 'get').mockImplementation(() => failed ? failure : null);
    vi.spyOn(scope, 'hasGlobalProjectionFailure', 'get').mockImplementation(() => failed);
    vi.spyOn(scope, 'hasProjectionDenials', 'get').mockImplementation(() => failed);
    vi.spyOn(scope, 'isProjectionDenied').mockImplementation(() => failed);
    const detail = workerDetail(); vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(workerResponse(detail)).mockImplementationOnce(() => pending.promise));
    const { result } = renderHook(() => useWorker(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    expect(result.current.snapshot?.worker.tasks).toHaveLength(1);
    failed = true; act(() => result.current.refresh()); await flush();
    expect(result.current.snapshot?.worker.tasks).toEqual([]); expect(result.current.snapshot?.worker.activeTaskCount).toBeNull();
    expect(result.current.snapshot?.worker.telemetry).toEqual(detail.worker.telemetry); expect(result.current.error).toBe(failure);
    pending.resolve(workerResponse(detail)); await flush(); expect(result.current.snapshot?.worker.tasks).toEqual([]); expect(result.current.error).toBe(failure);
  });
  it('does not publish private tasks from a failed fence after another read recovers storage', async () => {
    const scope = makeScope(), failure = new TaskCacheError('storage'), failedFence = new Map<string, string>(), recoveredFence = new Map<string, string>(), pending = deferred<Response>();
    vi.mocked(scope.prepareProjection).mockResolvedValueOnce(failedFence).mockResolvedValueOnce(recoveredFence);
    vi.spyOn(scope, 'projectionSnapshotFailed').mockImplementation(fence => fence === failedFence);
    vi.spyOn(scope, 'projectionSnapshotHasDenials').mockImplementation(fence => fence === failedFence);
    vi.spyOn(scope, 'projectionSnapshotDenied').mockImplementation(fence => fence === failedFence);
    vi.spyOn(scope, 'projectionSnapshotError').mockImplementation(fence => fence === failedFence ? failure : null);
    const first = workerDetail(1), second = workerDetail(2);
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(workerResponse(second)));
    const old = renderHook(() => useWorker(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    const current = renderHook(() => useWorker(workerId(2), { readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    expect(current.result.current.snapshot?.worker.tasks).toHaveLength(1);
    pending.resolve(workerResponse(first)); await flush();
    expect(old.result.current.snapshot?.worker.tasks).toEqual([]); expect(old.result.current.snapshot?.worker.activeTaskCount).toBeNull();
    expect(old.result.current.snapshot?.worker.telemetry).toEqual(first.worker.telemetry); expect(old.result.current.error).toBe(failure);
  });
  it('freezes hidden observations and refreshes before reusing a post-sleep clock', async () => {
    const pending = deferred<Response>(), freshTime = '2026-10-29T13:00:00Z';
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockImplementationOnce(() => pending.promise); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); await advance(1_000); const time = result.current.serverMilliseconds;
    await setVisibility('hidden'); expect(result.current.stale).toBe(true); expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.refresh()); await advance(300_000); expect(result.current.serverMilliseconds).toBe(time); expect(fetch).toHaveBeenCalledOnce();
    await setVisibility('visible'); await flush(); expect(fetch).toHaveBeenCalledTimes(2); expect(result.current.stale).toBe(true); expect(result.current.serverMilliseconds).toBe(time);
    await advance(1_000); expect(result.current.serverMilliseconds).toBe(time);
    pending.resolve(workerResponse(workerPage([], null, freshTime))); await flush(); expect(result.current.stale).toBe(false); expect(result.current.serverMilliseconds).toBe(Date.parse(freshTime));
  });
  it('defers initial hidden reads and cancels outstanding reads during identity checking', async () => {
    visibility = 'hidden'; const pending = deferred<Response>(), fetch = vi.fn((_url: string, _options: RequestInit) => pending.promise); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkers({ readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    await setVisibility('visible'); await flush(); expect(fetch).toHaveBeenCalledOnce();
    const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
    rerender({ enabled: false }); expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(workerResponse(workerPage())); await flush(); expect(result.current.snapshot).toBeNull();
  });
  it('retains same-account snapshots while reads are disabled and recalibrates on resume', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockResolvedValueOnce(workerResponse(workerPage([], null, '2026-10-29T13:00:00Z'))); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkers({ readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); const snapshot = result.current.snapshot, time = result.current.serverMilliseconds;
    rerender({ enabled: false }); expect(result.current.stale).toBe(true); expect(result.current.snapshot).toBe(snapshot);
    await advance(300_000); expect(fetch).toHaveBeenCalledOnce(); expect(result.current.serverMilliseconds).toBe(time);
    rerender({ enabled: true }); await flush(); expect(result.current.stale).toBe(false); expect(result.current.snapshot?.items).toEqual([]); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('waits for the existing auth gate both before requesting and before publishing', async () => {
    const pending = deferred<Response>(), fetch = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetch);
    const resumeInitial = pauseAuthRequests();
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); expect(fetch).not.toHaveBeenCalled(); resumeInitial(); await flush(); expect(fetch).toHaveBeenCalledOnce();
    const resumeResponse = pauseAuthRequests(); pending.resolve(workerResponse(workerPage())); await flush(); expect(result.current.snapshot).toBeNull();
    await advance(1_000); expect(result.current.snapshot).toBeNull(); resumeResponse(); await flush(); expect(result.current.status).toBe('ready');
  });
  it('discards the prior account and ignores its late response when the scope changes', async () => {
    const pending = deferred<Response>(), other = workerId(9), firstScope = makeScope(), secondScope = makeScope(other);
    let scope = firstScope;
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerPage())).mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(workerResponse(workerPage([workerSummary(2)]), other)); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: ({ children }) => <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider> });
    await flush(); act(() => result.current.refresh()); await flush();
    scope = secondScope; rerender(); expect(result.current.snapshot).toBeNull(); await flush(); expect(result.current.snapshot?.items[0]?.workerId).toBe(workerId(2));
    pending.resolve(workerResponse(workerPage())); await flush(); expect(result.current.snapshot?.items[0]?.workerId).toBe(workerId(2));
  });
  it('clears data immediately when its authenticated scope is invalidated', async () => {
    const scope = makeScope(); vi.stubGlobal('fetch', vi.fn(async () => workerResponse(workerPage())));
    const { result } = renderHook(() => useWorkers({ readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    await act(async () => { await scope.invalidateScope(); }); expect(result.current.snapshot).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('ignores a prior Worker resource response and clears only an admitted404', async () => {
    const pending = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerDetail())).mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(workerResponse(workerDetail(2))).mockResolvedValueOnce(workerError(404)); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ id }) => useWorker(id, { readEnabled: true }), { initialProps: { id: workerId(1) }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.refresh()); await flush();
    rerender({ id: workerId(2) }); expect(result.current.snapshot).toBeNull(); await flush(); expect(result.current.snapshot?.worker.workerId).toBe(workerId(2));
    pending.resolve(workerResponse(workerDetail())); await flush(); expect(result.current.snapshot?.worker.workerId).toBe(workerId(2));
    act(() => result.current.refresh()); await flush(); expect(result.current.status).toBe('unavailable'); expect(result.current.snapshot).toBeNull(); expect(result.current.serverMilliseconds).toBeNull();
  });
  it('does not turn a malformed-principal404 into a confirmed unavailable Worker', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse(workerDetail())).mockResolvedValueOnce(new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorker(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) }); await flush(); const snapshot = result.current.snapshot;
    act(() => result.current.refresh()); await flush(); expect(result.current.status).toBe('ready'); expect(result.current.snapshot).toBe(snapshot); expect(result.current.stale).toBe(true); expect(result.current.error).toMatchObject({ kind: 'protocol', status: 404 });
  });
  it.each([200, 404])('invalidates identity before publishing another principal on%s', async status => {
    const mismatch = vi.fn(), scope = makeScope(WORKER_USER, mismatch);
    vi.stubGlobal('fetch', vi.fn(async () => status === 200 ? workerResponse(workerDetail(), workerId(9)) : workerError(404, workerId(9))));
    const { result } = renderHook(() => useWorker(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) }); await flush();
    expect(mismatch).toHaveBeenCalledOnce(); expect(scope.isInvalidated).toBe(true); expect(result.current.snapshot).toBeNull(); expect(result.current.status).toBe('loading');
  });
});
