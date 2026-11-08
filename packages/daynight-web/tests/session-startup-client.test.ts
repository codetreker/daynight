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
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, ownerUserId: userId, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn() });
  clients.push(client);
  return { s, page, api, client, disconnect: (error?: unknown) => disconnect(error), current: (value: CurrentSessionResponse) => { current = value; }, receive: (snapshot: TaskSessionSnapshot) => receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot, cursor: 'zero' }), event: (snapshot: TaskSessionSnapshot, eventSeq: string) => receive({ protocol: s.protocol, type: 'event', cursor: eventSeq, event: { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: snapshot.executionGeneration, connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq, kind: 'snapshot', payload: snapshot } }) };
}
function report(s: TaskSessionSnapshot, revision = '1'): SessionStartupReport {
  return { schemaVersion: 1, source: 'worker', sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, controllerInstanceId: s.identity.controllerInstanceId, revision, observedAt: new Date().toISOString(), startup: { state: 'unknown', reasonCode: 'native_timeout' }, recovery: { state: 'blocked', reasonCode: 'native_identity_missing' } };
}

describe('startup observations and live history admission', () => {
  it('does not poll complete snapshots or request offline history while the report is unchanged', async () => {
    vi.useFakeTimers();
    const f = fixture(), offline = { ...f.s, connectionState: 'disconnected' as const, synchronized: false, activity: 'initializing' as const };
    f.current({ status: 'registered', session: offline, startupReport: report(offline) });
    await f.client.start(); f.receive(offline);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.api.timeline).not.toHaveBeenCalled();
    expect(f.api.current).toHaveBeenCalledOnce();
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
    const f = fixture(), blocked: SessionStartupReport = { ...report(f.s), startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'blocked', reasonCode: 'recovery_limit' } };
    f.current({ status: 'registered', session: f.s, startupReport: blocked });
    await f.client.start(); f.receive(f.s);
    f.client.setDraft('retain input while the Worker reconciles its report');
    expect(f.api.timeline).not.toHaveBeenCalled();
    await expect(f.client.send('connected does not bypass a recovery block')).rejects.toThrow();
    f.client.observeTaskStartupReport({ ...blocked, revision: '2', startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'none', reasonCode: null } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.client.snapshot()).toMatchObject({ connected: true, startupReport: { revision: '2', recovery: { state: 'none' } }, draft: { text: 'retain input while the Worker reconciles its report' } });
    expect(f.api.timeline).toHaveBeenCalledOnce();
    expect(f.api.channel).toHaveBeenCalledOnce();
    f.client.observeTaskStartupReport(blocked);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.client.snapshot()).toMatchObject({ connected: true, startupReport: { revision: '2', recovery: { state: 'none' } } });
    expect(f.api.command).not.toHaveBeenCalled();
  });

  it('does not regress a newer report revision or retry the same offline history refusal', async () => {
    vi.useFakeTimers();
    const f = fixture(), healthy = { ...report(f.s, '3'), startup: { state: 'ready' as const, reasonCode: 'ready' as const }, recovery: { state: 'none' as const, reasonCode: null } };
    f.current({ status: 'registered', session: f.s, startupReport: healthy });
    vi.mocked(f.api.timeline).mockRejectedValue(new ApiError('server', 503, 'controller_offline'));
    await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
    f.client.observeTaskStartupReport(report(f.s, '2'));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.api.timeline).toHaveBeenCalledOnce();
    expect(f.client.snapshot()).toMatchObject({ errorCode: 'controller_offline', startupReport: { revision: '3' } });
    expect(f.api.channel).toHaveBeenCalledOnce();
  });

  it('clears execution content after the Task authority is revoked', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
    f.client.setDraft('private text');
    f.client.invalidate(new ApiError('server', 403, 'forbidden'));
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
  f.client.invalidate(new ApiError('server', 403, 'forbidden'));
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot()).toMatchObject({ status: 'unavailable', errorCode: 'forbidden', error: 'You do not have permission to perform this action.', state: { snapshot: null } });
});

it('does not publish an old Task report after a streamed generation replacement', async () => {
  const f = fixture(), oldReport = report(f.s);
  f.current({ status: 'registered', session: f.s, startupReport: oldReport });
  await f.client.start(); f.receive(f.s);
  const replacement = { ...f.s, executionGeneration: '2', connectionState: 'disconnected' as const, synchronized: false, identity: { ...f.s.identity, controllerInstanceId: '00000010-1111-4111-8111-111111111111' } };
  f.receive(replacement);
  f.client.observeTaskStartupReport(oldReport);
  expect(f.client.snapshot()).toMatchObject({ startupReport: null, environmentConnected: false, state: { snapshot: { executionGeneration: '2' } } });
  expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.api.current).toHaveBeenCalledOnce();
});

it('keeps history corruption visible across unchanged Task startup observations', async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, hasMoreBefore: true, beforeCursor: null });
  await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot().error).toContain('empty pagination cursor');
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.client.snapshot().error).toContain('empty pagination cursor');
  expect(f.api.timeline).toHaveBeenCalledOnce();
});

it('keeps sending disabled when a streamed snapshot is ahead of the materialized event watermark', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  const newer = { ...f.s, sessionRevision: '13', lastEventSeq: '1' };
  f.receive(newer);
  await vi.advanceTimersByTimeAsync(0);
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
  f.receive(newer);
  await vi.advanceTimersByTimeAsync(0);
  finish(f.page); await vi.advanceTimersByTimeAsync(0);
  f.receive(newer); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.timeline).toHaveBeenCalledTimes(2);
  expect(f.client.snapshot().connected).toBe(true);
});

it('does not replace a newer streamed disconnection with an older unfinished tail snapshot', async () => {
  vi.useFakeTimers();
  const f = fixture(); let finish!: (page: TimelinePage) => void;
  vi.mocked(f.api.timeline).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await f.client.start(); f.receive(f.s);
  f.receive({ ...f.s, sessionRevision: '13', connectionState: 'disconnected', synchronized: false });
  await vi.advanceTimersByTimeAsync(0);
  finish(f.page); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot()).toMatchObject({ connected: false, state: { snapshot: { sessionRevision: '13', connectionState: 'disconnected' } } });
  await expect(f.client.send('do not send')).rejects.toThrow();
});

it('keeps a contradictory Task report visible ahead of an offline-history notice', async () => {
  const f = fixture(), healthy: SessionStartupReport = { ...report(f.s), startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'none', reasonCode: null } };
  f.client.observeTaskStartupReport(healthy);
  vi.mocked(f.api.timeline).mockRejectedValue(new ApiError('server', 503, 'controller_offline'));
  await f.client.start(); f.receive(f.s);
  await vi.waitFor(() => expect(f.client.snapshot().errorCode).toBe('controller_offline'));
  f.client.observeTaskStartupReport({ ...healthy, startup: { state: 'unknown', reasonCode: 'native_timeout' } });
  expect(f.client.snapshot()).toMatchObject({ errorCode: 'protocol', connected: false });
  f.client.observeTaskStartupReport({ ...healthy, revision: '2' });
  expect(f.client.snapshot()).toMatchObject({ errorCode: 'controller_offline', connected: false });
  expect(f.api.timeline).toHaveBeenCalledOnce();
});

it('does not replace a newer streamed disconnection with the delayed initial channel snapshot', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start();
  f.receive({ ...f.s, sessionRevision: '13', connectionState: 'disconnected', synchronized: false, lastEventSeq: '1' });
  await vi.advanceTimersByTimeAsync(0);
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

it('restores a healthy report without another complete snapshot or channel event', async () => {
  const f = fixture(), healthy: SessionStartupReport = { ...report(f.s), startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'none', reasonCode: null } };
  f.client.observeTaskStartupReport(healthy);
  await f.client.start(); f.receive(f.s);
  await vi.waitFor(() => expect(f.client.snapshot().historyReady).toBe(true));
  f.client.setDraft('preserve the idle draft');
  f.client.observeTaskStartupReport({ ...healthy, startup: { state: 'unknown', reasonCode: 'native_timeout' } });
  expect(f.client.snapshot()).toMatchObject({ connected: false, status: 'error', errorCode: 'protocol' });
  f.client.observeTaskStartupReport({ ...healthy, revision: '2' });
  expect(f.client.snapshot()).toMatchObject({ connected: true, status: 'ready', historyReady: true, error: null, draft: { text: 'preserve the idle draft' } });
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.api.timeline).toHaveBeenCalledOnce();
});

it('retains a history failure when a valid Task report replaces a contradictory observation', async () => {
  const f = fixture(), healthy: SessionStartupReport = { ...report(f.s), startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'none', reasonCode: null } };
  f.client.observeTaskStartupReport(healthy);
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, hasMoreBefore: true, beforeCursor: null });
  await f.client.start(); f.receive(f.s);
  await vi.waitFor(() => expect(f.client.snapshot().error).toContain('empty pagination cursor'));
  const historyError = f.client.snapshot().error;
  f.client.observeTaskStartupReport({ ...healthy, startup: { state: 'unknown', reasonCode: 'native_timeout' } });
  f.client.observeTaskStartupReport({ ...healthy, revision: '2' });
  expect(f.client.snapshot()).toMatchObject({ connected: false, status: 'error', historyReady: false, error: historyError });
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.timeline).toHaveBeenCalledOnce(); expect(f.api.command).not.toHaveBeenCalled();
});


it('defers initial discovery until visible and retains a healthy channel while hidden', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.client.setVisible(false);
  await f.client.start(); await vi.advanceTimersByTimeAsync(15_000);
  expect(f.api.current).not.toHaveBeenCalled();
  f.client.setVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledOnce(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  f.client.setDraft('retained draft');
  const close = vi.mocked(f.api.channel).mock.results[0]!.value.close;
  f.client.setVisible(false); await vi.advanceTimersByTimeAsync(15_000);
  f.client.setVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.channel).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  expect(f.client.snapshot()).toMatchObject({ connected: true, draft: { text: 'retained draft' } });
});

it('discovers later registration and a newer execution once from Task reports', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.current({ status: 'not_registered', claimId: f.s.claimId, agentControlMode: 'web' });
  await f.client.start(); await vi.advanceTimersByTimeAsync(15_000);
  expect(f.api.current).toHaveBeenCalledOnce();
  const first = report(f.s);
  f.current({ status: 'registered', session: f.s, startupReport: first });
  f.client.observeTaskStartupReport(first); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.channel).toHaveBeenCalledOnce();
  f.client.observeTaskStartupReport({ ...first }); await vi.advanceTimersByTimeAsync(15_000);
  expect(f.api.current).toHaveBeenCalledTimes(2);
  const next = { ...f.s, executionGeneration: '2', identity: { ...f.s.identity, controllerInstanceId: '00000010-1111-4111-8111-111111111111' } };
  const replacement = report(next);
  f.client.setVisible(false); f.client.observeTaskStartupReport(replacement);
  f.current({ status: 'registered', session: next, startupReport: replacement });
  await vi.advanceTimersByTimeAsync(15_000); expect(f.api.current).toHaveBeenCalledTimes(2);
  f.client.setVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(3); expect(f.client.snapshot().state.snapshot?.executionGeneration).toBe('2');
  f.client.observeTaskStartupReport({ ...replacement, revision: '2' });
  f.client.observeTaskStartupReport(first); await vi.advanceTimersByTimeAsync(15_000);
  expect(f.api.current).toHaveBeenCalledTimes(3); expect(f.client.snapshot().startupReport?.executionGeneration).toBe('2');
});

it('serializes a report-triggered discovery behind a pending initial read', async () => {
  vi.useFakeTimers();
  const f = fixture(); let finish!: (result: CurrentSessionResponse) => void;
  vi.mocked(f.api.current).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.start();
  const observed = report(f.s); f.client.observeTaskStartupReport(observed);
  expect(f.api.current).toHaveBeenCalledOnce();
  f.current({ status: 'registered', session: f.s, startupReport: observed });
  finish({ status: 'not_registered', claimId: f.s.claimId, agentControlMode: 'web' });
  await pending; await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.channel).toHaveBeenCalledOnce();
  f.client.observeTaskStartupReport({ ...observed }); await vi.advanceTimersByTimeAsync(15_000);
  expect(f.api.current).toHaveBeenCalledTimes(2);
});

it('cancels a hidden discovery and excludes its late response after reopening', async () => {
  vi.useFakeTimers();
  const f = fixture(); let finish!: (result: CurrentSessionResponse) => void;
  vi.mocked(f.api.current).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.start(); const signal = vi.mocked(f.api.current).mock.calls[0]![0];
  f.client.setVisible(false); expect(signal.aborted).toBe(true);
  f.client.setVisible(true); expect(f.api.current).toHaveBeenCalledOnce();
  expect(f.api.channel).not.toHaveBeenCalled();
  finish({ status: 'registered', session: f.s }); await pending;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.channel).toHaveBeenCalledOnce();
});


it('applies the latest same-execution Task report when the initial current response arrives', async () => {
  const f = fixture(); let finish!: (result: CurrentSessionResponse) => void;
  vi.mocked(f.api.current).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.client.start();
  const ready: SessionStartupReport = { ...report(f.s, '2'), startup: { state: 'ready', reasonCode: 'ready' }, recovery: { state: 'none', reasonCode: null } };
  f.client.observeTaskStartupReport(ready);
  finish({ status: 'registered', session: f.s, startupReport: report(f.s) }); await pending;
  f.receive(f.s); await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  expect(f.client.snapshot().startupReport?.revision).toBe('2');
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.channel).toHaveBeenCalledOnce();
});


it('defers archive preparation discovered by a hidden stream until the panel opens', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.client.start(); f.receive(f.s); await vi.advanceTimersByTimeAsync(0);
  f.client.setVisible(false);
  const draining = { ...f.s, lifecycle: 'draining' as const, connectionState: 'disconnected' as const, sessionRevision: '13' };
  f.receive(draining); await vi.advanceTimersByTimeAsync(15_000);
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.archive).not.toHaveBeenCalled();
  f.current({ status: 'registered', session: { ...draining, lifecycle: 'archived', sessionRevision: '14' } });
  vi.mocked(f.api.archive).mockResolvedValue({ state: 'failed', sha256: null, byteLength: null, errorCode: 'archive_failed' });
  f.client.setVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.archive).toHaveBeenCalledOnce();
});
