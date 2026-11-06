import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useConfigurationProjects } from '../src/features/workers/configuration/useConfigurationProjects';
import type { Project } from '../src/api/types';
import type { CacheEvent } from '../src/features/task-cache/project-cache';
import { TaskCacheError } from '../src/features/task-cache/database';
import { configurationError } from './helpers/worker-configuration';
import { wireResponse } from './helpers/wireJson';
import { WORKER_TIME, WORKER_USER, workerId } from './helpers/workers';

const scopes: TaskCacheScope[] = [];
const makeScope = (userId = WORKER_USER, onIdentityMismatch = vi.fn()) => {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch });
  vi.spyOn(scope, 'prepareProjection').mockResolvedValue(new Map());
  scopes.push(scope); return scope;
};
const wrapper = (scope: TaskCacheScope) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={scope}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const project = (value: number): Project => ({ id: workerId(value), name: `Project ${value}`, repoUrl: `https://example.test/project-${value}.git`, settings: { version: 1n, executionWarningMinutes: 60 }, ownership: { teamId: workerId(999), version: 1n }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME });
const page = (items: readonly Project[], nextCursor: string | null = null, userId = WORKER_USER) => wireResponse({ items, nextCursor }, { headers: { 'Daynight-User-ID': userId } });
afterEach(() => { for (const scope of scopes.splice(0)) scope.dispose(); });

describe('configuration Project choices', () => {
  it('removes suspended metadata immediately and restores it only after a new authorized read', async () => {
    const scope = makeScope(), target = project(3), healthy = project(4), old = deferred<Response>(), suspended = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(page([target, healthy])).mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(page([target, healthy])).mockImplementationOnce(() => suspended.promise).mockResolvedValueOnce(page([target, healthy])); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(scope) }); await flush();
    act(() => result.current.refresh()); await flush(); act(() => scope.suspendProject(target.id)); await flush();
    expect(result.current.items).toEqual([healthy]); expect(result.current.loading).toBe(false);
    old.resolve(page([target, healthy])); await flush(); expect(result.current.items).toEqual([healthy]);
    act(() => result.current.refresh()); await flush();
    act(() => scope.resumeProject(target.id)); await flush(); expect(result.current.items).toEqual([target, healthy]);
    suspended.resolve(page([target, healthy])); await flush(); expect(result.current.items).toEqual([target, healthy]); expect(fetch).toHaveBeenCalledTimes(5);
  });
  it('withdraws metadata during pagination, ignores older generations, and permits fresh authorization', async () => {
    const scope = makeScope(), target = project(3), healthy = project(4), old = deferred<Response>(), fresh = deferred<Response>();
    let publish!: (event: CacheEvent) => void;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.mocked(scope.prepareProjection).mockResolvedValue(new Map([[target.id, 'generation-a']]));
    const fetch = vi.fn().mockResolvedValueOnce(page([target, healthy])).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(scope) });
    await flush(); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: target.id, accessRevoked: true, revokedGeneration: 'generation-a' })); await flush();
    expect(result.current.items).toEqual([healthy]);
    old.resolve(page([target, healthy])); await flush(); expect(result.current.items).toEqual([healthy]);
    fresh.resolve(page([healthy])); await flush(); expect(result.current.items).toEqual([healthy]);
    vi.mocked(scope.prepareProjection).mockResolvedValue(new Map([[target.id, 'generation-b']]));
    fetch.mockResolvedValueOnce(page([target, healthy])); act(() => result.current.refresh()); await flush();
    act(() => publish({ projectId: target.id, accessRevoked: true, revokedGeneration: 'generation-a' }));
    expect(result.current.items).toEqual([target, healthy]);
  });
  it('keeps failed cleanup visible and excludes only the denied Project on fresh reads', async () => {
    const scope = makeScope(), target = project(3), healthy = project(4), failure = new TaskCacheError('storage');
    let publish!: (event: CacheEvent) => void, denied = true;
    vi.spyOn(scope, 'subscribeProjection').mockImplementation(listener => { publish = listener; return () => {}; });
    vi.spyOn(scope, 'isProjectionDenied').mockImplementation(id => denied && id === target.id);
    vi.stubGlobal('fetch', vi.fn(async () => page([target, healthy])));
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(scope) }); await flush();
    act(() => publish({ projectId: target.id, accessRevoked: true, error: failure }));
    expect(result.current.error).toBe(failure); expect(result.current.items).toEqual([healthy]);
    vi.mocked(scope.prepareProjection).mockImplementation(async () => { if (denied) publish({ projectId: target.id, accessRevoked: true, error: failure }); return new Map(); });
    act(() => result.current.refresh()); await flush(); expect(result.current.error).toBe(failure); expect(result.current.items).toEqual([healthy]);
    denied = false; act(() => result.current.refresh()); await flush(); expect(result.current.error).toBeNull(); expect(result.current.items).toEqual([target, healthy]);
  });
  it('publishes the complete accessible Project set only after every page succeeds', async () => {
    const second = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(page([project(3)], 'next/+'))
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.loading).toBe(true); expect(result.current.items).toEqual([]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/projects?limit=100', '/api/v1/projects?limit=100&cursor=next%2F%2B']);
    second.resolve(page([project(4)])); await flush();
    expect(result.current.items).toEqual([project(3), project(4)]); expect(result.current.loading).toBe(false); expect(result.current.error).toBeNull();
  });
  it.each([{ items: [] as Project[] }, { items: [project(3), project(4)] }])('retains a fully loaded candidate set during a background read, including an empty set', async ({ items }) => {
    const next = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(page(items)).mockImplementationOnce(() => next.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled }) => useConfigurationProjects(enabled), { initialProps: { enabled: true }, wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.loading).toBe(false); expect(result.current.items).toEqual(items);
    rerender({ enabled: false }); rerender({ enabled: true }); await flush();
    expect(result.current.loading).toBe(false); expect(result.current.items).toEqual(items);
    next.resolve(page(items.map(item => ({ ...item })))); await flush();
    expect(result.current.loading).toBe(false); expect(result.current.items).toEqual(items);
  });
  it('drops cached metadata after permission/read failure without publishing a partial refresh', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([project(3)]))
      .mockResolvedValueOnce(page([project(4)], 'next')).mockResolvedValueOnce(configurationError(403, 'forbidden'));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.items).toEqual([project(3)]);
    act(() => result.current.refresh()); await flush(); expect(result.current.items).toEqual([]); expect(result.current.error).toMatchObject({ status: 403 });
  });
  it('rejects repeated pagination cursors and recovers from the first page', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([project(3)], 'repeated')).mockResolvedValueOnce(page([project(4)], 'repeated'))
      .mockResolvedValueOnce(page([project(5)]));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(makeScope()) });
    await flush(); expect(result.current.items).toEqual([]); expect(result.current.error).toMatchObject({ kind: 'protocol' });
    act(() => result.current.refresh()); await flush(); expect(result.current.items).toEqual([project(5)]); expect(fetch.mock.calls.at(-1)![0]).toBe('/api/v1/projects?limit=100');
  });
  it('fences superseded refresh pages and invalidates a foreign principal', async () => {
    const old = deferred<Response>(), mismatch = vi.fn(), scope = makeScope(WORKER_USER, mismatch);
    const fetch = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValueOnce(page([project(4)]))
      .mockResolvedValueOnce(page([project(9)], null, workerId(99)));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useConfigurationProjects(true), { wrapper: wrapper(scope) });
    await flush(); act(() => result.current.refresh()); await flush(); expect(result.current.items).toEqual([project(4)]);
    old.resolve(page([project(3)])); await flush(); expect(result.current.items).toEqual([project(4)]);
    act(() => result.current.refresh()); await flush(); expect(mismatch).toHaveBeenCalledOnce(); expect(result.current.items).toEqual([]);
  });
  it('holds reads during disabled/hidden states and clears choices on account invalidation', async () => {
    let visibility: DocumentVisibilityState = 'hidden'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const pending = deferred<Response>(), fetch = vi.fn().mockResolvedValueOnce(page([project(3)])).mockImplementationOnce(() => pending.promise);
    vi.stubGlobal('fetch', fetch); const scope = makeScope();
    const { result, rerender } = renderHook(({ enabled }) => useConfigurationProjects(enabled), { initialProps: { enabled: false }, wrapper: wrapper(scope) });
    await flush(); act(() => result.current.refresh()); expect(fetch).not.toHaveBeenCalled();
    rerender({ enabled: true }); await flush(); expect(fetch).not.toHaveBeenCalled();
    visibility = 'visible'; act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush(); expect(result.current.items).toEqual([project(3)]);
    act(() => result.current.refresh()); await flush(); visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange')));
    pending.resolve(page([project(4)])); await flush(); expect(result.current.items).toEqual([project(3)]);
    act(() => scope.principalMismatch()); expect(result.current.items).toEqual([]);
  });
});
