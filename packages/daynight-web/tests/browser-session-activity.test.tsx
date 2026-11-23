import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hasActiveAuthenticatedRead, invalidateAuthRequests, pauseAuthRequests, request } from '../src/api/client';
import { reportBrowserSessionActivity } from '../src/api/session-activity';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { useBrowserSessionActivity } from '../src/features/task-agent-session/useBrowserSessionActivity';

const userId = '00000009-1111-4111-8111-111111111111';
const minute = 60_000;
const response = () => new Response(null, { status: 204, headers: { 'Daynight-User-ID': userId } });
const View = ({ enabled }: { readonly enabled: boolean }) => { useBrowserSessionActivity(userId, enabled); return null; };

beforeEach(() => { vi.useFakeTimers(); invalidateAuthRequests(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); invalidateAuthRequests(); });

it('posts the expected account and checks success and identity errors', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'identity_mismatch', message: 'changed', requestId: 'request-1' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const mismatch = vi.fn();
  await reportBrowserSessionActivity(userId, new AbortController().signal, mismatch);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/auth/session/activity');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ expectedUserId: userId }) });
  await expect(reportBrowserSessionActivity(userId, new AbortController().signal, mismatch)).rejects.toThrow();
  expect(mismatch).toHaveBeenCalledOnce();
});

it('reports only for a visible enabled view and postpones while ordinary reads occur', async () => {
  const fetcher = vi.fn().mockImplementation((url: string) => Promise.resolve(url === '/api/v1/auth/session/activity' ? response() : new Response('{}', { status: 200, headers: { 'Daynight-User-ID': userId } })));
  vi.stubGlobal('fetch', fetcher);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const element = (enabled: boolean) => <TaskCacheProvider scope={scope}><View enabled={enabled} /></TaskCacheProvider>;
  const rendered = render(element(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(4 * minute); await request('/api/v1/projects', new AbortController().signal); await vi.advanceTimersByTimeAsync(4 * minute); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(minute); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rendered.rerender(element(false));
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * minute); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  scope.dispose();
});

it('does not report while a normal read is in flight, then resumes after it completes', async () => {
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn().mockImplementation((url: string) => url === '/api/v1/projects' ? pending.promise : Promise.resolve(response()));
  vi.stubGlobal('fetch', fetcher);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  render(<TaskCacheProvider scope={scope}><View enabled /></TaskCacheProvider>);
  const read = request('/api/v1/projects', new AbortController().signal);
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * minute); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(new Response('{}', { status: 200, headers: { 'Daynight-User-ID': userId } })); await read; await vi.advanceTimersByTimeAsync(5 * minute); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  scope.dispose();
});

it('retires cancelled and old-identity reads without losing newer in-flight reads', async () => {
  const first = Promise.withResolvers<Response>(), second = Promise.withResolvers<Response>(), third = Promise.withResolvers<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise));
  const owner = new AbortController();
  const cancelled = request('/api/v1/projects', owner.signal).catch(() => {});
  expect(hasActiveAuthenticatedRead()).toBe(true);
  owner.abort();
  expect(hasActiveAuthenticatedRead()).toBe(false);
  first.resolve(response()); await cancelled;
  const old = request('/api/v1/projects', new AbortController().signal);
  invalidateAuthRequests();
  const current = request('/api/v1/projects', new AbortController().signal);
  second.resolve(response()); await old;
  expect(hasActiveAuthenticatedRead()).toBe(true);
  third.resolve(response()); await current;
  expect(hasActiveAuthenticatedRead()).toBe(false);
});

it('cancels a pending report on hide, disconnect, account pause and scope invalidation', async () => {
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn().mockImplementation((_url: string, init: RequestInit) => { signal = init.signal ?? undefined; return new Promise(() => {}); });
  vi.stubGlobal('fetch', fetcher);
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
  const element = (enabled: boolean) => <TaskCacheProvider scope={scope}><View enabled={enabled} /></TaskCacheProvider>;
  const rendered = render(element(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * minute); });
  expect(signal?.aborted).toBe(false);
  act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * minute); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  act(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  rendered.rerender(element(false));
  expect(signal?.aborted).toBe(true);
  rendered.rerender(element(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * minute); });
  const release = pauseAuthRequests();
  expect(signal?.aborted).toBe(true);
  release();
  rendered.rerender(element(false)); rendered.rerender(element(true));
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * minute); });
  scope.principalMismatch();
  expect(signal?.aborted).toBe(true);
  scope.dispose();
});
