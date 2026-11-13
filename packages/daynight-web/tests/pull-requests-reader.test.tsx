import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { usePullRequests } from '../src/features/pull-requests/usePullRequests';
import { prDeferred, prPage, prProjectId, prResponse, prStatus, prUserId } from './pull-requests-fixtures';

const options = () => ({ userId: prUserId, projectId: prProjectId, canRead: true, active: true, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() });
const errorResponse = (status: number) => prResponse({ error: { code: status === 404 ? 'not_found' : 'forbidden', message: 'Unavailable', requestId: 'test' } }, status);
const isStatus = (url: string) => url.endsWith('/github');
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('retains the page, filters and cursor across suspension and reports new PRs without changing its upper bound', async () => {
  let latest = false;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    return prResponse(cursor === 'second' ? prPage(['36'], '2', null, 'back') : cursor !== null ? prPage(['42', '41'], '2', 'second', 'synthetic') : latest ? prPage(['50', '42'], '2', 'second') : prPage(['42', '41'], '1', 'second'));
  }); vi.stubGlobal('fetch', fetch);
  const gate = options(), { result, rerender } = renderHook(props => usePullRequests(props), { initialProps: gate });
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next()); await waitFor(() => expect(result.current.pageNumber).toBe(2));
  expect(result.current.page?.items[0]?.number).toBe('36');
  rerender({ ...gate, active: false }); const calls = fetch.mock.calls.length;
  act(() => result.current.reconcile()); expect(fetch).toHaveBeenCalledTimes(calls);
  latest = true; rerender(gate);
  await waitFor(() => expect(result.current.hasUpdates).toBe(true));
  expect(result.current.pageNumber).toBe(2); expect(result.current.page?.items[0]?.number).toBe('36');
  act(() => result.current.refresh()); await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('50'));
  expect(result.current.pageNumber).toBe(1); expect(result.current.hasUpdates).toBe(false);
});

it('sends filters and title/number searches to the server and resets pagination', async () => {
  const fetch = vi.fn(async (url: string) => prResponse(isStatus(url) ? prStatus() : prPage(['42'], '1', 'next'))); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next()); await waitFor(() => expect(result.current.pageNumber).toBe(2));
  act(() => result.current.setFilter('merged')); await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.pageNumber).toBe(1); expect(result.current.filter).toBe('merged');
  act(() => result.current.setQuery('#42')); await waitFor(() => expect(result.current.loading).toBe(false));
  expect(new URL(fetch.mock.calls.at(-1)![0], 'https://test').searchParams.get('q')).toBe('#42');
  expect(result.current.query).toBe('#42');
});

it('revalidates the first page with a bounded cursor and keeps previous navigation for a changed empty later page', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    return prResponse(cursor === 'second' ? prPage([], '2', null, 'return') : prPage(['42'], '1', 'second', cursor ? 'synthetic-previous' : null));
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false)); act(() => result.current.reconcile());
  await waitFor(() => expect(result.current.loading).toBe(false));
  const cursorCall = fetch.mock.calls.find(([url]) => !isStatus(url) && new URL(url, 'https://test').searchParams.get('cursor')?.startsWith('ey'));
  const token = new URL(cursorCall![0], 'https://test').searchParams.get('cursor')!;
  expect(JSON.parse(atob(token.replaceAll('-', '+').replaceAll('_', '/')))).toMatchObject({ upperNumber: '42', anchorNumber: '43', direction: 'next', limit: 6 });
  expect(result.current.page?.previousCursor).toBeNull();
  act(() => result.current.next()); await waitFor(() => expect(result.current.pageNumber).toBe(2));
  expect(result.current.page?.items).toEqual([]); expect(result.current.page?.previousCursor).toBe('return');
});

it('preserves genuine previous cursors when reopened PRs shift a numeric first page', async () => {
  const cursor = (anchorNumber: string, direction: 'next' | 'previous') => btoa(JSON.stringify({ v: 1, projectId: prProjectId, state: 'active', q: '', limit: 6, upperNumber: '24', anchorNumber, direction })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const second = cursor('14', 'next'), shiftedFirst = cursor('12', 'previous'), remainingFirst = cursor('23', 'previous');
  let reopened = false;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus(reopened ? '2' : '1'));
    const requested = new URL(url, 'https://test').searchParams.get('cursor');
    if (requested === second) return prResponse(prPage(['12', '10', '8', '6', '4', '2'], '1', null, shiftedFirst));
    if (requested === shiftedFirst) return prResponse(prPage(['23', '22', '20', '18', '16', '14'], '2', second, remainingFirst));
    if (requested === remainingFirst) return prResponse(prPage(['24'], '2', cursor('24', 'next')));
    if (requested !== null) throw new Error(`Unexpected cursor: ${requested}`);
    return prResponse(prPage(['24', '22', '20', '18', '16', '14'], reopened ? '2' : '1', second));
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next());
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('12'));
  expect(result.current.pageNumber).toBe(2);
  reopened = true;
  act(() => result.current.previous());
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('23'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.pageNumber).toBe(1);
  expect(result.current.page?.previousCursor).toBe(remainingFirst);
  act(() => result.current.reconcile());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(fetch.mock.calls.filter(([url]) => new URL(url, 'https://test').searchParams.get('cursor') === shiftedFirst)).toHaveLength(2);
  expect(result.current.page?.previousCursor).toBe(remainingFirst);
  act(() => result.current.previous());
  await waitFor(() => expect(result.current.page?.items.map(item => item.number)).toEqual(['24']));
  expect(result.current.pageNumber).toBe(1);
  expect(result.current.page?.previousCursor).toBeNull();
  expect(fetch.mock.calls.some(([url]) => new URL(url, 'https://test').searchParams.get('cursor') === remainingFirst)).toBe(true);
});

it('keeps initially empty data and announces newly saved records until an explicit refresh', async () => {
  let added = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => prResponse(isStatus(url) ? prStatus() : prPage(added ? ['1'] : [], added ? '2' : '1'))));
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false)); added = true;
  act(() => result.current.reconcile()); await waitFor(() => expect(result.current.hasUpdates).toBe(true));
  expect(result.current.page?.items).toEqual([]);
  act(() => result.current.refresh()); await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('1'));
});

it('retains the displayed page number when loading the next cursor fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    if (new URL(url, 'https://test').searchParams.get('cursor') === 'next') throw new Error('offline');
    return prResponse(prPage(['42'], '1', 'next'));
  }));
  const { result } = renderHook(() => usePullRequests(options())); await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next()); await waitFor(() => expect(result.current.error?.kind).toBe('network'));
  expect(result.current.pageNumber).toBe(1); expect(result.current.page?.items[0]?.number).toBe('42');
});

it('revalidates the maximum PR number without overflowing its cursor anchor', async () => {
  const fetch = vi.fn(async (url: string) => prResponse(isStatus(url) ? prStatus() : prPage(['9223372036854775807']))); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options())); await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.reconcile()); await waitFor(() => expect(result.current.loading).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.filter(([url]) => !isStatus(url)).every(([url]) => !new URL(url, 'https://test').searchParams.has('cursor'))).toBe(true);
  expect(result.current.page?.items[0]?.number).toBe('9223372036854775807');
});

it('does not overlap background batches and cancels polling while the tab or document is hidden', async () => {
  vi.useFakeTimers(); let hidden = false;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden ? 'hidden' : 'visible');
  const pending = prDeferred<Response>(); let hold = false;
  const fetch = vi.fn(async (url: string) => hold ? pending.promise : prResponse(isStatus(url) ? prStatus() : prPage())); vi.stubGlobal('fetch', fetch);
  const gate = options(), { result, rerender } = renderHook(props => usePullRequests(props), { initialProps: gate });
  await act(flush); expect(fetch).toHaveBeenCalledTimes(2);
  hold = true; await act(async () => { vi.advanceTimersByTime(15_000); await flush(); }); const inFlight = fetch.mock.calls.length;
  act(() => { window.dispatchEvent(new Event('focus')); }); expect(fetch).toHaveBeenCalledTimes(inFlight);
  hidden = true; act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { vi.advanceTimersByTime(60_000); await flush(); }); expect(fetch).toHaveBeenCalledTimes(inFlight);
  rerender({ ...gate, active: false }); hidden = false; act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(fetch).toHaveBeenCalledTimes(inFlight); expect(result.current.page?.items[0]?.number).toBe('42');
  hold = false; rerender(gate); await act(flush); expect(fetch.mock.calls.length).toBeGreaterThan(inFlight);
  pending.resolve(prResponse(prPage())); await act(flush);
});

it('rejects late and lower-revision reads and clears old identity and access data', async () => {
  const late = prDeferred<Response>(); let mode: 'initial' | 'late' | 'older' = 'initial';
  const fetch = vi.fn(async (url: string) => {
    if (mode === 'late') return late.promise;
    return prResponse(isStatus(url) ? prStatus(mode === 'older' ? '9007199254740992' : '9007199254740993') : prPage([mode === 'older' ? '1' : '42'], mode === 'older' ? '9007199254740992' : '9007199254740993'));
  }); vi.stubGlobal('fetch', fetch);
  const gate = options(), { result, rerender } = renderHook(props => usePullRequests(props), { initialProps: gate });
  await waitFor(() => expect(result.current.loading).toBe(false)); mode = 'late'; act(() => result.current.reconcile());
  mode = 'older'; act(() => result.current.refresh()); await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.page?.items[0]?.number).toBe('42');
  await act(async () => { late.resolve(prResponse(prPage(['100'], '9007199254740994'))); await late.promise; });
  expect(result.current.page?.items[0]?.number).toBe('42');
  rerender({ ...gate, active: false, userId: prProjectId }); expect(result.current.page).toBeNull(); expect(result.current.status).toBeNull();
  rerender({ ...gate, canRead: false }); expect(result.current.page).toBeNull();
});

it('retains independent successful list data when status fails, then clears everything on authenticated refusal', async () => {
  let fail = false, deny = false;
  const gate = options();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { if (deny) return errorResponse(403); if (fail && isStatus(url)) throw new Error('offline'); return prResponse(isStatus(url) ? prStatus() : prPage()); }));
  const { result } = renderHook(() => usePullRequests(gate)); await waitFor(() => expect(result.current.loading).toBe(false));
  fail = true; act(() => result.current.reconcile()); await waitFor(() => expect(result.current.statusError?.kind).toBe('network'));
  expect(result.current.page?.items[0]?.number).toBe('42'); expect(result.current.status).not.toBeNull();
  deny = true; act(() => result.current.reconcile()); await waitFor(() => expect(gate.onAccessError).toHaveBeenCalledOnce());
  expect(result.current.page).toBeNull(); expect(result.current.status).toBeNull();
});

it('waits for identity checks and restarts reads for the same account without publishing canceled responses', async () => {
  const pending = prDeferred<Response>(); let held = true;
  const fetch = vi.fn(async (url: string) => held ? pending.promise : prResponse(isStatus(url) ? prStatus() : prPage())); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options())); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const resume = pauseAuthRequests(); cancelAuthNetworkRequests();
  await act(async () => { pending.resolve(prResponse(prPage(['100'], '9'))); await pending.promise; });
  expect(result.current.page).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  held = false; act(resume); await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('42'));
});

it('cannot restore private list data after a concurrent status refusal withdraws the batch', async () => {
  const pending = prDeferred<Response>(), gate = options(); let denied = false;
  const fetch = vi.fn(async (url: string) => {
    if (!denied) return prResponse(isStatus(url) ? prStatus() : prPage());
    return isStatus(url) ? errorResponse(404) : pending.promise;
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(gate)); await waitFor(() => expect(result.current.loading).toBe(false));
  denied = true; act(() => result.current.reconcile());
  await waitFor(() => expect(gate.onAccessError).toHaveBeenCalledOnce()); expect(result.current.page).toBeNull();
  await act(async () => { pending.resolve(prResponse(prPage(['900'], '20'))); await pending.promise; });
  expect(result.current.page).toBeNull(); expect(result.current.status).toBeNull();
});

it('discards the batch when the account changes during a paused identity check', async () => {
  const pending = prDeferred<Response>(), fetch = vi.fn().mockReturnValue(pending.promise); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options())); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const resume = pauseAuthRequests(); cancelAuthNetworkRequests();
  await act(async () => { pending.resolve(prResponse(prPage())); await pending.promise; });
  act(() => { invalidateAuthRequests(); resume(); }); await act(flush);
  expect(result.current.page).toBeNull(); expect(result.current.status).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
});

it('bounds dispatched requests and retains the current page on a timeout', async () => {
  vi.useFakeTimers(); let hold = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (!hold) return prResponse(isStatus(url) ? prStatus() : prPage());
    return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }));
  const { result } = renderHook(() => usePullRequests(options())); await act(flush); hold = true;
  act(() => result.current.reconcile()); await act(async () => { vi.advanceTimersByTime(30_000); await flush(); });
  expect(result.current.error?.kind).toBe('network'); expect(result.current.page?.items[0]?.number).toBe('42'); expect(result.current.loading).toBe(false);
});
