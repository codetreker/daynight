import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionOperation, SessionResource } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';

const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' };
  let paused = false, current = true;
  const channels: { receive: (message: BrowserMessage) => void; disconnect: (error?: unknown) => void; close: ReturnType<typeof vi.fn> }[] = [];
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: 'older', afterCursor: null, hasMoreBefore: true, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/resource', channel: vi.fn((_id, _cursor, receive, disconnect) => { const channel = { receive, disconnect, close: vi.fn() }; channels.push(channel); return channel; }) };
  const mismatch = vi.fn();
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, isCurrent: () => current, isPaused: () => paused, onPrincipalMismatch: mismatch, storage: window.sessionStorage });
  clients.push(client);
  const snapshot = (): BrowserMessage => ({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'zero' });
  const event = (seq: number, text = `entry ${seq}`): BrowserMessage => ({ protocol: s.protocol, type: 'event', cursor: String(seq), event: { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: s.historyEpoch, eventSeq: String(seq), kind: 'timeline_upsert', payload: { kind: 'assistant_message', entryId: `entry-${seq}`, entrySeq: String(seq), revision: '1', content: [{ type: 'text', text }] } } });
  return { s, api, page, channels, client, mismatch, snapshot, event, pause: () => { paused = true; }, unpause: () => { paused = false; }, resume: () => { paused = false; client.syncAvailability(); }, revoke: () => { current = false; client.syncAvailability(); } };
}
async function ready(f: ReturnType<typeof fixture>) { f.client.syncAvailability(); await flush(); f.channels[0]!.receive(f.snapshot()); await flush(); expect(f.client.snapshot().connected).toBe(true); }

describe('session connection identity suspension', () => {
  it('retains the socket, draft and timeline during a brief pause and replays without loading history', async () => {
    const f = fixture(); await ready(f); f.client.setDraft('keep this draft');
    f.pause(); f.client.syncAvailability(); f.channels[0]!.receive(f.event(1));
    expect(f.client.snapshot().authPaused).toBe(true);
    expect(f.client.snapshot().connected).toBe(true);
    expect(f.client.snapshot().state.entries).toHaveLength(0);
    expect(f.channels[0]!.close).not.toHaveBeenCalled();
    await expect(f.client.send('blocked')).rejects.toThrow();
    f.resume(); await flush();
    expect(f.client.snapshot().authPaused).toBe(false);
    expect(f.client.snapshot().state.entries.map(entry => entry.entryId)).toEqual(['entry-1']);
    expect(f.client.snapshot().draft.text).toBe('keep this draft');
    expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.api.timeline).toHaveBeenCalledOnce(); expect(f.api.command).not.toHaveBeenCalled();
  });
  it('detects pause before the watchdog and never lets an obsolete socket close the replacement', async () => {
    const f = fixture(); await ready(f); f.pause(); f.channels[0]!.receive(f.event(1));
    expect(f.client.snapshot().state.entries).toHaveLength(0); expect(f.channels[0]!.close).not.toHaveBeenCalled();
    f.resume(); f.client.pause(); f.client.syncAvailability(); await flush();
    expect(f.channels).toHaveLength(2); f.channels[0]!.receive(f.event(2));
    expect(f.channels[1]!.close).not.toHaveBeenCalled();
  });
  it('disconnects after sixty seconds and resumes from the last consumed cursor', async () => {
    vi.useFakeTimers(); const f = fixture(); await ready(f); f.channels[0]!.receive(f.event(1));
    f.pause(); f.client.syncAvailability(); f.channels[0]!.receive(f.event(2));
    await vi.advanceTimersByTimeAsync(60_000); expect(f.channels[0]!.close).toHaveBeenCalledOnce();
    f.resume(); await flush(); expect(f.api.channel).toHaveBeenLastCalledWith(f.s.sessionId, '1', expect.any(Function), expect.any(Function));
    expect(f.client.snapshot().state.entries).toHaveLength(1);
  });
  it.each(['count', 'bytes'])('falls back to cursor replay when the suspension buffer exceeds its %s bound', async kind => {
    const f = fixture(); await ready(f); f.pause(); f.client.syncAvailability();
    if (kind === 'count') for (let i = 1; i <= 1001; i++) f.channels[0]!.receive(f.event(i));
    else f.channels[0]!.receive(f.event(1, 'a'.repeat(4 * 1024 * 1024)));
    expect(f.channels[0]!.close).toHaveBeenCalledOnce(); expect(f.client.snapshot().state.entries).toHaveLength(0);
    f.resume(); await flush(); expect(f.api.channel).toHaveBeenLastCalledWith(f.s.sessionId, 'zero', expect.any(Function), expect.any(Function));
  });
  it('handles a real socket close during suspension and reconnects once identity is verified', async () => {
    const f = fixture(); await ready(f); f.pause(); f.client.syncAvailability(); f.channels[0]!.disconnect();
    expect(f.client.snapshot().connected).toBe(false); f.resume(); await flush(); expect(f.channels).toHaveLength(2);
  });
  it('rejects a mismatched principal immediately even while suspended and discards buffered content', async () => {
    const f = fixture(); await ready(f); f.pause(); f.client.syncAvailability(); f.channels[0]!.receive(f.event(1));
    const value = f.snapshot(); if (value.type !== 'snapshot') throw new Error('fixture');
    f.channels[0]!.receive({ ...value, userId: '00000010-1111-4111-8111-111111111111' });
    expect(f.mismatch).toHaveBeenCalledOnce(); expect(f.client.snapshot().state.snapshot).toBeNull(); f.resume(); expect(f.api.channel).toHaveBeenCalledOnce();
  });
  it('waits to publish an in-flight initial snapshot and starts its channel after verification', async () => {
    const f = fixture(); let resolve!: (value: Awaited<ReturnType<SessionApi['current']>>) => void;
    vi.mocked(f.api.current).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.client.syncAvailability(); f.pause(); resolve({ status: 'registered', session: f.s }); await flush();
    expect(f.client.snapshot().state.snapshot).toBeNull(); expect(f.api.channel).not.toHaveBeenCalled();
    f.resume(); await flush(); expect(f.api.channel).toHaveBeenCalledOnce();
  });
  it('preserves an in-flight hydration and ordered events without getting stuck', async () => {
    const f = fixture(); let resolve!: (value: TimelinePage) => void;
    vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.client.syncAvailability(); await flush(); f.channels[0]!.receive(f.snapshot());
    f.pause(); f.channels[0]!.receive(f.event(1)); resolve(f.page); await flush(); expect(f.client.snapshot().connected).toBe(false);
    f.resume(); await flush(); expect(f.client.snapshot().connected).toBe(true); expect(f.client.snapshot().state.entries).toHaveLength(1); expect(f.api.timeline).toHaveBeenCalledOnce();
  });
  it('invalidates authorization failures during suspension without awaiting identity', async () => {
    const f = fixture(); let reject!: (reason: unknown) => void;
    vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    f.client.syncAvailability(); await flush(); f.channels[0]!.receive(f.snapshot()); f.pause(); reject(new ApiError('server', 403)); await flush();
    expect(f.client.snapshot().status).toBe('unavailable'); expect(f.channels[0]!.close).toHaveBeenCalledOnce();
  });
  it('replays buffered events before a new live event arrives ahead of the next watchdog tick', async () => {
    const f = fixture(); await ready(f); f.pause(); f.channels[0]!.receive(f.event(1));
    f.unpause(); f.channels[0]!.receive(f.event(2));
    expect(f.client.snapshot().state.entries.map(entry => entry.entryId)).toEqual(['entry-1', 'entry-2']);
    expect(f.client.snapshot().state.recoveryRequired).toBe(false); expect(f.api.channel).toHaveBeenCalledOnce();
  });
  it('enforces the deadline when background timer execution was throttled', async () => {
    vi.useFakeTimers(); const f = fixture(); await ready(f); f.pause(); f.client.syncAvailability();
    vi.setSystemTime(Date.now() + 60_001); f.resume(); await flush();
    expect(f.channels[0]!.close).toHaveBeenCalledOnce(); expect(f.channels).toHaveLength(2);
  });
  it('does not keep a socket when task freshness is lost and discards suspended events', async () => {
    const f = fixture(); await ready(f); f.pause(); f.channels[0]!.receive(f.event(1)); f.revoke();
    expect(f.channels[0]!.close).toHaveBeenCalledOnce(); expect(f.client.snapshot().connected).toBe(false);
    f.resume(); expect(f.client.snapshot().state.entries).toHaveLength(0); expect(f.channels).toHaveLength(1);
  });
  it('keeps an in-flight older page unpublished until identity resumes', async () => {
    const f = fixture(); await ready(f); let resolve!: (page: TimelinePage) => void;
    vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.client.loadOlder(); f.pause();
    const event = f.event(1); if (event.type !== 'event' || event.event.kind !== 'timeline_upsert') throw new Error('fixture');
    resolve({ ...f.page, items: [event.event.payload] }); await flush();
    expect(f.client.snapshot().state.entries).toHaveLength(0); expect(f.client.snapshot().loadingOlder).toBe(true);
    f.resume(); await pending; expect(f.client.snapshot().state.entries).toHaveLength(1); expect(f.client.snapshot().loadingOlder).toBe(false);
  });
  it('holds command receipts during suspension and never replays the native command', async () => {
    const f = fixture(); await ready(f); let resolve!: (receipt: SessionOperation) => void;
    vi.mocked(f.api.command).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.client.send('one command'); const command = vi.mocked(f.api.command).mock.calls[0]![1];
    f.pause(); const receipt: SessionOperation = { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', operationId: command.operationId, kind: 'send_message', state: 'provider_accepted', providerResult: 'started', error: null };
    vi.mocked(f.api.operation).mockResolvedValue(receipt); resolve(receipt); await flush();
    expect(f.client.snapshot().state.operations.get(command.operationId)?.state).toBe('unknown');
    f.resume(); await pending; expect(f.client.snapshot().state.operations.get(command.operationId)?.state).toBe('provider_accepted'); expect(f.api.command).toHaveBeenCalledOnce();
  });
  it('holds receipt queries until identity resumes and clears their checking state', async () => {
    const f = fixture(); await ready(f); let resolve!: (receipt: SessionOperation) => void;
    vi.mocked(f.api.operation).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.client.checkOperation('query'); f.pause();
    resolve({ protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', operationId: 'query', kind: 'send_message', state: 'provider_accepted', providerResult: 'started', error: null }); await flush();
    expect(f.client.snapshot().state.operations.has('query')).toBe(false); f.resume(); await pending;
    expect(f.client.snapshot().state.operations.has('query')).toBe(true); expect(f.client.snapshot().checking.size).toBe(0);
  });
  it.each([false, true])('holds in-flight resource bytes and honors cancellation while waiting (cancel=%s)', async cancel => {
    const f = fixture(); const resource: SessionResource = { resourceId: 'image', status: 'available', name: 'Private image', mediaType: 'image/png', byteLength: '7', sha256: null, error: null };
    vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, resources: [resource] }); await ready(f);
    let resolve!: (blob: Blob) => void; vi.mocked(f.api.resource).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const abort = new AbortController(); let settled = false;
    const pending = f.client.resource('image', abort.signal).then(blob => { settled = true; return blob; }, error => { settled = true; return error; });
    f.pause(); const blob = new Blob(['private']); resolve(blob); await flush(); expect(settled).toBe(false);
    if (cancel) { abort.abort(); expect(await pending).toBeInstanceOf(Error); }
    else { f.resume(); expect(await pending).toBe(blob); }
  });
  it('settles waiting publications when the scope is invalidated', async () => {
    const f = fixture(); await ready(f); let resolve!: (page: TimelinePage) => void;
    vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.client.loadOlder(); f.pause(); resolve(f.page); await flush();
    f.client.invalidate(); await pending; expect(f.client.snapshot().state.snapshot).toBeNull();
  });

  it('buffers a replacement snapshot and changes execution only after identity resumes', async () => {
    const f = fixture(); await ready(f); f.client.setDraft('old execution'); f.pause();
    const value = f.snapshot(); if (value.type !== 'snapshot') throw new Error('fixture');
    f.channels[0]!.receive({ ...value, snapshot: { ...f.s, executionGeneration: '2' } });
    expect(f.client.snapshot().state.snapshot?.executionGeneration).toBe('1'); expect(f.client.snapshot().draft.text).toBe('old execution');
    f.resume(); await flush(); expect(f.client.snapshot().state.snapshot?.executionGeneration).toBe('2'); expect(f.client.snapshot().draft.text).toBe('');
  });
  it('buffers a reset requirement then performs real recovery after identity resumes', async () => {
    vi.useFakeTimers(); const f = fixture(); await ready(f); f.pause();
    f.channels[0]!.receive({ protocol: f.s.protocol, type: 'reset_required', reason: 'history_compacted' });
    expect(f.client.snapshot().state.recoveryRequired).toBe(false); f.resume();
    expect(f.client.snapshot().state.recoveryRequired).toBe(true); await vi.advanceTimersByTimeAsync(1);
    expect(f.api.channel).toHaveBeenLastCalledWith(f.s.sessionId, null, expect.any(Function), expect.any(Function));
    f.channels[1]!.receive(f.snapshot()); await flush(); expect(f.client.snapshot().state.recoveryRequired).toBe(false); expect(f.client.snapshot().connected).toBe(true);
  });

});
