import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import * as configurationApi from '../src/api/worker-configuration';
import type { WorkerCloudToolPaths } from '../src/api/worker-tool-paths';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorkerConfiguration } from '../src/features/workers/configuration/useWorkerConfiguration';
import { configurationError, configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_USER, workerId } from './helpers/workers';

const paths: WorkerCloudToolPaths = { codex: { kind: 'auto' }, copilot: null, herdr: null };
const explicit: WorkerCloudToolPaths = { ...paths, codex: { kind: 'path', path: '/opt/new codex' } };
const value = (toolPaths = paths) => ({ ...configurationValue(), toolPaths });
const response = (revision = '1', toolPaths = paths, maxConcurrent = 2) => {
  const result = configurationResponse(configurationResource(revision, { ...value(toolPaths), maxConcurrent }));
  result.headers.set('Daynight-Worker-Tool-Paths', '1');
  return result;
};
const scopes: TaskCacheScope[] = [];
const scope = () => {
  const result = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() });
  scopes.push(result); return result;
};
const wrapper = (owner = scope()) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={owner}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let count = 0; count < 40; count++) await Promise.resolve(); });
const refresh = async (result: { readonly current: { readonly refresh: () => void } }) => { act(() => result.current.refresh()); await flush(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => { for (const owner of scopes.splice(0)) owner.dispose(); invalidateAuthRequests(); vi.useRealTimers(); });

describe('Worker tool paths in the configuration owner', () => {
  it('negotiates tools and saves an explicit path while preserving unadopted peers and application facts', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response('2', explicit));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper() });
    await flush();
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('Daynight-Worker-Tool-Paths')).toBe('1');
    expect(result.current.draft?.toolPaths).toEqual(paths);
    act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    await act(async () => result.current.save());
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ revision: '1', value: value(explicit) });
    expect(new Headers(fetch.mock.calls[1]![1].headers).get('Daynight-Worker-Tool-Paths')).toBe('1');
    expect(result.current.notice).toBe('saved');
    expect(result.current.dirty).toBe(false);
    expect(result.current.resource?.observation).toBeNull();
    expect(result.current.resource?.toolPathsSupported).toBe(true);
  });

  it('rejects invalid raw paths without dispatch and cancels back to the saved three-state values', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()); vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true, platform: 'linux' }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: { ...paths, codex: { kind: 'path', path: '' } } })));
    await act(async () => result.current.save());
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.current.dirty).toBe(true);
    expect(result.current.draft?.toolPaths?.codex).toEqual({ kind: 'path', path: '' });
    act(() => result.current.discard());
    expect(result.current.dirty).toBe(false); expect(result.current.draft?.toolPaths).toEqual(paths);
  });

  it('adopts newly negotiated fields without replacing edits to existing settings', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(configurationResponse(configurationResource())).mockResolvedValueOnce(response()).mockResolvedValueOnce(response('2', paths, 7));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' })));
    await refresh(result);
    expect(result.current.draft?.maxConcurrent).toBe('7'); expect(result.current.draft?.toolPaths).toEqual(paths);
    expect(result.current.conflict).toBe(false);
    await act(async () => result.current.save());
    expect(result.current.dirty).toBe(false);
    expect(JSON.parse(fetch.mock.calls[2]![1].body).value).toMatchObject({ maxConcurrent: 7, toolPaths: paths });
  });

  it('does not send future tool targets before the Worker has reported support', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 7 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    expect(result.current.saveableDirty).toBe(false);
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(1);
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' })));
    await act(async () => result.current.save());
    expect(JSON.parse(fetch.mock.calls[1]![1].body).value).not.toHaveProperty('toolPaths');
    expect(new Headers(fetch.mock.calls[1]![1].headers).has('Daynight-Worker-Tool-Paths')).toBe(false);
    expect(result.current.draft?.toolPaths).toEqual(explicit);
    expect(result.current.dirty).toBe(true); expect(result.current.saveableDirty).toBe(false);
  });

  it('preserves unsent tool edits when Worker capability disappears and other settings are saved', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 7 }))).mockResolvedValueOnce(response('2', paths, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ editable }) => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: editable }), { initialProps: { editable: true }, wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit, maxConcurrent: '7' })));
    rerender({ editable: false });
    await act(async () => result.current.save());
    expect(JSON.parse(fetch.mock.calls[1]![1].body).value).not.toHaveProperty('toolPaths');
    expect(result.current.draft?.toolPaths).toEqual(explicit); expect(result.current.dirty).toBe(true);
    rerender({ editable: true }); await refresh(result);
    expect(result.current.draft?.toolPaths).toEqual(explicit); expect(result.current.saveableDirty).toBe(true);
    expect(result.current.baselineRevision).toBe('2');
  });

  it('uses the legacy write projection after the service removes capability', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(configurationResponse(configurationResource())).mockResolvedValueOnce(configurationResponse(configurationResource('2', { ...configurationValue(), maxConcurrent: 7 })));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit, maxConcurrent: '7' })));
    await refresh(result); expect(result.current.resource?.toolPathsSupported).not.toBe(true);
    await act(async () => result.current.save());
    expect(JSON.parse(fetch.mock.calls[2]![1].body).value).not.toHaveProperty('toolPaths');
    expect(result.current.draft?.toolPaths).toEqual(explicit); expect(result.current.dirty).toBe(true);
  });

  it('reconciles an unknown tool save without replay and preserves a later raw edit', async () => {
    const read = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost')).mockImplementationOnce(() => read.promise);
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(result.current.uncertain).toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: { ...paths, codex: { kind: 'path', path: '' } } })));
    read.resolve(response('2', explicit)); await act(async () => saving);
    expect(result.current.notice).toBe('reconciled'); expect(result.current.uncertain).toBe(false);
    expect(result.current.draft?.toolPaths?.codex).toEqual({ kind: 'path', path: '' }); expect(result.current.dirty).toBe(true);
    expect(result.current.resource?.desired?.value.toolPaths).toEqual(explicit);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('keeps an unknown tool save query-only when a legacy response cannot reveal its target', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost')).mockResolvedValueOnce(configurationResponse(configurationResource('2'))).mockResolvedValueOnce(response('2', explicit));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    await act(async () => result.current.save());
    expect(result.current.uncertain).toBe(true); expect(result.current.draft?.toolPaths).toEqual(explicit);
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    await refresh(result);
    expect(result.current.uncertain).toBe(false); expect(result.current.notice).toBe('reconciled'); expect(result.current.dirty).toBe(false);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('retains the path on CAS conflict and loads adopted peers only on explicit discard', async () => {
    const adopted: WorkerCloudToolPaths = { ...paths, copilot: { kind: 'path', path: '/opt/copilot' } };
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(configurationError(409, 'version_conflict')).mockResolvedValueOnce(response('2', adopted));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    await act(async () => result.current.save());
    expect(result.current.conflict).toBe(true); expect(result.current.draft?.toolPaths).toEqual(explicit);
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    act(() => result.current.loadLatest());
    expect(result.current.draft?.toolPaths).toEqual(adopted); expect(result.current.dirty).toBe(false);
  });

  it('rechecks Worker capability after admission before dispatching a prepared tool save', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()); vi.stubGlobal('fetch', fetch);
    const owner = scope(), gate = deferred<void>();
    const { result, rerender } = renderHook(({ editable }) => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: editable }), { initialProps: { editable: true }, wrapper: wrapper(owner) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    vi.spyOn(owner, 'ready').mockImplementationOnce(() => gate.promise);
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    expect(result.current.pending).toBe(true);
    rerender({ editable: false }); gate.resolve(); await act(async () => saving);
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(false);
    expect(result.current.draft?.toolPaths).toEqual(explicit); expect(result.current.dirty).toBe(true);
  });

  it('settles tool preparation during identity pause and retains capability restrictions after resume', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response('2', explicit)); vi.stubGlobal('fetch', fetch);
    const owner = scope();
    const { result, rerender } = renderHook(({ editable }) => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: editable }), { initialProps: { editable: true }, wrapper: wrapper(owner) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    let resume!: () => void;
    vi.spyOn(owner, 'ready').mockImplementationOnce(async () => { resume = pauseAuthRequests(); });
    let saving!: Promise<void>, settled = false;
    act(() => { saving = result.current.save(); void saving.then(() => { settled = true; }); }); await flush();
    expect(settled).toBe(true); expect(result.current.pending).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    rerender({ editable: false }); resume(); await act(async () => saving);
    await act(async () => result.current.save());
    expect(fetch).toHaveBeenCalledTimes(1); expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(false);
    expect(result.current.draft?.toolPaths).toEqual(explicit); expect(result.current.dirty).toBe(true);
  });

  it('keeps a confirmed tool receipt through identity pause without replacing a later raw draft', async () => {
    const put = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => put.promise);
    vi.stubGlobal('fetch', fetch);
    const originalSave = configurationApi.saveWorkerConfiguration; let resume = () => {};
    const spy = vi.spyOn(configurationApi, 'saveWorkerConfiguration').mockImplementation((id, revision, target, signal, admission) => originalSave(id, revision, target, signal, {
      ...admission, onConfirmed: receipt => { admission.onConfirmed?.(receipt); resume = pauseAuthRequests(); },
    }));
    try {
      const { result, rerender } = renderHook(({ editable }) => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: editable }), { initialProps: { editable: true }, wrapper: wrapper() });
      await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
      let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
      put.resolve(response('2', explicit)); await act(async () => saving); await flush();
      expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(false); expect(result.current.publicationPending).toBe(true);
      expect(result.current.resource?.desired?.value.toolPaths).toEqual(paths);
      act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: { ...paths, codex: { kind: 'path', path: '' } } })));
      rerender({ editable: false }); await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(2);
      resume(); await flush();
      expect(result.current.notice).toBe('saved'); expect(result.current.publicationPending).toBe(false);
      expect(result.current.baselineRevision).toBe('2'); expect(result.current.resource?.desired?.value.toolPaths).toEqual(explicit);
      expect(result.current.draft?.toolPaths?.codex).toEqual({ kind: 'path', path: '' }); expect(result.current.dirty).toBe(true);
      expect(result.current.saveableDirty).toBe(false);
    } finally { resume(); spy.mockRestore(); }
  });

  it('retains the latest read capability when publishing an older confirmed tool receipt', async () => {
    const put = deferred<Response>(), enteringPublication = deferred<void>(), releasePublication = deferred<void>(), owner = scope();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => put.promise)
      .mockResolvedValueOnce(configurationResponse(configurationResource('2')));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: true }), { wrapper: wrapper(owner) });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    const ready = owner.ready.bind(owner);
    vi.spyOn(owner, 'ready').mockImplementationOnce(async () => { enteringPublication.resolve(); await releasePublication.promise; }).mockImplementation(ready);
    put.resolve(response('2', explicit)); await act(async () => enteringPublication.promise); await act(async () => saving);
    expect(result.current.publicationPending).toBe(true);
    await refresh(result);
    expect(result.current.notice).toBe('saved'); expect(result.current.uncertain).toBe(false);
    expect(result.current.resource?.toolPathsSupported).not.toBe(true);
    releasePublication.resolve(); await flush();
    expect(result.current.resource?.toolPathsSupported).not.toBe(true);
    act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: paths })));
    expect(result.current.saveableDirty).toBe(false);
    await act(async () => result.current.save());
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });

  it('settles an interrupted tool PUT locally and keeps legacy reconciliation query-only after resume', async () => {
    const dispatched = deferred<void>();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce((_url: string, init: RequestInit) => {
      dispatched.resolve();
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }).mockResolvedValueOnce(configurationResponse(configurationResource('2'))).mockResolvedValueOnce(response('2', explicit));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ enabled, editable }) => useWorkerConfiguration(workerId(1), { readEnabled: enabled, toolPathsEditable: editable }), { initialProps: { enabled: true, editable: true }, wrapper: wrapper() });
    await flush(); act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: explicit })));
    let saving!: Promise<void>, settled = false;
    act(() => { saving = result.current.save(); void saving.then(() => { settled = true; }); }); await act(async () => dispatched.promise);
    const resume = pauseAuthRequests(); rerender({ enabled: false, editable: false }); await flush();
    expect(settled).toBe(true); expect(result.current.pending).toBe(false); expect(result.current.uncertain).toBe(true);
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(2);
    resume(); rerender({ enabled: true, editable: false }); await flush();
    expect(result.current.uncertain).toBe(true); expect(result.current.draft?.toolPaths).toEqual(explicit);
    await act(async () => result.current.save()); expect(fetch).toHaveBeenCalledTimes(3);
    rerender({ enabled: true, editable: true }); await refresh(result); await act(async () => saving);
    expect(result.current.notice).toBe('reconciled'); expect(result.current.uncertain).toBe(false); expect(result.current.dirty).toBe(false);
    expect(fetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1);
  });
});
