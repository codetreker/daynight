import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests } from '../src/api/client';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorkerConfiguration } from '../src/features/workers/configuration/useWorkerConfiguration';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_USER, workerId } from './helpers/workers';

const scopes: TaskCacheScope[] = [];
const makeScope = (userId = WORKER_USER, onIdentityMismatch = vi.fn()) => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch }); scopes.push(scope); return scope;
};
const wrapper = (scope: TaskCacheScope) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); });
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
};
const advance = async () => { await act(async () => { vi.advanceTimersByTime(5_000); for (let n = 0; n < 40; n++) await Promise.resolve(); }); };
beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); });
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); invalidateAuthRequests(); vi.useRealTimers(); });

describe('Worker configuration editing lifetime', () => {
  it('keeps invalid raw edits while polling independently of task snapshots', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource()))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 8 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.draft?.maxConcurrent).toBe('2');
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '-', native: { ...draft.native, args: '[invalid' } })));
    await advance();
    expect(result.current.resource?.desired?.revision).toBe('2'); expect(result.current.draft?.maxConcurrent).toBe('-'); expect(result.current.draft?.native.args).toBe('[invalid');
    expect(result.current.baselineRevision).toBe('1'); expect(result.current.conflict).toBe(true); expect(result.current.dirty).toBe(true);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/configuration'))).toBe(true); expect(indexedDB.open).not.toHaveBeenCalled();
    act(() => result.current.loadLatest()); expect(result.current.draft?.maxConcurrent).toBe('8'); expect(result.current.dirty).toBe(false); expect(result.current.conflict).toBe(false);
  });
  it('accepts a successful submitted snapshot without erasing edits made during the PUT', async () => {
    const put = deferred<Response>(), initial = configurationValue();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush(); expect(result.current.pending).toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '5' })));
    put.resolve(configurationResponse(configurationResource('2', { ...initial, maxConcurrent: 3 }))); await act(async () => { await saving; });
    expect(result.current.notice).toBe('saved'); expect(result.current.baselineRevision).toBe('2'); expect(result.current.draft?.maxConcurrent).toBe('5'); expect(result.current.dirty).toBe(true);
    expect(result.current.resource?.desired?.value.maxConcurrent).toBe(3);
  });
  it('does not let a GET dispatched before PUT completion roll the saved target backward', async () => {
    const read = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => read.promise)
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => { result.current.refresh(); result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })); }); await flush();
    await act(async () => result.current.save()); expect(result.current.resource?.desired?.revision).toBe('2');
    read.resolve(configurationResponse(configurationResource())); await flush();
    expect(result.current.resource?.desired?.revision).toBe('2'); expect(result.current.baselineRevision).toBe('2'); expect(result.current.dirty).toBe(false);
  });
  it('does not label our polled target as a foreign edit while its PUT response is pending', async () => {
    const put = deferred<Response>(), saved = configurationResource('2', { ...configurationValue(), maxConcurrent: 3 });
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise)
      .mockResolvedValueOnce(configurationResponse(saved));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush(); await advance();
    expect(result.current.resource?.desired?.revision).toBe('2'); expect(result.current.baselineRevision).toBe('1'); expect(result.current.pending).toBe(true); expect(result.current.conflict).toBe(false);
    put.resolve(configurationResponse(saved)); await act(async () => saving);
    expect(result.current.notice).toBe('saved'); expect(result.current.conflict).toBe(false); expect(result.current.dirty).toBe(false);
  });
  it('retains the draft on CAS conflict and requires explicit loading before another save', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockResolvedValueOnce(configurationError(409, 'version_conflict'))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 7 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    await act(async () => result.current.save());
    expect(result.current.notice).toBe('conflict'); expect(result.current.conflict).toBe(true); expect(result.current.draft?.maxConcurrent).toBe('3'); expect(result.current.resource?.desired?.value.maxConcurrent).toBe(7);
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => result.current.loadLatest()); expect(result.current.draft?.maxConcurrent).toBe('7'); expect(result.current.baselineRevision).toBe('2');
  });
  it('reconciles an unknown PUT through GET and never replays it', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    await act(async () => result.current.save());
    expect(result.current.notice).toBe('reconciled'); expect(result.current.uncertain).toBe(false); expect(result.current.dirty).toBe(false); expect(result.current.baselineRevision).toBe('2');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('blocks another PUT while uncertain reconciliation fails, retaining all input', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockResolvedValueOnce(configurationError(500, 'internal_error')).mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(configurationResponse(configurationResource()));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    await act(async () => result.current.save()); expect(result.current.uncertain).toBe(true); expect(result.current.draft?.maxConcurrent).toBe('3');
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => result.current.refresh()); await flush(); expect(result.current.notice).toBe('notSaved'); expect(result.current.uncertain).toBe(false); expect(result.current.dirty).toBe(true);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('keeps explicit write failures and raw input until a deliberate correction', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockResolvedValueOnce(configurationError(400, 'invalid_input'))
      .mockResolvedValueOnce(configurationResponse(configurationResource()));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    await act(async () => result.current.save()); expect(result.current.error).toMatchObject({ status: 400 }); expect(result.current.draft?.maxConcurrent).toBe('3');
    await advance(); expect(result.current.error).toMatchObject({ status: 400 }); expect(result.current.draft?.maxConcurrent).toBe('3');
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '4' }))); expect(result.current.error).toBeNull();
    act(() => result.current.discard()); expect(result.current.error).toBeNull(); expect(result.current.dirty).toBe(false);
  });
  it('suspends hidden reads, fences their late responses and resumes without replacing edits', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const hiddenRead = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource()))
      .mockImplementationOnce(() => hiddenRead.promise).mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 8 })));
    vi.stubGlobal('fetch', fetch);
    const { result, unmount } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); await advance(); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush();
    act(() => { result.current.setDraft(draft => ({ ...draft, native: { ...draft.native, args: '[invalid' } })); result.current.refresh(); }); await flush();
    visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange'))); expect(vi.getTimerCount()).toBe(0);
    hiddenRead.resolve(configurationResponse(configurationResource('9', { ...configurationValue(), maxConcurrent: 99 }))); await flush();
    expect(result.current.resource?.desired?.revision).toBe('1'); expect(result.current.draft?.native.args).toBe('[invalid');
    visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush();
    expect(result.current.resource?.desired?.revision).toBe('2'); expect(result.current.draft?.native.args).toBe('[invalid');
    unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('distinguishes an unavailable Worker, an uninitialized target and a recovered read', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationError(404, 'not_found'))
      .mockResolvedValueOnce(configurationResponse({ desired: null, observationRevision: '0', observation: null }))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(configurationResponse(configurationResource()));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.unavailable).toBe(true); expect(result.current.draft).toBeNull();
    act(() => result.current.refresh()); await flush(); expect(result.current.unavailable).toBe(false); expect(result.current.resource?.desired).toBeNull(); expect(result.current.loading).toBe(false);
    await advance(); expect(result.current.errorSource).toBe('read');
    act(() => result.current.refresh()); await flush(); expect(result.current.error).toBeNull(); expect(result.current.errorSource).toBeNull(); expect(result.current.draft?.maxConcurrent).toBe('2');
  });
  it('rejects invalid raw drafts and does not issue requests while reading is disabled', async () => {
    const fetch = vi.fn().mockResolvedValue(configurationResponse(configurationResource())); vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled }), { initialProps: { enabled: false }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.refresh()); await act(async () => result.current.save()); expect(fetch).not.toHaveBeenCalled();
    rerender({ enabled: true }); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '-' }))); await act(async () => result.current.save());
    expect(fetch).toHaveBeenCalledOnce(); expect(result.current.draft?.maxConcurrent).toBe('-'); expect(result.current.dirty).toBe(true);
  });
  it('reconciles a dispatched write after reads are paused and resumed', async () => {
    const put = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise)
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    rerender({ enabled: false }); expect(result.current.uncertain).toBe(true); expect(result.current.pending).toBe(false);
    rerender({ enabled: true }); await flush(); expect(result.current.notice).toBe('reconciled'); expect(result.current.uncertain).toBe(false);
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await act(async () => saving);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('clears private target/draft and rejects an old-account completion', async () => {
    const put = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch); const scope = makeScope();
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => scope.principalMismatch()); expect(result.current.resource).toBeNull(); expect(result.current.draft).toBeNull();
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await act(async () => saving);
    expect(result.current.resource).toBeNull(); expect(result.current.draft).toBeNull(); await advance(); expect(fetch).toHaveBeenCalledTimes(2);
  });
});
