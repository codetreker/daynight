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
  async function select(n: number) { cache.select(bots[n - 1]!.binding); const pane = cache.snapshot().find(p => p.binding.botId === bots[n - 1]!.binding.botId)!; await vi.waitFor(() => expect(pane.client.snapshot().connected).toBe(true)); return pane; }
  return { bots, cache, select };
}
it('keeps three clients, selects without restarting, and evicts the least recently visited inactive pane', async () => {
  const f = fixture(); const a = await f.select(1); a.client.setDraft('draft A');
  await f.select(2); expect(await f.select(1)).toBe(a); await f.select(3); await f.select(4);
  expect(f.cache.snapshot().map(p => p.binding.botId)).toEqual([1, 3, 4].map(n => botBinding(n).botId));
  expect(f.bots[1]!.channel.close).toHaveBeenCalledOnce(); expect(f.bots[0]!.channel.close).not.toHaveBeenCalled();
  expect(a.client.snapshot().draft.text).toBe('draft A'); expect(f.bots[0]!.api.current).toHaveBeenCalledOnce();
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
