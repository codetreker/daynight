import { afterEach, expect, it, vi } from 'vitest';
import { getBotDeletionCoordinator, clearPendingBotDeletions } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botDefinition, botId, botResponse, botError } from './helpers/bots';
import type { DeletedBot } from '../src/api/bots';

const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); sessionStorage.clear(); });
const deleted = (state: 'pending' | 'failed' | 'completed' = 'pending', version = '2', deletionId = botId(90)): DeletedBot => ({ id: botId(), workerId: botId(20), version, deletion: { deletionId, requestedVersion: '1', workerCleanup: { state, code: state === 'failed' ? 'stop_failed' : null }, serverCleanup: { state: state === 'completed' ? 'completed' : 'pending', code: null } } });
function fixture() {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const cache = { blockBot: vi.fn(), unblockBot: vi.fn(), invalidateBot: vi.fn() };
  const coordinator = getBotDeletionCoordinator(scope); coordinator.attachCache(cache);
  return { scope, cache, coordinator, record: () => coordinator.snapshot()[0]! };
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
it('blocks before DELETE dispatch and accepts completed only from both cleanup stages', async () => {
  const f = fixture(), pending = deferred<Response>(); let input: { deletionId: string };
  const fetch = vi.fn(async (_url, init) => { expect(f.cache.blockBot).toHaveBeenCalledWith(botId()); input = JSON.parse(init.body); return pending.promise; }); vi.stubGlobal('fetch', fetch);
  const operation = f.coordinator.begin(botDefinition());
  expect(f.record().phase).toBe('submitting');
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  pending.resolve(botResponse(deleted('pending', '2', input!.deletionId))); await operation;
  expect(f.record().phase).toBe('pending'); expect(f.cache.invalidateBot).toHaveBeenCalledWith(botId(), undefined);
  f.coordinator.observe(deleted('completed', '3', input!.deletionId)); expect(f.record().phase).toBe('completed');
  f.coordinator.observe(deleted('pending', '2', input!.deletionId)); expect(f.record().phase).toBe('completed');
});
it('retains a lost response and active read as unknown without restoring send or repeating DELETE', async () => {
  const f = fixture(); const fetch = vi.fn(async (_url, init) => { if (init?.method === 'DELETE') throw Error('lost'); return botResponse(botDefinition()); }); vi.stubGlobal('fetch', fetch);
  await f.coordinator.begin(botDefinition());
  expect(f.record().phase).toBe('unknown'); expect(f.record().request?.ifVersion).toBe('1');
  expect(f.cache.unblockBot).not.toHaveBeenCalled(); expect(f.cache.invalidateBot).not.toHaveBeenCalled();
  await f.coordinator.check(botId()); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  const second = fixture(); expect(second.record().request).toEqual(f.record().request); expect(second.record().phase).toBe('unknown');
  expect(second.cache.blockBot).toHaveBeenCalledWith(botId());
});
it('only restores sending after a definite rejection followed by an authoritative active read', async () => {
  const f = fixture(); let readFails = true;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'DELETE' ? botError(409, 'version_conflict') : readFails ? botError(500, 'failure') : botResponse({ ...botDefinition(), version: '4' })));
  await f.coordinator.begin(botDefinition()); expect(f.record().phase).toBe('unknown'); expect(f.cache.unblockBot).not.toHaveBeenCalled();
  readFails = false; await f.coordinator.check(botId()); expect(f.record().phase).toBe('rejected'); expect(f.cache.unblockBot).toHaveBeenCalledWith(botId());
});
it('adopts another deletion identity and retries only its current original request after checking', async () => {
  const f = fixture(), calls: {method:string;body?:unknown}[] = [];
  let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    calls.push({ method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    if (init?.method === 'DELETE' && ++writes === 1) return botError(409, 'resource_conflict');
    if (init?.method === 'DELETE') return botResponse(deleted('completed', '5'));
    return botResponse(deleted('failed', '4'));
  }));
  await f.coordinator.begin(botDefinition()); expect(f.record().phase).toBe('failed');
  await f.coordinator.retry(botId()); expect(calls.map(call => call.method)).toEqual(['DELETE', 'GET', 'GET', 'DELETE']);
  expect(calls.at(-1)?.body).toEqual({ ifVersion: '1', deletionId: botId(90) }); expect(f.record().phase).toBe('completed');
});
it('does not retry when the required observation fails, and never equates access loss with completion', async () => {
  const f = fixture(); f.coordinator.observe(deleted()); const fetch = vi.fn(async () => botError(500, 'failure')); vi.stubGlobal('fetch', fetch);
  await f.coordinator.retry(botId()); expect(fetch).toHaveBeenCalledOnce(); expect(f.record().phase).toBe('pending');
  fetch.mockResolvedValue(botError(404, 'not_found')); await f.coordinator.check(botId()); expect(f.record().phase).toBe('unavailable'); expect(f.cache.invalidateBot).toHaveBeenCalled();
});
it('does not let a late active observation reverse confirmed deletion', async () => {
  const f = fixture(), read = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'DELETE' ? botError(409, 'version_conflict') : read.promise));
  const operation = f.coordinator.begin(botDefinition()); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  f.coordinator.observe(deleted('completed', '6')); read.resolve(botResponse(botDefinition())); await operation;
  expect(f.record().phase).toBe('completed'); expect(f.cache.unblockBot).not.toHaveBeenCalled();
});
it('retains in-memory requests when storage fails and clears them when the scope expires', async () => {
  const f = fixture(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('blocked'); });
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'DELETE' ? botError(500, 'failure') : botResponse(botDefinition())));
  await f.coordinator.begin(botDefinition()); expect(getBotDeletionCoordinator(f.scope).snapshot()[0]?.phase).toBe('unknown');
  f.scope.dispose(); expect(f.coordinator.snapshot()).toEqual([]); await f.coordinator.begin(botDefinition()); expect(fetch).toHaveBeenCalledTimes(2);
});
it('clears cold pending identities without mounting their coordinator and rejects malformed storage', () => {
  sessionStorage.setItem(`daynight.bot.deletions:${BOT_USER}`, 'not json'); expect(fixture().record()).toBeUndefined();
  clearPendingBotDeletions(BOT_USER); expect(sessionStorage.getItem(`daynight.bot.deletions:${BOT_USER}`)).toBeNull();
});
it('does not resolve an earlier unknown write from a rejected retry and an active read', async () => {
  const f = fixture(); let writes = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'DELETE') { if (++writes === 1) throw Error('lost'); return botError(409, 'version_conflict'); }
    return botResponse(botDefinition());
  }));
  await f.coordinator.begin(botDefinition()); await f.coordinator.retry(botId());
  expect(f.record().phase).toBe('unknown'); expect(f.cache.unblockBot).not.toHaveBeenCalled();
});
it('blocks duplicate submissions and stops business requests when the account expires', async () => {
  const f = fixture(), pending = deferred<Response>(); const fetch = vi.fn(async () => pending.promise); vi.stubGlobal('fetch', fetch);
  const operation = f.coordinator.begin(botDefinition()); await f.coordinator.begin(botDefinition());
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); f.scope.dispose(); pending.resolve(botResponse(deleted())); await operation;
  expect(f.coordinator.snapshot()).toEqual([]); expect(fetch).toHaveBeenCalledOnce();
});
it('restores only a valid original request and does not retain unrelated Bot configuration', async () => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'DELETE' ? botError(500, 'failure') : botResponse(botDefinition())));
  await f.coordinator.begin(botDefinition());
  const stored = sessionStorage.getItem(`daynight.bot.deletions:${BOT_USER}`)!;
  expect(stored).not.toContain('/ordinary/directory'); expect(stored).not.toContain('roleConfiguration');
  const values = JSON.parse(stored); values[0].request.ifVersion = '9223372036854775808';
  sessionStorage.setItem(`daynight.bot.deletions:${BOT_USER}`, JSON.stringify(values)); expect(fixture().coordinator.snapshot()).toEqual([]);
});
it('refuses a different Worker response without releasing the original input fence', async () => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'DELETE' ? botError(500, 'failure') : botResponse({ ...botDefinition(), workerId: botId(21), resolvedConfiguration: { ...botDefinition().resolvedConfiguration, workerId: botId(21) } })));
  await f.coordinator.begin(botDefinition()); expect(f.record().phase).toBe('unknown'); expect(f.record().error).toBeInstanceOf(Error); expect(f.cache.unblockBot).not.toHaveBeenCalled();
});
it('treats a DELETE response for another Worker as unknown and reconciles the original Bot', async () => {
  const f = fixture(); vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    if (init?.method === 'DELETE') return botResponse({ ...deleted('pending', '2', JSON.parse(init.body).deletionId), workerId: botId(21) });
    return botResponse(botDefinition());
  }));
  await f.coordinator.begin(botDefinition()); expect(f.record().phase).toBe('unknown'); expect(fetch).toHaveBeenCalledTimes(2); expect(f.cache.unblockBot).not.toHaveBeenCalled();
});
