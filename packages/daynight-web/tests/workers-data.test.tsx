import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorker } from '../src/features/workers/useWorker';
import { useWorkers } from '../src/features/workers/useWorkers';
import { isWorkerOnline, isWorkerRecent, sortWorkers, workerServerMilliseconds } from '../src/features/workers/observation';
import { WORKER_TIME, WORKER_USER, workerDetail, workerError, workerId, workerPage, workerResponse, workerSummary } from './helpers/workers';

const scopes: TaskCacheScope[] = [];
let monotonic: number;
let visibility: DocumentVisibilityState;
const makeScope = (userId = WORKER_USER, onIdentityMismatch = vi.fn()) => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch }); scopes.push(scope); return scope;
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
  it('uses server and monotonic time for119/120 seconds and72-hour visibility without mutating input', () => {
    const now = Date.parse(WORKER_TIME), current = workerSummary(1), old = workerSummary(2);
    current.lastReportedAt = new Date(now - 119_000).toISOString();
    old.lastReportedAt = new Date(now - 72 * 3_600_000).toISOString();
    expect(isWorkerOnline(current, now)).toBe(true); expect(isWorkerOnline(current, now + 1_000)).toBe(false);
    expect(isWorkerRecent(old, now)).toBe(true); expect(isWorkerRecent(old, now + 1)).toBe(false);
    const tie = { ...current, workerId: workerId(3) }, input = [old, tie, current];
    expect(sortWorkers(input, now).map(worker => worker.workerId)).toEqual([current.workerId, tie.workerId, old.workerId]);
    expect(input).toEqual([old, tie, current]);
    expect(workerServerMilliseconds({ observedAt: WORKER_TIME, receivedMonotonic: 100 }, 200)).toBe(now + 100);
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
    await advance(19_000); expect(fetch).toHaveBeenCalledTimes(2);
    unmount(); expect(vi.getTimerCount()).toBe(0);
    pending.resolve(workerResponse(workerPage([]))); await flush();
  });
});

describe('complete Worker list reads', () => {
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
});

describe('Worker read lifetimes', () => {
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
