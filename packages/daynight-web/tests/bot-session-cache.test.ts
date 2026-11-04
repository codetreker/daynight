import { afterEach, expect, it, vi } from 'vitest';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
const caches: BotSessionCache[] = [];
afterEach(() => { caches.splice(0).forEach(cache => cache.close()); sessionStorage.clear(); });
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
