import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { createBotSessionApi, createSessionApi, createTestSessionApi, type SessionApi } from '../src/api/sessions';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { sessionFence } from '../../daynight/src/session/protocol';
import type { SessionArchive } from '../../daynight/src/session/archive';
import { botFixture } from './helpers/bot-session';

const clients: TaskSessionClient[] = [];
// Keep IndexedDB cleanup on its real task queue while controlling Session deadlines.
const fakeSessionClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear(); localStorage.clear(); });
const refused = (userId: string, code = 'resource_conflict') => new Response(JSON.stringify({ error: { code, message: 'The resource cannot be read.', requestId: 'deletion-read' } }), { status: 409, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
function fixture(bot: boolean, archived = false) {
  fakeSessionClock();
  const f = botFixture(), { binding } = f;
  if (archived) f.change({ ...f.snapshot(), lifecycle: 'archived', connectionState: 'disconnected', operations: { canSend: false, canCancel: false, canRespond: false } });
  let deny = false;
  const fetch = vi.fn(async () => deny ? refused(binding.ownerUserId) : new Response(JSON.stringify({ session: f.snapshot() }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': binding.ownerUserId } }));
  vi.stubGlobal('fetch', fetch);
  const transport = bot ? createBotSessionApi(binding, vi.fn()) : createTestSessionApi(binding.sessionId, binding.ownerUserId, vi.fn());
  const api: SessionApi = { ...f.api, current: transport.current };
  const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(f.snapshot()), controllerId: f.snapshot().identity.controllerId, controllerInstanceId: f.snapshot().identity.controllerInstanceId, provider: f.snapshot().identity.provider, nativeSessionId: f.snapshot().identity.nativeSessionId, entries: f.page.items, resources: [] };
  vi.mocked(api.archive).mockResolvedValue({ state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null });
  vi.mocked(api.archiveContent).mockResolvedValue(archive);
  const onInvalidate = vi.fn();
  const client = new TaskSessionClient({ api, userId: binding.ownerUserId, testSessionId: binding.sessionId, ...(bot ? { bot: binding } : {}), isCurrent: () => true, onPrincipalMismatch: vi.fn(), onInvalidate, storage: sessionStorage });
  clients.push(client);
  const displayKey = `daynight.web.session.display.v1:${JSON.stringify([binding.ownerUserId, binding.sessionId])}`;
  localStorage.setItem(displayKey, '"standard"');
  return { ...f, api, client, fetch, onInvalidate, displayKey, deny: () => { deny = true; } };
}

it.each([true, false])('clears an already loaded independent conversation after authoritative current refusal (Bot binding=%s)', async bot => {
  const f = fixture(bot);
  await f.client.start(); await vi.advanceTimersByTimeAsync(0);
  expect(f.client.snapshot().connected).toBe(true); expect(f.client.snapshot().state.entries).toHaveLength(1);
  f.client.setDraft('private draft');
  vi.mocked(f.api.command).mockRejectedValue(new Error('delivery unknown'));
  await expect(f.client.send('private draft')).rejects.toThrow();
  const ownedKeys = Object.keys(sessionStorage); expect(ownedKeys.length).toBeGreaterThan(0);
  sessionStorage.setItem('unrelated-task', 'keep'); localStorage.setItem('unrelated-display', 'keep');
  f.deny(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot().status).toBe('unavailable');
  expect(f.client.snapshot().state.entries).toEqual([]); expect(f.client.snapshot().state.operations.size).toBe(0);
  expect(f.client.snapshot().draft.text).toBe(''); expect(f.onInvalidate).toHaveBeenCalledOnce();
  expect(ownedKeys.map(key => sessionStorage.getItem(key))).toEqual(ownedKeys.map(() => null));
  expect(localStorage.getItem(f.displayKey)).toBeNull();
  expect(sessionStorage.getItem('unrelated-task')).toBe('keep'); expect(localStorage.getItem('unrelated-display')).toBe('keep');
  expect(f.api.archive).not.toHaveBeenCalled(); expect(f.api.archiveContent).not.toHaveBeenCalled();
  await expect(f.client.send('late')).rejects.toThrow(); expect(f.api.command).toHaveBeenCalledOnce();
});

it('refuses an old Test URL before restoring its saved draft or loading an archive', async () => {
  const f = fixture(false);
  const draftKey = `daynight:session-draft:${f.binding.ownerUserId}:test:${f.binding.sessionId}:test:${f.binding.testExecutionId}:1`;
  sessionStorage.setItem(draftKey, JSON.stringify({ text: 'old private draft', revision: 'old', submission: null }));
  f.deny(); await f.client.start();
  expect(f.client.snapshot().status).toBe('unavailable'); expect(f.client.snapshot().state.snapshot).toBeNull();
  expect(sessionStorage.getItem(draftKey)).toBeNull(); expect(localStorage.getItem(f.displayKey)).toBeNull();
  expect(f.api.archive).not.toHaveBeenCalled(); expect(f.api.timeline).not.toHaveBeenCalled();
});

it('revalidates a displayed independent archive without repeatedly fetching its content', async () => {
  const f = fixture(false, true);
  await f.client.start(); expect(f.client.snapshot().archiveState).toBe('ready');
  expect(f.client.snapshot().state.entries).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.fetch.mock.calls.length).toBeGreaterThan(2); expect(f.api.archiveContent).toHaveBeenCalledOnce();
  f.deny(); await vi.advanceTimersByTimeAsync(3000);
  expect(f.client.snapshot().status).toBe('unavailable'); expect(f.client.snapshot().archiveState).toBeNull();
  expect(f.client.snapshot().state.entries).toEqual([]); expect(localStorage.getItem(f.displayKey)).toBeNull();
  expect(f.api.archiveContent).toHaveBeenCalledOnce();
});

it('does not reinterpret Task current conflicts or independent resource conflicts as access loss', async () => {
  const f = fixture(true);
  await f.client.start(); await vi.advanceTimersByTimeAsync(0);
  const api = createSessionApi(f.binding.botId, f.binding.testExecutionId, f.binding.ownerUserId, vi.fn());
  f.deny();
  await expect(api.current(new AbortController().signal)).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'resource_conflict' });
  const transport = createTestSessionApi(f.binding.sessionId, f.binding.ownerUserId, vi.fn());
  await expect(transport.resource(f.binding.sessionId, f.binding.botId, new AbortController().signal)).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'resource_conflict' });
  f.client.setDraft('keep until current is read');
  vi.mocked(f.api.command).mockRejectedValue(new ApiError('server', 409, 'resource_conflict'));
  await expect(f.client.send('keep until current is read')).rejects.toThrow();
  expect(f.client.snapshot().status).toBe('ready'); expect(f.client.snapshot().draft.text).toBe('keep until current is read');
  expect(f.onInvalidate).not.toHaveBeenCalled();
});
