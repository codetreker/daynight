import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { TaskCacheLifecycleChanged } from '../src/features/task-cache/project-cache';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorkerConfiguration } from '../src/features/workers/configuration/useWorkerConfiguration';
import { configurationError, configurationResource, configurationResponse, configurationValue, controlModeResponse } from './helpers/worker-configuration';
import { WORKER_USER, workerId } from './helpers/workers';

const scopes: TaskCacheScope[] = [];
const makeScope = (userId = WORKER_USER, onIdentityMismatch = vi.fn()) => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => { onIdentityMismatch(); void scope.invalidateScope(); } }); scopes.push(scope); return scope;
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
  it('protects an edit back to the original baseline while the submitted snapshot is pending', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '2' })));
    expect(result.current.pending).toBe(true); expect(result.current.dirty).toBe(true);
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    await act(async () => saving);
    expect(result.current.draft?.maxConcurrent).toBe('2'); expect(result.current.dirty).toBe(true);
    expect(result.current.baselineRevision).toBe('2');
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
  it('abandons to the highest observed configuration while retaining the write and later edits', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise)
      .mockResolvedValueOnce(configurationResponse(configurationResource('3', { ...configurationValue(), maxConcurrent: 8 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush(); await advance();
    act(() => result.current.abandon());
    expect(result.current.pending).toBe(true); expect(result.current.dirty).toBe(false);
    expect(result.current.draft?.maxConcurrent).toBe('8'); expect(result.current.baselineRevision).toBe('3');
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '9' })));
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    await act(async () => saving);
    expect(result.current.draft?.maxConcurrent).toBe('9'); expect(result.current.dirty).toBe(true);
    expect(result.current.resource?.desired?.revision).toBe('3'); expect(result.current.conflict).toBe(true);
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
  it('protects an edit back to the original baseline while the save outcome is unknown', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockRejectedValueOnce(new Error('connection lost'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    await act(async () => result.current.save()); expect(result.current.uncertain).toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '2' })));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.refresh()); await flush();
    expect(result.current.uncertain).toBe(false); expect(result.current.draft?.maxConcurrent).toBe('2');
    expect(result.current.dirty).toBe(true);
  });
  it('keeps protecting an edited baseline after an unknown save reconciles to a different target', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockRejectedValueOnce(new Error('connection lost'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 4 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    await act(async () => result.current.save()); expect(result.current.uncertain).toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '2' })));
    act(() => result.current.refresh()); await flush();
    expect(result.current.uncertain).toBe(false); expect(result.current.conflict).toBe(true);
    expect(result.current.draft?.maxConcurrent).toBe('2'); expect(result.current.dirty).toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '4' })));
    expect(result.current.dirty).toBe(false); expect(result.current.conflict).toBe(false);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '2' })));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.discard()); expect(result.current.draft?.maxConcurrent).toBe('4'); expect(result.current.dirty).toBe(false);
  });
  it('keeps the edited baseline protected through a conflict response and its fresh read', async () => {
    const put = deferred<Response>(), fresh = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise).mockImplementationOnce(() => fresh.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '2' })));
    put.resolve(configurationError(409, 'version_conflict')); await flush();
    expect(result.current.dirty).toBe(true);
    fresh.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 4 })));
    await act(async () => saving);
    expect(result.current.conflict).toBe(true); expect(result.current.dirty).toBe(true);
    act(() => result.current.discard()); expect(result.current.draft?.maxConcurrent).toBe('4'); expect(result.current.dirty).toBe(false);
  });
  it('does not make a clean draft dirty when a background read observes another version', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource()))
      .mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 4 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.refresh()); await flush();
    expect(result.current.conflict).toBe(true); expect(result.current.dirty).toBe(false);
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
  it('keeps the dispatched PUT pending across paused reads and publishes its snapshot only after admission', async () => {
    const put = deferred<Response>(), read = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise).mockImplementationOnce(() => read.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    const resumeAuth = pauseAuthRequests(); rerender({ enabled: false });
    expect(result.current.pending).toBe(true); expect(result.current.uncertain).toBe(false);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '4' })));
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await flush();
    expect(result.current.pending).toBe(true); expect(result.current.baselineRevision).toBe('1');
    rerender({ enabled: true }); await flush(); expect(result.current.pending).toBe(true);
    resumeAuth(); await act(async () => saving);
    expect(result.current.notice).toBe('saved'); expect(result.current.baselineRevision).toBe('2'); expect(result.current.draft?.maxConcurrent).toBe('4');
    read.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await flush();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('cancels a not-yet-dispatched save when its draft is abandoned during admission', async () => {
    const fetch = vi.fn().mockResolvedValue(configurationResponse(configurationResource()));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    const resume = pauseAuthRequests();
    let saving!: Promise<void>;
    try {
      act(() => { saving = result.current.save(); }); await flush();
      expect(result.current.pending).toBe(true);
      act(() => result.current.abandon());
      expect(result.current.pending).toBe(false); expect(result.current.dirty).toBe(false);
      expect(result.current.draft?.maxConcurrent).toBe('2');
    } finally { resume(); }
    await act(async () => saving);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(0);
  });
  it.each([{ status: 409, code: 'version_conflict' }, { status: 400, code: 'invalid_input' }])('publishes the known $status PUT failure only after admission resumes', async ({ status, code }) => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise).mockImplementation(() => configurationResponse(configurationResource()));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    rerender({ enabled: false }); put.resolve(configurationError(status, code)); await flush();
    expect(result.current.pending).toBe(true); expect(result.current.error).toBeNull();
    rerender({ enabled: true }); await act(async () => saving);
    expect(result.current.pending).toBe(false); expect(result.current.error).toMatchObject({ status, code });
    expect(result.current.uncertain).toBe(false); expect(result.current.draft?.maxConcurrent).toBe('3');
    expect(result.current.notice).toBe(status === 409 ? 'conflict' : null);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('fences a cancelled explicit refresh and keeps the draft through the resumed background read', async () => {
    const old = deferred<Response>(), resumed = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => resumed.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => { result.current.setDraft(draft => ({ ...draft, maxConcurrent: '-' })); result.current.refresh(); }); await flush();
    expect(result.current.refreshing).toBe(true); rerender({ enabled: false }); expect(result.current.refreshing).toBe(false);
    old.resolve(configurationResponse(configurationResource('9', { ...configurationValue(), maxConcurrent: 9 }))); await flush(); expect(result.current.resource?.desired?.revision).toBe('1');
    rerender({ enabled: true }); await flush(); expect(result.current.refreshing).toBe(false); expect(result.current.draft?.maxConcurrent).toBe('-');
    resumed.resolve(configurationResponse(configurationResource())); await flush(); expect(result.current.resource?.desired?.revision).toBe('1'); expect(result.current.draft?.maxConcurrent).toBe('-');
  });
  it('clears the previous Worker draft and fences its late PUT when the Worker changes', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise)
      .mockResolvedValueOnce(configurationResponse(configurationResource('1', { ...configurationValue(), maxConcurrent: 8 })));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ id }) => useWorkerConfiguration(id, { readEnabled: true }), { initialProps: { id: workerId(1) }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    rerender({ id: workerId(2) }); await flush(); expect(result.current.draft?.maxConcurrent).toBe('8');
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await act(async () => saving);
    expect(result.current.draft?.maxConcurrent).toBe('8'); expect(result.current.baselineRevision).toBe('1');
  });
  it('retains a successful PUT when identity pauses during the readiness check', async () => {
    const put = deferred<Response>(), scope = makeScope();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch);
    const ready = scope.ready.bind(scope); let resumeAuth!: () => void;
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(scope) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    vi.spyOn(scope, 'ready').mockImplementationOnce(async () => { resumeAuth = pauseAuthRequests(); throw new TaskCacheLifecycleChanged(); }).mockImplementation(ready);
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await flush();
    expect(result.current.pending).toBe(true); expect(result.current.uncertain).toBe(false);
    resumeAuth(); await act(async () => saving);
    expect(result.current.notice).toBe('saved'); expect(result.current.uncertain).toBe(false); expect(result.current.baselineRevision).toBe('2');
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it('defers an unknown PUT result across paused admission without replaying it', async () => {
    const put = deferred<Response>(), verify = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise).mockImplementation(() => verify.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled }), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    rerender({ enabled: false }); put.reject(new Error('offline')); await flush();
    expect(result.current.pending).toBe(true); expect(result.current.uncertain).toBe(false);
    rerender({ enabled: true }); await flush(); expect(result.current.uncertain).toBe(true); expect(result.current.pending).toBe(false);
    verify.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await act(async () => saving); await flush();
    expect(result.current.notice).toBe('reconciled'); expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
  it.each([
    { name: 'missing principal', response: () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'missing', requestId: 'request' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }) },
    { name: 'malformed body', response: () => new Response('{', { status: 404, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER } }) },
  ])('retains the draft and PUT for an untrusted 404 with $name', async ({ response }) => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise).mockImplementationOnce(response);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => result.current.refresh()); await flush();
    expect(result.current.error).toMatchObject({ kind: 'protocol', status: 404 }); expect(result.current.unavailable).toBe(false);
    expect(result.current.pending).toBe(true); expect(result.current.draft?.maxConcurrent).toBe('3');
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await act(async () => saving);
    expect(result.current.notice).toBe('saved'); expect(result.current.baselineRevision).toBe('2');
  });
  it('clears a missing Worker and fences a late PUT completion', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockImplementationOnce(() => put.promise).mockResolvedValueOnce(configurationError(404, 'not_found'));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '3' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    act(() => result.current.refresh()); await flush();
    expect(result.current.unavailable).toBe(true); expect(result.current.draft).toBeNull(); expect(result.current.resource).toBeNull();
    put.resolve(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 3 }))); await act(async () => saving);
    expect(result.current.unavailable).toBe(true); expect(result.current.draft).toBeNull(); expect(result.current.resource).toBeNull();
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


describe('control mode capability continuity', () => {
  it('adopts a newly negotiated field without replacing an existing draft of other settings', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource()))
      .mockResolvedValueOnce(controlModeResponse(configurationResource('1', { ...configurationValue(), agentControlMode: null })))
      .mockResolvedValueOnce(controlModeResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 7, agentControlMode: null })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' })));
    await advance(); expect(result.current.draft?.maxConcurrent).toBe('7'); expect(result.current.draft?.agentControlMode).toBeNull();
    expect(result.current.dirty).toBe(true); expect(result.current.conflict).toBe(false);
    await act(async () => result.current.save());
    expect(result.current.notice).toBe('saved'); expect(result.current.dirty).toBe(false);
    expect(JSON.parse(fetch.mock.calls[2]![1].body).value).toMatchObject({ maxConcurrent: 7, agentControlMode: null });
  });
  it('reconciles an unknown mode save with capability intact and preserves a later edit', async () => {
    const initial = { ...configurationValue(), agentControlMode: 'herdr' as const }, read = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(controlModeResponse(configurationResource('1', initial))).mockRejectedValueOnce(new TypeError('connection lost')).mockImplementationOnce(() => read.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper(makeScope()) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, agentControlMode: 'web' })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush(); expect(result.current.uncertain).toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, agentControlMode: 'herdr' })));
    read.resolve(controlModeResponse(configurationResource('2', { ...initial, agentControlMode: 'web' }))); await act(async () => saving);
    expect(result.current.uncertain).toBe(false); expect(result.current.notice).toBe('reconciled'); expect(result.current.dirty).toBe(true);
    expect(result.current.resource?.controlModeSupported).toBe(true); expect(result.current.draft?.agentControlMode).toBe('herdr');
    expect(result.current.resource?.desired?.value.agentControlMode).toBe('web'); expect(fetch).toHaveBeenCalledTimes(3);
  });
});
