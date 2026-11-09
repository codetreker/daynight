import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { BotSessionCache, botSessionKey } from '../src/features/bots/session-cache';
import { BotSessionStorage } from '../src/features/bots/session-storage';
import { useSessionDisplayPreference } from '../src/features/task-agent-session/useSessionDisplayPreference';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
const caches: BotSessionCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.close()); sessionStorage.clear(); localStorage.clear(); });
function fixture(storage: Storage | null = null) {
  const bots = [1, 2, 3, 4].map(n => botFixture(botBinding(n)));
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage, createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api });
  caches.push(cache);
  async function select(n: number) { cache.select(bots[n - 1]!.binding, bots[n - 1]!.binding); const pane = cache.snapshot().find(p => p.binding.botId === bots[n - 1]!.binding.botId)!; await vi.waitFor(() => expect(pane.client.snapshot().connected).toBe(true)); return pane; }
  return { bots, cache, select };
}
it('keeps three clients, selects without restarting, and evicts the least recently visited inactive pane', async () => {
  const f = fixture(); const a = await f.select(1); a.client.setDraft('draft A');
  await f.select(2); expect(await f.select(1)).toBe(a); await f.select(3); await f.select(4);
  expect(f.cache.snapshot().map(p => p.binding.botId)).toEqual([1, 3, 4].map(n => botBinding(n).botId));
  expect(f.bots[1]!.channel.close).toHaveBeenCalledOnce(); expect(f.bots[0]!.channel.close).not.toHaveBeenCalled();
  expect(a.client.snapshot().draft.text).toBe('draft A'); expect(f.bots[0]!.api.current).toHaveBeenCalledOnce();
});
it('keeps a display-only resident editable while refusing a new remote operation', async () => {
  const f = fixture(), a = await f.select(1);
  f.cache.select(a.binding, null);
  a.client.setDraft('local text during detail confirmation');
  expect(a.client.snapshot().draft.text).toBe('local text during detail confirmation');
  expect(a.client.snapshot().actionAdmitted).toBe(false);
  await expect(a.client.send('must not leave this page')).rejects.toThrow();
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
  expect(a.client.snapshot().draft.submission).toBeNull();
  expect(a.client.snapshot().state.operations.size).toBe(0);
});
it.each(['ownerUserId', 'botId', 'sessionId', 'testExecutionId'] as const)('refuses action admission when the %s binding differs', async field => {
  const f = fixture(), a = await f.select(1);
  f.cache.select(a.binding, { ...a.binding, [field]: botBinding(2)[field] === a.binding[field] ? 'another-user' : botBinding(2)[field] });
  await expect(a.client.send('wrong complete binding')).rejects.toThrow();
  expect(f.bots[0]!.api.command).not.toHaveBeenCalled();
});
it('synchronously freezes every resident without closing channels or losing local drafts', async () => {
  const f = fixture(), a = await f.select(1), b = await f.select(2);
  f.cache.select(a.binding, a.binding); a.client.setDraft('A'); b.client.setDraft('B');
  f.cache.suspendActions();
  await expect(a.client.send('old callback')).rejects.toThrow();
  await expect(b.client.send('hidden callback')).rejects.toThrow();
  expect(f.bots.every(bot => vi.mocked(bot.api.command).mock.calls.length === 0)).toBe(true);
  expect(a.client.snapshot().draft.text).toBe('A'); expect(b.client.snapshot().draft.text).toBe('B');
  expect(f.bots[0]!.channel.close).not.toHaveBeenCalled(); expect(f.bots[1]!.channel.close).not.toHaveBeenCalled();
  f.cache.select(a.binding, a.binding);
  expect(a.client.snapshot().actionAdmitted).toBe(true); expect(b.client.snapshot().actionAdmitted).toBe(false);
  f.cache.select(null, a.binding);
  expect(a.client.snapshot().actionAdmitted).toBe(false);
});
it('restores a draft and queries the original uncertain operation after eviction with storage denied', async () => {
  const broken: Storage = { get length(): number { throw Error('denied'); }, key: () => { throw Error('denied'); }, getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); }, removeItem: () => { throw Error('denied'); }, clear: () => { throw Error('denied'); } };
  const f = fixture(broken), a = await f.select(1);
  a.client.setDraft('one send'); vi.mocked(f.bots[0]!.api.command).mockRejectedValue(new Error('lost response'));
  await expect(a.client.send('one send')).rejects.toThrow();
  const id = a.client.snapshot().draft.submission!.operationId;
  await f.select(2); await f.select(3); await f.select(4);
  expect(a.client.snapshot().state.entries).toHaveLength(0);
  const restored = await f.select(1);
  expect(restored).not.toBe(a); expect(restored.client.snapshot().draft.text).toBe('one send');
  expect(restored.client.snapshot().draft.submission?.operationId).toBe(id);
  await vi.waitFor(() => expect(f.bots[0]!.api.operation).toHaveBeenCalledWith(botBinding(1).sessionId, id, expect.any(AbortSignal)));
  expect(f.bots[0]!.api.command).toHaveBeenCalledOnce();
});
it('discards obsolete generation state and refuses invalidated Bot or account bindings', async () => {
  const f = fixture(sessionStorage), a = await f.select(1); a.client.setDraft('old');
  await f.select(2); await f.select(3); await f.select(4);
  f.bots[0]!.change({ ...f.bots[0]!.snapshot(), executionGeneration: '2' });
  const reopened = await f.select(1); expect(reopened.client.snapshot().draft.text).toBe('');
  reopened.client.setDraft('secret'); f.cache.invalidateBot(botBinding(1).botId);
  expect(f.cache.snapshot().some(p => p.binding.botId === botBinding(1).botId)).toBe(false);
  f.cache.select(botBinding(1)); expect(f.cache.snapshot().some(p => p.binding.botId === botBinding(1).botId)).toBe(false);
  f.cache.select({ ...botBinding(2), ownerUserId: 'someone-else' }); expect(f.cache.snapshot()).toHaveLength(2);
  f.cache.invalidate(); expect(f.cache.snapshot()).toHaveLength(0); expect(sessionStorage.length).toBe(0);
});

it.each(['available', 'enumeration', 'removal'] as const)('revokes an earlier visit before selecting in the new cache when storage is %s', async mode => {
  const first = fixture(sessionStorage), a = await first.select(1), b = await first.select(2);
  a.client.setDraft('revoked secret'); b.client.setDraft('unrelated draft');
  first.cache.select(a.binding, a.binding);
  vi.mocked(first.bots[0]!.api.command).mockRejectedValue(new Error('lost receipt'));
  await expect(a.client.send('revoked secret')).rejects.toThrow();
  const operation = a.client.snapshot().draft.submission!.operationId;
  const displayKey = (n: number) => `daynight.web.session.display.v1:${JSON.stringify([botOwner, botBinding(n).sessionId])}`;
  localStorage.setItem(displayKey(1), '"standard"'); localStorage.setItem(displayKey(2), '"standard"');
  first.cache.close();
  const failing: Storage = {
    get length() { if (mode === 'enumeration') throw Error('denied'); return sessionStorage.length; },
    key: i => sessionStorage.key(i), getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => { if (mode !== 'available') throw Error('denied'); sessionStorage.removeItem(key); }, clear: () => { throw Error('denied'); },
  };
  const second = fixture(failing); second.cache.invalidateBot(botBinding(1).botId);
  expect(localStorage.getItem(displayKey(1))).toBeNull(); expect(localStorage.getItem(displayKey(2))).toBe('"standard"');
  const cold = new BotSessionStorage(botSessionKey(botBinding(1)), sessionStorage);
  expect(cold.length).toBe(0);
  const third = fixture(sessionStorage), restored = await third.select(1);
  expect(restored.client.snapshot().draft.text).toBe(''); expect(restored.client.snapshot().state.operations.size).toBe(0);
  expect(third.bots[0]!.api.operation).not.toHaveBeenCalledWith(botBinding(1).sessionId, operation, expect.any(AbortSignal));
  expect((await third.select(2)).client.snapshot().draft.text).toBe('unrelated draft');
  restored.client.setDraft('new authorization'); third.cache.close();
  expect((await fixture(sessionStorage).select(1)).client.snapshot().draft.text).toBe('new authorization');
});

it('discovers a cold Bot namespace and display preference without an in-memory retained binding', () => {
  const b = botBinding(3), identity = botSessionKey(b);
  sessionStorage.setItem(`daynight:bot-session:${identity}:draft`, 'cold secret');
  const displayKey = `daynight.web.session.display.v1:${JSON.stringify([botOwner, b.sessionId])}`;
  localStorage.setItem(displayKey, '"standard"');
  fixture(sessionStorage).cache.invalidateBot(b.botId);
  expect(sessionStorage.getItem(`daynight:bot-session:${identity}:draft`)).toBeNull(); expect(localStorage.getItem(displayKey)).toBeNull();
});

it('clears a cold Bot display choice in memory when physical preference removal fails', () => {
  const b = botBinding(5), display = { userId: botOwner, sessionId: b.sessionId };
  new BotSessionStorage(botSessionKey(b), sessionStorage).setItem('draft', 'old');
  const old = renderHook(() => useSessionDisplayPreference(display));
  act(() => old.result.current.setMode('standard'));
  const staleWrite = old.result.current.setMode;
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw Error('denied'); });
  try {
    act(() => fixture(sessionStorage).cache.invalidateBot(b.botId));
    expect(old.result.current.mode).toBe('conversation');
    const fresh = renderHook(() => useSessionDisplayPreference(display));
    expect(fresh.result.current.mode).toBe('conversation');
    act(() => fresh.result.current.setMode('standard'));
    expect(fresh.result.current.mode).toBe('standard');
    act(() => fresh.result.current.setMode('conversation'));
    act(() => staleWrite('standard'));
    expect(localStorage.getItem(`daynight.web.session.display.v1:${JSON.stringify([botOwner, b.sessionId])}`)).toBe('"conversation"');
    expect(fresh.result.current.mode).toBe('conversation');
  } finally { remove.mockRestore(); }
});

it('invalidates cold account state before the replacement cache has selected any Bot', async () => {
  const first = fixture(sessionStorage), pane = await first.select(2); pane.client.setDraft('private'); first.cache.close();
  const other = new BotSessionStorage(JSON.stringify(['another-owner', 'bot', 'session', 'execution']), sessionStorage); other.setItem('draft', 'other account');
  fixture(sessionStorage).cache.invalidate();
  expect(new BotSessionStorage(botSessionKey(botBinding(2)), sessionStorage).length).toBe(0);
  expect(other.getItem('draft')).toBe('other account');
});

it('blocks an unknown deletion without discarding the original draft, operation or bookmark', async () => {
  const f = fixture(sessionStorage), a = await f.select(1), b = await f.select(2);
  a.client.setDraft('keep until deletion is confirmed'); b.client.setDraft('other Bot');
  f.cache.select(a.binding, a.binding);
  vi.mocked(f.bots[0]!.api.command).mockRejectedValue(new Error('unknown delivery'));
  await expect(a.client.send('keep until deletion is confirmed')).rejects.toThrow();
  const operationId = a.client.snapshot().draft.submission!.operationId;
  const bookmark = { anchor: { key: 'reading-anchor' } } as unknown as NonNullable<typeof a.retained.bookmark>;
  a.retained.bookmark = bookmark;
  const changes = vi.fn(); f.cache.subscribe(changes);
  const before = f.cache.guardSnapshot();
  f.cache.blockBot(a.binding.botId);
  expect(f.cache.isBlocked(a.binding.botId)).toBe(true); expect(f.cache.isRevoked(a.binding.botId)).toBe(false);
  expect(f.cache.guardSnapshot()).toBeGreaterThan(before); expect(changes).toHaveBeenCalled();
  expect(f.cache.snapshot()).toEqual([b]);
  await expect(a.client.send('late input')).rejects.toThrow();
  f.cache.select(a.binding); expect(f.cache.snapshot()).toEqual([b]);
  expect(b.client.snapshot().draft.text).toBe('other Bot');
  f.cache.unblockBot(a.binding.botId);
  const restored = await f.select(1);
  expect(restored.client.snapshot().draft.text).toBe('keep until deletion is confirmed');
  expect(restored.client.snapshot().draft.submission?.operationId).toBe(operationId);
  expect(restored.retained.bookmark).toBe(bookmark);
  expect(f.bots[0]!.api.command).toHaveBeenCalledOnce();
});

it('retains deletion guards across cache replacement within one authenticated scope', async () => {
  const identityScope = {}, binding = botBinding(1), bot = botFixture(binding);
  const make = (scope = identityScope) => {
    const cache = new BotSessionCache({ userId: botOwner, identityScope: scope, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: sessionStorage, createApi: () => bot.api });
    caches.push(cache); return cache;
  };
  const first = make(); first.select(binding);
  await vi.waitFor(() => expect(first.snapshot()[0]!.client.snapshot().connected).toBe(true));
  first.blockBot(binding.botId); first.close();
  const second = make(); second.select(binding);
  expect(second.isBlocked(binding.botId)).toBe(true); expect(second.snapshot()).toEqual([]);
  second.unblockBot(binding.botId); second.select(binding);
  await vi.waitFor(() => expect(second.snapshot()[0]!.client.snapshot().connected).toBe(true));
  second.invalidateBot(binding.botId);
  const revokedRevision = second.guardSnapshot();
  second.invalidateBot(binding.botId); expect(second.guardSnapshot()).toBe(revokedRevision);
  second.close();
  const third = make(); third.unblockBot(binding.botId); third.select(binding);
  expect(third.isRevoked(binding.botId)).toBe(true); expect(third.snapshot()).toEqual([]);
  const nextScope = make({}); nextScope.select(binding);
  await vi.waitFor(() => expect(nextScope.snapshot()[0]!.client.snapshot().connected).toBe(true));
});

it('revokes other mounted caches in the same scope and clears an explicit cold display binding', async () => {
  const identityScope = {}, binding = botBinding(6), bot = botFixture(binding);
  const make = () => {
    const cache = new BotSessionCache({ userId: botOwner, identityScope, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: sessionStorage, createApi: () => bot.api });
    caches.push(cache); return cache;
  };
  const first = make(), second = make(); first.select(binding);
  await vi.waitFor(() => expect(first.snapshot()[0]!.client.snapshot().connected).toBe(true));
  const original = first.snapshot()[0]!; original.client.setDraft('owned draft');
  const coldSessionId = botBinding(7).sessionId;
  const displayKey = `daynight.web.session.display.v1:${JSON.stringify([botOwner, coldSessionId])}`;
  localStorage.setItem(displayKey, '"standard"');
  const taskKey = 'daynight:session-draft:task-other'; sessionStorage.setItem(taskKey, 'task draft');
  second.invalidateBot(binding.botId, coldSessionId);
  expect(first.snapshot()).toEqual([]); expect(first.isRevoked(binding.botId)).toBe(true);
  await expect(original.client.send('late')).rejects.toThrow();
  expect(localStorage.getItem(displayKey)).toBeNull(); expect(sessionStorage.getItem(taskKey)).toBe('task draft');
});
