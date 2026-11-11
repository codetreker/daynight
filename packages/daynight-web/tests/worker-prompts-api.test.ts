import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import { getWorkerPrompt, isPromptText, parsePromptResource, PROMPT_REQUEST_BYTES, PROMPT_RESPONSE_BYTES, promptSubmissionBytes, saveWorkerPrompt, type PromptResource, type PromptTarget } from '../src/api/worker-prompts';

const userId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const workerId = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-09T10:00:00Z';
const user: PromptTarget = { scope: 'user' };
const admission = () => ({ userId, onPrincipalMismatch: vi.fn(), onDispatch: vi.fn() });
const resource = (scope: PromptResource['scope'] = 'user', scopeId = userId, revision = '0', text = '', updatedAt: string | null = null): PromptResource => ({ scope, scopeId, revision, text, updatedAt });
const response = (body: unknown, status = 200, principal = userId) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const signal = () => new AbortController().signal;
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('prompt resources', () => {
  it('retains Unicode, whitespace and exact newlines with precise decimal revisions', () => {
    const value = resource('user', userId, '9223372036854775807', '  名称\r\n\t<value>&\n', at);
    expect(parsePromptResource(value, user, userId)).toEqual(value);
    expect(parsePromptResource(resource(), user, userId)).toEqual(resource());
    expect(isPromptText(' \t\r\n')).toBe(true);
    expect(isPromptText('\0')).toBe(false);
    expect(isPromptText('\u0085')).toBe(false);
    expect(isPromptText('\ud800')).toBe(false);
  });
  it.each([
    { ...resource(), extra: true }, { ...resource(), scope: 'project' }, { ...resource(), scopeId: projectId },
    { ...resource(), revision: '00' }, { ...resource(), revision: 1 }, { ...resource(), revision: '9223372036854775808' },
    { ...resource(), text: 'not empty' }, { ...resource(), updatedAt: at },
    { ...resource(), revision: '1' }, { ...resource(), revision: '1', updatedAt: 'bad' },
    { ...resource(), revision: '1', updatedAt: at, text: '\0' },
  ])('rejects malformed or inconsistent resource %#', value => {
    expect(() => parsePromptResource(value, user, userId)).toThrow();
  });
});

describe('principal-admitted prompt API', () => {
  it('uses the three independent endpoints and saves the frozen identity and text', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(resource())).mockResolvedValueOnce(response(resource('project', projectId)))
      .mockResolvedValueOnce(response(resource('worker', workerId))).mockResolvedValueOnce(response(resource('worker', workerId, '1', 'line\r\n', at)));
    vi.stubGlobal('fetch', fetch);
    const gate = admission();
    await getWorkerPrompt(user, signal(), gate);
    await getWorkerPrompt({ scope: 'project', projectId }, signal(), gate);
    await getWorkerPrompt({ scope: 'worker', workerId }, signal(), gate);
    expect(await saveWorkerPrompt({ scope: 'worker', workerId }, { expectedUserId: userId, revision: '0', text: 'line\r\n' }, signal(), gate)).toEqual(resource('worker', workerId, '1', 'line\r\n', at));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/me/worker-prompt', `/api/v1/me/projects/${projectId}/worker-prompt`, `/api/v1/me/workers/${workerId}/prompt`, `/api/v1/me/workers/${workerId}/prompt`]);
    expect(JSON.parse(fetch.mock.calls[3]![1].body)).toEqual({ expectedUserId: userId, revision: '0', text: 'line\r\n' });
    expect(gate.onDispatch).toHaveBeenCalledOnce();
  });
  it('waits for identity admission before dispatch and binds the principal on every response', async () => {
    const resume = pauseAuthRequests(), gate = admission(), fetch = vi.fn().mockResolvedValue(response(resource(), 200, projectId));
    vi.stubGlobal('fetch', fetch);
    const pending = saveWorkerPrompt(user, { expectedUserId: userId, revision: '0', text: '' }, signal(), gate);
    expect(fetch).not.toHaveBeenCalled(); expect(gate.onDispatch).not.toHaveBeenCalled();
    resume();
    await expect(pending).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
    expect(gate.onDispatch).toHaveBeenCalledOnce(); expect(gate.onPrincipalMismatch).toHaveBeenCalledOnce();
  });
  it('retains explicit conflict errors and rejects inconsistent successful replies', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: { code: 'version_conflict', message: 'changed', requestId: 'save-1' } }, 409))
      .mockResolvedValueOnce(response(resource('user', userId, '2', 'new', at)))
      .mockResolvedValueOnce(response(resource('user', userId, '1', 'wrong', at)));
    vi.stubGlobal('fetch', fetch);
    const input = { expectedUserId: userId, revision: '0', text: 'new' };
    await expect(saveWorkerPrompt(user, input, signal(), admission())).rejects.toMatchObject({ status: 409, code: 'version_conflict', requestId: 'save-1' });
    await expect(saveWorkerPrompt(user, input, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(saveWorkerPrompt(user, input, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('counts the complete escaped JSON bytes and refuses invalid or oversized writes before dispatch', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const gate = admission(), base = { expectedUserId: userId, revision: '0', text: '\n' };
    expect(promptSubmissionBytes(base)).toBe(new TextEncoder().encode(JSON.stringify(base)).length);
    expect(promptSubmissionBytes({ ...base, text: '\n'.repeat(PROMPT_REQUEST_BYTES / 2) })).toBeGreaterThan(PROMPT_REQUEST_BYTES);
    for (const input of [{ ...base, expectedUserId: projectId }, { ...base, text: '\ud800' }, { ...base, text: '\n'.repeat(PROMPT_REQUEST_BYTES / 2) }]) {
      await expect(saveWorkerPrompt(user, input, signal(), gate)).rejects.toMatchObject({ kind: 'protocol' });
    }
    expect(fetch).not.toHaveBeenCalled(); expect(gate.onDispatch).not.toHaveBeenCalled();
  });
  it('rejects duplicate JSON keys, malformed UTF-8 and oversized response streams', async () => {
    const headers = { 'Content-Type': 'application/json', 'Daynight-User-ID': userId };
    const duplicated = `{"scope":"user","scopeId":"${userId}","revision":"0","text":"","text":"","updatedAt":null}`;
    const fetch = vi.fn().mockResolvedValueOnce(new Response(duplicated, { headers }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { headers }))
      .mockResolvedValueOnce(new Response(new Uint8Array(PROMPT_RESPONSE_BYTES + 1), { headers }));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 3; i++) await expect(getWorkerPrompt(user, signal(), admission())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('cancels the response reader once and retains the network cancellation reason', async () => {
    let started!: () => void, dispatched!: AbortSignal, cancelReader!: ReturnType<typeof vi.spyOn>;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull() { started(); } }, { highWaterMark: 0 });
    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, 'getReader').mockImplementation(() => { const reader = getReader(); cancelReader = vi.spyOn(reader, 'cancel'); return reader; });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      dispatched = init.signal as AbortSignal;
      return new Response(stream, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    }));
    const pending = getWorkerPrompt(user, signal(), admission());
    await reading;
    cancelAuthNetworkRequests();
    await expect(pending).rejects.toBe(dispatched.reason);
    expect(cancelReader).toHaveBeenCalledOnce();
    expect(cancelReader).toHaveBeenCalledWith(dispatched.reason);
  });
  it('does not wait for reader cleanup after cancellation', async () => {
    let cleanupStarted!: () => void, failCleanup!: (cause: Error) => void, dispatched!: AbortSignal;
    const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const stream = new ReadableStream<Uint8Array>({ start(body) { body.enqueue(new TextEncoder().encode(JSON.stringify(resource()))); body.close(); } });
    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, 'getReader').mockImplementation(() => {
      const reader = getReader();
      vi.spyOn(reader, 'cancel').mockImplementation(() => {
        cleanupStarted();
        return new Promise<void>((_resolve, reject) => { failCleanup = reject; });
      });
      return reader;
    });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      dispatched = init.signal as AbortSignal;
      return new Response(stream, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    }));
    const pending = getWorkerPrompt(user, signal(), admission());
    await cleaning;
    cancelAuthNetworkRequests();
    await expect(pending).rejects.toBe(dispatched.reason);
    expect(stream.locked).toBe(false);
    failCleanup(new Error('late cleanup failure'));
    await Promise.resolve();
  });
  it('accepts a large legal escaped resource without truncation', async () => {
    const text = '<'.repeat(800_000), value = resource('user', userId, '1', text, at);
    const source = JSON.stringify(value).replaceAll('<', '\\u003c');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(source, { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } })));
    expect((await getWorkerPrompt(user, signal(), admission())).text).toBe(text);
  });
});
