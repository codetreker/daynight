import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsupportedSessionObservation } from '../../daynight/src/api/task-observation';
import * as api from '../src/api/personal-tasks';
import { ApiError } from '../src/api/client';
import { useMyTasks } from '../src/features/my-tasks/useMyTasks';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { TaskCacheError } from '../src/features/task-cache/database';
import type { CacheEvent } from '../src/features/task-cache/project-cache';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const scopes: TaskCacheScope[] = [];
const scopeFor = (userId = WORKER_USER) => { const scope = createTaskCacheScope({ userId, onIdentityMismatch: () => { void scope.invalidateScope(); } }); vi.spyOn(scope, 'prepareProjection').mockResolvedValue(new Map()); scopes.push(scope); return scope; };
const wrapper = (scope: TaskCacheScope) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const row = (number: number, project = 3, count = 1): api.PersonalTaskPage['items'][number] => ({ project: { id: workerId(project), name: `Project ${project}`, ownerTeam: { id: workerId(9), kind: 'personal', name: null }, executionWarningMinutes: 120, matchedTaskCount: count }, task: { id: workerId(number), version: '1', title: `Task ${number}`, status: 'in_progress', startedAt: null, allowAgents: true, paused: false, worker: null, goal: null }, session: unsupportedSessionObservation() });
const page = (items: api.PersonalTaskPage['items'], nextCursor: string | null = null, totalTaskCount = items.length, totalProjectCount = new Set(items.map(item => item.project.id)).size): api.PersonalTaskPage => ({ observedAt: WORKER_TIME, inventoryRevision: 'a'.repeat(64), totalTaskCount, totalProjectCount, sessionPartial: true, items, nextCursor });
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); vi.restoreAllMocks(); });
describe('personal task inventory', () => {
  it('shows initial pages as incomplete and publishes consistent totals at completion', async () => {
    const later = deferred<api.PersonalTaskPage>();
    const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10, 3, 2)], 'next', 2, 1)).mockImplementationOnce(() => later.promise);
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(10)]); expect(result.current.loaded).toBe(false); expect(result.current.totalTaskCount).toBeNull();
    later.resolve(page([row(11, 3, 2)], null, 2, 1)); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(10), workerId(11)]); expect(result.current.totalTaskCount).toBe(2); expect(result.current.loaded).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it.each(['revision', 'total', 'duplicate', 'cursor', 'project', 'group count'] as const)('rejects inconsistent %s without claiming completeness', async variant => {
    const first = page([row(10, 3, 2)], 'next', 2, 1);
    const second = page([row(11, 3, 2)], null, 2, 1);
    const invalid = variant === 'revision' ? { ...second, inventoryRevision: 'b'.repeat(64) } : variant === 'total' ? { ...second, totalTaskCount: 3 } : variant === 'duplicate' ? { ...second, items: [row(10, 3, 2)] } : variant === 'cursor' ? { ...second, nextCursor: 'next' } : variant === 'project' ? { ...second, items: [{ ...row(11, 3, 2), project: { ...row(11, 3, 2).project, name: 'Changed' } }] } : { ...second, items: [] };
    vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(first).mockResolvedValueOnce(invalid);
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush();
    expect(result.current.loaded).toBe(false); expect(result.current.totalTaskCount).toBeNull(); expect(result.current.error).toMatchObject({ kind: 'protocol' });
  });
  it('retains the last complete set on refresh conflict and exposes stale state', async () => {
    const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10)]));
    load.mockRejectedValueOnce(new ApiError('server', 409));
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush();
    act(() => result.current.refresh()); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(10)]); expect(result.current.loaded).toBe(true); expect(result.current.stale).toBe(true); expect(load).toHaveBeenCalledTimes(2);
  });
  it('withdraws matching projects, fences late pages and requires a fresh read on restoration', async () => {
    const scope = scopeFor(), pending = deferred<api.PersonalTaskPage>(), fresh = deferred<api.PersonalTaskPage>();
    let publish!: (event: CacheEvent) => void;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10), row(11, 4)])).mockImplementationOnce(() => pending.promise).mockImplementationOnce(() => fresh.promise);
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scope) }); await flush();
    act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: workerId(3), scopeSuspended: true })); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(11)]); expect(result.current.totalTaskCount).toBeNull();
    pending.resolve(page([row(10), row(11, 4)])); await flush(); expect(result.current.items.map(x => x.task.id)).toEqual([workerId(11)]);
    fresh.resolve(page([row(11, 4)])); await flush(); expect(result.current.items.map(x => x.task.id)).toEqual([workerId(11)]); expect(load).toHaveBeenCalledTimes(3);
  });
  it('filters denied rows and retains cleanup failure as an error', async () => {
    const scope = scopeFor(); const failure = new TaskCacheError('storage');
    vi.spyOn(scope, 'projectionSnapshotDenied').mockImplementation((_fence, id) => id === workerId(3));
    vi.spyOn(scope, 'projectionSnapshotHasDenials').mockReturnValue(true);
    vi.spyOn(scope, 'projectionSnapshotError').mockReturnValue(failure);
    vi.spyOn(api, 'listPersonalTasks').mockResolvedValue(page([row(10), row(11, 4)]));
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scope) }); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(11)]); expect(result.current.loaded).toBe(false); expect(result.current.totalTaskCount).toBeNull(); expect(result.current.error).toBe(failure);
  });
  it('coalesces a manual refresh while a read is in flight', async () => {
    const pending = deferred<api.PersonalTaskPage>();
    const load = vi.spyOn(api, 'listPersonalTasks').mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(page([row(11)]));
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush();
    act(() => { result.current.refresh(); result.current.refresh(); }); await flush(); expect(load).toHaveBeenCalledTimes(1);
    pending.resolve(page([row(10)])); await flush(); expect(load).toHaveBeenCalledTimes(2); expect(result.current.items.map(x => x.task.id)).toEqual([workerId(11)]);
  });
});

describe('personal task failure and lifetime', () => {
  it('retains the initial partial page after a subsequent read fails', async () => {
    vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10, 3, 2)], 'next', 2, 1)).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(10)]); expect(result.current.loading).toBe(false); expect(result.current.loaded).toBe(false); expect(result.current.error).toEqual(new Error('offline'));
  });
  it('clears previously published rows if projection preparation fails', async () => {
    const scope = scopeFor(), failure = new TaskCacheError('storage');
    vi.spyOn(api, 'listPersonalTasks').mockResolvedValue(page([row(10)]));
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scope) }); await flush(); expect(result.current.loaded).toBe(true);
    vi.mocked(scope.prepareProjection).mockRejectedValueOnce(failure); act(() => result.current.refresh()); await flush();
    expect(result.current.items).toEqual([]); expect(result.current.totalTaskCount).toBeNull(); expect(result.current.error).toBe(failure);
  });
  it('discards late results after invalidation and unmount', async () => {
    const scope = scopeFor(), pending = deferred<api.PersonalTaskPage>();
    vi.spyOn(api, 'listPersonalTasks').mockImplementationOnce(() => pending.promise);
    const { result, unmount } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scope) }); await flush();
    act(() => scope.principalMismatch()); await flush(); pending.resolve(page([row(10)])); await flush();
    expect(result.current.items).toEqual([]); expect(result.current.totalTaskCount).toBeNull(); unmount();
  });
});

describe('personal task refresh scheduling', () => {
  it('keeps refresh failure visible until a successful replacement is available', async () => {
    const later = deferred<api.PersonalTaskPage>();
    const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10)])).mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => later.promise);
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush();
    act(() => result.current.refresh()); await flush(); expect(result.current.error).toEqual(new Error('offline'));
    act(() => result.current.refresh()); await flush(); expect(result.current.error).toEqual(new Error('offline')); expect(result.current.items).toHaveLength(1);
    later.resolve(page([row(10)])); await flush(); expect(result.current.error).toBeNull(); expect(load).toHaveBeenCalledTimes(3);
  });
  it('polls at visible and hidden intervals and immediately on visibility restoration', async () => {
    let visibility: DocumentVisibilityState = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValue(page([row(10)]));
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scopeFor()) }); await flush(); expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); await flush(); expect(load).toHaveBeenCalledTimes(2);
    visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(299_999); }); expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await flush(); expect(load).toHaveBeenCalledTimes(3);
    visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush(); expect(load).toHaveBeenCalledTimes(4);
    unmount(); vi.useRealTimers();
  });
});

describe('personal task projection generations', () => {
  it('ignores a stale revocation from an older project generation', async () => {
    const scope = scopeFor(), current = new Map([[workerId(3), workerId(60)]]); let publish!: (event: CacheEvent) => void;
    vi.mocked(scope.prepareProjection).mockResolvedValue(current);
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    const load = vi.spyOn(api, 'listPersonalTasks').mockResolvedValue(page([row(10)]));
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scope) }); await flush();
    act(() => publish({ projectId: workerId(3), accessRevoked: true, revokedGeneration: workerId(59) })); await flush();
    expect(result.current.items).toHaveLength(1); expect(result.current.totalTaskCount).toBe(1); expect(load).toHaveBeenCalledTimes(1);
  });
  it('retains the remaining published rows while rechecking after project removal', async () => {
    const scope = scopeFor(), later = deferred<api.PersonalTaskPage>(); let publish!: (event: CacheEvent) => void;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.spyOn(api, 'listPersonalTasks').mockResolvedValueOnce(page([row(10), row(11, 4)]))
      .mockResolvedValueOnce(page([row(12, 4, 2)], 'next', 2, 1)).mockImplementationOnce(() => later.promise);
    const { result } = renderHook(() => useMyTasks(true), { wrapper: wrapper(scope) }); await flush();
    act(() => publish({ projectId: workerId(3), accessRevoked: true })); await flush();
    expect(result.current.items.map(x => x.task.id)).toEqual([workerId(11)]); expect(result.current.totalTaskCount).toBeNull();
    later.resolve(page([row(13, 4, 2)], null, 2, 1)); await flush(); expect(result.current.items.map(x => x.task.id)).toEqual([workerId(12), workerId(13)]);
  });
  it('prevents a retired account from publishing over the new account', async () => {
    const firstScope = scopeFor(), secondScope = scopeFor(workerId(99)), pending = deferred<api.PersonalTaskPage>();
    vi.spyOn(api, 'listPersonalTasks').mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(page([row(11, 4)]));
    function Capture() { const data = useMyTasks(true); return <span data-testid="row">{data.items.map(item => item.task.id).join(',')}</span>; }
    const view = render(<TaskCacheProvider scope={firstScope}><Capture /></TaskCacheProvider>);
    await flush(); view.rerender(<TaskCacheProvider scope={secondScope}><Capture /></TaskCacheProvider>); await flush();
    pending.resolve(page([row(10)])); await flush();
    expect(view.getByTestId('row').textContent).toBe(workerId(11));
  });
});
