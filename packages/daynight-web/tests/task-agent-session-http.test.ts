import type { TaskSessionSnapshot } from './helpers/session';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionApi } from '../src/api/sessions';
import type { SessionSnapshot } from '../src/api/types';
const s: TaskSessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const userId = '00000009-1111-4111-8111-111111111111';
const response = (body: unknown, principal = userId, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
afterEach(() => vi.unstubAllGlobals());
describe('task session HTTP boundary', () => {
  it('uses the existing cookie and principal boundary for the current claim', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ status: 'registered', session: s })); vi.stubGlobal('fetch', fetch);
    const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, vi.fn());
    expect(await api.current(new AbortController().signal)).toEqual({ status: 'registered', session: s });
    expect(fetch.mock.calls[0]?.[0]).toContain('/sessions/current');
  });
  it('rejects a response served under a switched account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ status: 'registered', session: s }, s.identity.workerId)));
    const mismatch = vi.fn(); const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, mismatch);
    await expect(api.current(new AbortController().signal)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce();
  });
  it('does not trust an operation URL returned by the server to choose a query target', async () => {
    const operation = { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, operationId: '00000011-1111-4111-8111-111111111111', kind: 'send_message', state: 'accepted', providerResult: null, error: null };
    const fetch = vi.fn(async () => response({ operation, operationUrl: 'https://evil.example/operation' }, userId, 202)); vi.stubGlobal('fetch', fetch);
    const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, vi.fn());
    await expect(api.command(s.sessionId, { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, operationId: operation.operationId, requestId: 'request', kind: 'send_message', payload: { content: [{ type: 'text', text: 'hello' }], expectedTurnId: null } }, new AbortController().signal)).resolves.toEqual(operation);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('fetches resource bytes through an authenticated principal-checked request', async () => {
    const fetch = vi.fn(async () => new Response('resource', { headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': userId } })); vi.stubGlobal('fetch', fetch);
    const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, vi.fn());
    expect(await (await api.resource(s.sessionId, '00000012-1111-4111-8111-111111111111', new AbortController().signal)).text()).toBe('resource');
  });
});

describe('browser session channel', () => {
  it('requires an authenticated snapshot before admitting events and rejects malformed frames', () => {
    class Socket {
      static last: Socket;
      onmessage: ((event: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: URL) { Socket.last = this; }
    }
    vi.stubGlobal('WebSocket', Socket);
    const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, vi.fn());
    const received = vi.fn(), closed = vi.fn();
    const connection = api.channel(s.sessionId, 'opaque cursor', received, closed);
    expect(Socket.last.url.searchParams.get('after')).toBe('opaque cursor');
    Socket.last.onmessage?.({ data: JSON.stringify({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'opaque cursor' }) });
    expect(received).toHaveBeenCalledOnce();
    Socket.last.onmessage?.({ data: '{broken' });
    expect(closed).toHaveBeenCalledOnce(); expect(Socket.last.close).toHaveBeenCalledOnce();
    connection.close();
  });
  it('refuses unbounded or binary frames before JSON parsing', () => {
    class Socket {
      static last: Socket; onmessage: ((event: { data: unknown }) => void) | null = null; onclose = null; onerror = null;
      close = vi.fn(); constructor() { Socket.last = this; }
    }
    vi.stubGlobal('WebSocket', Socket);
    const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, vi.fn());
    const received = vi.fn(), closed = vi.fn();
    api.channel(s.sessionId, null, received, closed);
    Socket.last.onmessage?.({ data: new ArrayBuffer(4) });
    expect(received).not.toHaveBeenCalled(); expect(closed).toHaveBeenCalledOnce();
  });
  it('constructs exact same-origin history and receipt queries', async () => {
    const operation = { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, operationId: '00000011-1111-4111-8111-111111111111', kind: 'cancel', state: 'confirmed', providerResult: 'handled', error: null };
    const fetch = vi.fn(async (url: string) => response(url.includes('/timeline') ? { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' } : { operation })); vi.stubGlobal('fetch', fetch);
    const api = createSessionApi(s.identity.projectId, s.identity.taskId, userId, vi.fn()); const signal = new AbortController().signal;
    await api.timeline(s.sessionId, 'before', 'opaque&cursor', signal); await api.operation(s.sessionId, operation.operationId, signal);
    expect(fetch.mock.calls[0]?.[0]).toContain('cursor=opaque%26cursor');
    expect(fetch.mock.calls[1]?.[0]).toContain(`/operations/${operation.operationId}`);
    await expect(api.timeline(s.sessionId, 'before', null, signal)).rejects.toThrow();
  });
});
