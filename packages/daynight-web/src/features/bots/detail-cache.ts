import { ApiError, authRequestsPaused, isAbortError } from '../../api/client';
import { parseBot, type Bot, type BotDefinition, type DeletedBot } from '../../api/bots';
import type { BotSessionBinding } from '../../api/sessions';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';

/** Object identity denotes one selection, including a return to the same Bot. */
export type BotDetailSelection = { readonly botId: string | null };
export type BotDetailRequest = {
  readonly scope: TaskCacheScope;
  readonly botId: string;
  readonly selection: BotDetailSelection;
  readonly generation: number;
  readonly signal: AbortSignal;
};
export type BotDetailView = {
  readonly value: BotDefinition | null;
  readonly deletion: DeletedBot | null;
  readonly displayBinding: BotSessionBinding | null;
  readonly actionBinding: BotSessionBinding | null;
  readonly busy: boolean;
  readonly error: unknown;
  readonly errorKind: 'network' | 'protocol' | 'server' | 'unavailable' | 'unknown' | null;
};
type Entry = {
  value: BotDefinition | null;
  binding: BotSessionBinding | null;
  deletion: DeletedBot | null;
  confirmed: BotDetailSelection | null;
  pending: { ticket: BotDetailRequest; controller: AbortController } | null;
  error: unknown;
  errorKind: BotDetailView['errorKind'];
};
const emptyEntry = (): Entry => ({ value: null, binding: null, deletion: null, confirmed: null, pending: null, error: null, errorKind: null });
const emptyView = (): BotDetailView => ({ value: null, deletion: null, displayBinding: null, actionBinding: null, busy: false, error: null, errorKind: null });
const unavailable = (error: unknown): boolean => error instanceof ApiError && error.kind === 'server' && [403, 404, 410].includes(error.status ?? 0);
type Guards = { blocked: Set<string>; revoked: Set<string>; caches: Set<BotDetailCache> };
const scopeGuards = new WeakMap<TaskCacheScope, Guards>();
function guardsFor(scope: TaskCacheScope): Guards {
  let guards = scopeGuards.get(scope);
  if (!guards) { guards = { blocked: new Set(), revoked: new Set(), caches: new Set() }; scopeGuards.set(scope, guards); }
  return guards;
}

/** Page-owned details, isolated by the authenticated scope. No Session or persistent history is owned here. */
export class BotDetailCache {
  private readonly entries = new Map<string, Entry>();
  private readonly guards: Guards;
  private readonly listeners = new Set<() => void>();
  private selection: BotDetailSelection | null = null;
  private displayed = false;
  private invalidated = false;
  private generation = 0;
  private revision = 0;
  constructor(readonly scope: TaskCacheScope) { this.guards = guardsFor(scope); }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = (): number => this.revision;
  private publish(): void { this.revision++; for (const listener of this.listeners) listener(); }
  private live(): boolean { return !this.invalidated && !this.scope.isInvalidated; }
  private allowed(botId: string): boolean { return this.live() && !this.guards.blocked.has(botId) && !this.guards.revoked.has(botId); }

  /** Commit selection outside render. The composition layer supplies at most three resident pane IDs. */
  select(selection: BotDetailSelection, retainedBotIds: ReadonlySet<string>, canRestore = true): void {
    if (retainedBotIds.size > 3) throw new RangeError('Bot details may retain at most three resident panes.');
    if (!this.live()) return;
    this.guards.caches.add(this);
    const changed = this.selection !== selection;
    if (changed) { this.selection = selection; this.displayed = false; }
    this.displayed ||= canRestore && !authRequestsPaused();
    const retained = new Set(retainedBotIds);
    if (selection.botId !== null) retained.add(selection.botId);
    for (const [id, entry] of this.entries) if (!retained.has(id)) { entry.pending?.controller.abort(); this.entries.delete(id); }
    // A blocked cold target still needs an empty slot so a later authoritative
    // unblock can be followed by a fresh read without changing selection.
    if (selection.botId !== null && !this.entries.has(selection.botId)) this.entries.set(selection.botId, emptyEntry());
    // A selection change invalidates admission even when no request is running.
    if (changed) for (const entry of this.entries.values()) entry.confirmed = null;
    this.publish();
  }

  /** A new selection can synchronously read its own display, but never another selection's confirmation. */
  read(selection: BotDetailSelection, canRestore = true, actionEnabled = true): BotDetailView {
    if (!this.live() || selection.botId === null) return emptyView();
    const entry = this.entries.get(selection.botId);
    if (!entry) return emptyView();
    const visible = this.allowed(selection.botId) && (canRestore && !authRequestsPaused() || this.selection === selection && this.displayed);
    const displayBinding = visible ? entry.binding : null;
    return {
      value: visible ? entry.value : null, deletion: entry.deletion, displayBinding,
      actionBinding: displayBinding && actionEnabled && !authRequestsPaused() && this.selection === selection && entry.confirmed === selection ? displayBinding : null,
      busy: entry.pending !== null, error: entry.error, errorKind: entry.errorKind,
    };
  }

  /** Start one read for the committed selection; polling preserves the existing confirmation bit. */
  begin(): BotDetailRequest | null {
    const selection = this.selection, botId = selection?.botId;
    if (!selection || !botId || !this.allowed(botId) || authRequestsPaused()) return null;
    const entry = this.entries.get(botId);
    if (!entry || entry.pending?.ticket.selection === selection) return null;
    entry.pending?.controller.abort();
    const controller = new AbortController();
    const ticket = { scope: this.scope, botId, selection, generation: ++this.generation, signal: AbortSignal.any([controller.signal, this.scope.signal]) };
    entry.pending = { ticket, controller }; this.publish(); return ticket;
  }
  private current(ticket: BotDetailRequest): Entry | null {
    const entry = this.entries.get(ticket.botId);
    return ticket.scope === this.scope && this.allowed(ticket.botId) && !ticket.signal.aborted && entry?.pending?.ticket === ticket ? entry : null;
  }
  /** Accept only a validated response for a still-retained request; background completion cannot grant admission. */
  accept(ticket: BotDetailRequest, value: Bot): void {
    const entry = this.current(ticket); if (!entry) return;
    let bot: Bot;
    try { bot = parseBot(value, this.scope.userId, ticket.botId); }
    catch (error) { this.fail(ticket, error); return; }
    if (bot.deletion !== null) {
      entry.deletion = bot; this.invalidateBot(ticket.botId); return;
    }
    if (authRequestsPaused()) { this.cancel(ticket); return; }
    entry.pending = null; entry.value = bot; entry.error = null; entry.errorKind = null;
    entry.binding = bot.sessionId && bot.testExecutionId ? { ownerUserId: bot.ownerUserId, botId: bot.id, sessionId: bot.sessionId, testExecutionId: bot.testExecutionId } : null;
    entry.confirmed = this.selection === ticket.selection ? ticket.selection : null;
    this.publish();
  }
  fail(ticket: BotDetailRequest, error: unknown): void {
    if (ticket.signal.aborted || isAbortError(error)) { this.cancel(ticket); return; }
    const entry = this.current(ticket); if (!entry) return;
    entry.pending = null; entry.confirmed = null; entry.error = error;
    entry.errorKind = unavailable(error) ? 'unavailable' : error instanceof ApiError ? error.kind : 'unknown';
    if (unavailable(error)) this.invalidateBot(ticket.botId); else this.publish();
  }
  /** Cancellation only removes in-flight work; it neither grants admission nor invents a read error. */
  cancel(ticket: BotDetailRequest): void {
    const entry = this.entries.get(ticket.botId);
    if (entry?.pending?.ticket !== ticket) return;
    entry.pending.controller.abort(); entry.pending = null; this.publish();
  }
  blockBot = (botId: string): void => {
    if (this.guards.blocked.has(botId) || this.guards.revoked.has(botId)) return;
    this.guards.blocked.add(botId);
    for (const cache of this.guards.caches) { cache.clearEntry(botId); cache.publish(); }
  };
  /** Releasing a temporary deletion barrier requires a fresh read, never a pre-barrier confirmation. */
  unblockBot = (botId: string): void => {
    if (this.guards.blocked.delete(botId)) for (const cache of this.guards.caches) cache.publish();
  };
  invalidateBot = (botId: string): void => {
    this.guards.revoked.add(botId); this.guards.blocked.delete(botId);
    for (const cache of this.guards.caches) { cache.clearEntry(botId); cache.publish(); }
  };
  private clearEntry(botId: string): void {
    const entry = this.entries.get(botId); if (!entry) return;
    entry.pending?.controller.abort(); entry.pending = null; entry.value = null; entry.binding = null; entry.confirmed = null;
  }
  invalidate = (): void => { this.invalidated = true; this.close(); };
  /** Release page-owned reads and details. Scope-wide revocations remain effective if the owner is reused. */
  close = (): void => {
    for (const entry of this.entries.values()) entry.pending?.controller.abort();
    this.entries.clear(); this.selection = null; this.displayed = false; this.publish();
    this.guards.caches.delete(this);
  };
}
