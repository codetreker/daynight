import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { getThreadPage, isThreadScopeLoss, postThreadMessage, ThreadPostError, THREAD_REQUEST_TIMEOUT_MS, type ThreadAdmission } from '../src/features/task-thread/api';
import { mergeThreadMessage, parseThreadMessage, parseThreadPage, THREAD_MESSAGE_BYTES, type ThreadMessage, type ThreadScope } from '../src/features/task-thread/contract';
import { readThreadJsonSource } from '../src/features/task-thread/json';

const scope: ThreadScope = {
  userId: '10000000-0000-0000-0000-000000000001',
  projectId: '20000000-0000-0000-0000-000000000002',
  taskId: '30000000-0000-0000-0000-000000000003',
};
const id = (number: number): string => `40000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
const message = (number = 1): ThreadMessage => ({
  id: id(number), author: { userId: scope.userId, displayName: null, Agent: false },
  body: '  hello\n\n```ts\n  const value = 1;\n```\n ', createdAt: '2026-11-04T10:20:30.000Z',
});
const page = (items: readonly ThreadMessage[] = [message()]) => ({ items, hasMoreBefore: false, hasMoreAfter: false });
const admission = (overrides: Partial<ThreadAdmission> = {}): ThreadAdmission => ({ assertCurrent: vi.fn(), onPrincipalMismatch: vi.fn(), ...overrides });
const response = (value: unknown, status = 200, userId = scope.userId): Response => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId },
});
const errorResponse = (status: number, code: string): Response => response({ error: { code, requestId: 'thread-request', message: 'A safe failure.' } }, status);
const signal = (): AbortSignal => new AbortController().signal;
const fetchResponse = (value: Response) => {
  const fetch = vi.fn().mockResolvedValue(value);
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Thread contract shared with CLI', () => {
  it('preserves nullable and empty names, raw bodies and historical provider snapshots', async () => {
    const human = message();
    const agent: ThreadMessage = { ...message(2), author: { ...human.author, displayName: '  ', Agent: true,
      execution: { claimId: id(7), workerId: id(8), provider: 'codex' } } };
    fetchResponse(response(page([human, agent])));
    expect(await getThreadPage(scope, { count: 50 }, signal(), admission())).toEqual(page([human, agent]));
    expect(parseThreadMessage(JSON.stringify({ ...human, author: { ...human.author, displayName: '' } })).author.displayName).toBe('');
  });

  it.each([
    (value: ThreadMessage) => ({ ...value, id: value.id.toUpperCase().replace('4', 'A') }),
    (value: ThreadMessage) => ({ ...value, createdAt: '2026-11-04T10:20:30Z' }),
    (value: ThreadMessage) => ({ ...value, createdAt: '2026-02-30T10:20:30.000Z' }),
    (value: ThreadMessage) => ({ ...value, author: { userId: scope.userId, Agent: false } }),
    (value: ThreadMessage) => ({ ...value, author: { ...value.author, Agent: 'false' } }),
    (value: ThreadMessage) => ({ ...value, replyTo: null }),
    (value: ThreadMessage) => ({ ...value, body: '\ud800' }),
    (value: ThreadMessage) => ({ ...value, body: ' \n\t' }),
    (value: ThreadMessage) => ({ ...value, body: 'bad\0text' }),
  ])('rejects invalid immutable fields %#', (change) => {
    expect(() => parseThreadMessage(JSON.stringify(change(message())))).toThrow(ApiError);
  });

  it('rejects duplicate source fields, count violations, descending pages and wrong boundary sides', () => {
    const source = JSON.stringify(page());
    expect(() => parseThreadPage(source.replace('"Agent":false', '"Agent":false,"Agent":true'), { count: 50 })).toThrow(ApiError);
    expect(() => parseThreadPage(JSON.stringify(page([message(2), message(1)])), { count: 50 })).toThrow(ApiError);
    expect(() => parseThreadPage(JSON.stringify(page([message(1), message(2)])), { count: 1 })).toThrow(ApiError);
    expect(() => parseThreadPage(JSON.stringify(page([message(1)])), { count: 50, afterId: id(2) }, message(2))).toThrow(ApiError);
    expect(() => parseThreadPage(JSON.stringify({ items: [], hasMoreBefore: true, hasMoreAfter: false }), { count: 50 })).toThrow(ApiError);
  });

  it('preserves a complete count-selected page of four 64 KiB messages', async () => {
    const items = [1, 2, 3, 4].map((number) => {
      const item = { ...message(number), body: '' };
      return { ...item, body: 'a'.repeat(THREAD_MESSAGE_BYTES - new TextEncoder().encode(JSON.stringify(item)).byteLength) };
    });
    const value = { ...page(items), hasMoreAfter: true };
    const source = JSON.stringify(value);
    for (const item of items) expect(new TextEncoder().encode(JSON.stringify(item)).byteLength).toBe(THREAD_MESSAGE_BYTES);
    expect(new TextEncoder().encode(source).byteLength).toBeGreaterThan(262_144);
    expect(parseThreadPage(source, { count: 4 })).toEqual(value);
    const fetch = fetchResponse(response(value));
    await expect(getThreadPage(scope, { count: 4 }, signal(), admission())).resolves.toEqual(value);
    fetch.mockResolvedValueOnce(response(page([message(5)])));
    await expect(getThreadPage(scope, { count: 4, afterId: id(4) }, signal(), admission({ boundary: items[3]! }))).resolves.toEqual(page([message(5)]));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toContain(`afterId=${id(4)}`);
    fetch.mockResolvedValueOnce(response({ ...value, items: [...items.slice(0, 3), { ...items[3]!, createdAt: 'invalid' }] }));
    await expect(getThreadPage(scope, { count: 4 }, signal(), admission())).rejects.toBeInstanceOf(ApiError);
  });

  it('only enriches matching immutable messages', () => {
    const base = { ...message(), author: { ...message().author, Agent: true } };
    const detailed = { ...base, author: { ...base.author, execution: { claimId: id(7), workerId: id(8), provider: 'codex' as const } } };
    expect(mergeThreadMessage(base, detailed)).toBe(detailed);
    expect(mergeThreadMessage(detailed, base)).toBe(detailed);
    expect(() => mergeThreadMessage(base, { ...detailed, body: 'conflict' })).toThrow(ApiError);
    expect(() => mergeThreadMessage(detailed, { ...detailed, author: { ...detailed.author, execution: { ...detailed.author.execution, provider: 'claude' } } })).toThrow(ApiError);
  });
});

describe('bounded Thread transport', () => {
  it('uses the existing authenticated transport and always requests detailed pages', async () => {
    const fetch = fetchResponse(response(page()));
    await getThreadPage(scope, { count: 1, beforeId: id(2) }, signal(), admission());
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/v1/projects/${scope.projectId}/tasks/${scope.taskId}/thread/messages?count=1&details=true&beforeId=${id(2)}`);
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    expect(init.headers).toMatchObject({ 'Daynight-Worker-Protocol': '2' });
  });

  it('cancels a Thread response being read with the original network reason', async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const cancelled = vi.fn();
    let dispatched!: AbortSignal;
    const stream = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel: cancelled }, { highWaterMark: 0 });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      dispatched = init.signal as AbortSignal;
      return new Response(stream, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': scope.userId } });
    }));
    const pending = getThreadPage(scope, { count: 50 }, signal(), admission());
    await reading;
    cancelAuthNetworkRequests();
    await expect(pending).rejects.toBe(dispatched.reason);
    expect(cancelled).toHaveBeenCalledWith(dispatched.reason);
  });

  it('keeps a confirmed Thread receipt when its callback cancels the network lifetime', async () => {
    const posted = message();
    const fetch = fetchResponse(response(posted, 201));
    const onConfirmed = vi.fn(() => cancelAuthNetworkRequests());
    const pending = postThreadMessage(scope, { body: posted.body }, signal(), admission({ onConfirmed }));
    const error = await pending.catch((value: unknown) => value);
    expect(error).toBe((fetch.mock.calls[0]![1].signal as AbortSignal).reason);
    expect(onConfirmed).toHaveBeenCalledWith(posted);
  });

  it('rejects overlong or malformed UTF-8 streams and cancels retained responses', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel: cancelled });
    await expect(readThreadJsonSource(new Response(stream, { headers: { 'Content-Type': 'application/json' } }), signal(), 2)).rejects.toBeInstanceOf(ApiError);
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(readThreadJsonSource(new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } }), signal(), 10)).rejects.toBeInstanceOf(ApiError);
    await expect(readThreadJsonSource(new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '11' } }), signal(), 10)).rejects.toBeInstanceOf(ApiError);
  });

  it('fences retired responses before principal mismatch can affect another account', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    let live = true;
    const onPrincipalMismatch = vi.fn();
    const pending = getThreadPage(scope, { count: 50 }, signal(), admission({
      assertCurrent: () => { if (!live) throw new DOMException('Retired.', 'AbortError'); }, onPrincipalMismatch,
    }));
    live = false;
    resolve(response(page(), 200, id(99)));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(onPrincipalMismatch).not.toHaveBeenCalled();
  });

  it('notifies a live principal mismatch and treats only validated parent errors as scope loss', async () => {
    const onPrincipalMismatch = vi.fn();
    fetchResponse(response(page(), 200, id(99)));
    await expect(getThreadPage(scope, { count: 50 }, signal(), admission({ onPrincipalMismatch }))).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(onPrincipalMismatch).toHaveBeenCalledOnce();
    for (const [status, code, scopeLoss] of [[403, 'forbidden', true], [404, 'not_found', true], [410, 'task_deleted', true], [404, 'message_not_found', false]] as const) {
      fetchResponse(errorResponse(status, code));
      const error = await getThreadPage(scope, { count: 50 }, signal(), admission()).catch((value: unknown) => value);
      expect(isThreadScopeLoss(error)).toBe(scopeLoss);
    }
    fetchResponse(response({ error: { code: 'not_found' } }, 404));
    const malformed = await getThreadPage(scope, { count: 50 }, signal(), admission()).catch((value: unknown) => value);
    expect(malformed).toBeInstanceOf(ApiError);
    expect(isThreadScopeLoss(malformed)).toBe(false);
  });

  it('rejects retired error responses after decoding without publishing scope loss', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
    fetchResponse(new Response(stream, { status: 404, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': scope.userId } }));
    let live = true;
    let checks = 0;
    let headersChecked!: () => void;
    const readingBody = new Promise<void>((resolve) => { headersChecked = resolve; });
    const pending = getThreadPage(scope, { count: 50 }, signal(), admission({
      assertCurrent: () => { if (!live) throw new DOMException('Retired.', 'AbortError'); if (++checks === 2) headersChecked(); },
    }));
    await readingBody;
    live = false;
    body.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: 'not_found', requestId: 'old-request', message: 'Missing.' } })));
    body.close();
    const error = await pending.catch((value: unknown) => value);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(isThreadScopeLoss(error)).toBe(false);
  });
});

describe('Thread post outcomes', () => {
  it('posts raw human body/reply only and confirms before returning', async () => {
    const posted = { ...message(), replyTo: id(2) };
    const fetch = fetchResponse(response(posted, 201));
    const onConfirmed = vi.fn();
    expect(await postThreadMessage(scope, { body: posted.body, replyTo: posted.replyTo }, signal(), admission({ onConfirmed }))).toEqual(posted);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ body: posted.body, replyTo: posted.replyTo });
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith(posted);
  });

  it.each([[400, 'invalid_input', 'refused'], [404, 'message_not_found', 'refused'], [413, 'payload_too_large', 'refused'],
    [503, 'clock_not_advanced', 'refused'], [503, 'message_outcome_unknown', 'unknown'], [503, 'internal_error', 'unknown'], [500, 'internal_error', 'unknown']] as const)
  ('classifies %i %s as %s without replay', async (status, code, outcome) => {
    const fetch = fetchResponse(errorResponse(status, code));
    await expect(postThreadMessage(scope, { body: message().body }, signal(), admission())).rejects.toMatchObject({ outcome, cause: { code } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    response({ ...message(), body: 'wrong' }, 201),
    response({ ...message(), author: { ...message().author, Agent: true } }, 201),
    response(message(), 200),
    response({ error: { code: 'invalid_input' } }, 400),
  ])('keeps unverified dispatched results unknown %#', async (value) => {
    fetchResponse(value);
    const onConfirmed = vi.fn();
    await expect(postThreadMessage(scope, { body: message().body }, signal(), admission({ onConfirmed }))).rejects.toMatchObject({ outcome: 'unknown' });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('keeps local rejection and cancelled auth waits not_sent', async () => {
    const fetch = fetchResponse(response(message(), 201));
    await expect(postThreadMessage(scope, { body: '\0' }, signal(), admission())).rejects.toMatchObject({ outcome: 'not_sent' });
    expect(fetch).not.toHaveBeenCalled();
    const resume = pauseAuthRequests();
    const abort = new AbortController();
    const pending = postThreadMessage(scope, { body: message().body }, abort.signal, admission());
    abort.abort();
    await expect(pending).rejects.toMatchObject({ outcome: 'not_sent' });
    resume();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts the network deadline after auth waiting and stops it at confirmed201', async () => {
    vi.useFakeTimers();
    const resume = pauseAuthRequests();
    const fetch = fetchResponse(response(message(), 201));
    const onConfirmed = vi.fn();
    const pending = postThreadMessage(scope, { body: message().body }, signal(), admission({ onConfirmed }));
    await vi.advanceTimersByTimeAsync(THREAD_REQUEST_TIMEOUT_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
    resume();
    await expect(pending).resolves.toEqual(message());
    expect(onConfirmed).toHaveBeenCalledOnce();
    const dispatchedSignal = fetch.mock.calls[0]![1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(THREAD_REQUEST_TIMEOUT_MS * 2);
    expect(dispatchedSignal.aborted).toBe(false);
  });

  it('classifies a dispatched network deadline as unknown', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const pending = postThreadMessage(scope, { body: message().body }, signal(), admission());
    const expectation = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    await vi.advanceTimersByTimeAsync(THREAD_REQUEST_TIMEOUT_MS);
    await expectation;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('bounds response-body waiting after headers have arrived', async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled });
    fetchResponse(new Response(stream, { status: 201, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': scope.userId } }));
    const pending = postThreadMessage(scope, { body: message().body }, signal(), admission());
    const expectation = expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    await vi.advanceTimersByTimeAsync(THREAD_REQUEST_TIMEOUT_MS);
    await expectation;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('preserves local callback errors after remote confirmation', async () => {
    vi.useFakeTimers();
    const fetch = fetchResponse(response(message(), 201));
    const localFailure = new Error('The local window was retired.');
    await expect(postThreadMessage(scope, { body: message().body }, signal(), admission({ onConfirmed: () => { throw localFailure; } }))).rejects.toBe(localFailure);
    await vi.advanceTimersByTimeAsync(THREAD_REQUEST_TIMEOUT_MS * 2);
    expect((fetch.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(false);
  });
});
