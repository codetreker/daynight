import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteTask, subscribeUnauthorized } from '../src/api/client';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-00000000000a';
const task = '20000000-0000-4000-8000-00000000000b';
const signal = () => new AbortController().signal;
const response = (status = 204, code = 'task_deleted', viewer: string | null = TEST_VIEWER_ID) => new Response(status === 204 ? null : JSON.stringify({ error: { code, message: 'Server detail', requestId: 'delete-request' } }), {
  status, headers: viewer === null ? { 'Content-Type': 'application/json' } : viewerHeaders(viewer, { 'Content-Type': 'application/json' }),
});
const fetchResponse = (reply: Response) => {
  const fetcher = vi.fn().mockResolvedValue(reply); vi.stubGlobal('fetch', fetcher); return fetcher;
};
afterEach(() => vi.unstubAllGlobals());

describe('versioned task soft-delete transport', () => {
  it.each([1n, 9_007_199_254_740_993n, 9_223_372_036_854_775_807n])('submits one DELETE with exact int64 version %s and accepts the empty204', async (version) => {
    const fetcher = fetchResponse(response()); const abortSignal = signal(); const confirmed = vi.fn(); const mismatch = vi.fn();
    await expect(deleteTask(project.toUpperCase(), task.toUpperCase(), version, abortSignal, { userId: TEST_VIEWER_ID, onPrincipalMismatch: mismatch, onWriteConfirmed: confirmed })).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/projects/${project}/tasks/${task}`, {
      method: 'DELETE', redirect: 'error', signal: abortSignal, cache: 'no-store', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: `{"version":${version}}`,
    });
    expect(confirmed).toHaveBeenCalledOnce(); expect(mismatch).not.toHaveBeenCalled();
  });
  it.each([{ status: 409, code: 'version_conflict' }, { status: 409, code: 'dependency_unsatisfied' }, { status: 409, code: 'invalid_transition' }, { status: 410, code: 'task_deleted' }, { status: 404, code: 'not_found' }])('preserves $status $code without replaying the mutation', async ({ status, code }) => {
    const fetcher = fetchResponse(response(status, code)); const confirmed = vi.fn();
    await expect(deleteTask(project, task, 1n, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed: confirmed })).rejects.toMatchObject({ kind: 'server', status, code, requestId: 'delete-request' });
    expect(fetcher).toHaveBeenCalledOnce(); expect(confirmed).not.toHaveBeenCalled();
  });
  it.each([null, '00000000-0000-4000-8000-000000000202'])('checks the actual response principal before accepting success or deletion when principal is %s', async (viewer) => {
    for (const status of [204, 410]) {
      const fetcher = fetchResponse(response(status, 'task_deleted', viewer)); const mismatch = vi.fn(); const confirmed = vi.fn();
      await expect(deleteTask(project, task, 1n, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: mismatch, onWriteConfirmed: confirmed })).rejects.toMatchObject({ kind: 'protocol' });
      expect(fetcher).toHaveBeenCalledOnce(); expect(confirmed).not.toHaveBeenCalled();
      expect(mismatch).toHaveBeenCalledTimes(viewer === null ? 0 : 1);
    }
  });
  it('rejects another successful status and does not claim the write confirmed', async () => {
    const confirmed = vi.fn(); fetchResponse(response(200));
    await expect(deleteTask(project, task, 1n, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn(), onWriteConfirmed: confirmed })).rejects.toMatchObject({ kind: 'protocol', status: 200 });
    expect(confirmed).not.toHaveBeenCalled();
  });
  it('exposes network loss without retrying', async () => {
    const failure = new TypeError('response lost'); const fetcher = vi.fn().mockRejectedValue(failure); vi.stubGlobal('fetch', fetcher);
    await expect(deleteTask(project, task, 1n, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: 'network', cause: failure });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects invalid scope, version and pre-submit cancellation before I/O', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
    await expect(deleteTask('bad', task, 1n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    await expect(deleteTask(project, 'bad', 1n, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    for (const version of [0n, -1n, 9_223_372_036_854_775_808n, 1 as unknown as bigint]) await expect(deleteTask(project, task, version, signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    const controller = new AbortController(); const reason = new Error('retired'); controller.abort(reason);
    await expect(deleteTask(project, task, 1n, controller.signal, admission)).rejects.toBe(reason); expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses the existing session-expiry notification', async () => {
    const listener = vi.fn(); const unsubscribe = subscribeUnauthorized(listener);
    try {
      fetchResponse(response(401, 'unauthenticated', null));
      await expect(deleteTask(project, task, 1n, signal(), { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() })).rejects.toMatchObject({ kind: 'server', status: 401, code: 'unauthenticated' });
      expect(listener).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });
});
