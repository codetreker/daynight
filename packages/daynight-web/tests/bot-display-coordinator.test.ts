import { afterEach, expect, it, vi } from 'vitest';
import { BotDisplaySnapshotCoordinator, BotHistorySnapshotObserver, clearBotDisplaySnapshots, retryBotDisplaySnapshotCleanup } from '../src/features/bots/display-snapshot-coordinator';
import { BotDisplaySnapshotStore, type BotDisplayPreview } from '../src/features/bots/display-snapshot';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import type { TimelineReadingBookmark } from '../src/ui/useTimelineScroll';
import { sessionFence } from '../../daynight/src/session/protocol';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.useRealTimers(); localStorage.clear(); });
const storage = (): Storage => ({ get length() { return localStorage.length; }, key: index => localStorage.key(index), getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value), removeItem: key => localStorage.removeItem(key), clear: () => localStorage.clear() });
function fixture() {
  const store = new BotDisplaySnapshotStore({ isCurrent: owner => owner === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  const owner = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store });
  cleanups.push(() => owner.close());
  return { owner, store };
}
function preview(): BotDisplayPreview {
  const binding = botBinding(1);
  return { schemaVersion: 1, ownerUserId: botOwner, botId: binding.botId, lastKnownBinding: binding, botName: 'Assistant', fence: { sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: '1' }, historyEpoch: 'history', lastEventSeq: '1', entries: [{ kind: 'assistant_message', entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'saved history' }] }], resources: [], savedAt: 1 };
}
async function seed(store: BotDisplaySnapshotStore, value = preview()) {
  const lease = await store.observe(botOwner, value.botId);
  await store.save(lease!, { source: 'verified-history', historyLoaded: true, preview: value });
  return value;
}
it('reads an authenticated cold target and hides it synchronously on temporary block', async () => {
  const { owner, store } = fixture(), value = await seed(store);
  expect(await owner.read(value.botId)).toEqual(value);
  owner.blockBot(value.botId);
  expect(await owner.read(value.botId)).toBeNull();
  owner.unblockBot(value.botId);
  expect(await owner.read(value.botId)).toEqual(value);
  owner.invalidateBot(value.botId);
  expect(await owner.read(value.botId)).toBeNull();
  expect(await store.read(botOwner, value.botId)).toBeNull();
});
it('clears a cold obsolete binding before it can become a preview for a new execution', async () => {
  const { owner, store } = fixture(), value = await seed(store);
  expect(await owner.read(value.botId)).toEqual(value);
  owner.bind({ ...value.lastKnownBinding, testExecutionId: crypto.randomUUID() });
  expect(await owner.read(value.botId)).toBeNull();
  expect(await store.read(botOwner, value.botId)).toBeNull();
});
it('rejects a read queued before revocation instead of publishing its late private payload', async () => {
  let blocked = false;
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const store = new BotDisplaySnapshotStore({ isCurrent: owner => owner === botOwner, storage: storage(), withLock: async (_key, run) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  } });
  const owner = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store });
  cleanups.push(() => owner.close());
  const value = await seed(store);
  blocked = true;
  const read = owner.read(value.botId);
  await entered.promise;
  owner.invalidateBot(value.botId);
  gate.resolve();
  await expect(read).resolves.toBeNull();
  expect(await owner.read(value.botId)).toBeNull();
});
it.each([false, true])('cannot save cold accepted history when a peer clears it before its observation acquires the lock (storage event: %s)', async notify => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  let blocked = false;
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  } });
  const owner = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store });
  const peer = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  cleanups.push(() => owner.close(), () => peer.close());
  const bot = botFixture(), item = { ...bot.page.items[0]!, entryId: crypto.randomUUID() };
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [item] });
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn() });
  cleanups.push(cache.close); cache.select(bot.binding, bot.binding);
  const client = cache.snapshot()[0]!.client;
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const acceptedRevision = client.snapshot().historyRevision;
  expect(await owner.read(bot.binding.botId)).toBeNull();
  expect(owner.cached(bot.binding.botId)).toBeNull();
  blocked = true;
  const observe = vi.spyOn(store, 'observe');
  const observer = new BotHistorySnapshotObserver({ owner, binding: bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await entered.promise;
  await expect(peer.clearTarget(botOwner, bot.binding.botId)).resolves.toBe(true);
  if (notify) window.dispatchEvent(new StorageEvent('storage', { key: `daynight:bot-display:v1:${botOwner}`, storageArea: localStorage, newValue: localStorage.getItem(`daynight:bot-display:v1:${botOwner}`) }));
  gate.resolve();
  await observe.mock.results[0]!.value;
  await expect(observer.flush()).resolves.toBeNull();
  expect(await store.read(botOwner, bot.binding.botId)).toBeNull();
  client.setDraft('local edits cannot renew the pre-clear payload');
  await observe.mock.results.at(-1)!.value;
  await observer.flush();
  expect(await store.read(botOwner, bot.binding.botId)).toBeNull();
  await client.refresh();
  await vi.waitFor(() => expect(client.snapshot().historyRevision).toBeGreaterThan(acceptedRevision));
  await observe.mock.results.at(-1)!.value;
  await expect(observer.flush()).resolves.toBe('saved');
  expect((await store.read(botOwner, bot.binding.botId))?.entries).toEqual([item]);
});
it.each(['save', 'touch'] as const)('does not revoke a cold target first save when a peer %s changes only another target', async change => {
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: localStorage, withLock: async (_key, run) => run() });
  const owner = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store });
  const peer = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  cleanups.push(() => owner.close(), () => peer.close());
  const sibling = await seed(peer), bot = botFixture(botBinding(2));
  const item = { ...bot.page.items[0]!, entryId: crypto.randomUUID() };
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [item] });
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn() });
  cleanups.push(cache.close); cache.select(bot.binding, bot.binding);
  const client = cache.snapshot()[0]!.client;
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  expect(await owner.read(bot.binding.botId)).toBeNull();
  const observe = vi.spyOn(store, 'observe');
  const observer = new BotHistorySnapshotObserver({ owner, binding: bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await observe.mock.results[0]!.value;
  if (change === 'save') await seed(peer, { ...sibling, lastEventSeq: '2' });
  else await peer.read(botOwner, sibling.botId);
  window.dispatchEvent(new StorageEvent('storage', { key: `daynight:bot-display:v1:${botOwner}`, storageArea: localStorage, newValue: localStorage.getItem(`daynight:bot-display:v1:${botOwner}`) }));
  await expect(observer.flush()).resolves.toBe('saved');
  expect((await store.read(botOwner, bot.binding.botId))?.entries).toEqual([item]);
  expect((await peer.read(botOwner, sibling.botId))?.lastEventSeq).toBe(change === 'save' ? '2' : '1');
});
it.each([false, true])('accepts the first passive sibling read after a peer clear while rejecting older queued reads (queued: %s)', async queued => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  let blocked = false;
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: localStorage, withLock: async (_key, run) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  } });
  const owner = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store });
  const peer = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  cleanups.push(() => owner.close(), () => peer.close());
  const removed = await seed(store), binding = botBinding(2);
  const sibling = await seed(store, { ...preview(), botId: binding.botId, lastKnownBinding: binding, fence: { sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: '1' } });
  expect(await owner.read(sibling.botId)).toEqual(sibling);
  let oldRead: Promise<BotDisplayPreview | null> | null = null;
  if (queued) { blocked = true; oldRead = owner.read(sibling.botId, { touch: false }); await entered.promise; }
  await expect(peer.clearTarget(botOwner, removed.botId)).resolves.toBe(true);
  window.dispatchEvent(new StorageEvent('storage', { key: `daynight:bot-display:v1:${botOwner}`, storageArea: localStorage, newValue: localStorage.getItem(`daynight:bot-display:v1:${botOwner}`) }));
  gate.resolve();
  if (oldRead) await expect(oldRead).resolves.toBeNull();
  await expect(owner.read(sibling.botId, { touch: false })).resolves.toEqual(sibling);
  await expect(owner.read(removed.botId, { touch: false })).resolves.toBeNull();
});
it('does not feed passive cross-tab invalidation reads back into persistent LRU writes', async () => {
  const { owner, store } = fixture(), first = await seed(store), binding = botBinding(2);
  const second = { ...preview(), botId: binding.botId, lastKnownBinding: binding, fence: { sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: '1' } };
  await seed(store, second);
  const peer = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  const peerOwner = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store: peer });
  cleanups.push(() => peerOwner.close());
  const original = Storage.prototype.setItem;
  let changedWrites = 0;
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    const changed = this.getItem(key) !== value; original.call(this, key, value);
    if (changed && ++changedWrites < 10) queueMicrotask(() => window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage, newValue: value })));
  });
  const detach = owner.subscribe(() => { void owner.read(first.botId, { touch: false }); });
  const detachPeer = peerOwner.subscribe(() => { void peerOwner.read(second.botId, { touch: false }); });
  try {
    await owner.read(first.botId);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changedWrites).toBe(1);
    expect((await peerOwner.read(second.botId, { touch: false }))?.botId).toBe(second.botId);
    expect(changedWrites).toBe(1);
  } finally { detach(); detachPeer(); write.mockRestore(); }
});
it('retries the old failed disk cleanup without revoking a newer scope for the same account', async () => {
  const { owner, store } = fixture(), old = await seed(store);
  const original = Storage.prototype.setItem;
  const denied = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'QuotaExceededError'); });
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(clearBotDisplaySnapshots(botOwner)).resolves.toBe(false);
    expect(owner.allowed(old.botId)).toBe(false);
  } finally { denied.mockRestore(); }
  expect(Storage.prototype.setItem).toBe(original);
  const freshStore = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  const fresh = new BotDisplaySnapshotCoordinator({ userId: botOwner, isCurrent: () => true, store: freshStore });
  cleanups.push(() => fresh.close());
  const lease = await freshStore.observe(botOwner, old.botId);
  await expect(freshStore.save(lease!, { source: 'verified-history', historyLoaded: true, preview: { ...old, lastEventSeq: '2', savedAt: 2 } })).resolves.toBe('saved');
  const replacement = localStorage.getItem(`daynight:bot-display:v1:${botOwner}`);
  await expect(retryBotDisplaySnapshotCleanup(botOwner)).resolves.toBe(true);
  expect(fresh.allowed(old.botId)).toBe(true);
  expect(localStorage.getItem(`daynight:bot-display:v1:${botOwner}`)).toBe(replacement);
  expect(owner.allowed(old.botId)).toBe(false);
  diagnostic.mockRestore();
});
it('keeps current-only loading out of persistence and flushes accepted history on pane eviction', async () => {
  const { owner, store } = fixture(), bots = [1, 2, 3, 4].map(number => botFixture(botBinding(number)));
  const history = Promise.withResolvers<typeof bots[0]['page']>();
  vi.mocked(bots[0]!.api.timeline).mockReturnValue(history.promise);
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: null, createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api, displaySnapshots: owner });
  cleanups.push(cache.close);
  cache.setBotName(bots[0]!.binding.botId, 'Assistant');
  cache.select(bots[0]!.binding, bots[0]!.binding);
  await vi.waitFor(() => expect(cache.snapshot()[0]!.client.snapshot().state.snapshot).not.toBeNull());
  cache.flushDisplay(bots[0]!.binding.botId);
  expect(await store.read(botOwner, bots[0]!.binding.botId)).toBeNull();
  const item = { kind: 'assistant_message' as const, entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text' as const, text: 'accepted before eviction' }] };
  history.resolve({ ...bots[0]!.page, items: [item] });
  await vi.waitFor(() => expect(cache.snapshot()[0]!.client.snapshot().historySettled).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 0));
  for (const bot of bots.slice(1)) cache.select(bot.binding, bot.binding);
  await vi.waitFor(async () => expect((await store.read(botOwner, bots[0]!.binding.botId))?.entries).toEqual([item]));
  expect(cache.snapshot()).toHaveLength(3);
  expect(bots[0]!.channel.close).toHaveBeenCalledOnce();
});
it('saves only accepted settled client history and flushes before client closure', async () => {
  const { owner, store } = fixture(), bot = botFixture();
  const entries = [{ kind: 'assistant_message' as const, entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text' as const, text: 'real accepted history' }] }];
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: entries });
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: null, createApi: () => bot.api });
  cleanups.push(cache.close);
  cache.select(bot.binding, bot.binding);
  const pane = cache.snapshot()[0]!;
  await vi.waitFor(() => expect(pane.client.snapshot().historySettled).toBe(true));
  let bookmark: TimelineReadingBookmark | null = null;
  const observer = new BotHistorySnapshotObserver({ owner, binding: bot.binding, client: pane.client, name: () => 'Assistant', bookmark: () => bookmark });
  cleanups.push(() => observer.close(false));
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(observer.flush()).resolves.toBe('saved');
  expect((await store.read(botOwner, bot.binding.botId))?.entries[0]).toEqual(entries[0]);
  bookmark = { identity: 'confirmed reading', historyEpoch: bot.snapshot().historyEpoch, following: false, anchor: { key: entries[0]!.entryId, top: -24 } };
  await expect(observer.flush()).resolves.toBe('saved');
  expect((await store.read(botOwner, bot.binding.botId))?.readingAnchor).toEqual({ entryId: entries[0]!.entryId, offset: 24, following: false });
  owner.blockBot(bot.binding.botId);
  observer.close(false);
  expect(await owner.read(bot.binding.botId)).toBeNull();
});
it('cannot renew cleared history from local edits and resumes only after a new accepted history page', async () => {
  const { owner, store } = fixture(), bot = botFixture(), peer = new BotDisplaySnapshotStore({ isCurrent: user => user === botOwner, storage: storage(), withLock: async (_key, run) => run() });
  cleanups.push(() => peer.close());
  const entry = { ...bot.page.items[0]!, entryId: crypto.randomUUID() };
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [entry] });
  const cache = new BotSessionCache({ userId: botOwner, isCurrent: () => true, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn() });
  cleanups.push(cache.close); cache.select(bot.binding, bot.binding);
  const client = cache.snapshot()[0]!.client;
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const observer = new BotHistorySnapshotObserver({ owner, binding: bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(observer.flush()).resolves.toBe('saved');
  await owner.read(bot.binding.botId);
  await peer.clearTarget(botOwner, bot.binding.botId);
  window.dispatchEvent(new StorageEvent('storage', { key: `daynight:bot-display:v1:${botOwner}`, storageArea: localStorage, newValue: localStorage.getItem(`daynight:bot-display:v1:${botOwner}`) }));
  for (const draft of ['first local edit', 'second local edit']) {
    client.setDraft(draft);
    await new Promise(resolve => setTimeout(resolve, 0));
    await observer.flush();
    expect(await store.read(botOwner, bot.binding.botId)).toBeNull();
  }
  expect(bot.api.current).toHaveBeenCalledOnce();
  await client.refresh();
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(observer.flush()).resolves.toBe('saved');
  expect((await store.read(botOwner, bot.binding.botId))?.entries).toEqual([entry]);
});
it('reobserves new accepted history when a sibling clear changes the generation before any old-source publish', async () => {
  const userId = crypto.randomUUID();
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === userId, storage: localStorage, withLock: async (_key, run) => run() });
  const owner = new BotDisplaySnapshotCoordinator({ userId, isCurrent: () => true, store });
  const peer = new BotDisplaySnapshotStore({ isCurrent: user => user === userId, storage: storage(), withLock: async (_key, run) => run() });
  cleanups.push(() => owner.close(), () => peer.close());
  const siblingBinding = { ...botBinding(2), ownerUserId: userId }, sibling = { ...preview(), ownerUserId: userId, botId: siblingBinding.botId, lastKnownBinding: siblingBinding, fence: { sessionId: siblingBinding.sessionId, testExecutionId: siblingBinding.testExecutionId, executionGeneration: '1' } };
  const siblingLease = (await peer.observe(userId, sibling.botId))!;
  await expect(peer.save(siblingLease, { source: 'verified-history', historyLoaded: true, preview: sibling })).resolves.toBe('saved');
  const bot = botFixture({ ...botBinding(1), ownerUserId: userId }), first = { kind: 'assistant_message' as const, entryId: crypto.randomUUID(), entrySeq: '1', revision: '1', content: [{ type: 'text' as const, text: 'accepted before sibling clear' }] };
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [first] });
  const cache = new BotSessionCache({ userId, isCurrent: () => true, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn() });
  cleanups.push(cache.close); cache.select(bot.binding, bot.binding);
  const client = cache.snapshot()[0]!.client;
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const observe = vi.spyOn(store, 'observe');
  const observer = new BotHistorySnapshotObserver({ owner, binding: bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await observe.mock.results[0]!.value;
  await expect(observer.flush()).resolves.toBe('saved');
  await expect(peer.clearTarget(userId, sibling.botId)).resolves.toBe(true);
  window.dispatchEvent(new StorageEvent('storage', { key: `daynight:bot-display:v1:${userId}`, storageArea: localStorage, newValue: localStorage.getItem(`daynight:bot-display:v1:${userId}`) }));
  // No draft edit or flush observes the old source after the account fence.
  const second = { ...first, entryId: crypto.randomUUID(), entrySeq: '2', content: [{ type: 'text' as const, text: 'new authority after sibling clear' }] };
  const snapshot = bot.snapshot();
  bot.receive({ protocol: snapshot.protocol, type: 'event', cursor: 'next', event: { protocol: snapshot.protocol, ...sessionFence(snapshot), connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: second } });
  expect(client.snapshot().state.entries).toEqual([first, second]);
  await observe.mock.results.at(-1)!.value;
  await expect(observer.flush()).resolves.toBe('saved');
  expect((await store.read(userId, bot.binding.botId))?.entries).toEqual([first, second]);
  expect(await store.read(userId, sibling.botId)).toBeNull();
});
