import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { SessionApi } from '../src/api/sessions';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { TaskSessionSnapshot } from './helpers/session';

const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.useRealTimers(); });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture() {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' };
  let paused = false, current = true;
  const channels: { receive: (message: BrowserMessage) => void; disconnect: (error?: unknown) => void }[] = [];
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: 'A', afterCursor: null, hasMoreBefore: true, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/resource', channel: vi.fn((_id, _cursor, receive, disconnect) => { channels.push({ receive, disconnect }); return { close: vi.fn() }; }) };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, isCurrent: () => current, isPaused: () => paused, onPrincipalMismatch: vi.fn(), storage: null });
  clients.push(client);
  const receive = (snapshot: TaskSessionSnapshot = s) => channels.at(-1)!.receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot, cursor: 'live' });
  return { s, api, page, client, channels, receive, pause: () => { paused = true; client.syncAvailability(); }, resume: () => { paused = false; client.syncAvailability(); }, revoke: () => { current = false; client.syncAvailability(); } };
}
async function ready(f: ReturnType<typeof fixture>) { await f.client.start(); f.receive(); await flush(); expect(f.client.snapshot().connected).toBe(true); }

describe('session history request progress', () => {
  it.each([null, ''])('rejects an initial tail advertising more history without a usable cursor (%s)', async cursor => {
    vi.useFakeTimers();
    const f = fixture(); vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: cursor });
    await f.client.start(); f.receive(); await flush();
    expect(f.client.snapshot().status).toBe('error'); expect(f.client.snapshot().error).toBeTruthy();
    await f.client.loadOlder(); expect(f.api.timeline).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(f.api.current).toHaveBeenCalledOnce();
  });
  it.each([null, '', 'A'])('rejects a nonadvancing cursor %s without merging the invalid page', async cursor => {
    const f = fixture(); await ready(f);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: cursor, items: [{ kind: 'assistant_message', entryId: 'invalid', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'invalid page' }] }] });
    await f.client.loadOlder();
    expect(f.client.snapshot().historyError).toBeTruthy();
    expect(f.client.snapshot().state.entries).toHaveLength(0);
    expect(f.client.snapshot().loadingOlder).toBe(false);
  });
  it('detects an opaque cursor cycle while accepting empty pages', async () => {
    const f = fixture(); await ready(f);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'B' }).mockResolvedValueOnce({ ...f.page, beforeCursor: 'C' }).mockResolvedValueOnce({ ...f.page, beforeCursor: 'A' });
    await f.client.loadOlder(); await f.client.loadOlder();
    expect(f.client.snapshot().historyError).toBeNull();
    await f.client.loadOlder(); expect(f.client.snapshot().historyError).toBeTruthy();
  });
  it('retains newer entries and resource state when a valid page only repeats revisions', async () => {
    const f = fixture();
    const item = { kind: 'assistant_message' as const, entryId: 'message', entrySeq: '2', revision: '3', content: [{ type: 'text' as const, text: 'latest text' }] };
    const resource = { resourceId: 'image', status: 'unavailable' as const, name: 'image.png', mediaType: 'image/png', byteLength: '7', sha256: null, error: null };
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, items: [item], resources: [resource] }); await ready(f);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'B', items: [{ ...item, revision: '1' }], resources: [{ ...resource, status: 'available' }] });
    await f.client.loadOlder();
    expect(f.client.snapshot().historyError).toBeNull(); expect(f.client.snapshot().state.entries).toEqual([item]);
    expect(f.client.snapshot().state.resources.get('image')?.status).toBe('unavailable');
  });
  it('publishes page completion even when there are no new entries', async () => {
    const f = fixture(); await ready(f); const initial = f.client.snapshot().historyRevision;
    expect(f.client.snapshot().historyReady).toBe(true);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'B' });
    await f.client.loadOlder(); expect(f.client.snapshot().historyRevision).toBe(initial + 1);
  });
  it('serializes older pages and retries the failed cursor explicitly', async () => {
    const f = fixture(); await ready(f); const response = deferred<TimelinePage>();
    vi.mocked(f.api.timeline).mockReturnValueOnce(response.promise);
    const pending = f.client.loadOlder(); await f.client.loadOlder();
    expect(f.api.timeline).toHaveBeenCalledTimes(2);
    response.reject(new Error('History temporarily unavailable')); await pending;
    expect(f.client.snapshot().historyError).toBe('History temporarily unavailable');
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: null, hasMoreBefore: false });
    await f.client.loadOlder();
    expect(f.api.timeline).toHaveBeenLastCalledWith(f.s.sessionId, 'before', 'A', expect.any(AbortSignal));
    expect(f.client.snapshot().historyError).toBeNull(); expect(f.client.snapshot().hasOlder).toBe(false);
    await f.client.loadOlder(); expect(f.api.timeline).toHaveBeenCalledTimes(3);
  });
  it.each(['offline', 'paused', 'revoked', 'runtime-offline', 'synchronizing'] as const)('does not request older history when %s', async state => {
    const f = fixture(); await ready(f);
    if (state === 'offline') f.channels[0]!.disconnect();
    else if (state === 'paused') f.pause();
    else if (state === 'revoked') f.revoke();
    else f.receive({ ...f.s, sessionRevision: '13', connectionState: state === 'runtime-offline' ? 'disconnected' : 'synchronizing', synchronized: false });
    await f.client.loadOlder(); expect(f.api.timeline).toHaveBeenCalledOnce();
  });
  it.each(['success', 'failure', 'forbidden'] as const)('ignores an old request %s while a replacement request is loading', async outcome => {
    const f = fixture(); await ready(f); const old = deferred<TimelinePage>();
    vi.mocked(f.api.timeline).mockReturnValueOnce(old.promise); const pending = f.client.loadOlder();
    f.channels[0]!.disconnect(); await f.client.start(); f.receive(); await flush();
    const next = deferred<TimelinePage>(); vi.mocked(f.api.timeline).mockReturnValueOnce(next.promise); const replacement = f.client.loadOlder();
    expect(f.client.snapshot().loadingOlder).toBe(true);
    if (outcome === 'success') old.resolve({ ...f.page, beforeCursor: null, hasMoreBefore: false });
    else old.reject(outcome === 'forbidden' ? new ApiError('server', 403) : new Error('Old request failed'));
    await pending;
    expect(f.client.snapshot().loadingOlder).toBe(true); expect(f.client.snapshot().historyError).toBeNull(); expect(f.client.snapshot().status).toBe('ready');
    next.resolve({ ...f.page, beforeCursor: 'B' }); await replacement;
    expect(f.client.snapshot().loadingOlder).toBe(false); expect(f.client.snapshot().hasOlder).toBe(true);
  });
  it('discards an in-flight page immediately after the socket disconnects', async () => {
    const f = fixture(); await ready(f); const response = deferred<TimelinePage>();
    vi.mocked(f.api.timeline).mockReturnValueOnce(response.promise); const pending = f.client.loadOlder();
    f.channels[0]!.disconnect(); response.resolve({ ...f.page, beforeCursor: null, hasMoreBefore: false }); await pending;
    expect(f.client.snapshot().hasOlder).toBe(true); expect(f.client.snapshot().loadingOlder).toBe(false);
  });
  it('discards old history after a same-socket epoch replacement and clears cursor progress', async () => {
    const f = fixture(); await ready(f); const response = deferred<TimelinePage>();
    vi.mocked(f.api.timeline).mockReturnValueOnce(response.promise); const pending = f.client.loadOlder();
    const nextSnapshot = { ...f.s, historyEpoch: 'history-2', sessionRevision: '13' };
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, historyEpoch: 'history-2' }); f.receive(nextSnapshot); await flush();
    response.resolve({ ...f.page, beforeCursor: null, hasMoreBefore: false }); await pending;
    expect(f.client.snapshot().state.snapshot?.historyEpoch).toBe('history-2'); expect(f.client.snapshot().hasOlder).toBe(true);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, historyEpoch: 'history-2', beforeCursor: 'B' }); await f.client.loadOlder();
    expect(f.client.snapshot().historyError).toBeNull();
  });
  it.each(['history', 'execution', 'connection'] as const)('keeps a newer same-socket request loading after %s changes', async identity => {
    const f = fixture(); await ready(f); const old = deferred<TimelinePage>();
    vi.mocked(f.api.timeline).mockReturnValueOnce(old.promise); const pending = f.client.loadOlder();
    const nextSnapshot = { ...f.s, sessionRevision: '13', ...(identity === 'history' ? { historyEpoch: 'history-2' } : identity === 'execution' ? { executionGeneration: '2' } : { connectionEpoch: '2' }) };
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, historyEpoch: nextSnapshot.historyEpoch });
    f.receive(nextSnapshot); await flush();
    const next = deferred<TimelinePage>(); vi.mocked(f.api.timeline).mockReset().mockReturnValueOnce(next.promise);
    const replacement = f.client.loadOlder(); expect(f.client.snapshot().loadingOlder).toBe(true);
    old.reject(new ApiError('server', 403)); await pending;
    expect(f.client.snapshot().loadingOlder).toBe(true); expect(f.client.snapshot().status).toBe('ready');
    next.resolve({ ...f.page, historyEpoch: nextSnapshot.historyEpoch, beforeCursor: 'B' }); await replacement;
    expect(f.client.snapshot().historyError).toBeNull(); expect(f.client.snapshot().loadingOlder).toBe(false);
  });
  it('keeps cursor progress across a reconnect that retains the loaded history', async () => {
    const f = fixture(); await ready(f);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'B' }); await f.client.loadOlder();
    f.channels[0]!.disconnect(); await f.client.start(); f.receive(); await flush();
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'A' }); await f.client.loadOlder();
    expect(f.client.snapshot().historyError).toBeTruthy();
  });
  it('recovers reset_required through a new tail and can load the same cursor again', async () => {
    vi.useFakeTimers(); const f = fixture(); await ready(f);
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'B' }); await f.client.loadOlder();
    vi.mocked(f.api.timeline).mockRejectedValueOnce(new ApiError('server', 409, 'reset_required')); await f.client.loadOlder();
    expect(f.client.snapshot().historyReady).toBe(false);
    await vi.advanceTimersByTimeAsync(1); f.receive(); await flush();
    vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, beforeCursor: 'B' }); await f.client.loadOlder();
    expect(f.client.snapshot().historyError).toBeNull(); expect(f.client.snapshot().historyReady).toBe(true);
  });
  it('preserves current authorization rejection while identity is suspended', async () => {
    const f = fixture(); await ready(f); const response = deferred<TimelinePage>();
    vi.mocked(f.api.timeline).mockReturnValueOnce(response.promise); const pending = f.client.loadOlder();
    f.pause(); response.reject(new ApiError('server', 401)); await pending;
    expect(f.client.snapshot().status).toBe('unavailable'); expect(f.client.snapshot().state.snapshot).toBeNull();
  });
});
