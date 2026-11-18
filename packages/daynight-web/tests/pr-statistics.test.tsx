import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { parsePRStatistics, validateStatisticsWindow, type PRStatistics } from '../src/features/project-statistics/pr-statistics-api';
import { usePRStatistics } from '../src/features/project-statistics/pr-statistics';

vi.mock('../src/features/project-statistics/pr-statistics-api', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/features/project-statistics/pr-statistics-api')>();
  return { ...actual, getPRStatistics: vi.fn() };
});
import { getPRStatistics } from '../src/features/project-statistics/pr-statistics-api';

const projectId = 'fb1a3e30-f945-4c48-ab0f-55be117e098e';
const userId = '6153d2b9-82b1-4589-9107-8f6fc78b5da7';
const endDate = '2026-03-08';
const dateWindow = '0@1770422400000,1@1770508800000,-@1770595200000';
const data = (authorId: string | null = null): PRStatistics => ({ projectId, endDate, revision: '1', projectTotal: '9007199254740993', availability: 'ready', hasAuthors: true, daily: Array(30).fill('1'), authorId, author: authorId === null ? null : { id: authorId, login: 'renamed' }, authorDaily: authorId === null ? null : Array(30).fill('1') });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('PR statistics protocol', () => {
  it('retains exact counts and rejects mismatched authors and malformed series', () => {
    expect(parsePRStatistics(data('8'), projectId, endDate, '8').projectTotal).toBe('9007199254740993');
    expect(() => parsePRStatistics({ ...data('8'), author: { id: '9', login: 'other' } }, projectId, endDate, '8')).toThrow();
    expect(() => parsePRStatistics({ ...data('8'), authorDaily: Array(30).fill('2') }, projectId, endDate, '8')).toThrow();
    expect(() => parsePRStatistics({ ...data(), daily: Array(29).fill('0') }, projectId, endDate, null)).toThrow();
    expect(() => parsePRStatistics({ ...data(), revision: '01' }, projectId, endDate, null)).toThrow();
  });
  it('checks window ordering, dates and segment bounds before dispatch', () => {
    expect(() => validateStatisticsWindow(endDate, dateWindow)).not.toThrow();
    expect(() => validateStatisticsWindow(endDate, '0@1770422400000,0@1770508800000,-@1770595200000')).toThrow(ApiError);
    expect(() => validateStatisticsWindow('2026-02-30', dateWindow)).toThrow(ApiError);
    expect(() => validateStatisticsWindow(endDate, '0@1770422400000,-@1770681600000')).toThrow(ApiError);
  });
  it('treats a 404 without a principal from an older server as a protocol error', async () => {
    const api = await vi.importActual<typeof import('../src/features/project-statistics/pr-statistics-api')>('../src/features/project-statistics/pr-statistics-api');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));
    const mismatch = vi.fn();
    await expect(api.getPRStatistics(projectId, endDate, dateWindow, null, new AbortController().signal, { userId, onPrincipalMismatch: mismatch })).rejects.toMatchObject({ kind: 'protocol', status: 404 });
    expect(mismatch).not.toHaveBeenCalled();
  });
});

describe('PR statistics lifecycle', () => {
  it('drops stale authors and applies the latest login from the aggregation', async () => {
    const previous = deferred<PRStatistics>(), next = deferred<PRStatistics>();
    vi.mocked(getPRStatistics).mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
    const props = { userId, projectId, canRead: true, active: true, endDate, window: dateWindow, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() };
    const { result } = renderHook(() => usePRStatistics(props));
    await waitFor(() => expect(getPRStatistics).toHaveBeenCalledTimes(1));
    act(() => result.current.setAuthor({ id: '8', login: 'old', loginAmbiguous: true }));
    expect(getPRStatistics).toHaveBeenCalledTimes(2);
    await act(async () => { previous.resolve(data()); await previous.promise; });
    expect(result.current.data).toBeNull();
    await act(async () => { next.resolve(data('8')); await next.promise; });
    await waitFor(() => expect(result.current.author?.login).toBe('renamed'));
    expect(result.current.author?.loginAmbiguous).toBe(true);
    expect(result.current.data?.authorId).toBe('8');
  });
  it('retains the shown series and author until a new selection succeeds, including failure and retry', async () => {
    const pending = deferred<PRStatistics>();
    vi.mocked(getPRStatistics).mockResolvedValueOnce(data()).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(data('9'));
    const props = { userId, projectId, canRead: true, active: true, endDate, window: dateWindow, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() };
    const { result } = renderHook(() => usePRStatistics(props));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    const shown = result.current.data;
    act(() => result.current.setAuthor({ id: '8', login: 'old', loginAmbiguous: false }));
    expect(result.current.data).toBe(shown);
    expect(result.current.author).toBeNull();
    act(() => result.current.setAuthor({ id: '9', login: 'candidate', loginAmbiguous: false }));
    await act(async () => { pending.resolve(data('8')); await pending.promise; });
    await waitFor(() => expect(result.current.error?.kind).toBe('network'));
    expect(result.current.data).toBe(shown);
    expect(result.current.author).toBeNull();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.authorId).toBe('9'));
    expect(result.current.author).toMatchObject({ id: '9', login: 'renamed' });
  });
  it('coalesces refresh and does not display a prior date while the next request is pending', async () => {
    const later = deferred<PRStatistics>();
    vi.mocked(getPRStatistics).mockResolvedValueOnce(data()).mockReturnValueOnce(later.promise);
    const initial = { userId, projectId, canRead: true, active: true, endDate, window: dateWindow, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() };
    const { result, rerender } = renderHook(props => usePRStatistics(props), { initialProps: initial });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    rerender({ ...initial, endDate: '2026-03-09' });
    await waitFor(() => expect(getPRStatistics).toHaveBeenCalledTimes(2));
    expect(result.current.data).toBeNull();
    act(() => { result.current.refresh(); result.current.refresh(); });
    expect(getPRStatistics).toHaveBeenCalledTimes(2);
  });
  it('keeps an old-server protocol failure local and exposes a retry', async () => {
    vi.mocked(getPRStatistics).mockRejectedValueOnce(new ApiError('protocol', 404)).mockResolvedValueOnce(data());
    const options = { userId, projectId, canRead: true, active: true, endDate, window: dateWindow, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() };
    const { result } = renderHook(() => usePRStatistics(options));
    await waitFor(() => expect(result.current.error?.kind).toBe('protocol'));
    expect(options.onAccessError).not.toHaveBeenCalled();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.projectTotal).toBe('9007199254740993'));
    expect(result.current.error).toBeNull();
  });
  it('loads the author directory only when opened and does not request the PR list', async () => {
    vi.mocked(getPRStatistics).mockResolvedValue(data());
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ projectId, revision: '1', items: [{ id: '8', login: 'author', loginAmbiguous: false }], nextCursor: null }), { status: 200, headers: { 'Daynight-User-ID': userId, 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const options = { userId, projectId, canRead: true, active: true, endDate, window: dateWindow, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() };
    const { result } = renderHook(() => usePRStatistics(options));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(fetch).not.toHaveBeenCalled();
    act(() => result.current.authors.open());
    await waitFor(() => expect(result.current.authors.items[0]?.login).toBe('author'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain('/pull-request-authors?');
  });
});
