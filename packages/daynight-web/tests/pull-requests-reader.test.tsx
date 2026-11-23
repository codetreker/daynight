import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { usePullRequests } from '../src/features/pull-requests/usePullRequests';
import { prDeferred, prPage, prProjectId, prResponse, prStatus, prUserId } from './pull-requests-fixtures';

const options = () => ({ userId: prUserId, projectId: prProjectId, canRead: true, active: true, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() });
const errorResponse = (status: number) => prResponse({ error: { code: status === 404 ? 'not_found' : 'forbidden', message: 'Unavailable', requestId: 'test' } }, status);
const isStatus = (url: string) => url.endsWith('/github');
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const background = () => window.dispatchEvent(new Event('focus'));
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('retains an anchored page across suspension and refreshes the current conditions from the first page', async () => {
  let latest = false;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    return prResponse(cursor === 'second' ? prPage(['36'], latest ? '2' : '1', null, 'back') : latest ? prPage(['50', '42'], '2', 'second') : prPage(['42', '41'], '1', 'second'));
  }); vi.stubGlobal('fetch', fetch);
  const gate = options(), { result, rerender } = renderHook(props => usePullRequests(props), { initialProps: gate });
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next()); await waitFor(() => expect(result.current.pageNumber).toBe(2));
  rerender({ ...gate, active: false }); const calls = fetch.mock.calls.length;
  act(background); expect(fetch).toHaveBeenCalledTimes(calls);
  latest = true; rerender(gate);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 2));
  await waitFor(() => expect(result.current.page?.revision).toBe('2'));
  expect(result.current.pageNumber).toBe(2); expect(result.current.page?.items[0]?.number).toBe('36');
  expect(result.current.page?.previousCursor).toBe('back');
  act(() => result.current.refresh()); await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('50'));
  expect(result.current.pageNumber).toBe(1);
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

it('reconciles the actual first page with one list read and publishes its records, counts and cursors together', async () => {
  let updated = false;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus(updated ? '2' : '1'));
    const params = new URL(url, 'https://test').searchParams;
    expect(params.has('cursor')).toBe(false);
    return prResponse(updated ? { ...prPage(['50', '42', '41', '40', '39', '38'], '2', 'new-next'), total: '9007199254740993', counts: { active: '9007199254740993', merged: '0', closed: '0', all: '9007199254740993' } } : prPage(['42'], '1', 'old-next'));
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('42'));
  updated = true; const calls = fetch.mock.calls.length;
  act(background);
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('50'));
  expect(fetch.mock.calls.length).toBe(calls + 2);
  expect(result.current.page?.items.map(item => item.number)).toEqual(['50', '42', '41', '40', '39', '38']);
  expect(result.current.page?.total).toBe('9007199254740993');
  expect(result.current.counts?.all).toBe('9007199254740993');
  expect(result.current.page?.nextCursor).toBe('new-next');
  expect(result.current.page?.previousCursor).toBeNull();
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
  act(background);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => new URL(url, 'https://test').searchParams.get('cursor') === shiftedFirst)).toHaveLength(2));
  expect(result.current.page?.previousCursor).toBe(remainingFirst);
  act(() => result.current.previous());
  await waitFor(() => expect(result.current.page?.items.map(item => item.number)).toEqual(['24']));
  expect(result.current.pageNumber).toBe(1);
  expect(result.current.page?.previousCursor).toBeNull();
  expect(fetch.mock.calls.some(([url]) => new URL(url, 'https://test').searchParams.get('cursor') === remainingFirst)).toBe(true);
  const calls = fetch.mock.calls.length;
  act(background);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 2));
  expect(new URL(fetch.mock.calls.at(-1)![0], 'https://test').searchParams.has('cursor')).toBe(false);
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('24'));
});

it('keeps an empty anchored page and its return path during reconciliation', async () => {
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (cursor === 'next') return prResponse(prPage(['36'], '1', null, 'back'));
    if (cursor === 'back') return prResponse(prPage([], '2', 'next', null));
    return prResponse(prPage(['42'], '1', 'next'));
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('42'));
  act(() => result.current.next()); await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('36'));
  act(() => result.current.previous()); await waitFor(() => expect(result.current.page?.items).toEqual([]));
  expect(result.current.pageNumber).toBe(1); expect(result.current.page?.nextCursor).toBe('next');
  const calls = fetch.mock.calls.length;
  act(background);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 2));
  expect(new URL(fetch.mock.calls.at(-1)![0], 'https://test').searchParams.get('cursor')).toBe('back');
  expect(result.current.page?.items).toEqual([]); expect(result.current.page?.nextCursor).toBe('next');
});

it('keeps errors and navigation usable during a background read and rejects its replaced result', async () => {
  const late = prDeferred<Response>(); let mode: 'initial' | 'fail' | 'hold' | 'next' = 'initial';
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (cursor === 'next') return prResponse(prPage(['30'], '3', null, 'back'));
    if (mode === 'fail') throw new TypeError('offline');
    if (mode === 'hold') return late.promise;
    return prResponse(prPage(['42'], '1', 'next'));
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('42'));
  mode = 'fail'; act(background);
  await waitFor(() => expect(result.current.error?.kind).toBe('network'));
  mode = 'hold'; act(background);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(6));
  expect(result.current.loading).toBe(false); expect(result.current.error?.kind).toBe('network');
  expect(result.current.page?.items[0]?.number).toBe('42');
  mode = 'next'; act(() => result.current.next());
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('30'));
  await act(async () => { late.resolve(prResponse(prPage(['100'], '4'))); await late.promise; });
  expect(result.current.page?.items[0]?.number).toBe('30'); expect(result.current.pageNumber).toBe(2);
});

it('automatically publishes the first matching record on an initially empty page', async () => {
  let added = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => prResponse(isStatus(url) ? prStatus() : prPage(added ? ['1'] : [], added ? '2' : '1'))));
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false)); added = true;
  act(background); await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('1'));
  expect(result.current.counts?.all).toBe('1');
});

it('retains the old page after a failed navigation and retries the same target', async () => {
  let fail = true;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    if (new URL(url, 'https://test').searchParams.get('cursor') === 'next') {
      if (fail) throw new Error('offline');
      return prResponse(prPage(['36'], '2', null, 'back'));
    }
    return prResponse(prPage(['42'], '1', 'next'));
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options())); await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next()); await waitFor(() => expect(result.current.error?.kind).toBe('network'));
  expect(result.current.pageNumber).toBe(1); expect(result.current.page?.items[0]?.number).toBe('42');
  fail = false; act(() => result.current.reconcile());
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('36'));
  expect(result.current.pageNumber).toBe(2); expect(result.current.page?.previousCursor).toBe('back');
  expect(fetch.mock.calls.filter(([url]) => new URL(url, 'https://test').searchParams.get('cursor') === 'next')).toHaveLength(2);
});

it('revalidates the maximum PR number without overflowing its cursor anchor', async () => {
  const fetch = vi.fn(async (url: string) => prResponse(isStatus(url) ? prStatus() : prPage(['9223372036854775807']))); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options())); await waitFor(() => expect(result.current.loading).toBe(false));
  act(background); await waitFor(() => expect(result.current.loading).toBe(false));
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

it('discards a pending background result after suspension and rechecks on resume', async () => {
  const late = prDeferred<Response>(); let hold = false;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    return hold ? late.promise : prResponse(prPage(['42'], '1'));
  }); vi.stubGlobal('fetch', fetch);
  const gate = options(), { result, rerender } = renderHook(props => usePullRequests(props), { initialProps: gate });
  await waitFor(() => expect(result.current.loading).toBe(false));
  hold = true; const calls = fetch.mock.calls.length; act(background);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 2));
  rerender({ ...gate, active: false });
  await act(async () => { late.resolve(prResponse(prPage(['100'], '9'))); await late.promise; });
  expect(result.current.page?.items[0]?.number).toBe('42');
  hold = false; rerender(gate);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 4));
  expect(result.current.page?.items[0]?.number).toBe('42');
});

it('rejects late and lower-revision reads and clears old identity and access data', async () => {
  const late = prDeferred<Response>(); let mode: 'initial' | 'late' | 'older' = 'initial';
  const fetch = vi.fn(async (url: string) => {
    if (mode === 'late') return late.promise;
    return prResponse(isStatus(url) ? prStatus(mode === 'older' ? '9007199254740992' : '9007199254740993') : prPage([mode === 'older' ? '1' : '42'], mode === 'older' ? '9007199254740992' : '9007199254740993'));
  }); vi.stubGlobal('fetch', fetch);
  const gate = options(), { result, rerender } = renderHook(props => usePullRequests(props), { initialProps: gate });
  await waitFor(() => expect(result.current.loading).toBe(false)); mode = 'late'; act(background);
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
  fail = true; act(background); await waitFor(() => expect(result.current.statusError?.kind).toBe('network'));
  expect(result.current.page?.items[0]?.number).toBe('42'); expect(result.current.status).not.toBeNull();
  deny = true; act(background); await waitFor(() => expect(gate.onAccessError).toHaveBeenCalledOnce());
  expect(result.current.page).toBeNull(); expect(result.current.status).toBeNull();
});

it('retains a status error while a background status read is pending and clears it only on status success', async () => {
  const pending = prDeferred<Response>(); let mode: 'initial' | 'fail' | 'hold' = 'initial';
  const fetch = vi.fn(async (url: string) => {
    if (!isStatus(url)) return prResponse(prPage(mode === 'hold' ? ['50'] : ['42'], mode === 'hold' ? '2' : '1'));
    if (mode === 'fail') throw new TypeError('offline');
    return mode === 'hold' ? pending.promise : prResponse(prStatus());
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  mode = 'fail'; act(background);
  await waitFor(() => expect(result.current.statusError?.kind).toBe('network'));
  mode = 'hold'; const calls = fetch.mock.calls.length; act(background);
  await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 2));
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('50'));
  expect(result.current.statusError?.kind).toBe('network'); expect(result.current.loading).toBe(false);
  await act(async () => { pending.resolve(prResponse(prStatus('2'))); await pending.promise; });
  await waitFor(() => expect(result.current.statusError).toBeNull());
  expect(result.current.status?.revision).toBe('2');
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
  denied = true; act(background);
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
  act(background); await act(async () => { vi.advanceTimersByTime(30_000); await flush(); });
  expect(result.current.error?.kind).toBe('network'); expect(result.current.page?.items[0]?.number).toBe('42'); expect(result.current.loading).toBe(false);
});

it('binds author page reads to one exact account while retaining filters and counts', async () => {
  const author = { id: '9007199254740997', login: 'author', loginAmbiguous: true };
  let hold = false;
  let observedAuthor = false;
  const delayed = prDeferred<Response>();
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const params = new URL(url, 'https://test').searchParams, selected = params.get('authorId');
    if (hold && selected !== null) return delayed.promise;
    if (selected === null) return prResponse(prPage(['42'], observedAuthor ? '2' : '1', 'second'));
    observedAuthor = true;
    const numbers = params.get('cursor') === 'second' ? ['31'] : ['40'];
    return prResponse({ ...prPage(numbers, '2', 'second', params.get('cursor') === 'second' ? 'back' : null), authorId: selected, projectTotal: '25', items: numbers.map(number => ({ ...prPage([number], '2').items[0], author: { id: selected, login: author.login } })) });
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setFilter('merged')); await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setQuery('topic')); await waitFor(() => expect(result.current.loading).toBe(false));
  hold = true; act(() => result.current.setAuthor(author));
  expect(result.current.page).toBeNull(); expect(result.current.counts).toBeNull(); expect(result.current.pageNumber).toBe(1);
  expect(result.current.filter).toBe('merged'); expect(result.current.query).toBe('topic');
  hold = false;
  await act(async () => { delayed.resolve(prResponse({ ...prPage(['40'], '2', 'second'), authorId: author.id, projectTotal: '25', items: [{ ...prPage(['40'], '2').items[0], author: { id: author.id, login: author.login } }] })); await delayed.promise; });
  await waitFor(() => expect(result.current.page?.items[0]?.number).toBe('40'));
  expect(result.current.counts?.all).toBe('1'); expect(result.current.projectTotal).toBe('25');
  act(background); await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.next()); await waitFor(() => expect(result.current.pageNumber).toBe(2));
  const calls = fetch.mock.calls.length;
  act(() => result.current.setAuthor({ ...author })); expect(result.current.pageNumber).toBe(2); expect(fetch).toHaveBeenCalledTimes(calls);
  act(() => result.current.previous()); await waitFor(() => expect(result.current.pageNumber).toBe(1));
  const authorCalls = fetch.mock.calls.map(([url]) => new URL(url, 'https://test')).filter(url => url.searchParams.get('authorId') === author.id);
  expect(authorCalls.every(url => url.searchParams.get('state') === 'merged' && url.searchParams.get('q') === 'topic')).toBe(true);
  expect(authorCalls.some(url => !url.searchParams.has('cursor'))).toBe(true);
  expect(authorCalls.some(url => url.searchParams.get('cursor') === 'second')).toBe(true);
  act(() => result.current.setAuthor(null));
  expect(result.current.filter).toBe('merged'); expect(result.current.query).toBe('topic'); expect(result.current.page).toBeNull(); expect(result.current.counts).toBeNull();
  expect(result.current.projectTotal).toBe('25');
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.page?.authorId).toBeNull();
});

it('retains author counts for query changes but rejects a late previous author response', async () => {
  const author = { id: '100', login: 'first', loginAmbiguous: false }, other = { id: '200', login: 'second', loginAmbiguous: false };
  const pending = prDeferred<Response>(); let holdFirst = false;
  const fetch = vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const id = new URL(url, 'https://test').searchParams.get('authorId');
    if (id === null) return prResponse(prPage(['42']));
    if (id === author.id && holdFirst) return pending.promise;
    const number = id === author.id ? '40' : '30';
    return prResponse({ ...prPage([number], '3'), authorId: id, projectTotal: '3', items: [{ ...prPage([number], '3').items[0], author: { id, login: 'x' } }] });
  }); vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => result.current.setAuthor(author)); await waitFor(() => expect(result.current.page?.authorId).toBe(author.id));
  holdFirst = true; act(() => result.current.setQuery('q'));
  expect(result.current.counts?.all).toBe('1'); expect(result.current.page).toBeNull();
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => { const params = new URL(url, 'https://test').searchParams; return params.get('authorId') === author.id && params.get('q') === 'q'; })).toBe(true));
  act(() => result.current.setAuthor(other)); expect(result.current.counts).toBeNull();
  await waitFor(() => expect(result.current.page?.authorId).toBe(other.id));
  await act(async () => { pending.resolve(prResponse({ ...prPage(['90'], '20'), authorId: author.id, projectTotal: '3', items: [{ ...prPage(['90'], '20').items[0], author: { id: author.id, login: 'first' } }] })); await pending.promise; });
  expect(result.current.author?.id).toBe(other.id); expect(result.current.page?.items[0]?.number).toBe('30');
});

it('reports a stale revision when a new author has no accepted page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (isStatus(url)) return prResponse(prStatus());
    const authorId = new URL(url, 'https://test').searchParams.get('authorId');
    if (authorId === null) return prResponse(prPage(['42'], '5'));
    return prResponse({ ...prPage(['40'], '4'), authorId, projectTotal: '1', items: [{ ...prPage(['40'], '4').items[0], author: { id: authorId, login: 'author' } }] });
  }));
  const { result } = renderHook(() => usePullRequests(options()));
  await waitFor(() => expect(result.current.page?.revision).toBe('5'));
  act(() => result.current.setAuthor({ id: '100', login: 'author', loginAmbiguous: false }));
  await waitFor(() => expect(result.current.error?.kind).toBe('protocol'));
  expect(result.current.page).toBeNull();
  expect(result.current.loading).toBe(false);
});
