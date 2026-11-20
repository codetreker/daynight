import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import type { BotObservation } from '../src/api/bot-observation';
import { useBotObservations, type BotObservationLoader } from '../src/features/bots/useBotObservations';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { botObservation } from './helpers/bot-observation';
import { BOT_USER, botDefinition, botId } from './helpers/bots';

const scopes: TaskCacheScope[] = [];
afterEach(() => { act(() => scopes.splice(0).forEach(scope => scope.dispose())); invalidateAuthRequests(); vi.useRealTimers(); vi.restoreAllMocks(); });
const scope = (userId = BOT_USER) => { const value = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(value); return value; };
const wrapper = ({ children }: { children: ReactNode }) => <TaskCacheProvider scope={scopes[0]!}>{children}</TaskCacheProvider>;
const flush = async () => { await act(async () => {}); };
const clock = () => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

it('shares Bot-specific state independently on one machine, preserving cached facts after a read failure', async () => {
  scope(); const bots = [botDefinition(), botDefinition(2)];
  const load = vi.fn<BotObservationLoader>().mockImplementation(async id => botObservation(id === botId() ? 1 : 2, id === botId() ? { state: 'working', currentTurnId: 'turn' } : {}));
  const { result } = renderHook(() => useBotObservations(bots, true, load), { wrapper });
  await waitFor(() => expect(result.current.get(botId()).value?.state).toBe('working'));
  expect(result.current.get(botId(2)).value?.state).toBe('idle'); expect(result.current.get(botId(2)).stale).toBe(false);
  load.mockRejectedValueOnce(Error('disconnected')); act(() => result.current.get(botId()).refresh());
  await waitFor(() => expect(result.current.get(botId()).error).toBeInstanceOf(Error));
  expect(result.current.get(botId()).value?.machine?.name).toBe('Office laptop'); expect(result.current.get(botId()).stale).toBe(true);
  expect(result.current.get(botId(2)).stale).toBe(false);
});
it('expires exact server-relative freshness during a pending read and ignores a response received after its budget', async () => {
  scope(); clock(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  let resolve!: (value: BotObservation) => void;
  const load = vi.fn<BotObservationLoader>().mockResolvedValueOnce(botObservation(1, { freshUntil: '2026-11-04T12:00:01Z' })).mockImplementation(() => new Promise(done => { resolve = done; }));
  const { result } = renderHook(() => useBotObservations([botDefinition()], true, load), { wrapper }); await flush();
  expect(result.current.get(botId()).stale).toBe(false);
  await act(async () => { vi.advanceTimersByTime(999); }); expect(result.current.get(botId()).stale).toBe(false);
  await act(async () => { vi.advanceTimersByTime(1); }); expect(result.current.get(botId()).stale).toBe(true); expect(load).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(31_000); resolve(botObservation()); });
  expect(result.current.get(botId()).stale).toBe(true); expect(result.current.get(botId()).value?.machine?.name).toBe('Office laptop');
});
it('preserves an explicit offline observation only within its read window', async () => {
  scope(); clock(); const load = vi.fn<BotObservationLoader>().mockResolvedValueOnce(botObservation(1, { state: 'offline', freshUntil: null })).mockImplementation(() => new Promise(() => {}));
  const { result, unmount } = renderHook(() => useBotObservations([botDefinition()], true, load), { wrapper }); await flush();
  expect(result.current.get(botId()).stale).toBe(false); expect(result.current.get(botId()).value?.state).toBe('offline');
  await act(async () => { vi.advanceTimersByTime(5_000); }); expect(result.current.get(botId()).stale).toBe(true);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('does not extend one sample on repeated responses or browser clock rollback', async () => {
  scope(); clock(); const value = botObservation(1, { freshUntil: '2026-11-04T12:00:01Z' });
  const load = vi.fn<BotObservationLoader>().mockResolvedValue(value);
  const { result } = renderHook(() => useBotObservations([botDefinition()], true, load), { wrapper }); await flush();
  await act(async () => { vi.advanceTimersByTime(700); }); act(() => result.current.refresh()); await flush();
  vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(result.current.get(botId()).stale).toBe(true); expect(result.current.get(botId()).value).toEqual(value);
});
it('keeps facts visible while reads are disabled or authentication is paused, then refreshes immediately on resume', async () => {
  scope(); const load = vi.fn<BotObservationLoader>().mockResolvedValue(botObservation());
  const { result, rerender } = renderHook(({ enabled }) => useBotObservations([botDefinition()], enabled, load), { initialProps: { enabled: true }, wrapper });
  await waitFor(() => expect(result.current.get(botId()).stale).toBe(false));
  rerender({ enabled: false }); expect(result.current.get(botId()).stale).toBe(true); expect(result.current.get(botId()).value).not.toBeNull();
  rerender({ enabled: true }); await waitFor(() => expect(result.current.get(botId()).stale).toBe(false));
  let resume!: () => void; act(() => { resume = pauseAuthRequests(); });
  expect(result.current.get(botId()).stale).toBe(true); expect(result.current.get(botId()).value).not.toBeNull();
  const count = load.mock.calls.length; await act(async () => resume());
  await waitFor(() => expect(load.mock.calls.length).toBe(count + 1)); expect(result.current.get(botId()).stale).toBe(false);
});
it('rejects older versions, generations and nanosecond observation times without replacing current facts', async () => {
  scope(); const latest = botObservation(1, { botVersion: '9007199254740993', hostingGeneration: '2', observedAt: '2026-11-04T12:00:00.000000002Z' });
  const load = vi.fn<BotObservationLoader>().mockResolvedValue(latest);
  const { result } = renderHook(() => useBotObservations([botDefinition()], true, load), { wrapper }); await waitFor(() => expect(result.current.get(botId()).value).toEqual(latest));
  for (const patch of [{ botVersion: '9007199254740992' }, { hostingGeneration: '1' }, { observedAt: '2026-11-04T12:00:00.000000001Z' }]) {
    load.mockResolvedValueOnce({ ...latest, ...patch }); act(() => result.current.refresh());
    await waitFor(() => expect(result.current.get(botId()).busy).toBe(false));
    expect(result.current.get(botId()).value).toEqual(latest); expect(result.current.get(botId()).error).toBeInstanceOf(ApiError);
  }
});
it('rejects generation rollback even at a higher Bot version but accepts confirmed missing Session evidence', async () => {
  scope(); const latest = botObservation(1, { hostingGeneration: '2', executionGeneration: '4', connectionEpoch: '8' });
  const load = vi.fn<BotObservationLoader>().mockResolvedValue(latest);
  const { result } = renderHook(() => useBotObservations([botDefinition()], true, load), { wrapper }); await waitFor(() => expect(result.current.get(botId()).value).toEqual(latest));
  for (const patch of [{ botVersion: '2', hostingGeneration: '1' }, { executionGeneration: '3' }, { connectionEpoch: '7' }]) {
    load.mockResolvedValueOnce({ ...latest, ...patch }); act(() => result.current.refresh()); await waitFor(() => expect(result.current.get(botId()).busy).toBe(false));
    expect(result.current.get(botId()).value).toEqual(latest); expect(result.current.get(botId()).stale).toBe(true);
  }
  const missing = { ...latest, state: 'abnormal' as const, reason: 'session_missing', executionGeneration: null, connectionEpoch: null, nativeSessionId: null };
  load.mockResolvedValueOnce(missing); act(() => result.current.refresh()); await waitFor(() => expect(result.current.get(botId()).value).toEqual(missing));
});
it('does not publish late responses after Bot removal, account replacement, or scope invalidation', async () => {
  let currentScope = scope(); const original = currentScope;
  const pending: { signal: AbortSignal; resolve: (value: BotObservation) => void }[] = [];
  const load: BotObservationLoader = (_id, _scope, signal) => new Promise(resolve => pending.push({ signal, resolve }));
  const { result, rerender } = renderHook(({ bots }) => useBotObservations(bots, true, load), { initialProps: { bots: [botDefinition()] }, wrapper: ({ children }) => <TaskCacheProvider scope={currentScope}>{children}</TaskCacheProvider> });
  await flush(); rerender({ bots: [] }); await act(async () => pending[0]!.resolve(botObservation()));
  expect(pending[0]!.signal.aborted).toBe(true); expect(result.current.get(botId()).value).toBeNull();
  rerender({ bots: [botDefinition()] }); await flush(); currentScope = scope(botId(99)); rerender({ bots: [botDefinition()] }); await flush();
  await act(async () => pending[1]!.resolve(botObservation())); expect(result.current.get(botId()).value).toBeNull();
  act(() => currentScope.dispose()); await act(async () => pending[2]!.resolve(botObservation())); expect(result.current.get(botId()).value).toBeNull();
  expect(original).not.toBe(currentScope);
});
it('limits observation reads to four and cancels work during hidden or paused authentication', async () => {
  scope(); clock(); let visible: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
  const pending: { id: string; signal: AbortSignal; resolve: (value: BotObservation) => void }[] = [];
  const load = vi.fn<BotObservationLoader>().mockImplementation((id, _scope, signal) => new Promise(resolve => pending.push({ id, signal, resolve })));
  const { result, unmount } = renderHook(() => useBotObservations(Array.from({ length: 6 }, (_, n) => botDefinition(n + 1)), true, load), { wrapper }); await flush();
  expect(load).toHaveBeenCalledTimes(4);
  await act(async () => pending[0]!.resolve(botObservation())); expect(load).toHaveBeenCalledTimes(5);
  act(() => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }); expect(pending.slice(1).every(item => item.signal.aborted)).toBe(true);
  await act(async () => { vi.advanceTimersByTime(40_000); }); expect(load).toHaveBeenCalledTimes(5); expect(result.current.get(botId()).stale).toBe(true);
  act(() => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }); await flush(); expect(load).toHaveBeenCalledTimes(9);
  let resume!: () => void; act(() => { resume = pauseAuthRequests(); }); expect(pending.slice(5).every(item => item.signal.aborted)).toBe(true);
  await act(async () => { vi.advanceTimersByTime(5_000); }); expect(load).toHaveBeenCalledTimes(9);
  act(() => resume()); await act(async () => { vi.advanceTimersByTime(5_000); }); expect(load).toHaveBeenCalledTimes(13);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});
it('withdraws old definition facts immediately and clears content on confirmed access refusal', async () => {
  scope(); const load = vi.fn<BotObservationLoader>().mockResolvedValue(botObservation());
  const { result, rerender } = renderHook(({ version, enabled }) => useBotObservations([{ ...botDefinition(), version }], enabled, load), { initialProps: { version: '1', enabled: true }, wrapper });
  await waitFor(() => expect(result.current.get(botId()).stale).toBe(false));
  rerender({ version: '2', enabled: false }); expect(result.current.get(botId()).stale).toBe(true);
  load.mockRejectedValue(new ApiError('server', 403)); rerender({ version: '2', enabled: true });
  await waitFor(() => expect(result.current.get(botId()).error).toBeInstanceOf(ApiError)); expect(result.current.get(botId()).value).toBeNull();
});
it('supports StrictMode effect replay without admitting cancelled reads', async () => {
  scope(); const load = vi.fn<BotObservationLoader>().mockResolvedValue(botObservation());
  const { result } = renderHook(() => useBotObservations([botDefinition()], true, load), { wrapper: ({ children }) => <StrictMode>{wrapper({ children })}</StrictMode> });
  await waitFor(() => expect(result.current.get(botId()).stale).toBe(false)); expect(result.current.get(botId()).value?.botId).toBe(botId());
});
