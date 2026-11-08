import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, CurrentSessionResponse, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionArchive } from '../../daynight/src/session/archive';
import { sessionFence } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';

const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.useRealTimers(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function fixture(visible = true) {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' };
  let owned = true, paused = false, receive!: (message: BrowserMessage) => void;
  const close = vi.fn();
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = { current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), archive: vi.fn(), archiveContent: vi.fn(), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused', channel: vi.fn((_id, _cursor, onMessage) => { receive = onMessage; return { close }; }) };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, ownerUserId: userId, isCurrent: () => owned, isPaused: () => paused, onPrincipalMismatch: vi.fn(), storage: null });
  client.setCurrentReadVisible(visible); clients.push(client);
  return { s, api, client, close, receive: () => receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'zero' }), pause: () => { paused = true; }, resume: () => { paused = false; client.syncAvailability(); }, revoke: () => { owned = false; client.syncAvailability(); } };
}
async function ready(f: ReturnType<typeof fixture>) { await f.client.start(); f.receive(); await vi.advanceTimersByTimeAsync(0); expect(f.client.snapshot().connected).toBe(true); }

it('starts hidden and preserves visible three-second observation after opening', async () => {
  vi.useFakeTimers(); const f = fixture(false);
  f.client.syncAvailability(); await f.client.start(); f.client.refresh(); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).not.toHaveBeenCalled();
  f.client.setCurrentReadVisible(true); f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledOnce();
  for (let i = 0; i < 11; i++) { f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(250); }
  expect(f.api.current).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(250); expect(f.api.current).toHaveBeenCalledTimes(2);
});

it('retains a healthy channel, draft and history while current observation is hidden', async () => {
  vi.useFakeTimers(); const f = fixture(); await ready(f);
  f.client.setDraft('keep the draft'); const entries = f.client.snapshot().state.entries;
  f.client.setCurrentReadVisible(false); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  f.client.setCurrentReadVisible(true);
  expect(f.api.current).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2999); expect(f.api.current).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(f.api.current).toHaveBeenCalledTimes(2);
  expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.client.snapshot().state.entries).toBe(entries);
  expect(f.client.snapshot()).toMatchObject({ status: 'ready', connected: true, draft: { text: 'keep the draft' } });
});

it('retains a cancelled observation flight until it settles before resuming the same channel', async () => {
  vi.useFakeTimers(); const f = fixture(); await ready(f);
  const pending = deferred<CurrentSessionResponse>(); vi.mocked(f.api.current).mockReturnValueOnce(pending.promise);
  await vi.advanceTimersByTimeAsync(3000); const signal = vi.mocked(f.api.current).mock.calls[1]![0];
  f.client.setCurrentReadVisible(false); expect(signal.aborted).toBe(true);
  f.client.setCurrentReadVisible(true); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.close).not.toHaveBeenCalled();
  pending.resolve({ status: 'registered', session: { ...f.s, sessionRevision: '99', connectionState: 'disconnected' } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot()).toMatchObject({ connected: true, state: { snapshot: { sessionRevision: '12' } } });
  await vi.advanceTimersByTimeAsync(3000); expect(f.api.current).toHaveBeenCalledTimes(3); expect(f.api.channel).toHaveBeenCalledOnce();
});

it('serializes rapid reopening behind a cancelled initial discovery', async () => {
  vi.useFakeTimers(); const f = fixture(); const pending = deferred<CurrentSessionResponse>();
  vi.mocked(f.api.current).mockReturnValueOnce(pending.promise); const starting = f.client.start();
  f.client.setCurrentReadVisible(false); expect(vi.mocked(f.api.current).mock.calls[0]![0].aborted).toBe(true);
  f.client.setCurrentReadVisible(true); f.client.syncAvailability(); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.channel).not.toHaveBeenCalled();
  pending.resolve({ status: 'registered', session: f.s }); await starting; await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.channel).toHaveBeenCalledOnce();
});

it('cancels a current result waiting for identity admission when the panel hides', async () => {
  vi.useFakeTimers(); const f = fixture(); await ready(f);
  vi.mocked(f.api.current).mockImplementationOnce(async () => { f.pause(); return { status: 'registered', session: { ...f.s, sessionRevision: '99' } }; });
  await vi.advanceTimersByTimeAsync(3000); expect(f.client.snapshot().authPaused).toBe(true);
  f.client.setCurrentReadVisible(false); await vi.advanceTimersByTimeAsync(0); f.resume();
  expect(f.client.snapshot().state.snapshot?.sessionRevision).toBe('12'); expect(f.api.current).toHaveBeenCalledTimes(2);
  f.client.setCurrentReadVisible(true); await vi.advanceTimersByTimeAsync(3000);
  expect(f.api.current).toHaveBeenCalledTimes(3); expect(f.api.channel).toHaveBeenCalledOnce();
});

it('keeps explicit refresh inactive while hidden', async () => {
  vi.useFakeTimers(); const f = fixture(); await ready(f); f.client.setDraft('retain input');
  f.client.setCurrentReadVisible(false); f.client.refresh(); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.close).not.toHaveBeenCalled();
  expect(f.client.snapshot()).toMatchObject({ connected: true, historyReady: true, draft: { text: 'retain input' } });
});

it('delays final archive binding until visible without repeating archive status retrieval', async () => {
  vi.useFakeTimers(); const f = fixture(); const s = { ...f.s, lifecycle: 'archived' as const, connectionState: 'disconnected' as const };
  vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: s });
  const pending = deferred<{ state: 'ready'; sha256: string; byteLength: string; errorCode: null }>(); vi.mocked(f.api.archive).mockReturnValue(pending.promise);
  const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(s), provider: s.identity.provider, controllerId: s.identity.controllerId, controllerInstanceId: s.identity.controllerInstanceId, nativeSessionId: s.identity.nativeSessionId, entries: [], resources: [] };
  vi.mocked(f.api.archiveContent).mockResolvedValue(archive);
  const starting = f.client.start(); await vi.advanceTimersByTimeAsync(0); f.client.setCurrentReadVisible(false);
  pending.resolve({ state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null }); await starting;
  expect(f.api.current).toHaveBeenCalledOnce(); expect(f.api.archiveContent).not.toHaveBeenCalled();
  f.client.setCurrentReadVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.archive).toHaveBeenCalledOnce(); expect(f.api.archiveContent).toHaveBeenCalledOnce();
  expect(f.client.snapshot().archiveState).toBe('ready');
});

it('keeps a cancelled final archive flight reserved across rapid reopening', async () => {
  vi.useFakeTimers(); const f = fixture(); const s = { ...f.s, lifecycle: 'archived' as const, connectionState: 'disconnected' as const };
  const pending = deferred<CurrentSessionResponse>();
  vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: s }).mockImplementationOnce(async () => ({ status: 'registered', session: s })).mockReturnValueOnce(pending.promise);
  vi.mocked(f.api.archive).mockResolvedValue({ state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null });
  const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(s), provider: s.identity.provider, controllerId: s.identity.controllerId, controllerInstanceId: s.identity.controllerInstanceId, nativeSessionId: s.identity.nativeSessionId, entries: [], resources: [] };
  vi.mocked(f.api.archiveContent).mockResolvedValue(archive);
  const starting = f.client.start(); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2);
  f.client.setCurrentReadVisible(false); f.client.setCurrentReadVisible(true); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).toHaveBeenCalledTimes(2);
  pending.resolve({ status: 'registered', session: s }); await starting; await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(3); expect(f.api.archive).toHaveBeenCalledOnce(); expect(f.api.archiveContent).toHaveBeenCalledOnce();
  expect(f.client.snapshot().archiveState).toBe('ready');
});

it('ignores an old current result after execution ownership is revoked', async () => {
  vi.useFakeTimers(); const f = fixture(); const pending = deferred<CurrentSessionResponse>(); vi.mocked(f.api.current).mockReturnValueOnce(pending.promise);
  const starting = f.client.start(); f.revoke(); pending.resolve({ status: 'registered', session: f.s }); await starting;
  expect(f.api.channel).not.toHaveBeenCalled(); expect(f.client.snapshot().state.snapshot).toBeNull();
});


it('does not publish final archive content after its current binding is cancelled', async () => {
  vi.useFakeTimers(); const f = fixture(); const s = { ...f.s, lifecycle: 'archived' as const, connectionState: 'disconnected' as const };
  vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: s });
  vi.mocked(f.api.archive).mockResolvedValue({ state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null });
  const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(s), provider: s.identity.provider, controllerId: s.identity.controllerId, controllerInstanceId: s.identity.controllerInstanceId, nativeSessionId: s.identity.nativeSessionId, entries: [], resources: [] };
  const content = deferred<SessionArchive>(); vi.mocked(f.api.archiveContent).mockResolvedValue(archive).mockReturnValueOnce(content.promise);
  const starting = f.client.start(); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.api.archiveContent).toHaveBeenCalledOnce();
  f.client.setCurrentReadVisible(false); f.client.setCurrentReadVisible(true); await vi.advanceTimersByTimeAsync(9000);
  expect(f.api.current).toHaveBeenCalledTimes(2); expect(f.client.snapshot().archiveState).toBe('loading');
  content.resolve(archive); await starting; await vi.advanceTimersByTimeAsync(0);
  expect(f.api.current).toHaveBeenCalledTimes(3); expect(f.api.archiveContent).toHaveBeenCalledTimes(2);
  expect(f.client.snapshot().archiveState).toBe('ready');
});
