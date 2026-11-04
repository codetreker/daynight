import { createRef, type RefObject } from 'react';
import { createBotSessionApi, type BotSessionBinding, type SessionApi } from '../../api/sessions';
import type { TimelineReadingBookmark } from '../../ui/useTimelineScroll';
import { TaskSessionClient } from '../task-agent-session/client';
import type { SessionTimelineReadingHandle } from '../task-agent-session/SessionTimeline';
import { clearSessionDisplayPreference } from '../task-agent-session/useSessionDisplayPreference';
import { BotSessionStorage, clearBotSessionStorage } from './session-storage';

export const botSessionKey = (binding: BotSessionBinding): string => JSON.stringify([binding.ownerUserId, binding.botId, binding.sessionId, binding.testExecutionId]);
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
  readonly isCurrent: () => boolean;
  readonly isPaused?: () => boolean;
  readonly onPrincipalMismatch: () => void;
  readonly storage: Storage | null;
  readonly createApi?: (binding: BotSessionBinding, onPrincipalMismatch: () => void) => SessionApi;
};

/** Page-owned LRU. Eviction releases clients; only draft/receipt strings and a bookmark survive. */
export class BotSessionCache {
  private panes: readonly BotSessionPane[] = [];
  private readonly retained = new Map<string, { binding: BotSessionBinding; state: Retained }>();
  private readonly recent = new Map<string, number>();
  private readonly revoked = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private clock = 0;
  private invalidated = false;
  constructor(private readonly options: Options) {}
  isCurrent = (): boolean => !this.invalidated && this.options.isCurrent();
  snapshot = (): readonly BotSessionPane[] => this.panes;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish() { for (const listener of this.listeners) listener(); }
  select(binding: BotSessionBinding | null): void {
    if (!this.isCurrent()) { this.invalidate(); return; }
    if (!binding || binding.ownerUserId !== this.options.userId || this.revoked.has(binding.botId)) return;
    const key = botSessionKey(binding);
    this.recent.set(key, ++this.clock);
    if (this.panes.some(pane => pane.key === key)) return;
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
      isCurrent: () => this.isCurrent() && this.panes.some(pane => pane.key === key && pane.client === client),
      ...(this.options.isPaused ? { isPaused: this.options.isPaused } : {}),
      onPrincipalMismatch: this.options.onPrincipalMismatch,
      onInvalidate: () => { if (this.panes.some(pane => pane.client === client)) this.invalidateBot(binding.botId); },
      storage: saved.storage,
    });
    const pane: BotSessionPane = { key, binding: immutableBinding, client, reading: createRef(), retained: saved };
    this.panes = [...this.panes, pane]; this.publish(); client.syncAvailability();
  }
  private remove(key: string, invalidate: boolean): void {
    const pane = this.panes.find(value => value.key === key), saved = this.retained.get(key);
    if (pane && !invalidate) pane.retained.bookmark = pane.reading.current?.captureBookmark() ?? pane.retained.bookmark;
    this.panes = this.panes.filter(value => value.key !== key); this.recent.delete(key);
    if (invalidate) {
      saved?.state.storage.invalidate();
      if (saved) clearSessionDisplayPreference({ userId: saved.binding.ownerUserId, sessionId: saved.binding.sessionId });
      this.retained.delete(key); pane?.client.invalidate();
    } else pane?.client.close();
  }
  /** Deletion or access loss includes evicted state and prevents stale selections reopening it. */
  invalidateBot(botId: string): void {
    this.revoked.add(botId);
    for (const sessionId of clearBotSessionStorage(this.options.userId, botId, this.options.storage)) clearSessionDisplayPreference({ userId: this.options.userId, sessionId });
    for (const [key, saved] of this.retained) if (saved.binding.botId === botId) this.remove(key, true);
    this.publish();
  }
  invalidate = (): void => {
    if (this.invalidated) return;
    this.invalidated = true;
    for (const sessionId of clearBotSessionStorage(this.options.userId, undefined, this.options.storage)) clearSessionDisplayPreference({ userId: this.options.userId, sessionId });
    for (const key of this.retained.keys()) this.remove(key, true);
    this.publish();
  };
  syncAvailability = (): void => {
    if (!this.isCurrent()) { if (!this.invalidated) this.invalidate(); return; }
    for (const pane of this.panes) pane.client.syncAvailability();
  };
  /** Navigation closes connections without issuing native stop or discarding saved input. */
  close = (): void => { for (const pane of this.panes) this.remove(pane.key, false); this.publish(); };
}
