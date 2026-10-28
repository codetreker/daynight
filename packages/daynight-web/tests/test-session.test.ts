import { ApiError } from '../src/api/client';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import { isLoginReturnPath, parseAuthRoute } from '../src/app/router';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { emptySessionState, hydrateSession, sessionSendGate } from '../src/features/task-agent-session/state';
import type { BrowserMessage } from '../../daynight/src/session/controller-protocol';
import type { SessionSnapshot } from '../src/api/types';

const owner = '00000009-1111-4111-8111-111111111111';
const execution = '00000010-1111-4111-8111-111111111111';
function snapshot(): Extract<SessionSnapshot, { readonly testExecutionId: string }> & { readonly identity: Extract<SessionSnapshot['identity'], { readonly ownerUserId: string }> } {
  const task = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const { claimId: _claim, ...base } = task;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = task.identity;
  return { ...base, testExecutionId: execution, identity: { ...identity, ownerUserId: owner }, initialInputState: 'not_required', lastEventSeq: '0' };
}
afterEach(() => vi.unstubAllGlobals());
it('recognizes only a canonical protected Test Session route and safe login return path', () => {
  const path = `/test-sessions/${snapshot().sessionId}`;
  expect(parseAuthRoute(path)).toEqual({ kind: 'testSession', sessionId: snapshot().sessionId });
  expect(isLoginReturnPath(path)).toBe(true);
  expect(parseAuthRoute('/test-sessions/not-a-session')).toEqual({ kind: 'notFound' });
  for (const unsafe of [`https://evil.example${path}`, `//evil.example${path}`, `/\\evil.example${path}`, `${path}#secret`]) expect(isLoginReturnPath(unsafe)).toBe(false);
});
it('binds Test API reads to the authenticated owner and exact session URL', async () => {
  expect(sessions).toHaveProperty('createTestSessionApi');
  const s = snapshot();
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ session: s }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner } }));
  vi.stubGlobal('fetch', fetch);
  const api = sessions.createTestSessionApi(s.sessionId, owner, vi.fn());
  await expect(api.current(new AbortController().signal)).resolves.toEqual({ status: 'registered', session: s });
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/test-sessions/${s.sessionId}`);
});
it('admits a synchronized no-prompt Test Session once the provider is ready without inventing native identity', () => {
  const s = snapshot();
  const state = hydrateSession(emptySessionState(), s, []);
  expect(sessionSendGate(state, true)).toBe(true);
  expect(sessionSendGate({ ...state, snapshot: { ...s, identity: { ...s.identity, nativeSessionId: null } } }, true)).toBe(true);
  expect(sessionSendGate({ ...state, snapshot: { ...s, synchronized: false } }, true)).toBe(false);
  expect(sessionSendGate({ ...state, snapshot: { ...s, activity: 'initializing', identity: { ...s.identity, nativeSessionId: null } } }, true)).toBe(false);
});
it('shares client delivery, keeps uncertain operations, and rejects owner/scope changes', async () => {
  const s = snapshot(); let receive!: (message: BrowserMessage) => void;
  const api: sessions.SessionApi = {
    current: vi.fn(async () => ({ status: 'registered' as const, session: s })),
    timeline: vi.fn(async () => ({ sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' })),
    command: vi.fn(async () => { throw new Error('lost acknowledgement'); }), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/resource',
    channel: vi.fn((_id, _after, onMessage) => { receive = onMessage; return { close: vi.fn() }; }),
  };
  const client = new TaskSessionClient({ api, userId: owner, testSessionId: s.sessionId, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: window.sessionStorage });
  try {
    await client.start();
    expect(client.snapshot().status).toBe('ready');
    receive({ protocol: s.protocol, type: 'snapshot', userId: owner, snapshot: s, cursor: 'zero' });
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    await expect(client.send('first')).rejects.toThrow('lost acknowledgement');
    const sent = vi.mocked(api.command).mock.calls[0]![1];
    expect(sent).toMatchObject({ testExecutionId: execution, sessionId: s.sessionId });
    expect(sent).not.toHaveProperty('claimId');
    await expect(client.send('second')).rejects.toThrow();
    expect(api.command).toHaveBeenCalledOnce();
    receive({ protocol: s.protocol, type: 'snapshot', userId: owner, snapshot: { ...s, identity: { ...s.identity, ownerUserId: execution } }, cursor: 'zero' });
    expect(client.snapshot().state.snapshot).toBeNull();
    expect(client.snapshot().state.operations.size).toBe(0);
    expect(Object.keys(window.sessionStorage).filter(key => key.includes(s.sessionId))).toEqual([]);
  } finally { client.close(); window.sessionStorage.clear(); }
});

it('rejects a Test response for another owner or session and never switches its request target', async () => {
  const s = snapshot();
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ session: { ...s, identity: { ...s.identity, ownerUserId: execution } } }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner } }));
  vi.stubGlobal('fetch', fetch);
  const api = sessions.createTestSessionApi(s.sessionId, owner, vi.fn());
  await expect(api.current(new AbortController().signal)).rejects.toThrow();
  expect(() => api.resourceUrl(execution, owner)).toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

it('allows verified steering after a no-prompt session has acquired its native identity', () => {
  const s = snapshot();
  const state = hydrateSession(emptySessionState(), { ...s, activity: 'working', currentTurnId: 'native-turn' }, []);
  expect(sessionSendGate(state, true)).toBe(true);
  expect(sessionSendGate({ ...state, snapshot: { ...state.snapshot!, identity: { ...s.identity, nativeSessionId: null } } }, true)).toBe(false);
});

it('drops prior execution state before hydrating a new Test fence on the channel', async () => {
  const s = snapshot(); let receive!: (message: BrowserMessage) => void;
  const api: sessions.SessionApi = {
    current: async () => ({ status: 'registered', session: s }),
    timeline: vi.fn(async () => ({ sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' })),
    command: vi.fn(async () => { throw new Error('lost acknowledgement'); }), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/resource',
    channel: (_id, _after, onMessage) => { receive = onMessage; return { close: vi.fn() }; },
  };
  const client = new TaskSessionClient({ api, userId: owner, testSessionId: s.sessionId, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: null });
  try {
    await client.start();
    receive({ protocol: s.protocol, type: 'snapshot', userId: owner, snapshot: s, cursor: 'zero' });
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    await expect(client.send('unknown')).rejects.toThrow();
    expect(client.snapshot().state.operations.size).toBe(1);
    receive({ protocol: s.protocol, type: 'snapshot', userId: owner, snapshot: { ...s, testExecutionId: '00000013-1111-4111-8111-111111111111' }, cursor: 'new' });
    expect(client.snapshot().connected).toBe(false);
    expect(client.snapshot().state.operations.size).toBe(0);
    await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
    expect(client.snapshot().state.operations.size).toBe(0);
  } finally { client.close(); }
});

it('clears persisted Test receipts when access is revoked before a snapshot can load', async () => {
  const s = snapshot();
  const key = `daynight:session-operations:${owner}:${s.sessionId}:test:${execution}:${s.executionGeneration}`;
  window.sessionStorage.setItem(key, '[]');
  const api: sessions.SessionApi = {
    current: async () => { throw new ApiError('server', 403, 'forbidden'); }, timeline: vi.fn(), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/resource', channel: vi.fn(),
  };
  const client = new TaskSessionClient({ api, userId: owner, testSessionId: s.sessionId, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: window.sessionStorage });
  try { await client.start(); expect(client.snapshot().status).toBe('unavailable'); expect(window.sessionStorage.getItem(key)).toBeNull(); }
  finally { client.close(); window.sessionStorage.clear(); }
});
