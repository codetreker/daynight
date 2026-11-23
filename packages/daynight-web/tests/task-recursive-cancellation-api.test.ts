import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setTaskStatus } from '../src/api/client';
import { detailFixture } from './helpers/taskDetail';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { stringifyApiJson } from '../src/api/json';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const child = '20000000-0000-4000-8000-000000000002';
const admission = () => ({ userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() });
const signal = () => new AbortController().signal;
const reply = (body: unknown, status = 409) => new Response(stringifyApiJson(body), { status, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
afterEach(() => vi.unstubAllGlobals());

describe('explicit recursive cancellation transport', () => {
  it('sends exact int64 version and true once after explicit intent', async () => {
    const version = 9_007_199_254_740_993n;
    const detail = detailFixture(project, task, { status: 'cancelled', cancelledAt: '2026-11-24T00:00:00Z', version: version + 1n });
    const fetcher = vi.fn().mockResolvedValue(reply(detail, 200)); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus(project, task, 'cancelled', version, signal(), admission(), true)).resolves.toEqual(detail);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1].body).toBe(`{"version":${version},"status":"cancelled","cancelDescendants":true}`);
  });
  it.each(['invalid_input', 'task_unfinished_children'])('preserves %s rejection and never downgrades or retries', async code => {
    const fetcher = vi.fn().mockResolvedValue(reply({ error: { code, message: 'Rejected', requestId: 'cancel-request', details: { taskIds: [child] } } })); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus(project, task, 'cancelled', 1n, signal(), admission(), true)).rejects.toMatchObject({ kind: 'server', code, taskIds: [child] });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects recursive intent for a non-cancellation before dispatch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus(project, task, 'done', 1n, signal(), admission(), true)).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps network response loss unknown and never resends', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Lost response')); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus(project, task, 'cancelled', 1n, signal(), admission(), true)).rejects.toMatchObject({ kind: 'network' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects malformed blocker IDs while retaining protocol failure', async () => {
    const fetcher = vi.fn().mockResolvedValue(reply({ error: { code: 'task_unfinished_children', message: 'Rejected', requestId: 'cancel-request', details: { taskIds: ['bad-id'] } } })); vi.stubGlobal('fetch', fetcher);
    await expect(setTaskStatus(project, task, 'cancelled', 1n, signal(), admission(), true)).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
