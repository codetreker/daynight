import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { ApiError } from '../src/api/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, CurrentSessionResponse, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionStartupReport } from '../../daynight/src/session/startup';
import type { TaskSessionSnapshot } from './helpers/session';

const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.useRealTimers(); });
function fixture() {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' };
  let receive!: (message: BrowserMessage) => void;
  let disconnect!: (error?: unknown) => void;
  let current: CurrentSessionResponse = { status: 'registered', session: s };
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = {
    current: vi.fn(async () => current), timeline: vi.fn(async () => page), archive: vi.fn(), archiveContent: vi.fn(), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused',
    channel: vi.fn((_id, _after, onMessage, onClose) => { receive = onMessage; disconnect = onClose; return { close: vi.fn() }; }),
  };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn() });
  clients.push(client);
  return { s, page, api, client, disconnect: (error?: unknown) => disconnect(error), current: (value: CurrentSessionResponse) => { current = value; }, receive: (snapshot: TaskSessionSnapshot) => receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot, cursor: 'zero' }), event: (snapshot: TaskSessionSnapshot, eventSeq: string) => receive({ protocol: s.protocol, type: 'event', cursor: eventSeq, event: { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: snapshot.executionGeneration, connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq, kind: 'snapshot', payload: snapshot } }) };
}
function report(s: TaskSessionSnapshot, revision = '1'): SessionStartupReport {
  return { schemaVersion: 1, source: 'worker', sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, controllerInstanceId: s.identity.controllerInstanceId, revision, observedAt: new Date().toISOString(), startup: { state: 'unknown', reasonCode: 'native_timeout' }, recovery: { state: 'blocked', reasonCode: 'native_identity_missing' } };
}

describe('startup observations and live history admission', () => {
  it('does not request offline history while continuing to observe the current startup report', async () => {
    vi.useFakeTimers();
    const f = fixture(), offline = { ...f.s, connectionState: 'disconnected' as const, synchronized: false, activity: 'initializing' as const };
    f.current({ status: 'registered', session: offline, startupReport: report(offline) });
    await f.client.start(); f.receive(offline);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.api.timeline).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.current).mock.calls.length).toBeGreaterThan(1);
    expect(f.api.channel).toHaveBeenCalledOnce();
    expect(f.client.snapshot()).toMatchObject({ startupReport: { startup: { state: 'unknown' }, recovery: { state: 'blocked' } }, connected: false });
    await expect(f.client.send('no accidental input')).rejects.toThrow();
    expect(f.api.command).not.toHaveBeenCalled();
  });

  it('loads history when a previously unready stream becomes usable without replacing the channel', async () => {
    const f = fixture(), offline = { ...f.s, connectionState: 'disconnected' as const, synchronized: false };
    f.current({ status: 'registered', session: offline });
    await f.client.start(); f.receive(offline);
    expect(f.api.timeline).not.toHaveBeenCalled();
    const online = { ...f.s, sessionRevision: String(BigInt(f.s.sessionRevision) + 1n), lastEventSeq: '1' };
    vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, lastEventSeq: '1' });
    f.event(online, '1');
    await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
    expect(f.api.timeline).toHaveBeenCalledOnce();
    expect(f.api.channel).toHaveBeenCalledOnce();
  });

  it('updates blocked observations over a healthy browser channel and resumes only after a newer report permits history', async () => {
    vi.useFakeTimers();
    const f = fixture(), blocked = report(f.s);
    f.current({ status: 'registered', session: f.s, startupReport: blocked });
    await f.client.start(); f.receive(f.s);
    expect(f.api.timeline).not.toHaveBeenCalled();
    f.current({ status: 'registered', session: f.s, startupReport: { ...blocked, revision: '2', startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'none', reasonCode: null } } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.client.snapshot()).toMatchObject({ connected: true, startupReport: { revision: '2', recovery: { state: 'none' } } });
    expect(f.api.timeline).toHaveBeenCalledOnce();
    expect(f.api.channel).toHaveBeenCalledOnce();
  });

  it('does not regress a newer report revision or retry the same offline history refusal', async () => {
    vi.useFakeTimers();
    const f = fixture(), healthy = { ...report(f.s, '3'), startup: { state: 'ready' as const, reasonCode: 'ready' as const }, recovery: { state: 'none' as const, reasonCode: null } };
    f.current({ status: 'registered', session: f.s, startupReport: healthy });
    vi.mocked(f.api.timeline).mockRejectedValue(new ApiError('server', 503, 'controller_offline'));
    await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
    f.current({ status: 'registered', session: f.s, startupReport: report(f.s, '2') });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.api.timeline).toHaveBeenCalledOnce();
    expect(f.client.snapshot()).toMatchObject({ errorCode: 'controller_offline', startupReport: { revision: '3' } });
    expect(f.api.channel).toHaveBeenCalledOnce();
  });

  it('rejects a polling permission revocation and clears execution content', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
    f.client.setDraft('private text');
    vi.mocked(f.api.current).mockRejectedValue(new ApiError('server', 403, 'forbidden'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.client.snapshot()).toMatchObject({ status: 'unavailable', connected: false, state: { snapshot: null }, draft: { text: '' } });
  });
});

it('remembers a connection only within the observed execution and controller identity', async () => {
  const f = fixture(); await f.client.start(); f.receive(f.s);
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  const offline = { ...f.s, synchronized: false, connectionState: 'disconnected' as const, sessionRevision: '13' };
  f.event(offline, '1');
  expect(f.client.snapshot()).toMatchObject({ environmentConnected: true });
  f.receive({ ...offline, executionGeneration: '2', identity: { ...offline.identity, controllerInstanceId: '00000010-1111-4111-8111-111111111111' } });
  expect(f.client.snapshot()).toMatchObject({ environmentConnected: false, startupReport: null });
});

it('keeps safe permission failures visible after removing private execution data', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  vi.mocked(f.api.current).mockRejectedValue(new ApiError('server', 403, 'forbidden'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ status: 'unavailable', errorCode: 'forbidden', error: 'You do not have permission to perform this action.', state: { snapshot: null } });
});

it('does not publish an old current response after a streamed generation replacement', async () => {
  vi.useFakeTimers();
  const f = fixture(), oldReport = report(f.s);
  f.current({ status: 'registered', session: f.s, startupReport: oldReport });
  await f.client.start(); f.receive(f.s);
  let finish!: (value: CurrentSessionResponse) => void;
  vi.mocked(f.api.current).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(3000);
  const replacement = { ...f.s, executionGeneration: '2', connectionState: 'disconnected' as const, synchronized: false, identity: { ...f.s.identity, controllerInstanceId: '00000010-1111-4111-8111-111111111111' } };
  f.receive(replacement);
  finish({ status: 'registered', session: f.s, startupReport: oldReport });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot()).toMatchObject({ startupReport: null, environmentConnected: false, state: { snapshot: { executionGeneration: '2' } } });
  expect(f.api.channel).toHaveBeenCalledOnce();
});

it('keeps history corruption visible across successful startup report polls', async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, hasMoreBefore: true, beforeCursor: null });
  await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot().error).toContain('empty pagination cursor');
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.client.snapshot().error).toContain('empty pagination cursor');
  expect(f.api.timeline).toHaveBeenCalledOnce();
});

it('keeps sending disabled when a polled snapshot is ahead of the materialized event watermark', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  const newer = { ...f.s, sessionRevision: '13', lastEventSeq: '1' };
  f.current({ status: 'registered', session: newer });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot().connected).toBe(false);
  await expect(f.client.send('not before replay')).rejects.toThrow();
  f.event(newer, '1');
  expect(f.client.snapshot().connected).toBe(true);
});

it('restarts an unfinished history read after the observed connection epoch changes', async () => {
  vi.useFakeTimers();
  const f = fixture(); let finish!: (page: TimelinePage) => void;
  vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.client.start(); f.receive(f.s);
  const newer = { ...f.s, sessionRevision: '13', connectionEpoch: '2' };
  f.current({ status: 'registered', session: newer });
  await vi.advanceTimersByTimeAsync(3000);
  finish(f.page); await vi.advanceTimersByTimeAsync(0);
  f.receive(newer); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.timeline).toHaveBeenCalledTimes(2);
  expect(f.client.snapshot().connected).toBe(true);
});

it('does not replace a newer polled disconnection with an older unfinished tail snapshot', async () => {
  vi.useFakeTimers();
  const f = fixture(); let finish!: (page: TimelinePage) => void;
  vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.client.start(); f.receive(f.s);
  f.current({ status: 'registered', session: { ...f.s, sessionRevision: '13', connectionState: 'disconnected', synchronized: false } });
  await vi.advanceTimersByTimeAsync(3000);
  finish(f.page); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot()).toMatchObject({ connected: false, state: { snapshot: { sessionRevision: '13', connectionState: 'disconnected' } } });
  await expect(f.client.send('do not send')).rejects.toThrow();
});

it('does not hide a protocol read failure behind an earlier offline-history notice', async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.api.timeline).mockRejectedValue(new ApiError('server', 503, 'controller_offline'));
  await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  vi.mocked(f.api.current).mockRejectedValueOnce(new ApiError('protocol'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ errorCode: 'protocol', error: 'The server returned an invalid response. Please try again.' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ errorCode: 'controller_offline', connected: false });
  expect(f.api.timeline).toHaveBeenCalledOnce();
});

it('does not replace a newer polled disconnection with the delayed initial channel snapshot', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start();
  f.current({ status: 'registered', session: { ...f.s, sessionRevision: '13', connectionState: 'disconnected', synchronized: false, lastEventSeq: '1' } });
  await vi.advanceTimersByTimeAsync(3000);
  f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot()).toMatchObject({ connected: false, state: { snapshot: { sessionRevision: '13', connectionState: 'disconnected' } } });
  expect(f.api.timeline).not.toHaveBeenCalled();
});

it('ignores a lower-generation current result while retaining the current execution draft', async () => {
  const f = fixture();
  const latest = { ...f.s, executionGeneration: '2', identity: { ...f.s.identity, controllerInstanceId: '00000010-1111-4111-8111-111111111111' } };
  f.current({ status: 'registered', session: latest }); await f.client.start(); f.receive(latest);
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true)); f.client.setDraft('current draft');
  f.current({ status: 'registered', session: f.s, startupReport: report(f.s) }); await f.client.start();
  expect(f.client.snapshot()).toMatchObject({ connected: false, state: { snapshot: { executionGeneration: '2' } }, draft: { text: 'current draft' } });
});

it('starts a new generation at its own replay watermark without retaining the prior history counter', async () => {
  const f = fixture(), old = { ...f.s, lastEventSeq: '10' };
  f.current({ status: 'registered', session: old });
  vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, lastEventSeq: '10' });
  await f.client.start(); f.receive(old);
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  f.receive({ ...f.s, executionGeneration: '2', identity: { ...f.s.identity, controllerInstanceId: '00000010-1111-4111-8111-111111111111' } });
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  expect(f.client.snapshot().state.lastEventSeq).toBe('0');
});

it('folds an offline pagination response into the shared status and resumes on a newer usable snapshot', async () => {
  const f = fixture();
  vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, hasMoreBefore: true, beforeCursor: 'older' });
  await f.client.start(); f.receive(f.s);
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  vi.mocked(f.api.timeline).mockRejectedValueOnce(new ApiError('server', 503, 'controller_offline'));
  await f.client.loadOlder();
  expect(f.client.snapshot()).toMatchObject({ connected: false, errorCode: 'controller_offline', historyError: null });
  await f.client.loadOlder(); expect(f.api.timeline).toHaveBeenCalledTimes(2);
  await expect(f.client.send('not while offline')).rejects.toThrow();
  f.event({ ...f.s, sessionRevision: '13', lastEventSeq: '1' }, '1');
  expect(f.client.snapshot()).toMatchObject({ connected: true, error: null, errorCode: null });
  await f.client.loadOlder(); expect(f.api.timeline).toHaveBeenCalledTimes(3);
});

it('withdraws an old public report when an explicit current refresh fails', async () => {
  const f = fixture(); f.current({ status: 'registered', session: f.s, startupReport: report(f.s) });
  await f.client.start();
  vi.mocked(f.api.current).mockRejectedValueOnce(new ApiError('network'));
  await f.client.start();
  expect(f.client.snapshot()).toMatchObject({ status: 'error', startupReport: null, errorCode: 'network' });
});

it('clears consecutive current-read failures after success without requiring another channel event', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot().historyReady).toBe(true);
  f.client.setDraft('preserve the idle draft');
  vi.mocked(f.api.current).mockRejectedValueOnce(new ApiError('network')).mockRejectedValueOnce(new ApiError('server', 500));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ connected: false, status: 'error', errorCode: 'network' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot().connected).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ connected: true, status: 'ready', historyReady: true, error: null, errorCode: null, draft: { text: 'preserve the idle draft' } });
  expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.api.timeline).toHaveBeenCalledOnce(); expect(f.api.command).not.toHaveBeenCalled();
});

it('retains an independent history failure through consecutive current-read failures and recovery', async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, hasMoreBefore: true, beforeCursor: null });
  await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  const historyError = f.client.snapshot().error;
  expect(historyError).toContain('empty pagination cursor');
  vi.mocked(f.api.current).mockRejectedValueOnce(new ApiError('network')).mockRejectedValueOnce(new ApiError('server', 500));
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.client.snapshot()).toMatchObject({ connected: false, status: 'error', historyReady: false, error: historyError });
  expect(f.api.timeline).toHaveBeenCalledOnce(); expect(f.api.command).not.toHaveBeenCalled();
});


it('keeps current-read error ownership when an offline fallback finishes before current recovers', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: (page: TimelinePage) => void;
  vi.mocked(f.api.timeline)
    .mockRejectedValueOnce(new ApiError('network'))
    .mockRejectedValueOnce(new ApiError('network'))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.client.start(); f.disconnect(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.api.channel).toHaveBeenCalledTimes(2);
  f.disconnect(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.api.channel).toHaveBeenCalledTimes(3);
  f.disconnect();
  vi.mocked(f.api.current).mockRejectedValueOnce(new ApiError('network'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ errorCode: 'network', connected: false });
  finish(f.page); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot().errorCode).toBe('network');
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ error: null, errorCode: null, status: 'ready', connected: false });
  expect(f.api.channel).toHaveBeenCalledTimes(3); expect(f.api.timeline).toHaveBeenCalledTimes(3); expect(f.api.command).not.toHaveBeenCalled();
});
