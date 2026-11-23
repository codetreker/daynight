import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { getWorkerReviewParticipation, saveWorkerReviewParticipation } from '../src/api/worker-review-participation';
import { WORKER_USER, workerId, workerResponse } from './helpers/workers';

const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() };
const signal = () => new AbortController().signal;
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Worker review participation protocol', () => {
  it('sends one scoped write with the exact version and verifies the receipt', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse({ enabled: false, version: '9007199254740993' }))
      .mockResolvedValueOnce(workerResponse({ enabled: true, version: '9007199254740994' }));
    vi.stubGlobal('fetch', fetch);
    expect(await getWorkerReviewParticipation(workerId(1), signal(), admission)).toEqual({ enabled: false, version: '9007199254740993' });
    const dispatch = vi.fn();
    expect(await saveWorkerReviewParticipation(workerId(1), true, '9007199254740993', signal(), admission, dispatch)).toEqual({ enabled: true, version: '9007199254740994' });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([`/api/v1/me/workers/${workerId(1)}/review-participation`, `/api/v1/me/workers/${workerId(1)}/review-participation`]);
    expect(fetch.mock.calls[0]![1].method).toBe('GET');
    expect(fetch.mock.calls[1]![1].method).toBe('PUT');
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ enabled: true, expectedVersion: '9007199254740993' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('rejects malformed state and invalid versions before they can become a baseline', async () => {
    const values = [null, {}, { enabled: 1, version: '1' }, { enabled: false, version: 1 }, { enabled: false, version: '0' }, { enabled: false, version: '01' }, { enabled: false, version: '9223372036854775808' }, { enabled: false, version: '1', extra: true }];
    const fetch = vi.fn(); for (const value of values) fetch.mockResolvedValueOnce(workerResponse(value));
    vi.stubGlobal('fetch', fetch);
    for (const _ of values) await expect(getWorkerReviewParticipation(workerId(1), signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
    const dispatch = vi.fn();
    await expect(saveWorkerReviewParticipation(workerId(1), true, '0', signal(), admission, dispatch)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(values.length); expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects mismatched receipts and never retries a write', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse({ enabled: false, version: '2' }))
      .mockResolvedValueOnce(workerResponse({ enabled: true, version: '1' }))
      .mockResolvedValueOnce(workerResponse({ enabled: true, version: '3' }));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 3; i++) await expect(saveWorkerReviewParticipation(workerId(1), true, '1', signal(), admission, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('accepts a legacy bare 404 as unavailable but rejects an explicit foreign principal', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(workerResponse({ enabled: false, version: '1' }, workerId(8)))
      .mockResolvedValueOnce(workerResponse({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, workerId(8), 404));
    vi.stubGlobal('fetch', fetch);
    await expect(getWorkerReviewParticipation(workerId(1), signal(), admission)).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 2; i++) await expect(getWorkerReviewParticipation(workerId(1), signal(), admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(admission.onPrincipalMismatch).toHaveBeenCalledTimes(2);
  });
});
