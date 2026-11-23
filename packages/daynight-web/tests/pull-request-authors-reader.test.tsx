import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { createReadSession } from '../src/features/pull-requests/read-session';
import { usePullRequestAuthors } from '../src/features/pull-requests/usePullRequestAuthors';
import { prDeferred, prProjectId, prResponse, prUserId } from './pull-requests-fixtures';

const author = (n: number) => ({ id: String(n), login: `user${String(n).padStart(3, '0')}`, loginAmbiguous: false });
const page = (start: number, end: number, revision: string, nextCursor: string | null) => ({ projectId: prProjectId, revision, items: Array.from({ length: end - start + 1 }, (_, index) => author(start + index)), nextCursor });
const setup = () => {
  const scope = createReadSession({ userId: prUserId, projectId: prProjectId, isAllowed: () => true, onPrincipalMismatch: vi.fn(), onAccessError: vi.fn() });
  return { scope, ...renderHook(() => usePullRequestAuthors({ userId: prUserId, projectId: prProjectId, active: true, scope })) };
};
const conflict = () => prResponse({ error: { code: 'resource_conflict', message: 'Conflict', requestId: 'test' } }, 409);
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('keeps 100 visible authors until rebuilding covers both the old range and anchors', async () => {
  let phase = 'old';
  const second = prDeferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (phase === 'old') {
      if (cursor === null) return prResponse(page(1, 50, '1', 'old-2'));
      if (cursor === 'old-2') return prResponse(page(51, 100, '1', 'old-3'));
      return conflict();
    }
    if (cursor === null) return prResponse(page(1, 50, '2', 'new-2'));
    return second.promise;
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(50));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(100));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  phase = 'new';
  act(() => result.current.retry({ focusedId: '90', visibleId: '60' }));
  await waitFor(() => expect(result.current.rebuilding).toBe(true));
  expect(result.current.items).toHaveLength(100);
  expect(result.current.revision).toBe('1');
  await act(async () => { second.resolve(prResponse(page(51, 100, '2', 'new-3'))); });
  await waitFor(() => expect(result.current.revision).toBe('2'));
  expect(result.current.items).toHaveLength(100);
  expect(result.current.nextCursor).toBe('new-3');
});

it('retains the old observation when rebuilding conflicts again', async () => {
  let phase = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (phase === 0 && cursor === null) return prResponse(page(1, 50, '1', 'old-2'));
    if (phase === 0 && cursor === 'old-2') return prResponse(page(51, 100, '1', 'old-3'));
    if (phase === 1 && cursor === null) return prResponse(page(1, 50, '2', 'new-2'));
    return conflict();
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(50));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(100));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  phase = 1;
  act(() => result.current.retry({ focusedId: '90', visibleId: '60' }));
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  expect(result.current.items).toHaveLength(100);
  expect(result.current.revision).toBe('1');
  expect(result.current.rebuilding).toBe(false);
});

it('synchronously withdraws the directory and ignores a late sibling success', async () => {
  const pending = prDeferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pending.promise));
  const { result, scope } = setup();
  act(() => result.current.open());
  act(() => scope.revoke());
  await act(async () => { pending.resolve(prResponse(page(1, 1, '1', null))); });
  expect(result.current.items).toEqual([]);
  expect(result.current.loaded).toBe(false);
});

it('keeps the previous pages when the complete rebuild exceeds its budget', async () => {
  let phase = 'old';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (phase === 'old' && cursor === null) return prResponse(page(1, 50, '1', 'old-2'));
    if (phase === 'old' && cursor === 'old-2') return prResponse(page(51, 100, '1', 'old-3'));
    if (phase === 'old') return conflict();
    if (cursor === null) return prResponse(page(1, 50, '2', 'new-2'));
    return new Promise<Response>(() => {});
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(50));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(100));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  phase = 'new'; vi.useFakeTimers();
  await act(async () => { result.current.retry({ focusedId: '90', visibleId: '60' }); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(result.current.rebuilding).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(result.current.error?.kind).toBe('network');
  expect(result.current.items).toHaveLength(100);
  expect(result.current.revision).toBe('1');
});

it('revalidates both baseline reads before accepting a directory after a 404', async () => {
  let baseline = false, directoryCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/pull-request-authors')) {
      directoryCalls++;
      return directoryCalls === 1 ? prResponse({ error: { code: 'not_found', message: 'Not found', requestId: 'test' } }, 404) : prResponse(page(1, 1, '1', null));
    }
    if (!baseline) throw new Error('offline');
    const { prPage, prStatus } = await import('./pull-requests-fixtures');
    return prResponse(url.endsWith('/github') ? prStatus() : prPage());
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.error?.status).toBe(404));
  await waitFor(() => expect(result.current.loading).toBe(false));
  baseline = true;
  act(() => result.current.retry({ focusedId: null, visibleId: null }));
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  expect(directoryCalls).toBe(2);
});

it('continues past the old range until a renamed focus anchor is found', async () => {
  let phase = 'old';
  const third = prDeferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (phase === 'old' && cursor === null) return prResponse(page(1, 50, '1', 'old-2'));
    if (phase === 'old' && cursor === 'old-2') return prResponse(page(51, 100, '1', 'old-3'));
    if (phase === 'old') return conflict();
    if (cursor === null) return prResponse(page(1, 50, '2', 'new-2'));
    if (cursor === 'new-2') return prResponse({ projectId: prProjectId, revision: '2', items: [...Array.from({ length: 39 }, (_, i) => author(i + 51)), ...Array.from({ length: 11 }, (_, i) => author(i + 91))], nextCursor: 'new-3' });
    return third.promise;
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(50));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(100));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  phase = 'new';
  act(() => result.current.retry({ focusedId: '90', visibleId: '60' }));
  await waitFor(() => expect(result.current.rebuilding).toBe(true));
  expect(result.current.revision).toBe('1');
  await act(async () => { third.resolve(prResponse({ projectId: prProjectId, revision: '2', items: [{ id: '90', login: 'user999', loginAmbiguous: false }], nextCursor: null })); });
  await waitFor(() => expect(result.current.revision).toBe('2'));
  expect(result.current.items).toHaveLength(101);
  expect(result.current.items.at(-1)?.id).toBe('90');
});

it('invalidates an old query during composition without dispatching until composition ends', async () => {
  const old = prDeferred<Response>();
  const fetch = vi.fn(async (url: string) => {
    const query = new URL(url, 'https://test').searchParams.get('q');
    return query === '' ? old.promise : prResponse(page(2, 2, '2', null));
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  vi.useFakeTimers();
  act(() => result.current.setQuery('user', true));
  await act(async () => { old.resolve(prResponse(page(1, 1, '1', null))); await Promise.resolve(); });
  expect(result.current.items).toHaveLength(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  act(() => result.current.setQuery('user', false));
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); for (let i = 0; i < 20; i++) await Promise.resolve(); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(result.current.items.map(item => item.id)).toEqual(['2']);
});


it('enforces the rebuild budget while waiting for authentication admission', async () => {
  let phase = 'old';
  let releaseAuth = () => {};
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (phase === 'old' && cursor === null) return prResponse(page(1, 50, '1', 'old-2'));
    if (phase === 'old' && cursor === 'old-2') return prResponse(page(51, 100, '1', 'old-3'));
    if (phase === 'old') return conflict();
    releaseAuth = pauseAuthRequests();
    return prResponse(page(1, 50, '2', 'new-2'));
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(50));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(100));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  phase = 'new'; vi.useFakeTimers();
  await act(async () => { result.current.retry({ focusedId: '90', visibleId: '60' }); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  expect(result.current.rebuilding).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(result.current.error?.kind).toBe('network');
  expect(result.current.rebuilding).toBe(false);
  expect(result.current.items).toHaveLength(100);
  expect(result.current.revision).toBe('1');
  act(releaseAuth);
});

it('publishes at EOF when an old anchor no longer exists', async () => {
  let phase = 'old';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (phase === 'old' && cursor === null) return prResponse(page(1, 50, '1', 'old-2'));
    if (phase === 'old' && cursor === 'old-2') return prResponse(page(51, 100, '1', 'old-3'));
    if (phase === 'old') return conflict();
    if (cursor === null) return prResponse(page(1, 50, '2', 'new-2'));
    return prResponse({ projectId: prProjectId, revision: '2', items: [...Array.from({ length: 39 }, (_, i) => author(i + 51)), ...Array.from({ length: 10 }, (_, i) => author(i + 91))], nextCursor: null });
  }));
  const { result } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(50));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.items).toHaveLength(100));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.status).toBe(409));
  phase = 'new';
  act(() => result.current.retry({ focusedId: '90', visibleId: '60' }));
  await waitFor(() => expect(result.current.revision).toBe('2'));
  expect(result.current.items).toHaveLength(99);
  expect(result.current.items.some(item => item.id === '90')).toBe(false);
  expect(result.current.nextCursor).toBeNull();
});

it('does not apply an old baseline denial while authentication is paused or to a new identity', async () => {
  const otherUser = '33333333-3333-4333-8333-333333333333';
  const oldDenied = vi.fn(), oldMismatch = vi.fn(), newDenied = vi.fn();
  const oldScope = createReadSession({ userId: prUserId, projectId: prProjectId, isAllowed: () => true, onPrincipalMismatch: oldMismatch, onAccessError: oldDenied });
  const newScope = createReadSession({ userId: otherUser, projectId: prProjectId, isAllowed: () => true, onPrincipalMismatch: vi.fn(), onAccessError: newDenied });
  let phase = 'old', paused = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'https://test');
    if (phase === 'new') return prResponse(page(2, 2, '2', null), 200, otherUser);
    if (url.pathname.endsWith('/pull-request-authors')) {
      return url.searchParams.has('cursor') ? prResponse({ error: { code: 'not_found', message: 'Not found', requestId: 'test' } }, 404) : prResponse(page(1, 1, '1', 'old-2'));
    }
    if (url.pathname.endsWith('/github')) {
      pauseAuthRequests(); paused = true;
      return prResponse({ error: { code: 'forbidden', message: 'Forbidden', requestId: 'test' } }, 403);
    }
    const { prPage } = await import('./pull-requests-fixtures');
    return prResponse(prPage());
  }));
  const { result, rerender } = renderHook(({ userId, scope }) => usePullRequestAuthors({ userId, projectId: prProjectId, active: true, scope }), { initialProps: { userId: prUserId, scope: oldScope } });
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  act(() => result.current.loadMore());
  await waitFor(() => expect(paused).toBe(true));
  expect(result.current.items.map(item => item.id)).toEqual(['1']);
  expect(oldDenied).not.toHaveBeenCalled();
  act(() => invalidateAuthRequests());
  await waitFor(() => expect(result.current.items).toEqual([]));
  expect(oldScope.isRevoked()).toBe(true);
  expect(oldDenied).not.toHaveBeenCalled();
  phase = 'new';
  rerender({ userId: otherUser, scope: newScope });
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items.map(item => item.id)).toEqual(['2']));
  expect(oldDenied).not.toHaveBeenCalled();
  expect(oldMismatch).not.toHaveBeenCalled();
  expect(newDenied).not.toHaveBeenCalled();
});

it('retains the directory and shared access on an untrusted 403 and can retry', async () => {
  let reject = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'https://test').searchParams.get('cursor');
    if (cursor === null) return prResponse(page(1, 1, '1', 'next'));
    if (reject) return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden', requestId: 'proxy' } }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    return prResponse(page(2, 2, '1', null));
  }));
  const { result, scope } = setup();
  act(() => result.current.open());
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.error?.kind).toBe('protocol'));
  expect(result.current.error?.status).toBe(403);
  expect(result.current.items).toEqual([author(1)]);
  expect(scope.isRevoked()).toBe(false);
  reject = false;
  act(() => result.current.retry({ focusedId: null, visibleId: null }));
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  expect(result.current.error).toBeNull();
});
