import { afterEach, expect, it, vi } from 'vitest';
import { BotDisplaySnapshotCoordinator, BotHistorySnapshotObserver, clearBotDisplaySnapshots, getBotDisplaySnapshotCoordinator, retryBotDisplaySnapshotCleanup } from '../src/features/bots/display-snapshot-coordinator';
import { BotDisplaySnapshotStore, type BotDisplayPreview, type BotDisplaySnapshotLock } from '../src/features/bots/display-snapshot';
import { BotSessionCache } from '../src/features/bots/session-cache';
import { botBinding, botFixture, botOwner } from './helpers/bot-session';
import type { TimelineReadingBookmark } from '../src/ui/useTimelineScroll';
import { sessionFence } from '../../daynight/src/session/protocol';
import { getBotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { botDefinition, botError, botResponse } from './helpers/bots';

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
it('hides an incompatible cold binding without deleting the peer record', async () => {
  const { owner, store } = fixture(), value = await seed(store);
  expect(await owner.read(value.botId)).toEqual(value);
  owner.bind({ ...value.lastKnownBinding, testExecutionId: crypto.randomUUID() });
  expect(await owner.read(value.botId)).toBeNull();
  expect(owner.cached(value.botId)).toBeNull();
  expect(await store.read(botOwner, value.botId)).toEqual(value);
});
it('clears the target after a previously observed local binding is replaced', async () => {
  const { owner, store } = fixture(), value = await seed(store);
  owner.bind(value.lastKnownBinding);
  owner.bind({ ...value.lastKnownBinding, testExecutionId: crypto.randomUUID() });
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

function epochTab(userId: string, epoch: string, nativeStorage: boolean, withLock: BotDisplaySnapshotLock = async (_key, run) => run()) {
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === userId, storage: nativeStorage ? localStorage : storage(), withLock });
  const owner = new BotDisplaySnapshotCoordinator({ userId, isCurrent: () => true, store });
  const bot = botFixture({ ...botBinding(1), ownerUserId: userId });
  bot.change({ ...bot.snapshot(), historyEpoch: epoch });
  const item = { ...bot.page.items[0]!, entryId: crypto.randomUUID() };
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, historyEpoch: epoch, items: [item] });
  const cache = new BotSessionCache({ userId, isCurrent: () => true, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn() });
  const observe = vi.spyOn(store, 'observe'), clear = vi.spyOn(store, 'clearTarget');
  cleanups.push(cache.close, () => owner.close());
  const start = () => { cache.select(bot.binding, bot.binding); return cache.snapshot()[0]!.client; };
  return { store, owner, bot, item, observe, clear, start };
}
async function savedEpochTab(userId: string, epoch: string, nativeStorage: boolean, named = true) {
  const tab = epochTab(userId, epoch, nativeStorage), client = tab.start();
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  let name: string | null = named ? 'Assistant' : null;
  const observer = new BotHistorySnapshotObserver({ owner: tab.owner, binding: tab.bot.binding, client, name: () => name, bookmark: () => null });
  cleanups.push(() => observer.close(false));
  if (named) { await tab.observe.mock.results.at(-1)!.value; await expect(observer.flush()).resolves.toBe('saved'); }
  return { ...tab, client, observer, setName: () => { name = 'Assistant'; } };
}
it.each([true, false])('keeps a peer accepted epoch after passive mismatches and unchanged local publishes (old lease: %s)', async named => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const old = await savedEpochTab(userId, oldEpoch, true, named);
  const acceptedRevision = old.client.snapshot().historyRevision;
  const peer = await savedEpochTab(userId, newEpoch, false);
  expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  window.dispatchEvent(new StorageEvent('storage', { key: `daynight:bot-display:v1:${userId}`, storageArea: localStorage, newValue: localStorage.getItem(`daynight:bot-display:v1:${userId}`) }));
  await expect(old.owner.read(old.bot.binding.botId, { touch: false })).resolves.toBeNull();
  await Promise.all(old.clear.mock.results.map(result => result.value));
  const generation = old.owner.generation(old.bot.binding.botId), version = old.owner.version();
  old.setName();
  old.observer.refresh();
  await Promise.all(old.observe.mock.results.map(result => result.value));
  await old.observer.flush();
  expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  const results: (string | null | undefined)[] = [];
  const reads: (string | null)[] = [];
  for (const draft of ['first local edit', 'second local edit', 'third local edit']) {
    old.client.setDraft(draft); old.observer.refresh();
    reads.push((await old.owner.read(old.bot.binding.botId, { touch: false }))?.historyEpoch ?? null);
    await Promise.all(old.clear.mock.results.map(result => result.value));
    await Promise.all(old.observe.mock.results.map(result => result.value));
    await old.observer.flush();
    results.push((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch ?? null);
  }
  expect(old.client.snapshot().historyRevision).toBe(acceptedRevision);
  expect(old.bot.api.current).toHaveBeenCalledOnce(); expect(old.bot.api.timeline).toHaveBeenCalledOnce();
  expect(results).toEqual([newEpoch, newEpoch, newEpoch]);
  expect(reads).toEqual([null, null, null]);
  expect(old.clear).not.toHaveBeenCalled();
  expect(old.owner.generation(old.bot.binding.botId)).toBe(generation);
  expect(old.owner.version()).toBe(version);
  await old.client.refresh();
  await vi.waitFor(() => expect(old.client.snapshot().historyRevision).toBeGreaterThan(acceptedRevision));
  await old.observe.mock.results.at(-1)!.value;
  await expect(old.observer.flush()).resolves.toBe('saved');
  expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(oldEpoch);
});
it('keeps a peer epoch when a cold preview meets current-only old history before any accepted history page', async () => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const peer = await savedEpochTab(userId, newEpoch, false), old = epochTab(userId, oldEpoch, true);
  expect((await old.owner.read(old.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  const history = Promise.withResolvers<typeof old.bot.page>();
  vi.mocked(old.bot.api.timeline).mockReturnValue(history.promise);
  const client = old.start();
  const observer = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await vi.waitFor(() => expect(client.snapshot().state.snapshot).not.toBeNull());
  expect(client.snapshot().historyLoaded).toBe(false);
  await Promise.all(old.clear.mock.results.map(result => result.value));
  const results: (string | null | undefined)[] = [];
  for (const draft of ['first cold draft', 'second cold draft']) {
    client.setDraft(draft); observer.refresh();
    await old.owner.read(old.bot.binding.botId, { touch: false });
    await Promise.all(old.clear.mock.results.map(result => result.value));
    await observer.flush();
    results.push((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch ?? null);
  }
  expect(client.snapshot().historyLoaded).toBe(false);
  expect(old.bot.api.current).toHaveBeenCalledOnce(); expect(old.bot.api.timeline).toHaveBeenCalledOnce();
  expect(results).toEqual([newEpoch, newEpoch]);
  expect(old.clear).not.toHaveBeenCalled();
  history.resolve({ ...old.bot.page, historyEpoch: oldEpoch, items: [old.item] });
});
it.each([false, true])('revokes an already queued old-source save when a captured passive mismatch is delivered (closed: %s)', async close => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const peer = await savedEpochTab(userId, newEpoch, false);
  const saveEntered = Promise.withResolvers<void>(), saveGate = Promise.withResolvers<void>();
  let blocked = false;
  const old = epochTab(userId, oldEpoch, true, async (_key, run) => {
    if (blocked) { saveEntered.resolve(); await saveGate.promise; }
    return run();
  });
  const client = old.start();
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const subscribeRejection = old.owner.subscribeSourceRevocation.bind(old.owner), detached = vi.fn();
  vi.spyOn(old.owner, 'subscribeSourceRevocation').mockImplementation(listener => {
    const detach = subscribeRejection(listener); return () => { detached(); detach(); };
  });
  const observer = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  // This first lease observes the peer version, before the coordinator reads it.
  await old.observe.mock.results.at(-1)!.value;
  const readCaptured = Promise.withResolvers<void>(), readGate = Promise.withResolvers<void>();
  const realRead = old.store.read.bind(old.store);
  vi.spyOn(old.store, 'read').mockImplementation(async (...args) => {
    const result = await realRead(...args); readCaptured.resolve(); await readGate.promise; return result;
  });
  const read = old.owner.read(old.bot.binding.botId, { touch: false });
  await readCaptured.promise;
  blocked = true;
  const save = observer.flush();
  await saveEntered.promise;
  if (close) observer.close(false);
  expect(detached).not.toHaveBeenCalled();
  readGate.resolve();
  await expect(read).resolves.toBeNull();
  saveGate.resolve();
  await expect(save).resolves.toBe('stale');
  if (!close) observer.close(false);
  expect(detached).toHaveBeenCalledOnce();
  await Promise.all(old.clear.mock.results.map(result => result.value));
  expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  expect(old.clear).not.toHaveBeenCalled();
});
it('does not accept an old-source observation that finishes after passive mismatch rejection', async () => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const peer = await savedEpochTab(userId, newEpoch, false);
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  let blocked = false;
  const old = epochTab(userId, oldEpoch, true, async (_key, run) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  });
  const client = old.start();
  await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const readCaptured = Promise.withResolvers<void>(), readGate = Promise.withResolvers<void>();
  const realRead = old.store.read.bind(old.store);
  vi.spyOn(old.store, 'read').mockImplementation(async (...args) => {
    const result = await realRead(...args); readCaptured.resolve(); await readGate.promise; return result;
  });
  const read = old.owner.read(old.bot.binding.botId, { touch: false });
  await readCaptured.promise;
  blocked = true;
  const observer = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await entered.promise;
  readGate.resolve(); await expect(read).resolves.toBeNull();
  gate.resolve(); await old.observe.mock.results.at(-1)!.value;
  for (const draft of ['first post-observation edit', 'second post-observation edit']) {
    client.setDraft(draft); observer.refresh();
    await expect(observer.flush()).resolves.toBeNull();
    expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  }
  expect(old.observe).toHaveBeenCalledOnce();
  expect(old.clear).not.toHaveBeenCalled();
  expect(old.bot.api.current).toHaveBeenCalledOnce(); expect(old.bot.api.timeline).toHaveBeenCalledOnce();
});
it.each([false, true])('keeps the rejected source fenced when its observer is rebuilt (closed before rejection: %s)', async closeBefore => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const old = await savedEpochTab(userId, oldEpoch, true), peer = await savedEpochTab(userId, newEpoch, false);
  if (closeBefore) old.observer.close(false);
  await expect(old.owner.read(old.bot.binding.botId, { touch: false })).resolves.toBeNull();
  old.observer.close(false);
  let name: string | null = closeBefore ? 'Assistant' : null;
  const rebuilt = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client: old.client, name: () => name, bookmark: () => null });
  cleanups.push(() => rebuilt.close(false));
  name = 'Assistant'; old.client.setDraft('draft after rebuilding'); rebuilt.refresh();
  await Promise.all(old.observe.mock.results.map(result => result.value));
  await expect(rebuilt.flush()).resolves.toBeNull();
  expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  expect(old.bot.api.current).toHaveBeenCalledOnce(); expect(old.bot.api.timeline).toHaveBeenCalledOnce();
  const revision = old.client.snapshot().historyRevision;
  await old.client.refresh();
  await vi.waitFor(() => expect(old.client.snapshot().historyRevision).toBeGreaterThan(revision));
  await old.observe.mock.results.at(-1)!.value;
  await expect(rebuilt.flush()).resolves.toBe('saved');
});
it('allows a reopened pane to save only after its new client accepts a fresh history page', async () => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === userId, storage: localStorage, withLock: async (_key, run) => run() });
  const owner = new BotDisplaySnapshotCoordinator({ userId, isCurrent: () => true, store });
  cleanups.push(() => owner.close());
  const bots = [1, 2, 3, 4].map(number => {
    const bot = botFixture({ ...botBinding(number), ownerUserId: userId });
    bot.change({ ...bot.snapshot(), historyEpoch: oldEpoch });
    vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, historyEpoch: oldEpoch, items: [{ ...bot.page.items[0]!, entryId: crypto.randomUUID() }] });
    return bot;
  });
  const first = bots[0]!, observe = vi.spyOn(store, 'observe'), save = vi.spyOn(store, 'save');
  const cache = new BotSessionCache({ userId, isCurrent: () => true, storage: null, createApi: binding => bots.find(bot => bot.binding.botId === binding.botId)!.api, onPrincipalMismatch: vi.fn(), displaySnapshots: owner });
  cleanups.push(cache.close); cache.setBotName(first.binding.botId, 'Assistant'); cache.select(first.binding, first.binding);
  const original = cache.snapshot()[0]!.client;
  await vi.waitFor(() => expect(original.snapshot().historySettled).toBe(true));
  await observe.mock.results.at(-1)!.value;
  cache.flushDisplay(first.binding.botId); await save.mock.results.at(-1)!.value;
  const peer = await savedEpochTab(userId, newEpoch, false);
  await expect(owner.read(first.binding.botId, { touch: false })).resolves.toBeNull();
  for (const bot of bots.slice(1)) cache.select(bot.binding, bot.binding);
  expect(cache.snapshot().some(pane => pane.client === original)).toBe(false);
  expect(first.channel.close).toHaveBeenCalledOnce();
  const history = Promise.withResolvers<typeof first.page>();
  vi.mocked(first.api.timeline).mockReturnValue(history.promise);
  cache.select(first.binding, first.binding);
  const reopened = cache.snapshot().find(pane => pane.binding.botId === first.binding.botId)!.client;
  expect(reopened).not.toBe(original);
  await vi.waitFor(() => expect(reopened.snapshot().state.snapshot).not.toBeNull());
  expect(reopened.snapshot().historyLoaded).toBe(false);
  reopened.setDraft('a new pane still needs accepted history'); cache.flushDisplay(first.binding.botId);
  expect((await peer.store.read(userId, first.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  const item = { ...first.page.items[0]!, entryId: crypto.randomUUID() };
  history.resolve({ ...first.page, historyEpoch: oldEpoch, items: [item] });
  await vi.waitFor(() => expect(reopened.snapshot().historySettled).toBe(true));
  await observe.mock.results.at(-1)!.value;
  cache.flushDisplay(first.binding.botId); await expect(save.mock.results.at(-1)!.value).resolves.toBe('saved');
  expect((await peer.store.read(userId, first.binding.botId, { touch: false }))?.entries).toEqual([item]);
  expect(first.api.current).toHaveBeenCalledTimes(2); expect(first.api.timeline).toHaveBeenCalledTimes(2);
});
it('broadcasts a passive rejection to simultaneous observers of the same accepted client source', async () => {
  const userId = crypto.randomUUID(), oldEpoch = crypto.randomUUID(), newEpoch = crypto.randomUUID();
  const old = await savedEpochTab(userId, oldEpoch, true);
  const second = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client: old.client, name: () => 'Second pane', bookmark: () => null });
  cleanups.push(() => second.close(false));
  await old.observe.mock.results.at(-1)!.value;
  const peer = await savedEpochTab(userId, newEpoch, false);
  await expect(old.owner.read(old.bot.binding.botId, { touch: false })).resolves.toBeNull();
  old.client.setDraft('shared local edit'); old.observer.refresh(); second.refresh();
  await expect(old.observer.flush()).resolves.toBeNull(); await expect(second.flush()).resolves.toBeNull();
  expect((await peer.store.read(userId, peer.bot.binding.botId, { touch: false }))?.historyEpoch).toBe(newEpoch);
  expect(old.bot.api.current).toHaveBeenCalledOnce(); expect(old.bot.api.timeline).toHaveBeenCalledOnce();
});
it('preserves the last saved history when deletion blocks a cache after its next flush has queued', async () => {
  const userId = crypto.randomUUID(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  cleanups.unshift(() => gate.resolve());
  let blocked = false;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, run: () => unknown) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  } } });
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }), owner = getBotDisplaySnapshotCoordinator(scope), store = owner.store;
  cleanups.push(() => scope.dispose(), () => owner.close());
  const bot = botFixture({ ...botBinding(1), ownerUserId: userId }), first = { ...bot.page.items[0]!, entryId: crypto.randomUUID() };
  vi.mocked(bot.api.timeline).mockResolvedValue({ ...bot.page, items: [first] });
  const cache = new BotSessionCache({ userId, identityScope: scope, isCurrent: () => !scope.isInvalidated, storage: null, createApi: () => bot.api, onPrincipalMismatch: vi.fn(), displaySnapshots: owner });
  cleanups.push(cache.close);
  const deletion = getBotDeletionCoordinator(scope), detach = deletion.attachCache(cache);
  cleanups.push(detach);
  const observe = vi.spyOn(store, 'observe'), save = vi.spyOn(store, 'save'), clear = vi.spyOn(store, 'clearTarget');
  cache.setBotName(bot.binding.botId, 'Assistant'); cache.select(bot.binding, bot.binding);
  const original = cache.snapshot()[0]!.client;
  await vi.waitFor(() => expect(original.snapshot().historySettled).toBe(true));
  await observe.mock.results.at(-1)!.value;
  cache.flushDisplay(bot.binding.botId); await expect(save.mock.results.at(-1)!.value).resolves.toBe('saved');
  const siblingBinding = { ...botBinding(2), ownerUserId: userId }, sibling = { ...preview(), ownerUserId: userId, botId: siblingBinding.botId, lastKnownBinding: siblingBinding, fence: { sessionId: siblingBinding.sessionId, testExecutionId: siblingBinding.testExecutionId, executionGeneration: '1' } };
  const siblingLease = (await store.observe(userId, sibling.botId))!;
  await expect(store.save(siblingLease, { source: 'verified-history', historyLoaded: true, preview: sibling })).resolves.toBe('saved');
  const key = `daynight:bot-display:v1:${userId}`;
  let before = localStorage.getItem(key);
  const second = { ...first, entryId: crypto.randomUUID(), entrySeq: '2', content: [{ type: 'text' as const, text: 'accepted immediately before deletion' }] }, snapshot = bot.snapshot();
  bot.receive({ protocol: snapshot.protocol, type: 'event', cursor: 'next', event: { protocol: snapshot.protocol, ...sessionFence(snapshot), connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: second } });
  expect(original.snapshot().state.entries).toEqual([first, second]);
  blocked = true; cache.flushDisplay(bot.binding.botId); await entered.promise;
  const lateSave = save.mock.results.at(-1)!.value;
  const pending = Promise.withResolvers<Response>(), history = Promise.withResolvers<typeof bot.page>();
  const definition = { ...botDefinition(), id: bot.binding.botId, ownerUserId: userId, sessionId: bot.binding.sessionId, testExecutionId: bot.binding.testExecutionId, roleConfiguration: { instructions: 'Assistant', revision: '1', digest: 'a'.repeat(64) } };
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => init?.method === 'DELETE' ? pending.promise : botResponse(definition, userId)));
  const operation = deletion.begin(definition);
  try {
    expect(deletion.snapshot()[0]!.phase).toBe('submitting');
    expect(cache.isBlocked(bot.binding.botId)).toBe(true); expect(cache.snapshot()).toEqual([]);
    expect(bot.channel.close).toHaveBeenCalledOnce();
    await expect(owner.read(bot.binding.botId, { touch: false })).resolves.toBeNull();
    expect(localStorage.getItem(key)).toBe(before);
    gate.resolve();
    await expect(lateSave).resolves.toBe('stale');
    expect(localStorage.getItem(key)).toBe(before); expect(clear).not.toHaveBeenCalled();
    await expect(store.save(siblingLease, { source: 'verified-history', historyLoaded: true, preview: { ...sibling, lastEventSeq: '2' } })).resolves.toBe('saved');
    expect((await store.read(userId, bot.binding.botId, { touch: false }))?.entries).toEqual([first]);
    before = localStorage.getItem(key);
    pending.resolve(botError(409, 'version_conflict', userId)); await operation;
    expect(deletion.snapshot()[0]!.phase).toBe('rejected');
    expect(cache.isBlocked(bot.binding.botId)).toBe(false);
    expect(localStorage.getItem(key)).toBe(before);
    vi.mocked(bot.api.timeline).mockReturnValue(history.promise);
    cache.select(bot.binding, bot.binding);
    const reopened = cache.snapshot()[0]!.client; expect(reopened).not.toBe(original);
    await vi.waitFor(() => expect(reopened.snapshot().state.snapshot).not.toBeNull());
    expect(reopened.snapshot().historyLoaded).toBe(false);
    cache.flushDisplay(bot.binding.botId); expect(localStorage.getItem(key)).toBe(before);
    history.resolve({ ...bot.page, items: [first, second] });
    await vi.waitFor(() => expect(reopened.snapshot().historySettled).toBe(true));
    await observe.mock.results.at(-1)!.value;
    cache.flushDisplay(bot.binding.botId); await expect(save.mock.results.at(-1)!.value).resolves.toBe('saved');
    expect((await store.read(userId, bot.binding.botId, { touch: false }))?.entries).toEqual([first, second]);
  } finally {
    gate.resolve(); pending.resolve(botError(409, 'version_conflict', userId)); history.resolve({ ...bot.page, items: [first, second] });
    await operation;
  }
});
it('keeps confirmed no-session history revoked until explicit session confirmation and new accepted progress', async () => {
  const userId = crypto.randomUUID(), old = await savedEpochTab(userId, crypto.randomUUID(), true);
  const revision = old.client.snapshot().historyRevision;
  old.owner.confirmNoSession(old.bot.binding.botId);
  const generation = old.owner.generation(old.bot.binding.botId), version = old.owner.version();
  old.owner.confirmNoSession(old.bot.binding.botId);
  expect(old.owner.generation(old.bot.binding.botId)).toBe(generation); expect(old.owner.version()).toBe(version);
  old.owner.bind(old.bot.binding); old.owner.history(old.bot.binding, old.bot.snapshot());
  old.client.setDraft('cached history cannot restore a session'); old.observer.refresh();
  expect(old.owner.displayAllowed(old.bot.binding.botId)).toBe(false);
  await expect(old.owner.read(old.bot.binding.botId, { touch: false })).resolves.toBeNull();
  await Promise.all(old.clear.mock.results.map(result => result.value));
  await expect(old.observer.flush()).resolves.toBeNull();
  expect(await old.store.read(userId, old.bot.binding.botId, { touch: false })).toBeNull();
  expect(old.owner.confirmSession(old.bot.binding)).toBe(true);
  old.observer.refresh(); await expect(old.observer.flush()).resolves.toBeNull();
  await old.client.refresh();
  await vi.waitFor(() => expect(old.client.snapshot().historyRevision).toBeGreaterThan(revision));
  await old.observe.mock.results.at(-1)!.value;
  await expect(old.observer.flush()).resolves.toBe('saved');
  expect((await old.store.read(userId, old.bot.binding.botId, { touch: false }))?.entries).toEqual([old.item]);
});
it('allows newly accepted history after session confirmation while the no-session clear is still queued', async () => {
  const userId = crypto.randomUUID(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  cleanups.unshift(() => gate.resolve());
  let blocked = false;
  const old = epochTab(userId, crypto.randomUUID(), true, async (_key, run) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  });
  const client = old.start(); await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const observer = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await old.observe.mock.results.at(-1)!.value; await expect(observer.flush()).resolves.toBe('saved');
  try {
    blocked = true; old.owner.confirmNoSession(old.bot.binding.botId); await entered.promise;
    expect(old.owner.confirmSession(old.bot.binding)).toBe(true);
    const revision = client.snapshot().historyRevision;
    await client.refresh(); await vi.waitFor(() => expect(client.snapshot().historyRevision).toBeGreaterThan(revision));
    const freshObservation = old.observe.mock.results.at(-1)!.value;
    gate.resolve();
    await Promise.all(old.clear.mock.results.map(result => result.value)); await freshObservation;
    await expect(observer.flush()).resolves.toBe('saved');
    expect((await old.store.read(userId, old.bot.binding.botId, { touch: false }))?.entries).toEqual([old.item]);
  } finally {
    gate.resolve(); observer.close(false);
    await Promise.allSettled([...old.clear.mock.results, ...old.observe.mock.results].map(result => result.value));
  }
});
it('rejects pre-confirmation reads and queued saves when the Session is confirmed absent', async () => {
  const userId = crypto.randomUUID(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  cleanups.unshift(() => gate.resolve());
  let blocked = false;
  const old = epochTab(userId, crypto.randomUUID(), true, async (_key, run) => {
    if (blocked) { entered.resolve(); await gate.promise; }
    return run();
  });
  const client = old.start(); await vi.waitFor(() => expect(client.snapshot().historySettled).toBe(true));
  const observer = new BotHistorySnapshotObserver({ owner: old.owner, binding: old.bot.binding, client, name: () => 'Assistant', bookmark: () => null });
  cleanups.push(() => observer.close(false));
  await old.observe.mock.results.at(-1)!.value; await expect(observer.flush()).resolves.toBe('saved');
  const captured = Promise.withResolvers<void>(), delivery = Promise.withResolvers<void>(), realRead = old.store.read.bind(old.store);
  cleanups.unshift(() => delivery.resolve());
  vi.spyOn(old.store, 'read').mockImplementation(async (...args) => { const result = await realRead(...args); captured.resolve(); await delivery.promise; return result; });
  const read = old.owner.read(old.bot.binding.botId, { touch: false });
  let save: ReturnType<typeof observer.flush> | undefined;
  try {
    await captured.promise;
    blocked = true; save = observer.flush(); await entered.promise;
    old.owner.confirmNoSession(old.bot.binding.botId); observer.close(false);
    old.owner.bind(old.bot.binding); old.owner.history(old.bot.binding, old.bot.snapshot());
    delivery.resolve(); await expect(read).resolves.toBeNull();
    expect(old.owner.displayAllowed(old.bot.binding.botId)).toBe(false); expect(old.owner.cached(old.bot.binding.botId)).toBeNull();
    gate.resolve(); await expect(save).resolves.toBe('stale');
    await Promise.all(old.clear.mock.results.map(result => result.value));
    expect(await old.store.read(userId, old.bot.binding.botId, { touch: false })).toBeNull();
  } finally {
    delivery.resolve(); gate.resolve(); observer.close(false);
    await Promise.allSettled([read, save, ...old.clear.mock.results.map(result => result.value)]);
  }
});
it('keeps no-session revocation target-specific and refuses session confirmation during admission failures', async () => {
  const userId = crypto.randomUUID(), binding = { ...botBinding(1), ownerUserId: userId }, sibling = { ...botBinding(2), ownerUserId: userId };
  let paused = false, current = true;
  const store = new BotDisplaySnapshotStore({ isCurrent: user => user === userId, storage: storage(), withLock: async (_key, run) => run() });
  const owner = new BotDisplaySnapshotCoordinator({ userId, isCurrent: () => current, isPaused: () => paused, store });
  cleanups.push(() => owner.close());
  const revoked = vi.fn(); owner.subscribeSourceRevocation(revoked);
  owner.confirmNoSession(binding.botId); await store.read(userId, binding.botId, { touch: false });
  expect(revoked.mock.calls).toEqual([[binding.botId]]);
  paused = true; expect(owner.confirmSession(binding)).toBe(false);
  paused = false; current = false; expect(owner.confirmSession(binding)).toBe(false);
  current = true; expect(owner.confirmSession({ ...binding, ownerUserId: crypto.randomUUID() })).toBe(false);
  owner.blockBot(binding.botId); owner.blockBot(binding.botId); expect(owner.confirmSession(binding)).toBe(false);
  expect(revoked.mock.calls).toEqual([[binding.botId], [binding.botId]]);
  owner.unblockBot(binding.botId); expect(owner.displayAllowed(binding.botId)).toBe(false);
  expect(owner.confirmSession(binding)).toBe(true); expect(owner.displayAllowed(binding.botId)).toBe(true);
  expect(revoked.mock.calls).toEqual([[binding.botId], [binding.botId]]);
  owner.bind(sibling);
  owner.invalidateBot(binding.botId); expect(owner.confirmSession(binding)).toBe(false);
  expect(owner.displayAllowed(sibling.botId)).toBe(true);
  expect(revoked.mock.calls).toEqual([[binding.botId], [binding.botId], [binding.botId]]);
});
