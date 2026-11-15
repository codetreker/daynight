import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { listProjectTags, resolveProjectTagColors, type ProjectTagColorPage } from '../src/api/task-tags';
import { createTaskCacheScope, type CacheEvent, type TaskCacheScope } from '../src/features/task-cache/project-cache';
import { TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TagColorProjection } from '../src/features/task-tags/useTagColors';
import { useProjectTags } from '../src/features/task-tags/useProjectTags';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { admitTaskGraph } from './helpers/taskSessions';
import { taskSyncEpoch } from './helpers/taskSync';

vi.mock('../src/api/task-tags', async original => ({ ...await original<typeof import('../src/api/task-tags')>(), listProjectTags: vi.fn(), resolveProjectTagColors: vi.fn() }));

const project = '10000000-0000-4000-8000-000000000001';
const tag = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const page = (ids: readonly string[], color = '#123456', catalogEpoch = 'epoch'): ProjectTagColorPage => ({
  catalogEpoch, items: ids.map(id => ({ id, state: 'found', version: 1n, color })),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const scopeFixture = () => {
  const lifetime = new AbortController();
  const listeners = new Set<(event: CacheEvent) => void>();
  const colorListeners = new Set<(projectId: string) => void>();
  const revalidate = vi.fn(async (_projectId: string) => true);
  let suspended = false;
  const scope = {
    userId: '30000000-0000-4000-8000-000000000001', signal: lifetime.signal, isInvalidated: false,
    isProjectSuspended: () => suspended, ready: async () => {}, principalMismatch: () => {}, revalidateProjectAccess: revalidate,
    subscribe: (listener: (event: CacheEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeTagColors: (listener: (projectId: string) => void) => { colorListeners.add(listener); return () => { colorListeners.delete(listener); }; },
  } as unknown as TaskCacheScope;
  return { scope, lifetime, emit: (event: CacheEvent) => { for (const listener of listeners) listener(event); }, emitColors: (projectId: string) => { for (const listener of colorListeners) listener(projectId); }, suspend: (value: boolean) => { suspended = value; }, listeners, colorListeners, revalidate };
};
const resolve = vi.mocked(resolveProjectTagColors);
beforeEach(() => { resolve.mockReset(); vi.mocked(listProjectTags).mockReset(); });

describe('shared tag color projection', () => {
  it('deduplicates observers and publishes all batches atomically, including missing IDs', async () => {
    const { scope } = scopeFixture(), store = new TagColorProjection(scope, project);
    const later = deferred<ProjectTagColorPage>();
    resolve.mockImplementation(async (_project, ids, epoch) => epoch === null ? page(ids) : later.promise);
    const ids = Array.from({ length: 101 }, (_, index) => tag(index));
    const stopFirst = store.watch(ids.slice(0, 100));
    const stopSecond = store.watch([ids[0]!, ids[100]!]);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(resolve.mock.calls[0]![1]).toHaveLength(100);
    expect(resolve.mock.calls[0]![2]).toBeNull();
    expect(resolve.mock.calls[1]![2]).toBe('epoch');
    expect(store.snapshot().items.size).toBe(0);
    later.resolve({ catalogEpoch: 'epoch', items: [{ id: ids[100]!, state: 'missing' }] });
    await waitFor(() => expect(store.snapshot().items.size).toBe(101));
    expect(store.snapshot().items.get(ids[100]!)).toEqual({ id: ids[100], state: 'missing' });
    expect(store.snapshot().items.get(ids[0]!)?.state).toBe('found');
    stopFirst(); stopSecond();
  });

  it('restarts the entire round once on epoch change and retains previous results after another conflict', async () => {
    const { scope } = scopeFixture(), store = new TagColorProjection(scope, project);
    const ids = Array.from({ length: 101 }, (_, index) => tag(index));
    resolve.mockImplementation(async (_project, batch) => page(batch));
    const stop = store.watch(ids);
    await waitFor(() => expect(store.snapshot().items.size).toBe(101));
    resolve.mockReset();
    resolve.mockImplementation(async (_project, batch, epoch) => {
      if (epoch !== null) throw new ApiError('server', 409, 'catalog_changed');
      return page(batch, '#ABCDEF', 'changed');
    });
    store.invalidate();
    await waitFor(() => expect(store.snapshot().error).toBeInstanceOf(ApiError));
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(store.snapshot().items.get(ids[0]!)).toMatchObject({ color: '#123456' });
    expect(store.snapshot().loading).toBe(false);
    resolve.mockReset(); resolve.mockImplementation(async (_project, batch) => page(batch, '#ABCDEF', 'changed'));
    store.invalidate();
    await waitFor(() => expect(store.snapshot().items.get(ids[0]!)).toMatchObject({ color: '#ABCDEF' }));
    expect(store.snapshot().error).toBeNull();
    stop();
  });

  it('restarts a mixed epoch round and shares one result across duplicate observers', async () => {
    const { scope } = scopeFixture(), store = new TagColorProjection(scope, project);
    const ids = Array.from({ length: 101 }, (_, index) => tag(index));
    resolve.mockImplementationOnce(async (_project, batch) => page(batch, '#111111', 'old'))
      .mockImplementationOnce(async (_project, batch) => page(batch, '#222222', 'new'))
      .mockImplementation(async (_project, batch) => page(batch, '#333333', 'new'));
    const first = store.watch(ids), duplicate = store.watch([ids[0]!]);
    await waitFor(() => expect(store.snapshot().items.size).toBe(101));
    expect(resolve).toHaveBeenCalledTimes(4);
    expect([...store.snapshot().items.values()].every(item => item.state === 'found' && item.color === '#333333')).toBe(true);
    duplicate();
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledTimes(4);
    first();
  });

  it('retains existing colors when one observer changes its visible IDs', async () => {
    const { scope } = scopeFixture(), store = new TagColorProjection(scope, project);
    resolve.mockImplementation(async (_project, ids) => page(ids));
    const interest = store.observe(); interest.update([tag(1)]);
    await waitFor(() => expect(store.snapshot().items.size).toBe(1));
    const pending = deferred<ProjectTagColorPage>();
    resolve.mockReturnValueOnce(pending.promise);
    interest.update([tag(1), tag(2)]);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    expect(store.snapshot().items.get(tag(1))).toMatchObject({ color: '#123456' });
    expect(store.snapshot().items.has(tag(2))).toBe(false);
    pending.resolve(page([tag(1), tag(2)], '#ABCDEF'));
    await waitFor(() => expect(store.snapshot().items.get(tag(2))).toMatchObject({ color: '#ABCDEF' }));
    interest.close();
  });

  it('fences late responses after invalidation, revocation and scope disposal', async () => {
    const fixture = scopeFixture(), store = new TagColorProjection(fixture.scope, project);
    const old = deferred<ProjectTagColorPage>(), after = deferred<ProjectTagColorPage>();
    resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(after.promise);
    const stop = store.watch([tag(1)]);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    fixture.emitColors(project);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    old.resolve(page([tag(1)], '#111111'));
    await Promise.resolve();
    expect(store.snapshot().items.size).toBe(0);
    after.resolve(page([tag(1)], '#222222'));
    await waitFor(() => expect(store.snapshot().items.get(tag(1))).toMatchObject({ color: '#222222' }));
    const revoked = deferred<ProjectTagColorPage>(); resolve.mockReturnValueOnce(revoked.promise);
    store.invalidate();
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(3));
    fixture.suspend(true); fixture.emit({ projectId: project, accessRevoked: true });
    revoked.resolve(page([tag(1)], '#333333'));
    await Promise.resolve();
    expect(store.snapshot().items.size).toBe(0);
    expect(store.snapshot().error).toBeInstanceOf(ApiError);
    fixture.suspend(false); resolve.mockImplementation(async (_project, ids) => page(ids, '#444444'));
    fixture.emit({ projectId: project, accessRestored: true });
    await waitFor(() => expect(store.snapshot().items.get(tag(1))).toMatchObject({ color: '#444444' }));
    fixture.lifetime.abort();
    expect(store.snapshot().items.size).toBe(0);
    expect(fixture.listeners.size).toBe(0);
    expect(fixture.colorListeners.size).toBe(0);
    stop();
    expect(fixture.listeners.size).toBe(0);
    expect(fixture.colorListeners.size).toBe(0);
  });

  it('isolates projects and account scopes and distinguishes network failure from denied access', async () => {
    const first = scopeFixture(), second = scopeFixture(), otherProject = tag(500);
    const a = new TagColorProjection(first.scope, project), b = new TagColorProjection(first.scope, otherProject), c = new TagColorProjection(second.scope, project);
    resolve.mockImplementation(async (requestedProject, ids, _epoch, _signal, admission) => page(ids, requestedProject === otherProject ? '#333333' : admission.userId === first.scope.userId ? '#111111' : '#222222'));
    // Both scope objects may represent the same principal in separate account lifetimes.
    const aStop = a.watch([tag(1)]), bStop = b.watch([tag(1)]), cStop = c.watch([tag(1)]);
    await waitFor(() => { expect(a.snapshot().items.size).toBe(1); expect(b.snapshot().items.size).toBe(1); expect(c.snapshot().items.size).toBe(1); });
    resolve.mockRejectedValueOnce(new Error('offline'));
    first.emitColors(project);
    await waitFor(() => expect(a.snapshot().error).toBeInstanceOf(Error));
    expect(a.snapshot().items.get(tag(1))).toMatchObject({ color: '#111111' });
    expect(b.snapshot().items.get(tag(1))).toMatchObject({ color: '#333333' });
    expect(c.snapshot().error).toBeNull();
    resolve.mockRejectedValueOnce(new ApiError('server', 403, 'permission_denied'));
    a.invalidate();
    await waitFor(() => expect(a.snapshot().error).toMatchObject({ status: 403 }));
    expect(a.snapshot().items.size).toBe(0);
    expect(first.revalidate).toHaveBeenCalledOnce();
    expect(first.revalidate).toHaveBeenCalledWith(project);
    first.lifetime.abort();
    expect(c.snapshot().items.size).toBe(1);
    aStop(); bStop(); cStop();
  });

  it('rechecks access only for the current denial and withdraws results on revocation', async () => {
    const fixture = scopeFixture(), store = new TagColorProjection(fixture.scope, project);
    const stale = deferred<ProjectTagColorPage>();
    resolve.mockReturnValueOnce(stale.promise).mockImplementation(async (_project, ids) => page(ids));
    const stop = store.watch([tag(1)]);
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
    store.invalidate();
    await waitFor(() => expect(store.snapshot().items.size).toBe(1));
    stale.reject(new ApiError('server', 403, 'permission_denied'));
    await Promise.resolve(); await Promise.resolve();
    expect(fixture.revalidate).not.toHaveBeenCalled();
    expect(store.snapshot().items.size).toBe(1);
    fixture.revalidate.mockImplementationOnce(async () => {
      fixture.suspend(true);
      fixture.emit({ projectId: project, accessRevoked: true });
      return false;
    });
    resolve.mockRejectedValueOnce(new ApiError('server', 403, 'permission_denied'));
    store.invalidate();
    await waitFor(() => expect(fixture.revalidate).toHaveBeenCalledOnce());
    expect(fixture.revalidate).toHaveBeenCalledWith(project);
    expect(store.snapshot().items.size).toBe(0);
    expect(store.snapshot().error).toMatchObject({ status: 404 });
    const count = resolve.mock.calls.length;
    store.invalidate();
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledTimes(count);
    stop();
  });

  it('resumes only after real scope admission, not a peer color hint, after ordinary revocation', async () => {
    class Channel {
      static channels = new Set<Channel>();
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      constructor(readonly name: string) { Channel.channels.add(this); }
      postMessage(value: unknown) {
        for (const other of Channel.channels) if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data: value } as MessageEvent<unknown>));
      }
      close() { Channel.channels.delete(this); }
    }
    vi.stubGlobal('BroadcastChannel', Channel);
    const userId = '30000000-0000-4000-8000-000000000001';
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const peer = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const graph = graphFixture([detailFixture(project, tag(1))]);
    const seed = () => admitTaskGraph(scope, graph, { versionForTask: () => 1n });
    const store = new TagColorProjection(scope, project);
    let stop = () => {};
    try {
      await seed();
      resolve.mockImplementation(async (_project, ids) => page(ids));
      stop = store.watch([tag(1)]);
      await waitFor(() => expect(store.snapshot().items.size).toBe(1));
      const ticket = await scope.beginSync(project, scope.signal);
      expect(await scope.revokeProject(ticket, scope.signal, false)).toBe(true);
      expect(store.snapshot().items.size).toBe(0);
      const hint = vi.fn();
      const unlisten = scope.subscribeTagColors(hint);
      const previousCalls = resolve.mock.calls.length;
      peer.notifyTagColors(project);
      await waitFor(() => expect(hint).toHaveBeenCalledWith(project));
      expect(resolve).toHaveBeenCalledTimes(previousCalls);
      unlisten();
      resolve.mockImplementation(async (_project, ids) => page(ids, '#ABCDEF'));
      await seed();
      await waitFor(() => expect(store.snapshot().items.get(tag(1))).toMatchObject({ color: '#ABCDEF' }));

      const next = await scope.beginSync(project, scope.signal);
      expect(await scope.revokeProject(next, scope.signal, false)).toBe(true);
      const direct = await scope.beginTaskRead(project, tag(1), 1, 1, scope.signal);
      expect(await scope.observeHistory(direct, taskSyncEpoch(project), scope.signal)).toBe('current');
      scope.markProjectReadable(project);
      await waitFor(() => expect(store.snapshot().items.get(tag(1))).toMatchObject({ color: '#ABCDEF' }));
    } finally { stop(); scope.dispose(); peer.dispose(); }
  });

  it('resumes a newly mounted catalog read after real scope cleanup, while a later withdrawal fences it', async () => {
    const userId = '30000000-0000-4000-8000-000000000001';
    const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() });
    const graph = graphFixture([detailFixture(project, tag(1))]);
    const store = new TagColorProjection(scope, project);
    const wrapper = ({ children }: { readonly children: ReactNode }) => createElement(TaskCacheProvider, { scope, children });
    let stop = () => {};
    try {
      await admitTaskGraph(scope, graph, { versionForTask: () => 1n });
      resolve.mockImplementation(async (_project, ids) => page(ids));
      vi.mocked(listProjectTags).mockResolvedValue({ items: [], catalogEpoch: taskSyncEpoch(project), nextCursor: null });
      stop = store.watch([tag(1)]);
      await waitFor(() => expect(store.snapshot().items.size).toBe(1));
      const ticket = await scope.beginSync(project, scope.signal);
      const started = deferred<void>(), release = deferred<void>();
      const ready = scope.ready.bind(scope);
      const spy = vi.spyOn(scope, 'ready').mockImplementationOnce(async signal => { started.resolve(); await release.promise; await ready(signal); });
      const cleanup = scope.revokeProject(ticket, scope.signal, false);
      await started.promise;
      const catalog = renderHook(() => useProjectTags(project), { wrapper });
      await waitFor(() => expect(catalog.result.current.page).not.toBeNull());
      expect(store.snapshot().items.size).toBe(0);
      await act(async () => { release.resolve(); expect(await cleanup).toBe(true); });
      await waitFor(() => expect(store.snapshot().items.size).toBe(1));
      catalog.unmount(); spy.mockRestore();

      await admitTaskGraph(scope, graph, { versionForTask: () => 1n });
      const next = await scope.beginSync(project, scope.signal);
      const nextStarted = deferred<void>(), nextRelease = deferred<void>();
      const secondSpy = vi.spyOn(scope, 'ready').mockImplementationOnce(async signal => { nextStarted.resolve(); await nextRelease.promise; await ready(signal); });
      const secondCleanup = scope.revokeProject(next, scope.signal, false);
      await nextStarted.promise;
      const laterCatalog = renderHook(() => useProjectTags(project), { wrapper });
      await waitFor(() => expect(laterCatalog.result.current.page).not.toBeNull());
      act(() => scope.suspendProject(project));
      const calls = resolve.mock.calls.length;
      await act(async () => { nextRelease.resolve(); expect(await secondCleanup).toBe(true); });
      expect(resolve).toHaveBeenCalledTimes(calls);
      expect(store.snapshot().items.size).toBe(0);
      laterCatalog.unmount(); secondSpy.mockRestore();
    } finally { stop(); scope.dispose(); }
  });
});
