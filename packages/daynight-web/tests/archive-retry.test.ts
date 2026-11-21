import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveRetryDelay } from '../src/api/archive-retry';
import { cancelAuthNetworkRequests, invalidateAuthRequests } from '../src/api/client';
import { createTestSessionApi } from '../src/api/sessions';
import { createTerminalSessionApi } from '../src/api/terminal-sessions';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = id(3), fence = { sessionId: id(1), testExecutionId: id(2), executionGeneration: '1' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const legacy = { schemaVersion: 1, ...fence, controllerId: id(6), controllerInstanceId: id(7), provider: 'codex', nativeSessionId: null, entries: [], resources: [] };
const timeline = JSON.stringify({ entries: [] });
const manifest = { schemaVersion: 3, contentKind: 'native_timeline', recordId: fence.sessionId, fence, provider: 'codex', nativeSessionId: null, controllerId: id(6), controllerInstanceId: id(7), timeline: { fileId: id(8), byteLength: String(Buffer.byteLength(timeline)), sha256: hash(timeline) }, resources: [], completeness: 'complete' };
const manifestBytes = JSON.stringify(manifest);
const manifestStatus = { state: 'ready' as const, schemaVersion: 3 as const, sha256: hash(manifestBytes), byteLength: String(Buffer.byteLength(manifestBytes)), errorCode: null, completeness: 'complete' as const };
const terminal = JSON.parse(readFileSync('../daynight/test/session/fixtures/v2/valid-archive.json', 'utf8'));
const terminalBytes = JSON.stringify(terminal), terminalOwner = terminal.owner;
const terminalStatus = JSON.parse(readFileSync('../daynight/test/session/fixtures/v2/valid-status.json', 'utf8'));
terminalStatus.payload = { ...terminalStatus.payload, sha256: hash(terminalBytes), byteLength: String(Buffer.byteLength(terminalBytes)), completeness: terminal.completeness, finalizationId: terminal.finalizationId };
const terminalItem = { sessionId: terminal.sessionId, claimId: terminal.claimId, executionGeneration: terminal.executionGeneration, agentControlMode: 'herdr' as const };
const response = (body: unknown, principal: string | null = user, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(principal === null ? {} : { 'Daynight-User-ID': principal }), ...extra } });
const busy = (principal: string | null = user, extra: Record<string, string> = {}) => response({ error: { code: 'resource_busy', message: 'busy', requestId: 'request-1' } }, principal, 429, extra);
const native = (mismatch = vi.fn()) => createTestSessionApi(fence.sessionId, user, mismatch);
const signal = () => new AbortController().signal;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')); vi.spyOn(Math, 'random').mockReturnValue(0.5); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('archive capacity retry', () => {
  it('uses the six agreed capped bases and independent jitter bounds', () => {
    expect(Array.from({ length: 6 }, (_, attempt) => archiveRetryDelay(attempt, 0.5))).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect(Array.from({ length: 6 }, (_, attempt) => archiveRetryDelay(attempt, 0))).toEqual([800, 1600, 3200, 6400, 8000, 8000]);
    [1200, 2400, 4800, 9600, 12000, 12000].forEach((value, attempt) => expect(archiveRetryDelay(attempt, 1)).toBeCloseTo(value));
  });
  it('retries legacy content after an early 429 without a principal', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(busy(null)).mockResolvedValueOnce(response({ archive: legacy })); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual(legacy);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([expect.stringMatching(/\/archive\/content$/), expect.stringMatching(/\/archive\/content$/)]);
  });

  it('retries only the timeline file and shares the budget without rereading the validated manifest', async () => {
    let contentReads = 0, fileReads = 0; const times: number[] = [];
    let fileStarted!: () => void; const firstFile = new Promise<void>(resolve => { fileStarted = resolve; });
    const fetch = vi.fn(async (url: string) => {
      times.push(Date.now());
      if (url.endsWith('/archive/content')) return ++contentReads === 1 ? busy() : response(manifest);
      if (url.includes('/archive/files/')) { fileStarted(); return ++fileReads === 1 ? busy() : response(JSON.parse(timeline)); }
      throw new Error(`Unexpected request ${url}`);
    }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal(), manifestStatus);
    await vi.advanceTimersByTimeAsync(1000);
    await firstFile; await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ schemaVersion: 3, entries: [] });
    expect(contentReads).toBe(2); expect(fileReads).toBe(2);
    expect(times.map(t => t - times[0]!)).toEqual([0, 1000, 1000, 2000]);
  });

  it('retries Herdr content after its status has been read', async () => {
    let contents = 0;
    const fetch = vi.fn(async (url: string) => url.endsWith('/archive') ? response(terminalStatus, terminalOwner.ownerUserId) : ++contents === 1 ? busy(null) : response(terminal, terminalOwner.ownerUserId)); vi.stubGlobal('fetch', fetch);
    const api = createTerminalSessionApi(terminalOwner.projectId, terminalOwner.taskId, terminalOwner.ownerUserId, vi.fn(), terminalOwner.serverOrigin);
    const result = api.archive(terminalItem, signal()); await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ archive: terminal });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([expect.stringMatching(/\/archive$/), expect.stringMatching(/\/archive\/content$/), expect.stringMatching(/\/archive\/content$/)]);
  });

  it('uses exponential delays and stops after four retries for the whole load', async () => {
    const times: number[] = []; const fetch = vi.fn(async () => { times.push(Date.now()); return busy(); }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal()).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ kind: 'server', status: 429, code: 'resource_busy' });
    expect(times.map(t => t - times[0]!)).toEqual([0, 1000, 3000, 7000, 15000]);
  });

  it('keeps the retry count across successful manifest and timeline requests', async () => {
    let contentReads = 0, fileReads = 0;
    let fileStarted!: () => void; const firstFile = new Promise<void>(resolve => { fileStarted = resolve; });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/archive/content')) return ++contentReads <= 3 ? busy() : response(manifest);
      if (url.includes('/archive/files/')) { fileStarted(); fileReads++; return busy(); }
      throw new Error(`Unexpected request ${url}`);
    }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal(), manifestStatus).catch(error => error);
    await vi.advanceTimersByTimeAsync(7000);
    await firstFile; await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ kind: 'server', status: 429, code: 'resource_busy' });
    expect(contentReads).toBe(4); expect(fileReads).toBe(2);
  });

  it.each([[0, 800], [1, 1200]] as const)('samples jitter at random=%s', async (random, delay) => {
    vi.mocked(Math.random).mockReturnValue(random); const times: number[] = [];
    const fetch = vi.fn(async () => { times.push(Date.now()); return times.length === 1 ? busy() : response({ archive: legacy }); }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal()); await vi.advanceTimersByTimeAsync(delay);
    await expect(result).resolves.toEqual(legacy); expect(times[1]! - times[0]!).toBe(delay);
  });

  it('honors Retry-After and returns the busy error when the hint exceeds the limit', async () => {
    const times: number[] = [];
    const fetch = vi.fn(async () => { times.push(Date.now()); return times.length === 1 ? busy(user, { 'Retry-After': '3' }) : response({ archive: legacy }); }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal()); await vi.advanceTimersByTimeAsync(3000);
    await expect(result).resolves.toEqual(legacy); expect(times[1]! - times[0]!).toBe(3000);
    fetch.mockReset().mockResolvedValue(busy(user, { 'Retry-After': '13' }));
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ status: 429, code: 'resource_busy' }); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['IMF-fixdate', 'Thu, 01 Jan 2026 00:00:03 GMT', 'Thu, 01 Foo 2026 00:00:03 GMT', 'Thu, 01 Jan 2026 00:00:13 GMT'],
    ['RFC 850', 'Thursday, 01-Jan-26 00:00:03 GMT', 'Thursday, 01-Foo-26 00:00:03 GMT', 'Thursday, 01-Jan-26 00:00:13 GMT'],
    ['asctime', 'Thu Jan  1 00:00:03 2026', 'Thu Foo  1 00:00:03 2026', 'Thu Jan  1 00:00:13 2026'],
  ])('handles %s Retry-After dates, invalid dates and hints over the limit', async (_format, valid, invalid, excessive) => {
    const times: number[] = [];
    const fetch = vi.fn(async () => { times.push(Date.now()); return times.length === 1 ? busy(user, { 'Retry-After': valid }) : response({ archive: legacy }); }); vi.stubGlobal('fetch', fetch);
    const accepted = native().archiveContent(fence.sessionId, signal()); await vi.advanceTimersByTimeAsync(3000);
    await expect(accepted).resolves.toEqual(legacy); expect(times[1]! - times[0]!).toBe(3000);

    times.length = 0;
    fetch.mockImplementation(async () => { times.push(Date.now()); return times.length === 1 ? busy(user, { 'Retry-After': invalid }) : response({ archive: legacy }); });
    const ignored = native().archiveContent(fence.sessionId, signal()); await vi.advanceTimersByTimeAsync(1000);
    await expect(ignored).resolves.toEqual(legacy); expect(times[1]! - times[0]!).toBe(1000);

    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fetch.mockReset().mockResolvedValue(busy(user, { 'Retry-After': excessive }));
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ status: 429, code: 'resource_busy' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('stops when the next valid Retry-After exceeds the remaining 30-second budget', async () => {
    const times: number[] = [];
    const fetch = vi.fn(async () => { times.push(Date.now()); return busy(user, { 'Retry-After': times.length < 3 ? '12' : '7' }); }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal()).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ kind: 'server', status: 429, code: 'resource_busy' });
    expect(times.map(t => t - times[0]!)).toEqual([0, 12000, 24000]);
  });

  it('cancels the first unconfirmed 429 body at 30 seconds and reports a protocol error', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); },
      cancel() { cancelled = true; },
    });
    const fetch = vi.fn(async () => new Response(body, { status: 429, headers: { 'Daynight-User-ID': user, 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    let settled = false;
    const result = native().archiveContent(fence.sessionId, signal()).catch(error => error).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(29_999); expect(settled).toBe(false); expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ kind: 'protocol', status: 429 });
    expect(cancelled).toBe(true); expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires a principal for a non-busy 429 and never retries it', async () => {
    const fetch = vi.fn(async () => response({ error: { code: 'rate_limited', message: 'no', requestId: 'request-1' } }, null, 429)); vi.stubGlobal('fetch', fetch);
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ kind: 'protocol', status: 429 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('ends a hanging retry fetch at the deadline with the last busy error', async () => {
    let aborted = false;
    const fetch = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      if (fetch.mock.calls.length === 1) return busy();
      const requestSignal = init!.signal!;
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => { aborted = true; reject(requestSignal.reason); }, { once: true });
      });
    }); vi.stubGlobal('fetch', fetch);
    let settled = false;
    const result = native().archiveContent(fence.sessionId, signal()).catch(error => error).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetch).toHaveBeenCalledTimes(2); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ kind: 'server', status: 429, code: 'resource_busy' });
    expect(aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancels a hanging successful body at the deadline without publishing its archive', async () => {
    let cancelled = false, release!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { release = () => { try { controller.enqueue(new TextEncoder().encode(JSON.stringify({ archive: legacy }))); controller.close(); } catch { /* stream already cancelled */ } }; },
      cancel() { cancelled = true; },
    });
    const fetch = vi.fn(async () => fetch.mock.calls.length === 1 ? busy() : new Response(body, { headers: { 'Daynight-User-ID': user, 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal()).catch(error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ kind: 'server', status: 429, code: 'resource_busy' });
    expect(cancelled).toBe(true); release(); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retains the deadline while a verified manifest is followed by a hanging timeline request', async () => {
    let fileStarted!: () => void; const firstFile = new Promise<void>(resolve => { fileStarted = resolve; });
    let aborted = false;
    const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/archive/content')) return fetch.mock.calls.length === 1 ? busy() : response(manifest);
      if (url.includes('/archive/files/')) {
        fileStarted(); const requestSignal = init!.signal!;
        return new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => { aborted = true; reject(requestSignal.reason); }, { once: true }));
      }
      throw new Error(`Unexpected request ${url}`);
    }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, signal(), manifestStatus).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000); await firstFile;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(await result).toMatchObject({ kind: 'server', status: 429, code: 'resource_busy' });
    expect(aborted).toBe(true); expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves page cancellation instead of reporting the busy deadline', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      if (fetch.mock.calls.length === 1) return busy();
      const requestSignal = init!.signal!;
      return new Promise((_resolve, reject) => requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }));
    }); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(1000); expect(fetch).toHaveBeenCalledTimes(2);
    controller.abort(); await vi.advanceTimersByTimeAsync(29_000);
    expect(await result).toMatchObject({ name: 'AbortError' }); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([429, 403])('rejects an oversized HTTP %i error body without a retry', async status => {
    const fetch = vi.fn(async () => new Response('x'.repeat(65_537), { status, headers: { 'Daynight-User-ID': user, 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('accepts a structured error body exactly at the byte limit', async () => {
    const body = JSON.stringify({ error: { code: 'forbidden', message: 'no', requestId: 'request-1' } });
    const fetch = vi.fn(async () => new Response(body.padEnd(65_536), { status: 403, headers: { 'Daynight-User-ID': user, 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ kind: 'server', status: 403, code: 'forbidden' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([['wrong principal', id(99)], ['invalid principal', 'invalid']] as const)('rejects a busy response with %s without sending again', async (_label, principal) => {
    const mismatch = vi.fn(), fetch = vi.fn(async () => busy(principal)); vi.stubGlobal('fetch', fetch);
    await expect(native(mismatch).archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledOnce(); expect(mismatch).toHaveBeenCalledTimes(principal === id(99) ? 1 : 0);
  });

  it.each([[429, 'rate_limited'], [403, 'forbidden'], [404, 'not_found']] as const)('does not retry HTTP %i with %s', async (status, code) => {
    const fetch = vi.fn(async () => response({ error: { code, message: 'no', requestId: 'request-1' } }, user, status)); vi.stubGlobal('fetch', fetch);
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ kind: 'server', status, code }); expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects a successful response without a principal', async () => {
    const fetch = vi.fn(async () => response({ archive: legacy }, null)); vi.stubGlobal('fetch', fetch);
    await expect(native().archiveContent(fence.sessionId, signal())).rejects.toMatchObject({ kind: 'protocol' }); expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(['page closes', 'account switches', 'network cancels'] as const)('does not send after %s while waiting', async cause => {
    const controller = new AbortController(); const fetch = vi.fn(async () => busy()); vi.stubGlobal('fetch', fetch);
    const result = native().archiveContent(fence.sessionId, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledOnce();
    if (cause === 'page closes') controller.abort();
    else if (cause === 'account switches') invalidateAuthRequests();
    else cancelAuthNetworkRequests();
    await vi.runAllTimersAsync(); expect(await result).toMatchObject({ name: 'AbortError' }); expect(fetch).toHaveBeenCalledOnce();
  });
});
