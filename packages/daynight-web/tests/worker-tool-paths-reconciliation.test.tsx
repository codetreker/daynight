import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests } from '../src/api/client';
import type { WorkerCloudToolPaths } from '../src/api/worker-tool-paths';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorkerConfiguration } from '../src/features/workers/configuration/useWorkerConfiguration';
import { configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_USER, workerId } from './helpers/workers';

const original: WorkerCloudToolPaths = { codex: { kind: 'path', path: '/opt/original/codex' }, copilot: null, herdr: { kind: 'auto' } };
const remote: WorkerCloudToolPaths = { ...original, codex: { kind: 'path', path: '/opt/remote/codex' }, copilot: { kind: 'path', path: '/opt/remote/copilot' } };
const local: WorkerCloudToolPaths = { ...original, codex: { kind: 'path', path: '/opt/local/codex' } };
const response = (revision = '1', toolPaths: WorkerCloudToolPaths | undefined = original, maxConcurrent = 2) => {
  const value = { ...configurationValue(), maxConcurrent, ...(toolPaths === undefined ? {} : { toolPaths }) };
  const result = configurationResponse(configurationResource(revision, value));
  if (toolPaths !== undefined) result.headers.set('Daynight-Worker-Tool-Paths', '1');
  return result;
};
const legacyResponse = (revision: string, maxConcurrent = 7) => configurationResponse(configurationResource(revision, { ...configurationValue(), maxConcurrent }));
const scopes: TaskCacheScope[] = [];
const scope = () => {
  const owner = createTaskCacheScope({ userId: WORKER_USER, onIdentityMismatch: vi.fn() });
  scopes.push(owner); return owner;
};
const wrapper = (owner = scope()) => ({ children }: { readonly children: ReactNode }) => <TaskCacheProvider scope={owner}>{children}</TaskCacheProvider>;
const flush = () => act(async () => { for (let count = 0; count < 40; count++) await Promise.resolve(); });
const refresh = async (result: { readonly current: { readonly refresh: () => void } }) => { act(() => result.current.refresh()); await flush(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const hook = (owner = scope()) => renderHook(({ editable }) => useWorkerConfiguration(workerId(1), { readEnabled: true, toolPathsEditable: editable }), { initialProps: { editable: true }, wrapper: wrapper(owner) });
const puts = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => JSON.parse(options.body));
beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => { for (const owner of scopes.splice(0)) owner.dispose(); invalidateAuthRequests(); vi.useRealTimers(); });

describe('Worker legacy tool-path save reconciliation', () => {
  it('adopts untouched omitted paths before using a newer read revision for a full save', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response('3', remote, 7)).mockResolvedValueOnce(response('4', remote, 8));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' }))); rerender({ editable: false });
    await act(async () => result.current.save());
    expect(result.current.notice).toBe('reconciled'); expect(result.current.dirty).toBe(false);
    expect(result.current.draft?.toolPaths).toEqual(remote); expect(result.current.baselineRevision).toBe('3');
    rerender({ editable: true }); act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '8' })));
    await act(async () => result.current.save());
    expect(puts(fetch)).toHaveLength(2); expect(puts(fetch)[0].value).not.toHaveProperty('toolPaths');
    expect(puts(fetch)[1]).toMatchObject({ revision: '3', value: { maxConcurrent: 8, toolPaths: remote } });
  });

  it('keeps unsent edits while merging independently changed omitted tools', async () => {
    const changedPeer: WorkerCloudToolPaths = { ...original, copilot: remote.copilot };
    const combined: WorkerCloudToolPaths = { ...local, copilot: remote.copilot };
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response('3', changedPeer, 7)).mockResolvedValueOnce(response('4', combined, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7', toolPaths: local }))); rerender({ editable: false });
    await act(async () => result.current.save());
    expect(result.current.conflict).toBe(false); expect(result.current.dirty).toBe(true);
    expect(result.current.draft?.toolPaths).toEqual(combined); expect(result.current.saveableDirty).toBe(false);
    rerender({ editable: true }); await act(async () => result.current.save());
    expect(puts(fetch)[1]).toMatchObject({ revision: '3', value: { toolPaths: combined } });
    expect(result.current.dirty).toBe(false);
  });

  it.each(['codex', 'copilot', 'herdr'] as const)('preserves a conflicting %s edit and adopts untouched peers until explicit resolution', async tool => {
    const peer = tool === 'codex' ? 'copilot' : 'codex';
    const localChange: WorkerCloudToolPaths = { ...original, [tool]: { kind: 'path', path: `/opt/local/${tool}` } };
    const remoteChange: WorkerCloudToolPaths = { ...original, [tool]: { kind: 'path', path: `/opt/remote/${tool}` }, [peer]: { kind: 'path', path: `/opt/remote/${peer}` } };
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response('3', remoteChange, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7', toolPaths: localChange }))); rerender({ editable: false });
    await act(async () => result.current.save());
    expect(result.current.notice).toBe('conflict'); expect(result.current.conflict).toBe(true); expect(result.current.dirty).toBe(true);
    expect(result.current.draft?.toolPaths).toEqual({ ...localChange, [peer]: remoteChange[peer] });
    rerender({ editable: true }); await act(async () => result.current.save()); expect(puts(fetch)).toHaveLength(1);
    act(() => result.current.loadLatest()); expect(result.current.draft?.toolPaths).toEqual(remoteChange); expect(result.current.dirty).toBe(false);
  });

  it('settles matching remote and unsent local selections without a false conflict', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(response('3', local, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7', toolPaths: local }))); rerender({ editable: false });
    await act(async () => result.current.save());
    expect(result.current.notice).toBe('reconciled'); expect(result.current.conflict).toBe(false); expect(result.current.dirty).toBe(false);
    rerender({ editable: true }); await act(async () => result.current.save()); expect(puts(fetch)).toHaveLength(1);
  });

  it('waits for observable omitted fields across legacy and stale recovery reads without replay', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(legacyResponse('3')).mockResolvedValueOnce(response('2', original, 7))
      .mockResolvedValueOnce(response('3', remote, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' }))); rerender({ editable: false });
    await act(async () => result.current.save());
    expect(result.current.uncertain).toBe(true); expect(result.current.baselineRevision).toBe('1');
    rerender({ editable: true }); await act(async () => result.current.save()); expect(puts(fetch)).toHaveLength(1);
    await refresh(result); expect(result.current.uncertain).toBe(true); expect(result.current.baselineRevision).toBe('1');
    await refresh(result); expect(result.current.uncertain).toBe(false); expect(result.current.draft?.toolPaths).toEqual(remote);
    expect(result.current.baselineRevision).toBe('3'); expect(puts(fetch)).toHaveLength(1);
  });

  it('retains a raw edit made while the omitted-field recovery read is pending', async () => {
    const read = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('connection lost')).mockImplementationOnce(() => read.promise);
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' }))); rerender({ editable: false });
    await act(async () => result.current.save());
    act(() => result.current.setDraft(draft => ({ ...draft, toolPaths: { ...original, codex: { kind: 'path', path: '' } } })));
    read.resolve(response('3', remote, 7)); await flush();
    expect(result.current.draft?.toolPaths?.codex).toEqual({ kind: 'path', path: '' });
    expect(result.current.notice).toBe('conflict'); expect(result.current.dirty).toBe(true);
  });

  it('binds a delayed confirmed legacy receipt to its own revision despite a newer full read', async () => {
    const put = deferred<Response>(), enteringPublication = deferred<void>(), releasePublication = deferred<void>(), owner = scope();
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => put.promise).mockResolvedValueOnce(response('3', remote, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(owner); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7', toolPaths: local }))); rerender({ editable: false });
    let saving!: Promise<void>; act(() => { saving = result.current.save(); }); await flush();
    const ready = owner.ready.bind(owner);
    vi.spyOn(owner, 'ready').mockImplementationOnce(async () => { enteringPublication.resolve(); await releasePublication.promise; }).mockImplementation(ready);
    put.resolve(legacyResponse('2')); await act(async () => enteringPublication.promise); await act(async () => saving);
    expect(result.current.publicationPending).toBe(true); await refresh(result);
    expect(result.current.notice).toBe('saved'); expect(result.current.baselineRevision).toBe('2');
    expect(result.current.resource?.desired?.revision).toBe('3'); expect(result.current.conflict).toBe(true);
    expect(result.current.draft?.toolPaths).toEqual(local); expect(result.current.dirty).toBe(true);
    releasePublication.resolve(); await flush(); rerender({ editable: true }); await act(async () => result.current.save());
    expect(puts(fetch)).toHaveLength(1);
  });

  it('preserves omitted unsent edits after a confirmed legacy receipt and a matching full read', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(legacyResponse('2'))
      .mockResolvedValueOnce(response('2', original, 7)).mockResolvedValueOnce(response('3', local, 7));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7', toolPaths: local }))); rerender({ editable: false });
    await act(async () => result.current.save()); await refresh(result);
    expect(result.current.baselineRevision).toBe('2'); expect(result.current.conflict).toBe(false);
    expect(result.current.draft?.toolPaths).toEqual(local); expect(result.current.dirty).toBe(true);
    rerender({ editable: true }); await act(async () => result.current.save());
    expect(puts(fetch)[1]).toMatchObject({ revision: '2', value: { toolPaths: local } }); expect(result.current.dirty).toBe(false);
  });
});
