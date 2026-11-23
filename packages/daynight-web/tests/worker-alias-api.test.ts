import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { getWorkerAlias, normalizeWorkerAlias, parseWorkerAlias, saveWorkerAlias } from '../src/api/worker-alias';
import { getWorker, listWorkers, parseWorkerDetail, parseWorkerPage } from '../src/api/workers';
import { WORKER_USER, workerDetail, workerId, workerPage, workerResponse, workerSummary } from './helpers/workers';

const admission = { userId: WORKER_USER, onPrincipalMismatch: vi.fn() };
const signal = () => new AbortController().signal;
const response = (value: unknown) => {
  const result = workerResponse(value); result.headers.set('Daynight-Worker-Alias', '1'); return result;
};
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Worker alias protocol', () => {
  it('normalizes Unicode spaces, retains emoji and counts scalar values', () => {
    expect(normalizeWorkerAlias('\u2003 办公室 Windows \u2003')).toBe('办公室 Windows');
    expect(normalizeWorkerAlias('👩‍💻'.repeat(26))).toBe('👩‍💻'.repeat(26));
    expect(normalizeWorkerAlias('😀'.repeat(80))).toBe('😀'.repeat(80));
    for (const value of ['', ' \u2003', '\ud800', '😀'.repeat(81), 'x\n', '\tx', '\u0085x', 'a\u2028b', 'a\u2029b', '\ufeffx', '\u061cx', 'a\u200fb', '\u202ex', 'a\u2069b']) expect(normalizeWorkerAlias(value)).toBeNull();
  });
  it('only accepts complete canonical alias resources', () => {
    expect(parseWorkerAlias({ value: null, version: '1' })).toEqual({ value: null, version: '1' });
    expect(parseWorkerAlias({ value: '<b>办公室</b>', version: '9223372036854775807' }).value).toBe('<b>办公室</b>');
    for (const value of [null, {}, { value: 'x', version: '0' }, { value: 'x', version: '01' }, { value: 'x', version: 1 },
      { value: 'x', version: '9223372036854775808' }, { value: '', version: '1' }, { value: ' x ', version: '1' }, { value: null, version: '1', extra: true }]) expect(() => parseWorkerAlias(value)).toThrow();
  });
  it('negotiates exact list/detail fields while retaining legacy reads', async () => {
    const alias = { value: '办公室 Windows', version: '2' };
    const page = workerPage([{ ...workerSummary(), alias }]);
    const detail = workerDetail(); detail.worker.alias = alias;
    expect(() => parseWorkerPage(page)).toThrow();
    expect(parseWorkerPage(page, true)).toEqual(page);
    expect(() => parseWorkerPage(workerPage(), true)).toThrow();
    expect(() => parseWorkerDetail(detail, workerId(1))).toThrow();
    expect(parseWorkerDetail(detail, workerId(1), false, true)).toEqual(detail);
    const fetch = vi.fn().mockResolvedValueOnce(response(page)).mockResolvedValueOnce(response(detail)).mockResolvedValueOnce(workerResponse(workerPage()));
    vi.stubGlobal('fetch', fetch);
    expect(await listWorkers({}, signal(), admission)).toEqual(page);
    expect(await getWorker(workerId(1), signal(), admission)).toEqual(detail);
    expect(await listWorkers({}, signal(), admission)).toEqual(workerPage());
    for (const call of fetch.mock.calls) expect(call[1].headers).toHaveProperty('Daynight-Worker-Alias', '1');
  });
  it('rejects unknown negotiation versions and unsolicited or missing metadata', async () => {
    const invalidVersion = response(workerPage()); invalidVersion.headers.set('Daynight-Worker-Alias', '2');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(invalidVersion).mockResolvedValueOnce(response(workerPage()))
      .mockResolvedValueOnce(workerResponse(workerPage([{ ...workerSummary(), alias: { value: null, version: '1' } }]))));
    for (let i = 0; i < 3; i++) await expect(listWorkers({}, signal(), admission)).rejects.toThrow();
  });
  it('binds PUT to the canonical Worker and exact observed version, with explicit null clearing', async () => {
    const alias = { value: '办公室', version: '2' };
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse({ workerId: workerId(1), alias }))
      .mockResolvedValueOnce(workerResponse({ workerId: workerId(1), alias: { value: null, version: '3' } }))
      .mockResolvedValueOnce(workerResponse({ workerId: workerId(1), alias }));
    vi.stubGlobal('fetch', fetch);
    const dispatch = vi.fn();
    expect(await saveWorkerAlias(workerId(1).toUpperCase(), '办公室', '1', signal(), admission, dispatch)).toEqual(alias);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ value: '办公室', expectedVersion: '1' });
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/workers/${workerId(1)}/alias`);
    await saveWorkerAlias(workerId(1), null, '2', signal(), admission, dispatch);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ value: null, expectedVersion: '2' });
    expect(await getWorkerAlias(workerId(1), signal(), admission)).toEqual(alias);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[2]![1].method).toBe('GET');
  });
  it('refuses invalid writes before dispatch and rejects foreign resources or principals', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(workerResponse({ workerId: workerId(2), alias: { value: null, version: '1' } }))
      .mockResolvedValueOnce(workerResponse({ workerId: workerId(1), alias: { value: null, version: '1' } }, workerId(8)));
    vi.stubGlobal('fetch', fetch);
    for (const name of ['', ' x ', 'a\n']) await expect(saveWorkerAlias(workerId(1), name, '1', signal(), admission, vi.fn())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(getWorkerAlias(workerId(1), signal(), admission)).rejects.toThrow();
    await expect(getWorkerAlias(workerId(1), signal(), admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(admission.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it('rejects mismatched save receipts rather than presenting another alias as saved', async () => {
    const fetch = vi.fn();
    for (const alias of [{ value: 'other', version: '2' }, { value: 'mine', version: '1' }, { value: 'mine', version: '4' }]) fetch.mockResolvedValueOnce(receiptFor(alias));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 3; i++) await expect(saveWorkerAlias(workerId(1), 'mine', '2', signal(), admission, vi.fn())).rejects.toThrow();
  });
});

const receiptFor = (alias: { readonly value: string; readonly version: string }) => workerResponse({ workerId: workerId(1), alias });
