import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { searchTasks, type TaskSearchPage } from '../src/api/task-search';
import { useTaskSearch } from '../src/features/task-search/useTaskSearch';
import type { CacheEvent, TaskCacheScope } from '../src/features/task-cache/project-cache';

vi.mock('../src/api/task-search', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/api/task-search')>(), searchTasks: vi.fn() }));
const project = '10000000-0000-4000-8000-000000000001';
const user = '20000000-0000-4000-8000-000000000001';
const item = (id: string) => ({ tags: [], id, projectId: project, title: id, status: 'todo' as const, assignedTo: null, updatedAt: '2026-01-01T00:00:00Z', cancelledAt: null, context: null, match: { fields: [] as ('title' | 'description')[], descriptionSnippet: null } });
const page = (id: string, nextCursor: string | null, total = 2): TaskSearchPage => ({ projectId: project, items: [item(id)], total, nextCursor });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const world = () => {
  const listeners = new Set<(event: CacheEvent) => void>(); const lifetime = new AbortController(); let revision = 0;
  const scope = { userId: user, signal: lifetime.signal, isInvalidated: false, principalMismatch: vi.fn(), ready: vi.fn(async () => {}), getProjectRevision: () => revision, markProjectReadable: vi.fn(), revalidateProjectAccess: vi.fn(async () => {}), subscribe: (listener: (event: CacheEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as TaskCacheScope;
  return { scope, abort: () => lifetime.abort(), bump: () => { revision++; }, emit: (event: CacheEvent) => { revision++; for (const listener of listeners) listener(event); } };
};
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it('separates draft, filters and cursors, and retires later cursors after reading page one again', async () => {
  const search = vi.mocked(searchTasks); search.mockResolvedValueOnce(page('a', 'cursor')).mockResolvedValueOnce(page('b', null)).mockResolvedValueOnce(page('a', 'new-cursor'));
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, 'me'));
  act(() => { result.current.setDraft('first'); result.current.submit(); });
  await waitFor(() => expect(result.current.items[0]?.id).toBe('a'));
  expect(result.current.filters.assignedTo).toBe('me');
  act(() => result.current.setDraft('unsent')); expect(result.current.applied).toBe('first');
  act(() => result.current.next()); await waitFor(() => expect(result.current.page).toBe(2));
  expect(search.mock.calls[1]?.[3]).toBe('cursor');
  act(() => result.current.previous()); await waitFor(() => expect(result.current.page).toBe(1));
  expect(result.current.canNext).toBe(true); expect(result.current.draft).toBe('unsent');
  search.mockResolvedValueOnce(page('c', null)); act(() => result.current.next()); await waitFor(() => expect(result.current.page).toBe(2));
  expect(search.mock.calls[3]?.[3]).toBe('new-cursor');
  act(() => result.current.clear()); expect(result.current.applied).toBeNull();
});
it('clears filters, pages and pending reads without publishing late results', async () => {
  const search = vi.mocked(searchTasks); const pending = deferred<TaskSearchPage>();
  search.mockResolvedValueOnce(page('a', 'cursor')).mockResolvedValueOnce(page('a', 'filtered-cursor')).mockResolvedValueOnce(page('b', null)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('fresh', null, 1));
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, 'me'));
  act(() => { result.current.setDraft('query'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => result.current.setFilters({ status: 'done', assignedTo: 'me' })); await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => result.current.next()); await waitFor(() => expect(result.current.page).toBe(2));
  act(() => result.current.retry()); await waitFor(() => expect(search).toHaveBeenCalledTimes(4));
  const signal = search.mock.calls[3]![4];
  act(() => result.current.clear());
  expect(signal.aborted).toBe(true);
  expect(result.current).toMatchObject({ draft: '', applied: null, filters: { status: '', assignedTo: '' }, items: [], total: null, page: 1, canPrevious: false, canNext: false, busy: false, error: null });
  await act(async () => { pending.resolve(page('late', 'late-cursor')); });
  expect(result.current).toMatchObject({ applied: null, items: [], page: 1, canNext: false });
  act(() => { result.current.setDraft('new'); result.current.submit(); }); await waitFor(() => expect(result.current.items[0]?.id).toBe('fresh'));
  expect(search.mock.calls[4]?.[3]).toBeNull();
});
it('aborts stale requests and does not publish late results after a new submission or history retirement', async () => {
  const search = vi.mocked(searchTasks); const first = deferred<TaskSearchPage>(), later = deferred<TaskSearchPage>();
  search.mockReturnValueOnce(first.promise).mockReturnValueOnce(later.promise).mockResolvedValueOnce(page('new-history', null, 1));
  const { scope, emit } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
  act(() => { result.current.setDraft('old'); result.current.submit(); });
  await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  act(() => { result.current.setDraft('new'); result.current.submit(); });
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  act(() => first.resolve(page('old', null, 1))); expect(result.current.items).toEqual([]);
  act(() => emit({ projectId: project, historyChanged: true }));
  await waitFor(() => expect(result.current.items[0]?.id).toBe('new-history'));
  act(() => later.resolve(page('late', null, 1))); await act(async () => {});
  expect(result.current.items[0]?.id).toBe('new-history');
});
it('restarts search_changed only once, preserves applied query, and surfaces repeated failure', async () => {
  const search = vi.mocked(searchTasks); const changed = new ApiError('server', 409, 'search_changed');
  search.mockResolvedValueOnce(page('a', 'cursor')).mockRejectedValueOnce(changed).mockRejectedValueOnce(changed);
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
  act(() => { result.current.setDraft('query'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => result.current.next()); await waitFor(() => expect(result.current.error).toBe(changed));
  expect(result.current.items).toEqual([]); expect(result.current.applied).toBe('query'); expect(result.current.errorQuery).toBe('query');
  expect(search).toHaveBeenCalledTimes(3); expect(search.mock.calls[2]?.[3]).toBeNull();
});
it('withdraws results immediately on access loss, preserves refresh errors and clears state on scope change', async () => {
  const search = vi.mocked(searchTasks); search.mockResolvedValueOnce(page('a', null, 1)).mockRejectedValueOnce(new ApiError('network'));
  const a = world(), b = world(); const { result, rerender } = renderHook(({ scope }) => useTaskSearch(project, scope, ''), { initialProps: { scope: a.scope } });
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.items).toHaveLength(1));
  act(() => result.current.retry()); await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'network' })); expect(result.current.items).toHaveLength(1);
  act(() => a.emit({ projectId: project, accessRevoked: true })); expect(result.current.items).toEqual([]);
  rerender({ scope: b.scope }); expect(result.current.applied).toBeNull(); expect(result.current.draft).toBe('');
});
it('pauses periodic requests while hidden and refreshes immediately upon visibility', async () => {
  const search = vi.mocked(searchTasks); search.mockResolvedValue(page('a', null, 1));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const key = Symbol.for('daynight.pollingIntervals'); Reflect.set(globalThis, key, { taskSync: 20 });
  try {
    const { scope } = world(); const { result, unmount } = renderHook(() => useTaskSearch(project, scope, ''));
    act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.items).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 70)); expect(search).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(search.mock.calls.length).toBeGreaterThan(1)); unmount();
  } finally { visibility.mockRestore(); Reflect.deleteProperty(globalThis, key); }
});
it('clears results as soon as the account scope aborts and does not publish an in-flight response', async () => {
  const search = vi.mocked(searchTasks); const pending = deferred<TaskSearchPage>();
  search.mockResolvedValueOnce(page('a', null, 1)).mockReturnValueOnce(pending.promise);
  const a = world(); const { result } = renderHook(() => useTaskSearch(project, a.scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.items).toHaveLength(1));
  act(() => result.current.retry()); await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  act(() => a.abort()); expect(result.current.items).toEqual([]);
  act(() => pending.resolve(page('old', null, 1))); await act(async () => {}); expect(result.current.items).toEqual([]);
});
it('keeps existing controls enabled during a background refresh', async () => {
  const search = vi.mocked(searchTasks); const refresh = deferred<TaskSearchPage>();
  search.mockResolvedValueOnce(page('a', 'cursor')).mockReturnValueOnce(refresh.promise);
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => document.dispatchEvent(new Event('visibilitychange'))); await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  expect(result.current.busy).toBe(false); expect(result.current.canNext).toBe(true); expect(result.current.items).toHaveLength(1);
  act(() => refresh.resolve(page('a', 'new-cursor'))); await act(async () => {});
});
it('keeps a refresh error visible while the next automatic check is pending', async () => {
  const search = vi.mocked(searchTasks); const refresh = deferred<TaskSearchPage>();
  search.mockResolvedValueOnce(page('a', null, 1)).mockRejectedValueOnce(new ApiError('network')).mockReturnValueOnce(refresh.promise);
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.items).toHaveLength(1));
  act(() => result.current.retry()); await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'network' }));
  act(() => document.dispatchEvent(new Event('visibilitychange'))); await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
  expect(result.current.error).toMatchObject({ kind: 'network' }); expect(result.current.items).toHaveLength(1);
  act(() => refresh.resolve(page('a', null, 1))); await waitFor(() => expect(result.current.error).toBeNull());
});
it('does not expose search errors when access is withdrawn before any search', () => {
  const a = world(); const { result } = renderHook(() => useTaskSearch(project, a.scope, ''));
  act(() => a.emit({ projectId: project, accessRevoked: true })); expect(result.current.error).toBeNull();
});
it('retries the failed target page using its obtained cursor and clears it on a new filter', async () => {
  const search = vi.mocked(searchTasks); search.mockResolvedValueOnce(page('a', 'cursor')).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(page('b', null)).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(page('filtered', null, 1));
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => result.current.next()); await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'network' }));
  act(() => result.current.retry()); await waitFor(() => expect(result.current.page).toBe(2)); expect(search.mock.calls[2]?.[3]).toBe('cursor');
  act(() => result.current.previous()); await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'network' }));
  act(() => result.current.setFilters({ status: 'done', assignedTo: '' })); await waitFor(() => expect(result.current.items[0]?.id).toBe('filtered'));
  expect(search.mock.calls[4]?.[3]).toBeNull();
});
it('retires cursors and cancels in-flight reads when the cache generation changes', async () => {
  const search = vi.mocked(searchTasks); const pending = deferred<TaskSearchPage>();
  search.mockResolvedValueOnce(page('a', 'cursor')).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('fresh', null, 1));
  const a = world(); const { result } = renderHook(() => useTaskSearch(project, a.scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => result.current.next()); await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  act(() => a.emit({ projectId: project, cacheGenerationChanged: true })); await waitFor(() => expect(result.current.items[0]?.id).toBe('fresh'));
  expect(result.current.page).toBe(1); expect(result.current.busy).toBe(false); expect(search.mock.calls[2]?.[3]).toBeNull();
  act(() => pending.resolve(page('old', null))); await act(async () => {}); expect(result.current.items[0]?.id).toBe('fresh');
});
it('keeps a failed next-page retry through background refresh and uses its newly obtained cursor', async () => {
  const search = vi.mocked(searchTasks); search.mockResolvedValueOnce(page('a', 'old')).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(page('a', 'new')).mockResolvedValueOnce(page('b', null));
  const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
  act(() => result.current.next()); await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'network' }));
  act(() => document.dispatchEvent(new Event('visibilitychange'))); await waitFor(() => expect(search).toHaveBeenCalledTimes(3));
  await act(async () => {}); expect(result.current.error).toMatchObject({ kind: 'network' });
  act(() => result.current.retry()); await waitFor(() => expect(result.current.page).toBe(2)); expect(search.mock.calls[3]?.[3]).toBe('new');
});
it('restarts once when a revision changes without an event during an in-flight read', async () => {
  const search = vi.mocked(searchTasks); const pending = deferred<TaskSearchPage>();
  search.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('fresh', null, 1));
  const a = world(); const { result } = renderHook(() => useTaskSearch(project, a.scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  act(() => { a.bump(); pending.resolve(page('old', null, 1)); });
  await waitFor(() => expect(result.current.items[0]?.id).toBe('fresh')); expect(result.current.busy).toBe(false); expect(search).toHaveBeenCalledTimes(2);
});
it('stops automatic recovery after consecutive search_changed errors until an explicit retry', async () => {
  const search = vi.mocked(searchTasks); const changed = new ApiError('server', 409, 'search_changed');
  search.mockRejectedValueOnce(changed).mockRejectedValueOnce(changed).mockResolvedValueOnce(page('fresh', null, 1));
  const a = world(); const { result } = renderHook(() => useTaskSearch(project, a.scope, ''));
  act(() => { result.current.setDraft('x'); result.current.submit(); }); await waitFor(() => expect(result.current.error).toBe(changed));
  act(() => { document.dispatchEvent(new Event('visibilitychange')); a.emit({ projectId: project, historyChanged: true }); }); await act(async () => {});
  expect(search).toHaveBeenCalledTimes(2); expect(result.current.error).toBe(changed);
  act(() => result.current.retry()); await waitFor(() => expect(result.current.items[0]?.id).toBe('fresh')); expect(search).toHaveBeenCalledTimes(3);
});
it('logs safe structured cycle correlation without query, cursor or upstream error text', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const search = vi.mocked(searchTasks);
    search.mockImplementationOnce(async (_project, _query, _filters, _cursor, _signal, _admission, correlation) => { correlation?.onResponseId('observed'); return page('a', 'secret-cursor'); });
    search.mockRejectedValueOnce(new ApiError('network', null, 'network', null, new Error('private upstream text')));
    const { scope } = world(); const { result } = renderHook(() => useTaskSearch(project, scope, ''));
    act(() => { result.current.setDraft('private query'); result.current.submit(); }); await waitFor(() => expect(result.current.canNext).toBe(true));
    act(() => result.current.next()); await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'network' }));
    const success = debug.mock.calls[0]?.[1] as Record<string, unknown>, failure = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(success).toMatchObject({ component: 'task_search', phase: 'read', request_id: 'observed', returned_count: 1, total: 2 });
    expect(success.cycle_id).toBeTruthy(); expect(failure).toMatchObject({ component: 'task_search', phase: 'read', error_code: 'network' });
    expect(JSON.stringify([success, failure])).not.toMatch(/private|secret-cursor/);
  } finally { debug.mockRestore(); warn.mockRestore(); }
});
