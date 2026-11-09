import { authRequestsPaused } from '../../api/client';
import type { BotSessionBinding } from '../../api/sessions';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { sessionFence, sessionFenceKey, type SessionSnapshot } from '../../../../daynight/src/session/protocol';
import type { TaskSessionClient } from '../task-agent-session/client';
import type { TimelineReadingBookmark } from '../../ui/useTimelineScroll';
import { BotDisplaySnapshotStore, type BotDisplayPreview, type BotDisplaySnapshotObservation, type BotDisplaySnapshotSaveResult } from './display-snapshot';

const bindingKey = (binding: BotSessionBinding) => JSON.stringify([binding.ownerUserId, binding.botId, binding.sessionId, binding.testExecutionId]);
const historyKey = (snapshot: Pick<SessionSnapshot, 'sessionId' | 'testExecutionId' | 'executionGeneration' | 'historyEpoch'>) => `${sessionFenceKey(snapshot)}:${snapshot.historyEpoch}`;
const previewHistoryKey = (preview: BotDisplayPreview) => `${sessionFenceKey(preview.fence)}:${preview.historyEpoch}`;
type Options = { readonly userId: string; readonly isCurrent: () => boolean; readonly isPaused?: () => boolean; readonly store?: BotDisplaySnapshotStore };
const owners = new WeakMap<TaskCacheScope, BotDisplaySnapshotCoordinator>();
const accounts = new Map<string, Set<BotDisplaySnapshotCoordinator>>();
const failedAccountCleanup = new Map<string, string | null | undefined>();
const snapshotAbsent = (userId: string): boolean => {
  try { return window.localStorage.getItem(`daynight:bot-display:v1:${userId}`) === null; } catch { return false; }
};

/** One persistence and revocation owner is shared by page, panes and cold deletion paths. */
export function getBotDisplaySnapshotCoordinator(scope: TaskCacheScope): BotDisplaySnapshotCoordinator {
  let owner = owners.get(scope);
  if (!owner) {
    owner = new BotDisplaySnapshotCoordinator({ userId: scope.userId, isCurrent: () => !scope.isInvalidated, isPaused: authRequestsPaused });
    owners.set(scope, owner);
    const invalidate = () => { void owner!.clearAccount().finally(() => owner!.close()); };
    scope.signal.addEventListener('abort', invalidate, { once: true });
    if (scope.signal.aborted) invalidate();
  }
  return owner;
}

/** Synchronous revocation precedes asynchronous physical cleanup, including accounts with no mounted Bot page. */
export async function clearBotDisplaySnapshots(userId: string): Promise<boolean> {
  let originalRaw: string | null | undefined;
  try { originalRaw = window.localStorage.getItem(`daynight:bot-display:v1:${userId}`); } catch { originalRaw = undefined; }
  const active = [...(accounts.get(userId) ?? [])];
  let cleared: boolean;
  if (active.length) cleared = (await Promise.all(active.map(owner => owner.clearAccount()))).every(Boolean);
  else {
    const store = new BotDisplaySnapshotStore({ isCurrent: () => false });
    try { cleared = await store.clearAccount(userId) || snapshotAbsent(userId); } finally { store.close(); }
  }
  if (!cleared) failedAccountCleanup.set(userId, originalRaw);
  else failedAccountCleanup.delete(userId);
  return cleared;
}

/** This retry belongs to the old failed disk cleanup; it never invalidates current account owners. */
export async function retryBotDisplaySnapshotCleanup(userId: string): Promise<boolean> {
  if (!failedAccountCleanup.has(userId)) return true;
  const expectedRaw = failedAccountCleanup.get(userId);
  if (expectedRaw === undefined) {
    if (!snapshotAbsent(userId)) return false;
    failedAccountCleanup.delete(userId); return true;
  }
  const store = new BotDisplaySnapshotStore({ isCurrent: () => false });
  try {
    const cleared = await store.retryClearAccount(userId, expectedRaw);
    if (cleared) failedAccountCleanup.delete(userId);
    return cleared;
  } finally { store.close(); }
}

export class BotDisplaySnapshotCoordinator {
  readonly store: BotDisplaySnapshotStore;
  private readonly blocked = new Set<string>();
  private readonly revoked = new Set<string>();
  private readonly bindings = new Map<string, string>();
  private readonly histories = new Map<string, string>();
  private readonly previews = new Map<string, BotDisplayPreview>();
  private readonly rejectedPreviews = new Map<string, string>();
  private readonly sourceRejections = new Map<string, number>();
  private readonly sources = new WeakMap<TaskSessionClient, { readonly source: string; readonly rejection: number }>();
  private readonly generations = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly historyListeners = new Set<(botId: string) => void>();
  private readonly rejectionListeners = new Set<(botId: string) => void>();
  private revision = 0;
  private storageGeneration = 0;
  private storeRevocation: object | null = null;
  private invalidated = false;
  private clearing: Promise<boolean> | null = null;
  private readonly detach: () => void;
  constructor(private readonly options: Options) {
    this.store = options.store ?? new BotDisplaySnapshotStore({ isCurrent: owner => owner === options.userId && this.current() });
    this.detach = this.store.subscribe(() => this.publish());
    let set = accounts.get(options.userId); if (!set) { set = new Set(); accounts.set(options.userId, set); } set.add(this);
    if (typeof window !== 'undefined') window.addEventListener('storage', this.externalChange);
  }
  private current = () => !this.invalidated && this.options.isCurrent() && !this.options.isPaused?.();
  displayAllowed = (botId: string) => !this.invalidated && this.options.isCurrent() && !this.blocked.has(botId) && !this.revoked.has(botId);
  allowed = (botId: string) => this.current() && this.displayAllowed(botId);
  version = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeHistoryReplacement = (listener: (botId: string) => void) => { this.historyListeners.add(listener); return () => { this.historyListeners.delete(listener); }; };
  subscribeHistoryRejection = (listener: (botId: string) => void) => { this.rejectionListeners.add(listener); return () => { this.rejectionListeners.delete(listener); }; };
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }
  private expire(botId: string) { this.generations.set(botId, (this.generations.get(botId) ?? 0) + 1); this.previews.delete(botId); this.publish(); }
  private externalChange = (event: StorageEvent) => {
    if (event.key !== null && event.key !== `daynight:bot-display:v1:${this.options.userId}`) return;
    this.previews.clear(); this.publish();
  };
  generation = (botId: string) => {
    const token = this.store.revocationToken(this.options.userId);
    // The store distinguishes real revocation from same-generation history and
    // LRU writes. A first read establishes the baseline without expiring itself.
    if (this.storeRevocation !== null && token !== this.storeRevocation) this.storageGeneration++;
    this.storeRevocation = token;
    return this.storageGeneration + (this.generations.get(botId) ?? 0);
  };
  cached = (botId: string): BotDisplayPreview | null => this.allowed(botId) ? this.previews.get(botId) ?? null : null;
  sourceAllowed(client: TaskSessionClient, botId: string, source: string): boolean {
    const rejection = this.sourceRejections.get(botId) ?? 0, previous = this.sources.get(client);
    // Keep the barrier with the client rather than an observer's mount lifetime.
    // A name, draft edit or rebuilt observer cannot advance accepted history.
    if (!previous || previous.source !== source) { this.sources.set(client, { source, rejection }); return true; }
    return previous.rejection === rejection;
  }
  async read(botId: string, options: { readonly touch?: boolean } = {}): Promise<BotDisplayPreview | null> {
    if (!this.allowed(botId)) return null;
    const generation = this.generation(botId);
    const preview = await this.store.read(this.options.userId, botId, options);
    if (!this.allowed(botId) || generation !== this.generation(botId)) return null;
    if (preview && (this.bindings.has(botId) && this.bindings.get(botId) !== bindingKey(preview.lastKnownBinding) || this.histories.has(botId) && this.histories.get(botId) !== previewHistoryKey(preview))) {
      this.rejectPreview(botId, preview); return null;
    }
    if (preview) this.rejectedPreviews.delete(botId);
    if (preview) this.previews.set(botId, preview); else this.previews.delete(botId);
    return preview;
  }
  bind(binding: BotSessionBinding): void {
    if (binding.ownerUserId !== this.options.userId || !this.allowed(binding.botId)) return;
    const key = bindingKey(binding), previous = this.bindings.get(binding.botId), preview = this.previews.get(binding.botId);
    this.bindings.set(binding.botId, key);
    if (previous !== undefined && previous !== key) { this.histories.delete(binding.botId); this.clearTarget(binding.botId, true); }
    else if (preview && bindingKey(preview.lastKnownBinding) !== key) this.rejectPreview(binding.botId, preview);
  }
  history(binding: BotSessionBinding, snapshot: SessionSnapshot): void {
    this.bind(binding);
    if (!this.allowed(binding.botId)) return;
    const key = historyKey(snapshot), previous = this.histories.get(binding.botId), preview = this.previews.get(binding.botId);
    this.histories.set(binding.botId, key);
    if (previous !== undefined && previous !== key) this.clearTarget(binding.botId, true);
    else if (preview && previewHistoryKey(preview) !== key) this.rejectPreview(binding.botId, preview);
  }
  private rejectPreview(botId: string, preview: BotDisplayPreview): void {
    const key = JSON.stringify([this.bindings.get(botId), this.histories.get(botId), bindingKey(preview.lastKnownBinding), previewHistoryKey(preview)]);
    this.previews.delete(botId);
    if (this.rejectedPreviews.get(botId) === key) return;
    this.rejectedPreviews.set(botId, key);
    this.sourceRejections.set(botId, (this.sourceRejections.get(botId) ?? 0) + 1);
    // A peer's incompatible record revokes local persistence authority without
    // deleting that record or authorizing another observation of old history.
    this.expire(botId);
    for (const listener of this.rejectionListeners) listener(botId);
  }
  blockBot(botId: string): void { if (!this.blocked.has(botId)) { this.blocked.add(botId); this.expire(botId); } }
  unblockBot(botId: string): void { if (this.blocked.delete(botId)) this.expire(botId); }
  invalidateBot(botId: string): void {
    if (this.revoked.has(botId)) return;
    this.revoked.add(botId); this.blocked.delete(botId); this.clearTarget(botId);
  }
  private clearTarget(botId: string, replacedHistory = false): void {
    this.rejectedPreviews.delete(botId);
    this.expire(botId);
    void this.store.clearTarget(this.options.userId, botId).then(cleared => {
      if (!cleared) console.error('Bot display snapshot could not be physically cleared.', botId);
      // Only a locally confirmed replacement authorizes another observation.
      // A cross-tab clear or a stale save never renews an old payload's lease.
      if (replacedHistory && this.allowed(botId)) for (const listener of this.historyListeners) listener(botId);
    });
  }
  clearAccount(): Promise<boolean> {
    if (this.clearing) return this.clearing;
    this.invalidated = true; this.previews.clear(); this.publish();
    this.clearing = this.store.clearAccount(this.options.userId).then(cleared => {
      const physicallyCleared = cleared || snapshotAbsent(this.options.userId);
      if (!physicallyCleared) console.error('Bot display snapshots could not be physically cleared.');
      return physicallyCleared;
    }).finally(() => { this.clearing = null; });
    return this.clearing;
  }
  close(): void {
    this.invalidated = true; this.previews.clear(); this.detach(); this.store.close(); this.listeners.clear(); this.historyListeners.clear(); this.rejectionListeners.clear();
    accounts.get(this.options.userId)?.delete(this);
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.externalChange);
  }
}

type ObserverOptions = {
  readonly owner: BotDisplaySnapshotCoordinator; readonly binding: BotSessionBinding; readonly client: TaskSessionClient;
  readonly name: () => string | null; readonly bookmark: () => TimelineReadingBookmark | null;
};
type Candidate = { readonly lease: BotDisplaySnapshotObservation; readonly preview: BotDisplayPreview; readonly generation: number; readonly source: string };
const historySource = (view: ReturnType<TaskSessionClient['snapshot']>): string | null => view.state.snapshot ? JSON.stringify([historyKey(view.state.snapshot), view.historyRevision, view.state.lastEventSeq]) : null;

/** Only protocol-accepted client state can supply persistence; preview rows never enter this observer. */
export class BotHistorySnapshotObserver {
  private candidate: Candidate | null = null;
  private lastAccepted: Candidate | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lease: BotDisplaySnapshotObservation | null = null;
  private identity: string | null = null;
  private observedSource: string | null = null;
  private observedGeneration: number | null = null;
  private expiredSource: string | null = null;
  private readonly saving = new Map<BotDisplaySnapshotObservation, number>();
  private observation = 0;
  private closed = false;
  private readonly detach: () => void;
  private readonly detachReplacement: () => void;
  private readonly detachRejection: () => void;
  constructor(private readonly options: ObserverOptions) {
    this.detach = options.client.subscribe(this.observe);
    this.detachReplacement = options.owner.subscribeHistoryReplacement(botId => { if (botId === options.binding.botId) { this.lease = null; this.observedSource = null; this.expiredSource = null; this.observe(); } });
    this.detachRejection = options.owner.subscribeHistoryRejection(botId => {
      if (botId !== options.binding.botId) return;
      for (const lease of [this.lease, this.candidate?.lease, this.lastAccepted?.lease, ...this.saving.keys()]) if (lease) options.owner.store.revokeObservation(lease);
      this.observation++; this.lease = null; this.candidate = null; this.lastAccepted = null;
      this.expiredSource = historySource(options.client.snapshot());
    });
    window.addEventListener('pagehide', this.pagehide);
    this.observe();
  }
  refresh = () => this.observe();
  private pagehide = () => { void this.flush(); };
  private observe = (): void => {
    const { owner, binding, client } = this.options, view = client.snapshot(), snapshot = view.state.snapshot;
    if (this.closed || !owner.allowed(binding.botId)) return;
    const source = historySource(view);
    if (source) owner.sourceAllowed(client, binding.botId, source);
    if (snapshot) owner.history(binding, snapshot);
    if (!snapshot || !view.historyLoaded || !view.historySettled) return;
    if (!source || !owner.sourceAllowed(client, binding.botId, source)) return;
    const name = this.options.name(); if (!name) return;
    const identity = historyKey(snapshot), generation = owner.generation(binding.botId);
    if (source === this.expiredSource) return;
    if (this.observedGeneration !== generation) {
      // New authority can obtain a fresh lease, but cannot reuse one revoked by
      // an account-generation change even when no old-source publish saw it.
      this.lease = null; this.candidate = null; this.lastAccepted = null;
      if (source === this.observedSource) { this.expiredSource = source; return; }
    }
    if (source !== this.observedSource) { this.observedSource = source; this.observedGeneration = generation; this.expiredSource = null; }
    if (identity !== this.identity) { this.identity = identity; this.lease = null; this.candidate = null; this.lastAccepted = null; }
    const ticket = ++this.observation;
    const enqueue = (lease: BotDisplaySnapshotObservation | null) => {
      const current = client.snapshot();
      if (this.closed || ticket !== this.observation || !owner.allowed(binding.botId) || generation !== owner.generation(binding.botId) || !current.historyLoaded || !current.historySettled || !current.state.snapshot || historyKey(current.state.snapshot) !== identity) return;
      if (!lease) { this.expiredSource = source; this.lease = null; this.candidate = null; this.lastAccepted = null; return; }
      this.lease = lease;
      const bookmark = this.options.bookmark(), anchor = bookmark?.anchor;
      const readingAnchor = anchor && bookmark.historyEpoch === snapshot.historyEpoch ? { entryId: anchor.key, offset: Math.max(0, -anchor.top), following: bookmark.following } : undefined;
      this.candidate = { lease, generation, source, preview: { schemaVersion: 1, ownerUserId: binding.ownerUserId, botId: binding.botId, lastKnownBinding: { ...binding }, botName: name, fence: sessionFence(current.state.snapshot), historyEpoch: current.state.snapshot.historyEpoch, lastEventSeq: current.state.lastEventSeq, entries: current.state.entries, resources: [...current.state.resources.values()], savedAt: Date.now(), ...(readingAnchor ? { readingAnchor } : {}) } };
      this.lastAccepted = this.candidate;
      if (this.timer === null) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 2_000);
    };
    if (this.lease) enqueue(this.lease); else void owner.store.observe(binding.ownerUserId, binding.botId).then(enqueue);
  };
  async flush(): Promise<BotDisplaySnapshotSaveResult | null> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    const candidate = this.candidate ?? this.lastAccepted; this.candidate = null;
    if (!candidate || !this.options.owner.allowed(this.options.binding.botId)) return null;
    if (candidate.source === this.expiredSource) return null;
    if (candidate.generation !== this.options.owner.generation(this.options.binding.botId)) { this.expiredSource = candidate.source; this.lease = null; return null; }
    const bookmark = this.options.bookmark(), anchor = bookmark?.anchor;
    const { readingAnchor: _oldAnchor, ...history } = candidate.preview;
    const readingAnchor = anchor && bookmark.historyEpoch === history.historyEpoch ? { entryId: anchor.key, offset: Math.max(0, -anchor.top), following: bookmark.following } : undefined;
    this.saving.set(candidate.lease, (this.saving.get(candidate.lease) ?? 0) + 1);
    try {
      const result = await this.options.owner.store.save(candidate.lease, { source: 'verified-history', historyLoaded: true, preview: { ...history, savedAt: Date.now(), ...(readingAnchor ? { readingAnchor } : {}) } });
      if (result === 'stale') { this.lease = null; this.expiredSource = candidate.source; }
      return result;
    } finally {
      const remaining = this.saving.get(candidate.lease)! - 1;
      if (remaining) this.saving.set(candidate.lease, remaining); else this.saving.delete(candidate.lease);
      if (this.closed && this.saving.size === 0) this.detachRejection();
    }
  }
  close(flush = true): void {
    if (this.closed) return;
    if (flush) void this.flush();
    this.closed = true; this.observation++; this.detach(); this.detachReplacement(); window.removeEventListener('pagehide', this.pagehide);
    // Eviction may have queued a final save. Keep its negative revocation live
    // until the store has completed every save, even when close(false) follows.
    if (this.saving.size === 0) this.detachRejection();
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null; this.candidate = null; this.lastAccepted = null;
  }
}
