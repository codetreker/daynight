import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, useSyncExternalStore, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { subscribeUnauthorized } from '../src/api/client';
import type { DeletedBot } from '../src/api/bots';
import { getBotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { useBotDeletionChecks } from '../src/features/bots/useBotDeletionChecks';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botError, botId, botResponse } from './helpers/bots';

const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => {
  act(() => scopes.splice(0).forEach(scope => scope.dispose()));
  sessionStorage.clear();
});
const deleted = (n: number, state: 'pending' | 'failed' | 'completed' = 'pending', version = '2'): DeletedBot => ({
  id: botId(n), workerId: botId(20), version,
  deletion: { deletionId: botId(90 + n), requestedVersion: '1', workerCleanup: { state, code: state === 'failed' ? 'failed' : null }, serverCleanup: { state: state === 'completed' ? 'completed' : 'pending', code: null } },
});
function fixture(strict = false) {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const coordinator = getBotDeletionCoordinator(scope);
  const wrapper = ({ children }: { children: ReactNode }) => {
    const content = <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>;
    return strict ? <StrictMode>{content}</StrictMode> : content;
  };
  const hook = (enabled: boolean) => {
    const records = useSyncExternalStore(coordinator.subscribe, coordinator.snapshot);
    return useBotDeletionChecks(coordinator, enabled, records);
  };
  return { scope, coordinator, wrapper, hook };
}
function controlledFetch() {
  const requests: { signal: AbortSignal; response: PromiseWithResolvers<Response> }[] = [];
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    const response = Promise.withResolvers<Response>();
    requests.push({ signal: init!.signal as AbortSignal, response });
    return response.promise;
  });
  vi.stubGlobal('fetch', fetcher);
  return { requests, fetcher };
}

it('starts only for newly eligible targets and does not cancel itself when busy changes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const f = fixture(), network = controlledFetch();
  const { unmount } = renderHook(() => f.hook(true), { wrapper: f.wrapper });
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => f.coordinator.observe(deleted(1)));
  await waitFor(() => expect(network.fetcher).toHaveBeenCalledTimes(1));
  expect(f.coordinator.snapshot()[0]!.busy).toBe(true);
  expect(network.requests[0]!.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(15_000));
  expect(network.fetcher).toHaveBeenCalledTimes(1); expect(network.requests[0]!.signal.aborted).toBe(false);
  await act(async () => f.coordinator.observe(deleted(2)));
  await waitFor(() => expect(network.fetcher).toHaveBeenCalledTimes(2));
  await act(async () => {
    network.requests[0]!.response.resolve(botResponse(deleted(1)));
    network.requests[1]!.response.resolve(botResponse(deleted(2)));
  });
  await waitFor(() => expect(f.coordinator.snapshot().every(record => !record.busy)).toBe(true));
  await act(async () => f.coordinator.observe(deleted(1, 'failed', '3')));
  expect(network.fetcher).toHaveBeenCalledTimes(2);
  await act(async () => { f.coordinator.observe(deleted(1, 'completed', '4')); f.coordinator.observe(deleted(2, 'completed', '3')); });
  expect(vi.getTimerCount()).toBe(0);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('allows a manual unavailable check without a timer and cancels it when disabled', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const f = fixture(); f.coordinator.observe(deleted(1));
  vi.stubGlobal('fetch', vi.fn(async () => botError(404, 'not_found')));
  await f.coordinator.check(botId(1), new AbortController().signal);
  expect(f.coordinator.snapshot()[0]!.phase).toBe('unavailable');
  const network = controlledFetch();
  const { result, rerender, unmount } = renderHook(({ enabled }) => f.hook(enabled), { wrapper: f.wrapper, initialProps: { enabled: true } });
  expect(vi.getTimerCount()).toBe(0); expect(network.fetcher).not.toHaveBeenCalled();
  let check!: Promise<void>;
  act(() => { check = result.current.check(botId(1)); });
  await act(async () => {});
  await waitFor(() => expect(network.fetcher).toHaveBeenCalledOnce());
  rerender({ enabled: false });
  expect(network.requests[0]!.signal.aborted).toBe(true);
  expect(f.coordinator.snapshot()[0]).toMatchObject({ phase: 'unavailable', busy: false });
  await act(async () => { network.requests[0]!.response.resolve(botResponse(deleted(1, 'completed', '3'))); await check; });
  expect(f.coordinator.snapshot()[0]!.phase).toBe('unavailable');
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

it('recreates a single owner after Strict Mode, visibility and disabled transitions, and ends it on scope invalidation', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let visible: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
  const f = fixture(true); f.coordinator.observe(deleted(1));
  const network = controlledFetch(), unauthorized = vi.fn(), unsubscribe = subscribeUnauthorized(unauthorized);
  const { rerender, unmount } = renderHook(({ enabled }) => f.hook(enabled), { wrapper: f.wrapper, initialProps: { enabled: true } });
  try {
    await act(async () => {});
    await waitFor(() => expect(network.fetcher).toHaveBeenCalledOnce());
    expect(network.requests[0]!.signal.aborted).toBe(false); expect(vi.getTimerCount()).toBe(1);
    act(() => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    expect(network.requests[0]!.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await act(async () => { network.requests[0]!.response.resolve(botError(401, 'unauthorized')); });
    expect(unauthorized).not.toHaveBeenCalled();
    await act(async () => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(network.fetcher).toHaveBeenCalledTimes(2));
    rerender({ enabled: false }); expect(network.requests[1]!.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await act(async () => network.requests[1]!.response.resolve(botResponse(deleted(1))));
    await act(async () => rerender({ enabled: true })); await waitFor(() => expect(network.fetcher).toHaveBeenCalledTimes(3));
    expect(vi.getTimerCount()).toBe(1);
    act(() => f.scope.invalidateScope());
    expect(network.requests[2]!.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await act(async () => network.requests[2]!.response.resolve(botResponse(deleted(1))));
    expect(f.coordinator.snapshot()).toEqual([]);
    unmount(); expect(vi.getTimerCount()).toBe(0);
  } finally { unsubscribe(); }
});
