import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalSessionApi, parseTerminalSessionState, parseSessionHistory } from '../src/api/terminal-sessions';
import { createSessionApi } from '../src/api/sessions';
import { hashSessionBytes } from '../../daynight/src/session/v2/values';
const fixture = (name: string) => JSON.parse(readFileSync(`../daynight/test/session/fixtures/v2/${name}.json`, 'utf8'));
const r = fixture('valid-registration');
const owner = r.payload.owner;
const state = () => ({ status: 'registered', protocol: r.protocol, schemaVersion: 2, projectionVersion: 1, sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', owner, binding: r.payload.binding, connectionEpoch: '1', connected: true, capabilities: r.payload.capabilities, control: fixture('valid-control').payload, snapshot: fixture('valid-snapshot').payload, ledger: fixture('valid-active-ledger').payload, archive: fixture('valid-status-pending').payload, recording: [] });
const response = (body: unknown, principal = owner.ownerUserId, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const api = () => createTerminalSessionApi(owner.projectId, owner.taskId, owner.ownerUserId, vi.fn(), owner.serverOrigin);
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
describe('terminal transport', () => {
  it('strictly admits the complete original task state and rejects substituted ownership', () => {
    expect(parseTerminalSessionState(state(), owner.projectId, owner.taskId, owner.serverOrigin)).toMatchObject({ sessionId: r.sessionId });
    expect(() => parseTerminalSessionState({ ...state(), owner: { ...owner, taskId: owner.projectId } }, owner.projectId, owner.taskId, owner.serverOrigin)).toThrow();
    expect(() => parseTerminalSessionState({ ...state(), extra: true }, owner.projectId, owner.taskId, owner.serverOrigin)).toThrow();
    expect(() => parseTerminalSessionState({ ...state(), snapshot: { ...state().snapshot, connectionEpoch: '2' } }, owner.projectId, owner.taskId, owner.serverOrigin)).toThrow();
  });
  it('selects v2 and checks the authenticated principal before admitting current state', async () => {
    const fetch = vi.fn(async () => response(state())); vi.stubGlobal('fetch', fetch);
    expect(await api().current(signal())).toMatchObject({ status: 'registered' });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'Daynight-Session-Protocol': 'daynight.session.v2' });
    fetch.mockImplementation(async () => response(state(), owner.workerId));
    await expect(api().current(signal())).rejects.toMatchObject({ code: 'principal_mismatch' });
  });
  it('selects native v1 startup observation and accepts a registered null report', async () => {
    const snapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ status: 'registered', session: snapshot, startupReport: null })); vi.stubGlobal('fetch', fetch);
    const native = createSessionApi(snapshot.identity.projectId, snapshot.identity.taskId, owner.ownerUserId, vi.fn());
    await expect(native.current(signal())).resolves.toMatchObject({ status: 'registered', startupReport: null });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Accept: 'application/json', 'X-Daynight-Startup-Version': '1' });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Daynight-Session-Protocol');
  });
  it('accepts nanosecond history timestamps and rejects inconsistent backend or ready identity', () => {
    const item = { sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00.123456789Z', endedAt: null, archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } };
    expect(parseSessionHistory({ items: [item], nextCursor: null }).items).toHaveLength(1);
    expect(() => parseSessionHistory({ items: [{ ...item, contentKind: 'native_timeline' }], nextCursor: null })).toThrow();
    expect(() => parseSessionHistory({ items: [{ ...item, archive: { ...item.archive, state: 'ready' } }], nextCursor: null })).toThrow();
  });
  it('reads fixed archive bytes without current, channel or command requests and rejects changed hashes', async () => {
    const archive = fixture('valid-archive'), bytes = JSON.stringify(archive), sha256 = await hashSessionBytes(bytes);
    const status = { ...fixture('valid-status'), payload: { ...fixture('valid-status').payload, completeness: archive.completeness, sha256, byteLength: String(new TextEncoder().encode(bytes).length), finalizationId: archive.finalizationId } };
    const item = { sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1', agentControlMode: 'herdr' as const, contentKind: 'terminal_recording' as const, createdAt: archive.startedAt, endedAt: archive.endedAt, archive: { state: 'ready' as const, sha256, byteLength: status.payload.byteLength, completeness: archive.completeness } };
    const fetch = vi.fn(async (url: string) => response(url.endsWith('/content') ? archive : status)); vi.stubGlobal('fetch', fetch);
    expect((await api().archive(item, signal())).archive).toEqual(archive);
    expect(fetch.mock.calls.map(c => c[0])).toEqual([expect.stringMatching(/\/archive$/), expect.stringMatching(/\/archive\/content$/)]);
    await expect(api().archive({ ...item, archive: { ...item.archive, sha256: 'b'.repeat(64) } }, signal())).rejects.toThrow();
  });
  it('uses the v2 socket protocol and rejects malformed or cross-session state', () => {
    class Socket {
      static last: Socket;
      onmessage: ((event: { data: unknown }) => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: URL, readonly protocol: string) { Socket.last = this; }
    }
    vi.stubGlobal('WebSocket', Socket); const received = vi.fn(), closed = vi.fn(); const channel = api().channel(r.sessionId, owner.worktreeId, received, closed);
    expect(Socket.last.protocol).toBe('daynight.session.v2'); expect(Socket.last.url.searchParams.get('browserClientId')).toBe(owner.worktreeId);
    Socket.last.onmessage?.({ data: JSON.stringify(state()) }); expect(received).toHaveBeenCalledOnce();
    Socket.last.onmessage?.({ data: JSON.stringify({ ...state(), sessionId: owner.workerId }) }); expect(closed).toHaveBeenCalledOnce(); expect(Socket.last.close).toHaveBeenCalledOnce(); channel.close();
  });
  it('sends one validated command with browser identity and queries only its own operation path', async () => {
    const command = fixture('valid-request'), result = { ...fixture('valid-result'), payload: { operationId: command.payload.operationId, state: 'queued', errorCode: null } };
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => response(result, owner.ownerUserId, init?.method === 'POST' ? 202 : 200)); vi.stubGlobal('fetch', fetch);
    expect(await api().command(r.sessionId, owner.worktreeId, command, signal())).toEqual(result);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Daynight-Browser-Client': owner.worktreeId });
    expect(await api().operation(r.sessionId, command.payload.operationId, signal())).toEqual(result);
    fetch.mockImplementation(async () => response({ ...result, claimId: owner.taskId }, owner.ownerUserId, 202)); await expect(api().command(r.sessionId, owner.worktreeId, command, signal())).rejects.toThrow();
  });
  it('admits unavailable discovery and loads history independently from the current claim', async () => {
    const fetch = vi.fn(async (url: string) => response(url.includes('?') ? { items: [], nextCursor: null } : { status: 'not_registered', protocol: r.protocol, claimId: r.claimId, agentControlMode: 'herdr' })); vi.stubGlobal('fetch', fetch);
    expect(await api().current(signal())).toMatchObject({ status: 'not_registered' }); expect(await api().history('stable cursor', signal())).toEqual({ items: [], nextCursor: null });
    expect(fetch.mock.calls[1]?.[0]).toContain('cursor=stable%20cursor');
  });
  it('distinguishes both valid empty states from malformed current responses', async () => {
    const fetch = vi.fn(async () => response({ status: 'not_applicable', protocol: r.protocol })); vi.stubGlobal('fetch', fetch);
    await expect(api().current(signal())).resolves.toEqual({ status: 'not_applicable', protocol: r.protocol });
    for (const body of [null, '', '{broken', 'null', '{}', JSON.stringify({ status: 'not_registered', protocol: r.protocol, claimId: owner.taskId, agentControlMode: 'web' })]) {
      fetch.mockImplementation(async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner.ownerUserId } }));
      await expect(api().current(signal())).rejects.toMatchObject({ kind: 'protocol' });
    }
  });
  it.each([[400, 'unsupported_protocol'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [410, 'task_deleted']] as const)(
    'preserves HTTP %i (%s) rather than treating it as an empty session', async (status, code) => {
      vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code, message: 'Unavailable', requestId: 'request-1' } }, owner.ownerUserId, status)));
      await expect(api().current(signal())).rejects.toMatchObject({ kind: 'server', status, code });
    },
  );
  it('reports a network failure and can make a later successful current read', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response({ status: 'not_applicable', protocol: r.protocol })); vi.stubGlobal('fetch', fetch);
    await expect(api().current(signal())).rejects.toMatchObject({ kind: 'network' });
    await expect(api().current(signal())).resolves.toEqual({ status: 'not_applicable', protocol: r.protocol });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('returns a pending archive without fetching content', async () => {
    const status = fixture('valid-status-pending'); vi.stubGlobal('fetch', vi.fn(async () => response(status)));
    const item = parseSessionHistory({ items: [{ sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00Z', endedAt: null, archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } }], nextCursor: null }).items[0]!;
    expect(await api().archive(item, signal())).toEqual({ status, archive: null }); expect(fetch).toHaveBeenCalledOnce();
  });
  it('keeps native archives on the v1 envelope and fixed hash/status boundary', async () => {
    const archive = { schemaVersion: 1, sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1', controllerId: owner.workerId, controllerInstanceId: owner.worktreeId, provider: 'codex', nativeSessionId: null, entries: [], resources: [] };
    const status = { state: 'ready', sha256: 'a'.repeat(64), byteLength: '1024', errorCode: null };
    const item = parseSessionHistory({ items: [{ sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1', agentControlMode: 'web', contentKind: 'native_timeline', createdAt: '2026-11-03T10:00:00Z', endedAt: null, archive: { ...status, errorCode: undefined, completeness: null } }].map(i => ({ ...i, archive: { state: status.state, sha256: status.sha256, byteLength: status.byteLength, completeness: null } })), nextCursor: null }).items[0]!;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => response({ archive: url.endsWith('/content') ? archive : status })); vi.stubGlobal('fetch', fetch);
    expect(await api().nativeArchive(item, signal())).toEqual({ status, archive }); expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Daynight-Session-Protocol');
    await expect(api().nativeArchive({ ...item, claimId: owner.taskId }, signal())).rejects.toThrow();
  });

  it('closes a socket that never supplies an authenticated state', async () => {
    vi.useFakeTimers(); class Socket { close = vi.fn(); onmessage = null; onclose = null; onerror = null; }
    vi.stubGlobal('WebSocket', Socket); const closed = vi.fn(); api().channel(r.sessionId, owner.worktreeId, vi.fn(), closed); await vi.advanceTimersByTimeAsync(10_000); expect(closed).toHaveBeenCalledOnce(); vi.useRealTimers();
  });
  it('rejects duplicate JSON keys rather than admitting the last identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"status":"not_applicable","protocol":"daynight.session.v2","protocol":"daynight.session.v2"}', { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner.ownerUserId } })));
    await expect(api().current(signal())).rejects.toMatchObject({ kind: 'protocol' });
  });

});
