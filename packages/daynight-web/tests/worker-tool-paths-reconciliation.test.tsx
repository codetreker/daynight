import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { invalidateAuthRequests } from '../src/api/client';
import type { WorkerCloudToolPaths } from '../src/api/worker-tool-paths';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { useWorkerConfiguration } from '../src/features/workers/configuration/useWorkerConfiguration';
import { configurationResource, configurationResponse, configurationValue } from './helpers/worker-configuration';
import { WORKER_USER, workerId } from './helpers/workers';

const original: WorkerCloudToolPaths = { codex: { kind: 'path', path: '/opt/original/codex' }, copilot: null };
const remote: WorkerCloudToolPaths = { ...original, codex: { kind: 'path', path: '/opt/remote/codex' }, copilot: { kind: 'path', path: '/opt/remote/copilot' } };
const local: WorkerCloudToolPaths = { ...original, codex: { kind: 'path', path: '/opt/local/codex' } };
const response = (revision = '1', toolPaths: WorkerCloudToolPaths | undefined = original, maxConcurrent = 2) => {
  const value = { ...configurationValue(), maxConcurrent, ...(toolPaths === undefined ? {} : { toolPaths }) };
  const result = configurationResponse(configurationResource(revision, value));
  if (toolPaths !== undefined) result.headers.set('Daynight-Worker-Tool-Paths', '2');
  return result;
};
const legacyResponse = (revision: string, maxConcurrent = 7) => configurationResponse(configurationResource(revision, { ...configurationValue(), maxConcurrent }));
const futureResponse = (revision: string, maxConcurrent: number, paths: WorkerCloudToolPaths = original, future = '900719925474099312345', recoveryLimit = 3) => {
  const toolPaths = { ...paths, codex: paths.codex === null ? null : { ...paths.codex, extra: { large: 'FUTURE_NUMBER' } }, nextTool: { kind: 'new', limit: 'FUTURE_NUMBER' } };
  const text = JSON.stringify(configurationResource(revision, { ...configurationValue(), maxConcurrent, recoveryLimit, toolPaths })).replaceAll('"FUTURE_NUMBER"', future);
  return new Response(text, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' } });
};
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

describe('Worker configuration source consistency', () => {
  it('retains the draft and blocks saves when the same revision changes unknown source', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(futureResponse('1', 2)).mockResolvedValueOnce(futureResponse('1', 2, original, '900719925474099312346'));
    vi.stubGlobal('fetch', fetch);
    const { result } = hook(); await flush();
    act(() => result.current.setDraft(draft => ({ ...draft, maxConcurrent: '7' })));
    await refresh(result);
    expect(result.current.error).toMatchObject({ kind: 'protocol' });
    expect(result.current.draft?.maxConcurrent).toBe('7'); expect(result.current.saveableDirty).toBe(false);
    await act(async () => result.current.save()); expect(puts(fetch)).toHaveLength(0);
  });

});
