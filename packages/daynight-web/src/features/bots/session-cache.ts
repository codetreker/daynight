import { createRef, type RefObject } from 'react';
import { createBotSessionApi, type BotSessionBinding, type SessionApi } from '../../api/sessions';
import type { TimelineReadingBookmark } from '../../ui/useTimelineScroll';
import { clearImageDraftScope } from '../task-agent-session/drafts/draft-store-cleanup';
import { TaskSessionClient, clearIndependentSessionStorage } from '../task-agent-session/client';
import type { SessionTimelineReadingHandle } from '../task-agent-session/SessionTimeline';
import { clearSessionDisplayPreference } from '../task-agent-session/useSessionDisplayPreference';
import { BotSessionStorage, clearBotSessionStorage } from './session-storage';
import { BotHistorySnapshotObserver, type BotDisplaySnapshotCoordinator } from './display-snapshot-coordinator';

export const botSessionKey = (binding: BotSessionBinding): string => JSON.stringify([binding.ownerUserId, binding.botId, binding.sessionId, binding.testExecutionId]);

/** Clear a Bot's stored draft, receipts and display choices without a mounted cache. */
export async function clearBotStoredSessionState(userId: string, botId: string, sessionId?: string, storage?: Storage | null, reason: 'revoked' | 'deleted' = 'revoked'): Promise<Error | null> {
  const sessions = new Set(clearBotSessionStorage(userId, botId, storage));
  if (sessionId) sessions.add(sessionId);
  const imageCleanup = [...sessions].map(id => clearImageDraftScope({ origin: window.location.origin, actorUserId: userId, sessionId: id, reason }));
  for (const id of sessions) {
    clearIndependentSessionStorage(userId, id, storage);
    clearSessionDisplayPreference({ userId, sessionId: id });
  }
  return (await Promise.all(imageCleanup)).find(error => error !== null) ?? null;
}
type Retained = { readonly storage: BotSessionStorage; bookmark: TimelineReadingBookmark | null };
export type BotSessionPane = {
  readonly key: string;
  readonly binding: BotSessionBinding;
  readonly client: TaskSessionClient;
  readonly reading: RefObject<SessionTimelineReadingHandle | null>;
  readonly retained: Retained;
};
type Options = {
  readonly userId: string;
  readonly identityScope?: object;
  readonly isCurrent: () => boolean;
  readonly isPaused?: () => boolean;
  readonly onPrincipalMismatch: () => void;
  readonly storage: Storage | null;
  readonly createApi?: (binding: BotSessionBinding, onPrincipalMismatch: () => void) => SessionApi;
  readonly displaySnapshots?: BotDisplaySnapshotCoordinator;
};
type Guards = { readonly blocked: Set<string>; readonly revoked: Set<string>; readonly noSessions: Set<string>; readonly caches: Set<BotSessionCache>; revision: number };
const scopeGuards = new WeakMap<object, Map<string, Guards>>();
function guardsFor(options: Options): Guards {
  const fresh = (): Guards => ({ blocked: new Set(), revoked: new Set(), noSessions: new Set(), caches: new Set(), revision: 0 });
  if (!options.identityScope) return fresh();
  let users = scopeGuards.get(options.identityScope);
  if (!users) { users = new Map(); scopeGuards.set(options.identityScope, users); }
  let guards = users.get(options.userId);
  if (!guards) { guards = fresh(); users.set(options.userId, guards); }
  return guards;
}

/** Page-owned LRU. Eviction releases clients; only draft/receipt strings and a bookmark survive. */
export class BotSessionCache {
  private panes: readonly BotSessionPane[] = [];
  private readonly retained = new Map<string, { binding: BotSessionBinding; state: Retained }>();
  private readonly recent = new Map<string, number>();
  private readonly guards: Guards;
  private readonly listeners = new Set<() => void>();
  private clock = 0;
  private invalidated = false;
  private readonly names = new Map<string, string>();
  private readonly observers = new Map<string, BotHistorySnapshotObserver>();
  constructor(private readonly options: Options) { this.guards = guardsFor(options); this.guards.caches.add(this); }
  displaySnapshots = (): BotDisplaySnapshotCoordinator | undefined => this.options.displaySnapshots;
  accountUserId = (): string => this.options.userId;
  setBotName(botId: string, name: string | null): void {
    if (!name || this.names.get(botId) === name) return;
    this.names.set(botId, name);
    for (const pane of this.panes) if (pane.binding.botId === botId) this.observers.get(pane.key)?.refresh();
  }
  flushDisplay(botId: string): void { for (const pane of this.panes) if (pane.binding.botId === botId) void this.observers.get(pane.key)?.flush(); }
  isCurrent = (): boolean => !this.invalidated && this.options.isCurrent();
  isBlocked = (botId: string): boolean => this.guards.blocked.has(botId);
  isRevoked = (botId: string): boolean => this.guards.revoked.has(botId);
  isNoSession = (botId: string): boolean => this.guards.noSessions.has(botId);
  guardSnapshot = (): number => this.guards.revision;
  snapshot = (): readonly BotSessionPane[] => this.panes;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish() { for (const listener of this.listeners) listener(); }
  /** Revoke new operations without disturbing reading, drafts or original receipts. */
  suspendActions = (): void => { for (const pane of this.panes) pane.client.setActionAdmission(false); };
  select(binding: BotSessionBinding | null, actionBinding: BotSessionBinding | null = null): void {
    this.suspendActions();
    if (!this.isCurrent()) { this.invalidate(); return; }
    this.guards.caches.add(this);
    if (!binding || binding.ownerUserId !== this.options.userId || this.isRevoked(binding.botId) || this.isBlocked(binding.botId)) return;
    const key = botSessionKey(binding);
    const actionAdmitted = actionBinding !== null && botSessionKey(actionBinding) === key;
    if (actionAdmitted) {
      if (this.options.isPaused?.() || this.options.displaySnapshots?.confirmSession(binding) === false) return;
      if (this.guards.noSessions.delete(binding.botId)) {
        this.guards.revision++;
        for (const cache of this.guards.caches) cache.publish();
      }
    } else if (this.isNoSession(binding.botId)) return;
    this.options.displaySnapshots?.bind(binding);
    this.recent.set(key, ++this.clock);
    const existing = this.panes.find(pane => pane.key === key);
    if (existing) { existing.client.setActionAdmission(actionAdmitted); return; }
    // A changed stable binding cannot inherit another execution's local state.
    for (const [otherKey, other] of this.retained) if (other.binding.botId === binding.botId && otherKey !== key) this.remove(otherKey, true);
    if (this.panes.length === 3) {
      const oldest = this.panes.reduce((a, b) => this.recent.get(a.key)! < this.recent.get(b.key)! ? a : b);
      this.remove(oldest.key, false);
    }
    let saved = this.retained.get(key)?.state;
    if (!saved) {
      saved = { storage: new BotSessionStorage(key, this.options.storage), bookmark: null };
      this.retained.set(key, { binding: { ...binding }, state: saved });
    }
    const immutableBinding = { ...binding };
    const client = new TaskSessionClient({
      api: (this.options.createApi ?? createBotSessionApi)(immutableBinding, this.options.onPrincipalMismatch),
      userId: binding.ownerUserId, testSessionId: binding.sessionId, bot: immutableBinding,
      initialActionAdmitted: false,
      isCurrent: () => this.isCurrent() && !this.isBlocked(binding.botId) && !this.isRevoked(binding.botId) && this.panes.some(pane => pane.key === key && pane.client === client),
      ...(this.options.isPaused ? { isPaused: this.options.isPaused } : {}),
      onPrincipalMismatch: this.options.onPrincipalMismatch,
      onInvalidate: () => { if (this.panes.some(pane => pane.client === client)) this.invalidateBot(binding.botId); },
      storage: saved.storage,
    });
    const pane: BotSessionPane = { key, binding: immutableBinding, client, reading: createRef(), retained: saved };
    if (this.options.displaySnapshots) this.observers.set(key, new BotHistorySnapshotObserver({ owner: this.options.displaySnapshots, binding: immutableBinding, client, name: () => this.names.get(binding.botId) ?? null, bookmark: () => pane.reading.current?.captureBookmark() ?? pane.retained.bookmark }));
    this.panes = [...this.panes, pane]; client.setActionAdmission(actionAdmitted); this.publish(); client.syncAvailability();
  }
  private remove(key: string, invalidate: boolean): void {
    const pane = this.panes.find(value => value.key === key), saved = this.retained.get(key);
    this.observers.get(key)?.close(!invalidate && !this.isBlocked(pane?.binding.botId ?? '') && !this.isRevoked(pane?.binding.botId ?? '')); this.observers.delete(key);
    if (pane && !invalidate) pane.retained.bookmark = pane.reading.current?.captureBookmark() ?? pane.retained.bookmark;
    this.panes = this.panes.filter(value => value.key !== key); this.recent.delete(key);
    if (invalidate) {
      saved?.state.storage.invalidate();
      if (saved) clearSessionDisplayPreference({ userId: saved.binding.ownerUserId, sessionId: saved.binding.sessionId });
      this.retained.delete(key); pane?.client.invalidate();
    } else pane?.client.close();
  }
  /** A confirmed absence ends the old Session without permanently revoking its Bot. */
  confirmNoSession(botId: string): void {
    if (!this.isCurrent() || this.isRevoked(botId) || this.isNoSession(botId)) return;
    this.guards.noSessions.add(botId); this.guards.revision++;
    this.options.displaySnapshots?.confirmNoSession(botId);
    clearBotStoredSessionState(this.options.userId, botId, undefined, this.options.storage);
    for (const cache of this.guards.caches) {
      for (const [key, saved] of cache.retained) if (saved.binding.botId === botId) cache.remove(key, true);
      cache.publish();
    }
  }
  /** Freeze an unconfirmed deletion without losing drafts, receipts or reading state. */
  blockBot(botId: string): void {
    if (this.isBlocked(botId) || this.isRevoked(botId)) return;
    this.guards.blocked.add(botId); this.guards.revision++;
    this.options.displaySnapshots?.blockBot(botId);
    for (const cache of this.guards.caches) {
      for (const pane of cache.panes) if (pane.binding.botId === botId) cache.remove(pane.key, false);
      cache.publish();
    }
  }
  /** Only an authoritative active definition permits resuming a blocked Bot. */
  unblockBot(botId: string): void {
    if (!this.guards.blocked.delete(botId)) return;
    this.options.displaySnapshots?.unblockBot(botId);
    this.guards.revision++;
    for (const cache of this.guards.caches) cache.publish();
  }
  /** Deletion or access loss includes evicted state and prevents stale selections reopening it. */
  invalidateBot(botId: string, sessionId?: string): void {
    if (!this.isRevoked(botId)) this.guards.revision++;
    this.guards.revoked.add(botId); this.guards.blocked.delete(botId);
    this.options.displaySnapshots?.invalidateBot(botId);
    clearBotStoredSessionState(this.options.userId, botId, sessionId, this.options.storage);
    for (const cache of this.guards.caches) {
      for (const [key, saved] of cache.retained) if (saved.binding.botId === botId) cache.remove(key, true);
      cache.publish();
    }
  }
  invalidate = (): void => {
    if (this.invalidated) return;
    this.invalidated = true;
    if (this.options.displaySnapshots) void this.options.displaySnapshots.clearAccount();
    for (const sessionId of clearBotSessionStorage(this.options.userId, undefined, this.options.storage)) clearSessionDisplayPreference({ userId: this.options.userId, sessionId });
    for (const key of this.retained.keys()) this.remove(key, true);
    this.guards.caches.delete(this);
    this.publish();
  };
  syncAvailability = (): void => {
    if (!this.isCurrent()) { if (!this.invalidated) this.invalidate(); return; }
    for (const pane of this.panes) pane.client.syncAvailability();
  };
  /** Navigation closes connections without issuing native stop or discarding saved input. */
  close = (): void => { for (const pane of this.panes) this.remove(pane.key, false); this.guards.caches.delete(this); this.publish(); };
}
