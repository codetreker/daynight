import { readFileSync } from 'node:fs';
import { screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionArchive, SessionArchiveStatus } from '../../daynight/src/session/archive';
import { sessionFence, type SessionSnapshot } from '../../daynight/src/session/protocol';
import type { BrowserMessage } from '../../daynight/src/session/controller-protocol';
import { createSessionApi, createTestSessionApi, type SessionApi } from '../src/api/sessions';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { TaskSessionSnapshot } from './helpers/session';
const render = createLocaleRender('en');
const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(lifecycle: SessionSnapshot['lifecycle'] = 'archived', standalone = false) {
  const task: TaskSessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const s: SessionSnapshot = { ...task, lifecycle, connectionState: 'disconnected', lastEventSeq: '0', operations: { canSend: false, canCancel: false, canRespond: false }, ...(standalone ? { claimId: undefined, testExecutionId: task.claimId, identity: { controllerId: task.identity.controllerId, controllerInstanceId: task.identity.controllerInstanceId, nativeSessionId: task.identity.nativeSessionId, provider: task.identity.provider, agentControlMode: 'web', ownerUserId: userId } } : {}) } as SessionSnapshot;
  if (standalone) delete (s as { claimId?: string }).claimId;
  const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(s), controllerId: s.identity.controllerId, controllerInstanceId: s.identity.controllerInstanceId, provider: s.identity.provider, nativeSessionId: s.identity.nativeSessionId, entries: [{ entryId: '00000007-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: 'The saved result.' }] }], resources: [] };
  const status: SessionArchiveStatus = { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null };
  let receive!: (value: BrowserMessage) => void;
  const close = vi.fn();
  const api: SessionApi = { current: vi.fn(async () => ({ status: 'registered' as const, session: s })), archive: vi.fn(async () => status), archiveContent: vi.fn(async () => archive), channel: vi.fn((_id, _cursor, next) => { receive = next; return { close }; }), timeline: vi.fn(), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused' };
  const client = new TaskSessionClient({ api, userId, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn(), ...(standalone ? { testSessionId: s.sessionId } : { projectId: task.identity.projectId, taskId: task.identity.taskId, claimId: task.claimId }) });
  clients.push(client);
  return { s, archive, api, client, close, receive: (value: BrowserMessage) => receive(value) };
}
it.each([false, true])('renders completed history without a live controller (standalone=%s)', async standalone => {
  const f = fixture('archived', standalone); await f.client.start();
  render(<SessionView client={f.client} active current />);
  expect(screen.getByText('The saved result.')).toBeVisible();
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  expect(f.api.channel).not.toHaveBeenCalled(); expect(f.api.timeline).not.toHaveBeenCalled();
  await expect(f.client.send('again')).rejects.toThrow();
  await expect(f.client.cancel()).rejects.toThrow();
  expect(f.api.command).not.toHaveBeenCalled();
});
it.each(['pending', 'failed', 'unavailable'] as const)('shows an honest %s state without an empty conversation or restoring message', async state => {
  const f = fixture(); vi.mocked(f.api.archive).mockResolvedValue({ state, sha256: null, byteLength: null, errorCode: state === 'failed' ? 'upload_failed' : null });
  await f.client.start(); render(<SessionView client={f.client} active current />);
  expect(f.client.snapshot().archiveState).toBe(state);
  expect(screen.queryByText('No conversation yet.')).toBeNull();
  expect(screen.queryByText('Restoring session')).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(f.api.archiveContent).not.toHaveBeenCalled();
});
it('keeps active disconnected executions on the live path', async () => {
  const f = fixture('active'); await f.client.start();
  expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.api.archive).not.toHaveBeenCalled();
  expect(f.client.snapshot().archiveState).toBeNull();
});
it('closes a live channel as soon as its snapshot starts draining', async () => {
  const f = fixture('active'); await f.client.start();
  vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: { ...f.s, lifecycle: 'draining' } });
  f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, lifecycle: 'draining' }, cursor: 'tail' });
  expect(f.close).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(f.client.snapshot().archiveState).toBe('ready'));
  await expect(f.client.respond({ kind: 'approval', interactionId: 'approval', revision: '1', title: 'Run', detail: 'Run', state: 'pending', actions: ['allow_once'] }, { kind: 'approval', action: 'allow_once' })).rejects.toThrow();
  expect(f.api.command).not.toHaveBeenCalled();
});
it.each(['claimId', 'controllerId', 'controllerInstanceId', 'nativeSessionId'] as const)('rejects archive identity mismatch in %s', async field => {
  const f = fixture(); vi.mocked(f.api.archiveContent).mockResolvedValue({ ...f.archive, [field]: '00000099-1111-4111-8111-111111111111' } as SessionArchive);
  await f.client.start(); expect(f.client.snapshot().archiveState).toBe('failed'); expect(f.client.snapshot().state.entries).toEqual([]);
});
it('discards an archive response after the client closes', async () => {
  const f = fixture(); let resolve!: (archive: SessionArchive) => void;
  vi.mocked(f.api.archiveContent).mockImplementation(() => new Promise(done => { resolve = done; }));
  const loading = f.client.start(); await vi.waitFor(() => expect(f.api.archiveContent).toHaveBeenCalledOnce());
  f.client.close(); resolve(f.archive); await loading;
  expect(f.client.snapshot().state.entries).toEqual([]);
});
it('reads archived resources locally and respects cancellation', async () => {
  const f = fixture(); const data = btoa('saved bytes');
  vi.mocked(f.api.archiveContent).mockResolvedValue({ ...f.archive, resources: [{ resource: { resourceId: '00000008-1111-4111-8111-111111111111', status: 'available', name: 'output.txt', mediaType: 'text/plain', byteLength: '11', sha256: 'a'.repeat(64), error: null }, data }] });
  await f.client.start(); const abort = new AbortController();
  const blob = await f.client.resource('00000008-1111-4111-8111-111111111111', abort.signal);
  expect(blob.size).toBe(11); expect(f.api.resource).not.toHaveBeenCalled();
  abort.abort(); await expect(f.client.resource('00000008-1111-4111-8111-111111111111', abort.signal)).rejects.toThrow();
});
it.each([false, true])('loads authenticated archive content through the shared API (standalone=%s)', async standalone => {
  const f = fixture('archived', standalone);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ archive: f.archive }), { headers: { 'Daynight-User-ID': userId, 'Content-Type': 'application/json' } })));
  const api = standalone ? createTestSessionApi(f.s.sessionId, userId, vi.fn()) : createSessionApi(f.s.identity.projectId!, f.s.identity.taskId!, userId, vi.fn());
  expect(await api.archiveContent(f.s.sessionId, new AbortController().signal)).toEqual(f.archive);
});
it('rejects archive responses from a different principal', async () => {
  const f = fixture(); const mismatch = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ archive: f.archive }), { headers: { 'Daynight-User-ID': '00000010-1111-4111-8111-111111111111' } })));
  const api = createSessionApi(f.s.identity.projectId!, f.s.identity.taskId!, userId, mismatch);
  await expect(api.archiveContent(f.s.sessionId, new AbortController().signal)).rejects.toThrow(); expect(mismatch).toHaveBeenCalledOnce();
});

it('rechecks draining sessions whose archive intent has not arrived yet', async () => {
  vi.useFakeTimers();
  const f = fixture('draining');
  vi.mocked(f.api.archive).mockResolvedValueOnce({ state: 'unavailable', sha256: null, byteLength: null, errorCode: null });
  await f.client.start(); render(<SessionView client={f.client} active current />);
  expect(screen.getByText('The session is ending. Waiting for its history archive.')).toBeVisible();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot().archiveState).toBe('ready');
  expect(f.api.channel).not.toHaveBeenCalled();
});
it('rejects oversized archive response bodies before reading them', async () => {
  const f = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Daynight-User-ID': userId, 'Content-Length': String(65 * 1024 * 1024) } })));
  const api = createSessionApi(f.s.identity.projectId!, f.s.identity.taskId!, userId, vi.fn());
  await expect(api.archiveContent(f.s.sessionId, new AbortController().signal)).rejects.toThrow();
});
it('rejects malformed archive envelopes and missing resource references', async () => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ archive: f.archive, extra: true }), { headers: { 'Daynight-User-ID': userId } }));
  vi.stubGlobal('fetch', fetch);
  const api = createSessionApi(f.s.identity.projectId!, f.s.identity.taskId!, userId, vi.fn());
  await expect(api.archiveContent(f.s.sessionId, new AbortController().signal)).rejects.toThrow();
  fetch.mockImplementation(async () => new Response(JSON.stringify({ archive: { ...f.archive, entries: [{ ...f.archive.entries[0], content: [{ type: 'resource', resourceId: '00000008-1111-4111-8111-111111111111', label: 'missing' }] }] } }), { headers: { 'Daynight-User-ID': userId } }));
  await expect(api.archiveContent(f.s.sessionId, new AbortController().signal)).rejects.toThrow();
});

it('rebinds a ready archive to the final native ID from a fresh authenticated snapshot', async () => {
  const f = fixture(); const final = { ...f.s, identity: { ...f.s.identity, nativeSessionId: 'final-native-id' } };
  vi.mocked(f.api.current).mockResolvedValueOnce({ status: 'registered', session: { ...f.s, identity: { ...f.s.identity, nativeSessionId: null } } }).mockResolvedValue({ status: 'registered', session: final });
  vi.mocked(f.api.archiveContent).mockResolvedValue({ ...f.archive, nativeSessionId: 'final-native-id' });
  await f.client.start();
  expect(f.api.current).toHaveBeenCalledTimes(2);
  expect(f.client.snapshot().archiveState).toBe('ready');
  expect(f.client.snapshot().state.snapshot?.identity.nativeSessionId).toBe('final-native-id');
});
it('does not load a previous generation archive after a concurrent standalone resume', async () => {
  const f = fixture('archived', true);
  const resumed = { ...f.s, executionGeneration: '2', lifecycle: 'active' as const };
  vi.mocked(f.api.current).mockResolvedValueOnce({ status: 'registered', session: f.s }).mockResolvedValue({ status: 'registered', session: resumed });
  await f.client.start();
  await vi.waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
  expect(f.api.archiveContent).not.toHaveBeenCalled();
  expect(f.client.snapshot().archiveState).toBeNull();
});
