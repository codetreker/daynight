import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalSessionApi, parseSessionHistory } from '../src/api/terminal-sessions';
import { createSessionApi } from '../src/api/sessions';
import { hashSessionBytes } from '../../daynight/src/session/v2/values';
const fixture = (name: string) => JSON.parse(readFileSync(`../daynight/test/session/fixtures/v2/${name}.json`, 'utf8'));
const r = fixture('valid-registration');
const owner = r.payload.owner;
const response = (body: unknown, principal = owner.ownerUserId, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const api = () => createTerminalSessionApi(owner.projectId, owner.taskId, owner.ownerUserId, vi.fn(), owner.serverOrigin);
const signal = () => new AbortController().signal;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function savedRecordFixture() {
  const original = Buffer.from('saved original'), resourceId = '00000012-1111-4111-8111-111111111111';
  const resource = { resourceId, status: 'available', name: 'saved.txt', mediaType: 'text/plain', byteLength: String(original.length), sha256: hash(original), error: null };
  const entries = [{ kind: 'assistant_message', entryId: '00000013-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', content: [{ type: 'resource', resourceId, label: 'saved' }] }];
  const timeline = JSON.stringify({ entries }), fence = { sessionId: r.sessionId, claimId: r.claimId, executionGeneration: '1' };
  const manifest = { schemaVersion: 3, contentKind: 'native_timeline', recordId: r.sessionId, fence, provider: 'codex', nativeSessionId: null, controllerId: owner.workerId, controllerInstanceId: owner.worktreeId, timeline: { fileId: '00000014-1111-4111-8111-111111111111', byteLength: String(Buffer.byteLength(timeline)), sha256: hash(timeline) }, resources: [{ resource, blobId: '00000015-1111-4111-8111-111111111111' }], completeness: 'complete' };
  const status = { state: 'ready', sha256: hash(JSON.stringify(manifest)), byteLength: String(Buffer.byteLength(JSON.stringify(manifest))), errorCode: null, schemaVersion: 3, completeness: 'complete' };
  const item = { ...fence, agentControlMode: 'web' as const, archive: { state: 'ready' as const, sha256: status.sha256, byteLength: status.byteLength, completeness: 'complete' as const } };
  return { original, resourceId, resource, entries, fence, manifest, status, item };
}
afterEach(() => vi.unstubAllGlobals());
describe('terminal transport', () => {
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
  it('reads paginated history with the authenticated principal and v2 protocol', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ items: [], nextCursor: null })); vi.stubGlobal('fetch', fetch);
    expect(await api().history('stable cursor', signal())).toEqual({ items: [], nextCursor: null });
    expect(fetch.mock.calls[0]?.[0]).toContain('cursor=stable%20cursor');
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Daynight-Session-Protocol': 'daynight.session.v2' });
    fetch.mockImplementation(async () => response({ items: [], nextCursor: null }, owner.workerId));
    await expect(api().history(null, signal())).rejects.toMatchObject({ code: 'principal_mismatch' });
  });
  it.each([[400, 'unsupported_protocol'], [401, 'unauthenticated'], [403, 'forbidden'], [404, 'not_found'], [410, 'task_deleted']] as const)(
    'preserves HTTP %i (%s) during history reads', async (status, code) => {
      vi.stubGlobal('fetch', vi.fn(async () => response({ error: { code, message: 'Unavailable', requestId: 'request-1' } }, owner.ownerUserId, status)));
      await expect(api().history(null, signal())).rejects.toMatchObject({ kind: 'server', status, code });
    },
  );
  it('reports a network failure and allows a later history read', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response({ items: [], nextCursor: null })); vi.stubGlobal('fetch', fetch);
    await expect(api().history(null, signal())).rejects.toMatchObject({ kind: 'network' });
    await expect(api().history(null, signal())).resolves.toEqual({ items: [], nextCursor: null });
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

  it('uses the unified saved reader for schema3 fixed native records without live Session requests', async () => {
    const { original, resourceId, resource, entries, fence, manifest, status, item } = savedRecordFixture();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.endsWith('/archive')) return response({ archive: status });
      if (url.endsWith('/archive/content')) return response(manifest);
      if (url.includes('/archive/files/')) return response({ entries });
      if (url.includes(`/resources/${resourceId}/content?`)) return response({ resourceId, byteLength: resource.byteLength, sha256: resource.sha256, offset: '0', data: original.toString('base64'), eof: true });
      throw new Error(`Unexpected fixed-record request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    const target = api(), loaded = await target.nativeArchive(item, signal());
    expect(loaded.archive).toMatchObject({ schemaVersion: 3, entries, resources: manifest.resources, completeness: 'complete' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const reader = target.resources(fence, () => true);
    try { expect(await reader.readResource(loaded.archive!.resources[0]!.resource, signal())).toEqual(new Uint8Array(original)); }
    finally { await reader.close(); }
    expect(fetch).toHaveBeenCalledTimes(4);
    await expect(target.nativeArchive({ ...item, claimId: owner.taskId }, signal())).rejects.toThrow();
    await expect(target.nativeArchive({ ...item, archive: { ...item.archive, completeness: 'partial' } }, signal())).rejects.toThrow();
  });

  it('rejects a manifest that changed after the selected fixed record status was verified', async () => {
    const { manifest, status, entries, item } = savedRecordFixture();
    const replacement = { ...manifest, controllerInstanceId: owner.taskId };
    const replacementStatus = { ...status, sha256: hash(JSON.stringify(replacement)), byteLength: String(Buffer.byteLength(JSON.stringify(replacement))) };
    let statusReads = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/archive')) return response({ archive: ++statusReads === 1 ? status : replacementStatus });
      if (url.endsWith('/archive/content')) return response(replacement);
      if (url.includes('/archive/files/')) return response({ entries });
      throw new Error(`Unexpected fixed-record request: ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(api().nativeArchive(item, signal())).rejects.toThrow();
    expect(fetch.mock.calls.some(([url]) => url.includes('/archive/files/'))).toBe(false);
  });

  it('rejects duplicate JSON keys in history', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[],"nextCursor":null,"nextCursor":null}', { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner.ownerUserId } })));
    await expect(api().history(null, signal())).rejects.toMatchObject({ kind: 'protocol' });
  });

});
