import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { browseWorkerDirectory, parseWorkerReadonlyResponse, requestWorkerReadonly, type WorkerReadonlyAdmission } from '../src/api/worker-readonly';

const ownerUserId = '11111111-1111-4111-8111-111111111111';
const workerId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const capabilityGeneration = '55555555-5555-4555-8555-555555555555';
const binding = { ownerUserId, workerId, connectionId, capabilityGeneration };
const result = () => ({ path: '/worker', parentPath: '/', entries: [{ name: 'project', path: '/worker/project' }], nextCursor: null });
const envelope = () => ({ type: 'result', protocol: 'daynight.worker-readonly.v1', ...binding, requestId, result: result() });
const admission = (): WorkerReadonlyAdmission => ({ userId: ownerUserId, onPrincipalMismatch: vi.fn() });
const response = (value: unknown, principal = ownerUserId, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const signal = () => new AbortController().signal;
const parse = (value: unknown) => parseWorkerReadonlyResponse(value, 'directory.list', { ownerUserId, workerId, requestId });

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Worker read-only directory client', () => {
  it('sends only the bound Worker query and retains its connection identity', async () => {
    const fetch = vi.fn().mockResolvedValue(response(envelope()));
    vi.stubGlobal('fetch', fetch);
    const input = { path: '/worker', filter: 'pro', showHidden: true, limit: 20, cursor: 'opaque' };
    expect(await browseWorkerDirectory(workerId, input, signal(), admission(), { requestId })).toEqual(envelope());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/me/workers/${workerId}/readonly/requests`);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ requestId, operation: 'directory.list', input });
  });
  it('generates a new request identity without filling in a default path', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => response({ ...envelope(), requestId: JSON.parse(String(init.body)).requestId })));
    const value = await requestWorkerReadonly(workerId, 'directory.list', {}, signal(), admission());
    expect(value.requestId).toMatch(/^[\da-f-]{36}$/);
    expect(value.result).toEqual(result());
  });
  it('accepts remote Windows paths without interpreting the browser platform', () => {
    const value = { ...envelope(), result: { path: 'C:\\Users', parentPath: 'C:\\', entries: [{ name: 'person', path: 'C:\\Users\\person' }], nextCursor: 'opaque' } };
    expect(parse(value)).toEqual(value);
  });
  it('distinguishes empty directories from every reported Worker failure', async () => {
    const empty = { ...envelope(), result: { ...result(), entries: [] } };
    expect(parse(empty).result.entries).toEqual([]);
    for (const code of ['offline', 'unsupported', 'permission_denied', 'not_found', 'timeout', 'cancelled', 'invalid_path', 'invalid_cursor', 'io_error', 'busy', 'limit_exceeded']) {
      const { result: _result, ...base } = envelope();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...base, error: { code, message: 'Directory request failed.' } })));
      await expect(browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId })).rejects.toMatchObject({ code });
    }
  });
  it('rejects wrong owner, Worker, request, connection and capability generations', () => {
    for (const key of ['ownerUserId', 'workerId', 'requestId']) expect(() => parse({ ...envelope(), [key]: connectionId })).toThrow();
    for (const key of ['connectionId', 'capabilityGeneration']) expect(() => parse({ ...envelope(), [key]: 'invalid' })).toThrow();
    expect(() => parseWorkerReadonlyResponse(envelope(), 'directory.list', { ownerUserId, workerId, requestId, binding: { connectionId: requestId, capabilityGeneration } })).toThrow();
    expect(() => parseWorkerReadonlyResponse(envelope(), 'directory.list', { ownerUserId, workerId, requestId, binding: { connectionId, capabilityGeneration: requestId } })).toThrow();
  });
  it('rejects malformed and oversized successful data', () => {
    const values = [null, {}, { ...envelope(), extra: true }, { ...envelope(), protocol: 'v2' }, { ...envelope(), type: 'request' },
      { ...envelope(), error: { code: 'io_error', message: 'failed' } }, { ...envelope(), result: null },
      { ...envelope(), result: { ...result(), entries: Array.from({ length: 101 }, (_, i) => ({ name: String(i), path: `/worker/${i}` })) } },
      { ...envelope(), result: { ...result(), entries: [result().entries[0], result().entries[0]] } },
      { ...envelope(), result: { ...result(), path: 'relative' } },
      { ...envelope(), result: { ...result(), entries: [{ name: '../escape', path: '/escape' }] } },
      { ...envelope(), result: { ...result(), nextCursor: '' } },
      { ...envelope(), result: { ...result(), entries: Array.from({ length: 100 }, (_, i) => ({ name: String(i), path: `/worker/${'x'.repeat(1000)}${i}` })) } },
    ];
    for (const value of values) expect(() => parse(value)).toThrow();
  });
  it('rejects invalid query fields before sending a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const input of [{ limit: 101 }, { limit: 0 }, { path: 'relative' }, { filter: '\0' }, { showHidden: 'true' }, { cursor: '' }, { extra: true }]) {
      await expect(browseWorkerDirectory(workerId, input as never, signal(), admission())).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks the response principal before reading directory data', async () => {
    const gate = admission();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(envelope(), connectionId)));
    await expect(browseWorkerDirectory(workerId, {}, signal(), gate, { requestId })).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it('preserves standard routing errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ error: { code: 'forbidden', message: 'Denied', requestId: 'routing' } }, ownerUserId, 403)));
    await expect(browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId })).rejects.toMatchObject({ kind: 'server', code: 'forbidden', status: 403 });
  });
  it.each(['cancel', 'account'])('discards a body invalidated between chunks: %s', async kind => {
    const controller = new AbortController(), bytes = new TextEncoder().encode(JSON.stringify(envelope()));
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({ pull(stream) {
      if (chunk++ === 0) { stream.enqueue(bytes.slice(0, 20)); return; }
      if (kind === 'cancel') controller.abort(); else invalidateAuthRequests();
      stream.enqueue(bytes.slice(20)); stream.close();
    } }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': ownerUserId } })));
    await expect(browseWorkerDirectory(workerId, {}, controller.signal, admission(), { requestId })).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunk).toBe(2);
  });
  it('starts the network deadline after authentication waiting ends', async () => {
    vi.useFakeTimers();
    const release = pauseAuthRequests(), fetch = vi.fn().mockResolvedValue(response(envelope()));
    vi.stubGlobal('fetch', fetch);
    const pending = browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId });
    await vi.advanceTimersByTimeAsync(24_000);
    expect(fetch).not.toHaveBeenCalled();
    release();
    expect(await pending).toEqual(envelope());
  });
  it('discards responses after account invalidation and form replacement', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { invalidateAuthRequests(); return response(envelope()); }));
    await expect(browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId })).rejects.toMatchObject({ name: 'AbortError' });
    let current = true;
    vi.stubGlobal('fetch', vi.fn(async () => { current = false; return response(envelope()); }));
    await expect(browseWorkerDirectory(workerId, {}, signal(), { ...admission(), isCurrent: () => current }, { requestId })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('bounds incoming body bytes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('x'.repeat(256 * 1024))));
    await expect(browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId })).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('cancels a stalled response body on its deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': ownerUserId } })));
    const pending = browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts a stalled fetch on its deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))));
    const pending = browseWorkerDirectory(workerId, {}, signal(), admission(), { requestId });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(12_000);
    await assertion;
  });
});
