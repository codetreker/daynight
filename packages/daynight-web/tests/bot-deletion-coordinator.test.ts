import { afterEach, expect, it, vi } from 'vitest';
import { getBotDeletionCoordinator, clearPendingBotDeletions } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_USER, botDefinition, botId, botResponse, botError } from './helpers/bots';
import type { DeletedBot } from '../src/api/bots';
import { BotSessionCache, botSessionKey } from '../src/features/bots/session-cache';
import { BotSessionStorage } from '../src/features/bots/session-storage';
import { botFixture } from './helpers/bot-session';

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

it.each(['pending', 'completed', 'unknown', 'unavailable'] as const)('handles a %s deletion response after the page cache has detached and closed', async outcome => {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const bindings = [1, 2].map(n => ({ ownerUserId: BOT_USER, botId: botId(n), sessionId: botId(30 + n), testExecutionId: botId(40 + n) }));
  const bots = bindings.map(binding => botFixture(binding));
  const cache = new BotSessionCache({ userId: BOT_USER, identityScope: scope, isCurrent: () => !scope.isInvalidated, onPrincipalMismatch: scope.principalMismatch, storage: sessionStorage, createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api });
  const coordinator = getBotDeletionCoordinator(scope), detach = coordinator.attachCache(cache);
  try {
    for (const binding of bindings) cache.select(binding);
    const [a, b] = cache.snapshot();
    await vi.waitFor(() => { expect(a!.client.snapshot().connected).toBe(true); expect(b!.client.snapshot().connected).toBe(true); });
    cache.select(bindings[0]!, bindings[0]!);
    expect(a!.client.snapshot().actionAdmitted).toBe(true);
    expect(b!.client.snapshot().actionAdmitted).toBe(false);
    a!.client.setDraft('deleted Bot draft'); b!.client.setDraft('other Bot draft');
    vi.mocked(bots[0]!.api.command).mockRejectedValue(new Error('receipt unknown'));
    await expect(a!.client.send('deleted Bot draft')).rejects.toThrow();
    const ownedPrefix = `daynight:bot-session:${botSessionKey(bindings[0]!)}:`;
    const otherPrefix = `daynight:bot-session:${botSessionKey(bindings[1]!)}:`;
    const ownedKeys = Object.keys(sessionStorage).filter(key => key.startsWith(ownedPrefix));
    expect(ownedKeys.some(key => key.includes('session-draft'))).toBe(true);
    expect(ownedKeys.some(key => key.includes('session-operations'))).toBe(true);
    const otherKeys = Object.keys(sessionStorage).filter(key => key.startsWith(otherPrefix));
    const otherValues = otherKeys.map(key => sessionStorage.getItem(key));
    const taskKey = `daynight:session-draft:${BOT_USER}:independent-task`;
    sessionStorage.setItem(taskKey, 'independent Task draft');
    const displayKey = (sessionId: string) => `daynight.web.session.display.v1:${JSON.stringify([BOT_USER, sessionId])}`;
    for (const binding of bindings) localStorage.setItem(displayKey(binding.sessionId), '\"standard\"');
    localStorage.setItem(displayKey(botId(70)), '\"standard\"');
    const pending = deferred<Response>(); let requestId = '';
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      if (init?.method === 'DELETE') { requestId = JSON.parse(init.body).deletionId; return pending.promise; }
      return outcome === 'unavailable' ? botError(404, 'not_found') : botResponse(botDefinition());
    }));
    const operation = coordinator.begin({ ...botDefinition(), sessionId: bindings[0]!.sessionId, testExecutionId: bindings[0]!.testExecutionId });
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    expect(cache.isBlocked(botId())).toBe(true);
    detach(); cache.close();
    expect(ownedKeys.every(key => sessionStorage.getItem(key) !== null)).toBe(true);
    pending.resolve(outcome === 'unknown' || outcome === 'unavailable' ? botError(500, 'failure') : botResponse(deleted(outcome, '2', requestId)));
    await operation;
    expect(coordinator.snapshot()[0]!.phase).toBe(outcome);
    if (outcome === 'unknown') {
      expect(ownedKeys.every(key => sessionStorage.getItem(key) !== null)).toBe(true);
      expect(a!.retained.storage.getItem(a!.retained.storage.key(0)!)).not.toBeNull();
      expect(localStorage.getItem(displayKey(bindings[0]!.sessionId))).toBe('\"standard\"');
    } else {
      expect(ownedKeys.map(key => sessionStorage.getItem(key))).toEqual(ownedKeys.map(() => null));
      expect(localStorage.getItem(displayKey(bindings[0]!.sessionId))).toBeNull();
      a!.retained.storage.setItem('late', 'late deleted Bot state');
      expect(a!.retained.storage.length).toBe(0);
      expect(new BotSessionStorage(botSessionKey(bindings[0]!), sessionStorage).length).toBe(0);
      expect(sessionStorage.getItem(`${ownedPrefix}late`)).toBeNull();
    }
    expect(otherKeys.map(key => sessionStorage.getItem(key))).toEqual(otherValues);
    expect(sessionStorage.getItem(taskKey)).toBe('independent Task draft');
    expect(localStorage.getItem(displayKey(bindings[1]!.sessionId))).toBe('\"standard\"');
    expect(localStorage.getItem(displayKey(botId(70)))).toBe('\"standard\"');
  } finally { detach(); cache.close(); }
});
