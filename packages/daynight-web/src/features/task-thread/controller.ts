import { ApiError, authRequestsPaused, isAbortError } from '../../api/client';
import { getThreadPage, isThreadScopeLoss, postThreadMessage, ThreadPostError } from './api';
import { compareThreadPositions, encodedMessageBytes, isThreadBody, mergeThreadMessage, type PostThreadInput, type ThreadMessage, type ThreadPage, type ThreadQuery, type ThreadScope } from './contract';

export const THREAD_LIMITS = { visibleCount: 200, visibleBytes: 2_097_152, incomingCount: 100, incomingBytes: 1_048_576, referenceCount: 16, referenceBytes: 1_048_576 } as const;
const RESERVATION_BYTES = 65_536;
const compare = compareThreadPositions;
const ordered = (messages: Iterable<ThreadMessage>): readonly ThreadMessage[] => [...messages].sort(compare);
const protocol = (): never => { throw new ApiError('protocol'); };
const aborted = (): never => { throw new DOMException('The discussion request was released.', 'AbortError'); };
const failure = (error: unknown): Error => error instanceof Error ? error : new Error('The discussion request failed.', { cause: error });
const messageSizes = new WeakMap<ThreadMessage, number>();
const messageBytes = (message: ThreadMessage): number => { const known = messageSizes.get(message); if (known !== undefined) return known; const size = encodedMessageBytes(message); messageSizes.set(message, size); return size; };
const bytes = (messages: Iterable<ThreadMessage>): number => [...messages].reduce((total, item) => total + messageBytes(item), 0);
const combine = (a: ThreadMessage | undefined, b: ThreadMessage): ThreadMessage => a === undefined ? b : mergeThreadMessage(a, b);

type ReadKind = 'forward' | 'history' | 'reference';
// History pages belong to their captured window even when the account and task remain unchanged.
type HistoryWindow = { readonly revision: number; readonly direction: 'older' | 'newer'; readonly boundary: Pick<ThreadMessage, 'id' | 'createdAt'> };
type Ticket = { readonly kind: ReadKind; readonly controller: AbortController; readonly generation: number; readonly window?: HistoryWindow };
export type ThreadPostOutcome = 'idle' | 'waiting_auth' | 'sending' | 'confirmed' | 'refused' | 'unknown';
export type ThreadRemoteOutcome = 'idle' | 'not_sent' | 'dispatched' | 'confirmed' | 'refused' | 'unknown';
export type ThreadView = {
  readonly visible: readonly ThreadMessage[];
  readonly incomingCount: number;
  readonly consumedAfterId: string | null;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly loadingOlder: boolean;
  readonly loadingNewer: boolean;
  readonly referenceLoading: string | null;
  readonly readError: Error | null;
  readonly historyError: Error | null;
  readonly referenceError: Error | null;
  readonly postError: Error | null;
  readonly draft: string;
  readonly replyTo: string | null;
  readonly replyMessage: ThreadMessage | null;
  readonly sending: boolean;
  readonly postOutcome: ThreadPostOutcome;
  readonly remoteOutcome: ThreadRemoteOutcome;
  readonly detailsMessage: ThreadMessage | null;
  readonly active: boolean;
  readonly retired: boolean;
  readonly authPaused: boolean;
  readonly catchupPaused: boolean;
  readonly revision: number;
  readonly canSend: boolean;
  readonly capacityBlocked: boolean;
};
export type ThreadLimits = { readonly [K in keyof typeof THREAD_LIMITS]: number };
export type ThreadControllerOptions = {
  readonly scope: ThreadScope;
  readonly lifetime: AbortSignal;
  readonly ready: (signal: AbortSignal) => Promise<void>;
  readonly principalMismatch: () => void;
  readonly limits?: ThreadLimits;
  readonly api?: { readonly list: typeof getThreadPage; readonly post: typeof postThreadMessage };
};
type ConfirmedPost = { readonly message: ThreadMessage; readonly draftRevision: number; readonly replyRevision: number; readonly replyTo: string | null };

export class ThreadController {
  private readonly options: ThreadControllerOptions;
  private readonly lifetime = new AbortController();
  private readonly api: NonNullable<ThreadControllerOptions['api']>;
  private readonly limits: ThreadLimits;
  private readonly listeners = new Set<() => void>();
  private visible = new Map<string, ThreadMessage>();
  // Visible echoes still belong to the complete buffered range; only out-of-window entries contribute to its notice.
  private incoming = new Map<string, ThreadMessage>();
  private references = new Map<string, ThreadMessage>();
  // POST echoes do not extend the fetched history range; its next boundary must still expose interleaved messages.
  private windowIds = new Set<string>();
  private windowRevision = 0;
  private cursor: Pick<ThreadMessage, 'id' | 'createdAt'> | null = null;
  private initialized = false;
  private forwardHasMoreAfter = false;
  private active = false;
  private documentVisible = true;
  private admissionBlocked = false;
  private retired = false;
  private following = true;
  private readingAnchor: string | null = null;
  private latestReceipt: string | null = null;
  private hasMoreBefore = false;
  private hasMoreAfter = false;
  private catchupPaused = false;
  private draft = '';
  private draftRevision = 0;
  private replyTo: string | null = null;
  private replyRevision = 0;
  private detailsId: string | null = null;
  private readError: Error | null = null;
  private historyError: Error | null = null;
  private referenceError: Error | null = null;
  private postError: Error | null = null;
  private postOutcome: ThreadPostOutcome = 'idle';
  private remoteOutcome: ThreadRemoteOutcome = 'idle';
  private reserved = false;
  private confirmed: ConfirmedPost | null = null;
  private publishing = false;
  private postTask: Promise<void> | null = null;
  private forwardTask: Promise<void> | null = null;
  private historyTask: Promise<void> | null = null;
  private referenceTask: Promise<void> | null = null;
  private referenceTarget: string | null = null;
  private referenceReveal = false;
  private historyDirection: 'older' | 'newer' | null = null;
  private readonly generations: Record<ReadKind, number> = { forward: 0, history: 0, reference: 0 };
  private readonly tickets = new Map<ReadKind, Ticket>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private view: ThreadView;

  constructor(options: ThreadControllerOptions) {
    this.options = options;
    this.limits = options.limits === undefined ? THREAD_LIMITS : options.limits;
    this.api = options.api === undefined ? { list: getThreadPage, post: postThreadMessage } : options.api;
    this.view = this.makeView();
    options.lifetime.addEventListener('abort', this.retire, { once: true });
    if (options.lifetime.aborted) this.retire();
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = (): ThreadView => this.view;
  getMessage = (id: string): ThreadMessage | null => this.visible.get(id) ?? this.incoming.get(id) ?? this.references.get(id) ?? null;
  private paused = (): boolean => this.admissionBlocked || authRequestsPaused();
  private readable = (): boolean => !this.retired && this.active && this.documentVisible && !this.paused();
  private live = (): void => { if (this.retired || this.lifetime.signal.aborted || this.options.lifetime.aborted) aborted(); };
  private makeView = (): ThreadView => ({
    visible: ordered(this.visible.values()), incomingCount: [...this.incoming.keys()].filter(id => !this.visible.has(id)).length, consumedAfterId: this.cursor?.id ?? null,
    hasMoreBefore: this.hasMoreBefore, hasMoreAfter: this.hasMoreAfter,
    loading: !this.initialized && this.forwardTask !== null, refreshing: this.initialized && this.forwardTask !== null,
    loadingOlder: this.historyDirection === 'older', loadingNewer: this.historyDirection === 'newer', referenceLoading: this.referenceTarget,
    readError: this.readError, historyError: this.historyError, referenceError: this.referenceError, postError: this.postError,
    draft: this.draft, replyTo: this.replyTo, replyMessage: this.replyTo === null ? null : this.getMessage(this.replyTo),
    sending: this.postTask !== null || this.confirmed !== null, postOutcome: this.postOutcome, remoteOutcome: this.remoteOutcome,
    detailsMessage: this.detailsId === null ? null : this.getMessage(this.detailsId), active: this.active, retired: this.retired,
    authPaused: this.paused(), catchupPaused: this.catchupPaused, revision: this.revision,
    capacityBlocked: !this.retired && !this.reserved && !this.canReserve(),
    canSend: this.readable() && this.initialized && this.readError === null && this.postTask === null && this.confirmed === null && isThreadBody(this.draft) && this.canReserve(),
  });
  private emit = (): void => { this.revision++; this.view = this.makeView(); for (const listener of this.listeners) listener(); };
  private clearTimer = (): void => { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; };
  private schedule = (): void => {
    this.clearTimer();
    if (this.readable() && this.readError === null && !this.catchupPaused) this.timer = setTimeout(() => { this.timer = null; void this.refresh(); }, 5_000);
  };
  private cancelReads = (): void => {
    this.clearTimer();
    for (const kind of ['forward', 'history', 'reference'] as const) { this.generations[kind]++; this.tickets.get(kind)?.controller.abort(); this.tickets.delete(kind); }
    this.forwardTask = null; this.historyTask = null; this.referenceTask = null; this.referenceTarget = null; this.historyDirection = null;
  };
  private ticket = (kind: ReadKind, window?: HistoryWindow): Ticket => {
    const ticket = { kind, controller: new AbortController(), generation: ++this.generations[kind], ...(window === undefined ? {} : { window }) };
    this.tickets.set(kind, ticket); return ticket;
  };
  private currentTicket = (ticket: Ticket): boolean => {
    if (!this.readable() || this.lifetime.signal.aborted || this.options.lifetime.aborted || ticket.controller.signal.aborted || this.generations[ticket.kind] !== ticket.generation) return false;
    if (ticket.window === undefined) return true;
    const boundary = this.boundary(ticket.window.direction);
    return ticket.window.revision === this.windowRevision && boundary !== undefined && compare(boundary, ticket.window.boundary) === 0;
  };
  private assertTicket = (ticket: Ticket): void => { if (!this.currentTicket(ticket)) aborted(); };
  private replaceHistoryWindow = (): void => {
    this.windowRevision++; this.generations.history++; this.tickets.get('history')?.controller.abort(); this.tickets.delete('history');
    this.historyTask = null; this.historyDirection = null; this.historyError = null;
  };
  private admission = (assertCurrent: () => void, boundary?: Pick<ThreadMessage, 'id' | 'createdAt'>) => ({
    assertCurrent,
    onPrincipalMismatch: () => { assertCurrent(); this.options.principalMismatch(); this.retire(); },
    ...(boundary === undefined ? {} : { boundary }),
  });
  private read = async (ticket: Ticket, query: ThreadQuery, boundary?: Pick<ThreadMessage, 'id' | 'createdAt'>): Promise<ThreadPage> => {
    const signal = AbortSignal.any([this.lifetime.signal, ticket.controller.signal]);
    await this.options.ready(signal); this.assertTicket(ticket);
    const page = await this.api.list(this.options.scope, query, signal, this.admission(() => this.assertTicket(ticket), boundary));
    this.assertTicket(ticket);
    for (const item of page.items) {
      if (boundary !== undefined && (query.beforeId !== undefined && compare(item, boundary) >= 0 || query.afterId !== undefined && compare(item, boundary) <= 0)) protocol();
      combine(this.getMessage(item.id) ?? undefined, item);
    }
    return page;
  };
  private normalize = (items: readonly ThreadMessage[]): readonly ThreadMessage[] => items.map(item => combine(this.getMessage(item.id) ?? undefined, item));
  private enrich = (items: readonly ThreadMessage[]): void => {
    for (const item of items) for (const map of [this.visible, this.incoming, this.references]) if (map.has(item.id)) map.set(item.id, item);
  };
  private fitsVisible = (messages: Map<string, ThreadMessage>, reserve = this.reserved): boolean => messages.size + Number(reserve) <= this.limits.visibleCount && bytes(messages.values()) + (reserve ? RESERVATION_BYTES : 0) <= this.limits.visibleBytes;
  private fitsIncoming = (messages: Map<string, ThreadMessage>): boolean => messages.size <= this.limits.incomingCount && bytes(messages.values()) <= this.limits.incomingBytes;
  private pinned = (id: string): boolean => id === this.readingAnchor || id === this.latestReceipt;
  private consumed = (item: ThreadMessage): boolean => this.cursor !== null && compare(item, this.cursor) <= 0;
  private rangeMessages = (): readonly ThreadMessage[] => ordered([...this.windowIds].flatMap(id => this.visible.has(id) ? [this.visible.get(id)!] : []));
  private rangeConnects = (position: Pick<ThreadMessage, 'id' | 'createdAt'> | null, items: readonly ThreadMessage[]): boolean => {
    if (this.windowIds.size === 0) return position === null;
    return position !== null && this.windowIds.has(position.id) || items.some(item => this.windowIds.has(item.id));
  };
  private releaseCoveredIncoming = (): void => {
    if ([...this.incoming.keys()].every(id => this.windowIds.has(id))) this.incoming = new Map();
  };
  private pruned = (messages: Map<string, ThreadMessage>, direction: 'oldest' | 'newest', explicit: boolean, reserve = this.reserved, range = this.rangeMessages()): Map<string, ThreadMessage> | null => {
    const result = new Map(messages);
    const retainedRange = new Set(range.filter(item => result.has(item.id)).map(item => item.id));
    const candidates = [...ordered(result.values())];
    if (direction === 'newest') candidates.reverse();
    const anchor = this.readingAnchor === null ? null : this.getMessage(this.readingAnchor);
    for (const item of candidates) {
      if (this.fitsVisible(result, reserve)) break;
      if (this.pinned(item.id) || !explicit && (!this.consumed(item) || anchor !== null && compare(item, anchor) >= 0)) continue;
      // A fetched boundary must survive when disconnected pins are the only other retained entries.
      if (retainedRange.size === 1 && retainedRange.has(item.id)) continue;
      result.delete(item.id); retainedRange.delete(item.id);
    }
    return this.fitsVisible(result, reserve) ? result : null;
  };
  private canReserve = (): boolean => this.reserved || this.pruned(this.visible, 'oldest', false, true) !== null;
  private applyVisible = (next: Map<string, ThreadMessage>, range: readonly ThreadMessage[], retain: 'oldest' | 'newest' = 'newest'): void => {
    const candidateRange = ordered(new Map(range.map(item => [item.id, item])).values());
    const runs: ThreadMessage[][] = [];
    let run: ThreadMessage[] = [];
    for (const item of candidateRange) {
      if (next.has(item.id)) run.push(next.get(item.id)!);
      else if (run.length > 0) { runs.push(run); run = []; }
    }
    if (run.length > 0) runs.push(run);
    // Skipped fixed pins stay visible, but cannot bridge a hole left by pruning.
    const nextWindow = (retain === 'oldest' ? runs[0] : runs.at(-1)) ?? [];
    const removed = [...this.visible.values()].filter(item => !next.has(item.id));
    const known = [...removed, ...candidateRange, ...next.values()];
    const first = nextWindow[0], last = nextWindow.at(-1);
    if (first !== undefined && known.some(item => compare(item, first) < 0)) this.hasMoreBefore = true;
    if (last !== undefined && known.some(item => compare(item, last) > 0)) this.hasMoreAfter = true;
    for (const item of removed) if (item.id === this.replyTo || item.id === this.detailsId) this.cacheReference(item);
    this.visible = next; this.windowIds = new Set(nextWindow.map(item => item.id)); this.releaseCoveredIncoming();
  };
  private handle = (error: unknown, kind: 'read' | 'history' | 'reference' | 'post', phase: string = kind): void => {
    if (this.retired || isAbortError(error)) return;
    this.reportFailure(error, phase);
    if (isThreadScopeLoss(error)) { this.retire(); return; }
    const value = failure(error);
    if (kind === 'read') this.readError = value;
    else if (kind === 'history') this.historyError = value;
    else if (kind === 'reference') this.referenceError = value;
    else this.postError = value;
  };
  private reportFailure = (error: unknown, phase: string): void => {
    const cause = error instanceof ThreadPostError ? error.cause : error;
    const api = cause instanceof ApiError ? cause : null;
    const safeCode = api !== null && /^[a-z][a-z0-9_]{0,63}$/.test(api.code) ? api.code : 'protocol';
    const requestId = api?.requestId;
    const category = cause instanceof Error && ['ApiError', 'Error', 'AbortError', 'TimeoutError'].includes(cause.name) ? cause.name : 'Error';
    console.warn('Task discussion request failed', {
      component: 'task_thread_web', phase: phase === 'history' || phase === 'reference' ? 'read' : phase,
      ...(phase === 'post' || phase === 'admit' ? {} : { direction: phase === 'reference' ? 'reference' : phase === 'history' ? this.historyDirection === 'older' ? 'before' : 'after' : this.initialized ? 'after' : 'latest' }), projectId: this.options.scope.projectId, taskId: this.options.scope.taskId,
      code: safeCode, status: api?.status ?? null, requestId: requestId !== null && requestId !== undefined && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(requestId) ? requestId : null,
      cause: category, outcome: this.remoteOutcome === 'confirmed' ? 'confirmed' : phase === 'post' ? this.remoteOutcome : 'protocol',
    });
  };
  setActive = (active: boolean): void => {
    if (this.retired || this.active === active) return;
    this.active = active;
    if (!active) { this.cancelReads(); this.detailsId = null; }
    this.emit(); if (this.readable()) void this.refresh();
  };
  setDocumentVisible = (visible: boolean): void => {
    if (this.retired || this.documentVisible === visible) return;
    this.documentVisible = visible;
    if (!visible) { this.cancelReads(); this.detailsId = null; }
    this.emit(); if (this.readable()) void this.refresh();
  };
  setAdmissionBlocked = (blocked: boolean): void => {
    if (this.retired || this.admissionBlocked === blocked) return;
    this.admissionBlocked = blocked;
    if (blocked) { this.cancelReads(); this.detailsId = null; }
    this.emit();
    if (!blocked) { if (this.confirmed !== null) void this.publishConfirmed(); if (this.readable()) void this.refresh(); }
  };
  setFollowing = (following: boolean): void => { if (this.retired || following === this.following) return; this.following = following; this.emit(); };
  setReadingAnchor = (id: string | null): void => { if (this.retired || id === this.readingAnchor) return; this.readingAnchor = id; this.emit(); };
  setDraft = (draft: string): void => { if (this.retired || draft === this.draft) return; this.draft = draft; this.draftRevision++; this.emit(); };
  setReply = (id: string | null): void => { if (this.retired || id === this.replyTo) return; this.replyTo = id; this.replyRevision++; const item = id === null ? null : this.getMessage(id); if (item !== null) this.cacheReference(item); this.emit(); };
  closeDetails = (): void => { if (this.detailsId === null) return; this.detailsId = null; this.emit(); };
  refresh = (): Promise<void> => {
    if (!this.readable()) return Promise.resolve();
    if (this.forwardTask !== null) return this.forwardTask;
    this.clearTimer(); this.readError = null; this.catchupPaused = false;
    const ticket = this.ticket('forward');
    const task = this.runForward(ticket);
    this.forwardTask = task; this.emit();
    return task;
  };
  private runForward = async (ticket: Ticket): Promise<void> => {
    try {
      do {
        const initial = !this.initialized;
        const boundary = this.cursor;
        const query: ThreadQuery = boundary !== null ? { afterId: boundary.id, count: 50 } : this.initialized ? { fromBeginning: true, count: 50 } : { count: 50 };
        const page = await this.read(ticket, query, boundary === null ? undefined : boundary);
        const items = this.normalize(page.items);
        if (initial) {
          this.visible = new Map(items.map(item => [item.id, item])); this.windowIds = new Set(this.visible.keys());
          this.hasMoreBefore = page.hasMoreBefore; this.hasMoreAfter = page.hasMoreAfter; this.initialized = true;
        } else {
          const incoming = new Map(this.incoming);
          const visible = new Map(this.visible);
          const direct = this.following && this.incoming.size === 0 && this.rangeConnects(boundary, items);
          for (const item of items) {
            if (direct) visible.set(item.id, item);
            else { incoming.set(item.id, item); if (visible.has(item.id)) visible.set(item.id, item); }
          }
          const range = direct ? [...this.rangeMessages(), ...items] : this.rangeMessages();
          const trimmed = this.pruned(visible, 'oldest', false, this.reserved, range);
          if (trimmed === null || !this.fitsIncoming(incoming)) { this.catchupPaused = true; break; }
          const previousEnd = this.rangeMessages().at(-1), pageEnd = items.at(-1);
          if (direct && pageEnd !== undefined && (previousEnd === undefined || compare(pageEnd, previousEnd) >= 0)) this.hasMoreAfter = page.hasMoreAfter;
          this.applyVisible(trimmed, range);
          this.incoming = incoming; this.releaseCoveredIncoming();
          this.enrich(items);
        }
        this.forwardHasMoreAfter = page.hasMoreAfter;
        const last = items.at(-1);
        if (last !== undefined) this.cursor = { id: last.id, createdAt: last.createdAt };
        this.readError = null; this.emit();
        if (!page.hasMoreAfter || page.items.length === 0) break;
      } while (this.readable());
    } catch (error) { this.handle(error, 'read'); }
    finally {
      if (this.generations.forward === ticket.generation) { this.forwardTask = null; this.tickets.delete('forward'); this.emit(); this.schedule(); }
    }
  };
  private boundary = (direction: 'older' | 'newer'): ThreadMessage | undefined => {
    const messages = this.rangeMessages();
    return direction === 'older' ? messages[0] : messages.at(-1);
  };
  loadOlder = (): Promise<void> => this.loadHistory('older');
  loadWindowNewer = (): Promise<void> => this.loadHistory('newer');
  private loadHistory = (direction: 'older' | 'newer'): Promise<void> => {
    if (!this.readable()) return Promise.resolve();
    if (this.historyTask !== null) return this.historyTask;
    const boundary = this.boundary(direction); if (boundary === undefined) return Promise.resolve();
    this.historyError = null; this.historyDirection = direction;
    const ticket = this.ticket('history', { revision: this.windowRevision, direction, boundary });
    const task = this.runHistory(ticket, direction, boundary); this.historyTask = task; this.emit(); return task;
  };
  private runHistory = async (ticket: Ticket, direction: 'older' | 'newer', boundary: ThreadMessage): Promise<void> => {
    try {
      const page = await this.read(ticket, direction === 'older' ? { beforeId: boundary.id, count: 50 } : { afterId: boundary.id, count: 50 }, boundary);
      this.assertTicket(ticket);
      const items = this.normalize(page.items), next = new Map(this.visible);
      for (const item of items) next.set(item.id, item);
      const range = [...this.rangeMessages(), ...items];
      const trimmed = this.pruned(next, direction === 'older' ? 'newest' : 'oldest', true, this.reserved, range);
      if (trimmed === null) throw new ApiError('protocol', null, 'window_capacity');
      this.following = false;
      if (direction === 'older') this.hasMoreBefore = page.hasMoreBefore; else this.hasMoreAfter = page.hasMoreAfter;
      this.applyVisible(trimmed, range, direction === 'older' ? 'oldest' : 'newest'); this.enrich(items); this.emit();
    } catch (error) { if (this.currentTicket(ticket)) this.handle(error, 'history'); }
    finally { if (this.generations.history === ticket.generation) { this.historyTask = null; this.historyDirection = null; this.tickets.delete('history'); this.emit(); } }
  };
  // Buffered pages remain represented when their cursor advances; only already shown entries may be displaced.
  revealIncoming = (): void => {
    if (this.retired) return;
    const buffered = this.incoming.size > 0;
    const preserved = !buffered && !this.catchupPaused;
    const range = buffered ? ordered(this.incoming.values()) : preserved ? this.rangeMessages() : this.rangeMessages().slice(-1);
    const next = preserved ? new Map(this.visible) : new Map(range.map(item => [item.id, item]));
    for (const id of [this.readingAnchor, this.latestReceipt]) { const item = id === null ? null : this.getMessage(id); if (item !== null) next.set(item.id, item); }
    if (!this.fitsVisible(next)) protocol();
    this.replaceHistoryWindow();
    if (buffered) this.hasMoreAfter = this.forwardHasMoreAfter;
    this.applyVisible(next, range); this.incoming = new Map(); this.following = true; this.catchupPaused = false; this.emit();
    if (this.readable()) void this.refresh();
  };
  private cacheReference = (message: ThreadMessage): void => {
    const next = new Map(this.references); next.delete(message.id); next.set(message.id, message);
    for (const [id] of next) {
      if (next.size <= this.limits.referenceCount && bytes(next.values()) <= this.limits.referenceBytes) break;
      if (id !== this.replyTo && id !== this.detailsId && id !== message.id) next.delete(id);
    }
    if (next.size > this.limits.referenceCount || bytes(next.values()) > this.limits.referenceBytes) throw new ApiError('protocol', null, 'reference_capacity');
    this.references = next;
  };
  showReference = (id: string): Promise<void> => this.resolveReference(id, true);
  openDetails = (id: string): Promise<void> => this.resolveReference(id, false);
  private resolveReference = (id: string, reveal: boolean): Promise<void> => {
    if (!this.readable()) return Promise.resolve();
    if (this.referenceTask !== null && this.referenceTarget !== id) {
      this.generations.reference++; this.tickets.get('reference')?.controller.abort(); this.tickets.delete('reference'); this.referenceTask = null; this.referenceTarget = null;
    }
    this.referenceReveal = reveal;
    const known = this.getMessage(id);
    if (known !== null) { this.presentReference(known, reveal); return Promise.resolve(); }
    if (this.referenceTask !== null) return this.referenceTask;
    this.referenceError = null; this.referenceTarget = id;
    const ticket = this.ticket('reference'); const task = this.runReference(ticket, id); this.referenceTask = task; this.emit(); return task;
  };
  private runReference = async (ticket: Ticket, id: string): Promise<void> => {
    try {
      const before = await this.read(ticket, { beforeId: id, count: 1 });
      const predecessor = before.items.at(-1);
      const page = await this.read(ticket, predecessor === undefined ? { fromBeginning: true, count: 1 } : { afterId: predecessor.id, count: 1 }, predecessor);
      if (page.items.length !== 1 || page.items[0]!.id !== id) protocol();
      const item = this.normalize(page.items)[0]!;
      this.cacheReference(item); this.presentReference(item, this.referenceReveal);
    } catch (error) { this.handle(error, 'reference'); }
    finally { if (this.generations.reference === ticket.generation) { this.referenceTask = null; this.referenceTarget = null; this.tickets.delete('reference'); this.emit(); } }
  };
  private presentReference = (message: ThreadMessage, reveal: boolean): void => {
    if (this.references.has(message.id)) this.cacheReference(message);
    if (reveal && !this.visible.has(message.id)) {
      this.replaceHistoryWindow();
      this.latestReceipt = null;
      this.hasMoreBefore = true; this.hasMoreAfter = true;
      this.applyVisible(new Map([[message.id, message]]), [message]); this.following = false;
    }
    if (!reveal) this.detailsId = message.id;
    this.referenceError = null; this.emit();
  };
  send = (): Promise<void> => {
    if (!this.view.canSend) return this.postTask ?? Promise.resolve();
    const reserved = this.pruned(this.visible, 'oldest', false, true); if (reserved === null) return Promise.resolve();
    this.applyVisible(reserved, this.rangeMessages()); this.reserved = true; this.postError = null; this.postOutcome = 'waiting_auth'; this.remoteOutcome = 'not_sent';
    const input: PostThreadInput = this.replyTo === null ? { body: this.draft } : { body: this.draft, replyTo: this.replyTo };
    const captured = { draftRevision: this.draftRevision, replyRevision: this.replyRevision, replyTo: this.replyTo };
    const task = this.runPost(input, captured); this.postTask = task; this.emit(); return task;
  };
  private runPost = async (input: PostThreadInput, captured: Omit<ConfirmedPost, 'message'>): Promise<void> => {
    try {
      await this.options.ready(this.lifetime.signal); this.live();
      const message = await this.api.post(this.options.scope, input, this.lifetime.signal, {
        ...this.admission(this.live),
        onDispatch: () => { this.live(); this.postOutcome = 'sending'; this.remoteOutcome = 'dispatched'; this.emit(); },
        onConfirmed: (message: ThreadMessage) => { this.live(); this.confirmed = { message, ...captured }; this.remoteOutcome = 'confirmed'; this.postOutcome = 'confirmed'; this.emit(); },
      });
      this.live();
      if (this.confirmed === null) { this.confirmed = { message, ...captured }; this.remoteOutcome = 'confirmed'; this.postOutcome = 'confirmed'; this.emit(); }
      await this.publishConfirmed();
    } catch (error) {
      if (!this.retired && this.remoteOutcome !== 'confirmed') {
        const outcome = error instanceof ThreadPostError ? error.outcome : this.remoteOutcome === 'dispatched' ? 'unknown' : 'not_sent';
        this.remoteOutcome = outcome; this.postOutcome = outcome === 'unknown' ? 'unknown' : 'refused';
      }
      this.handle(error, this.remoteOutcome === 'confirmed' ? 'read' : 'post', this.remoteOutcome === 'confirmed' ? 'admit' : 'post');
    } finally { this.postTask = null; if (this.confirmed === null) this.reserved = false; this.emit(); }
  };
  private publishConfirmed = async (): Promise<void> => {
    if (this.publishing || this.confirmed === null || this.retired) return;
    this.publishing = true;
    try {
      await this.options.ready(this.lifetime.signal); this.live();
      if (this.admissionBlocked) return;
      const confirmed = this.confirmed; if (confirmed === null) return;
      const item = combine(this.getMessage(confirmed.message.id) ?? undefined, confirmed.message);
      const next = new Map(this.visible); next.set(item.id, item);
      this.reserved = false;
      const trimmed = this.pruned(next, 'oldest', true);
      if (trimmed === null) return protocol();
      this.latestReceipt = item.id; this.applyVisible(trimmed, this.rangeMessages()); this.enrich([item]);
      if (this.draftRevision === confirmed.draftRevision) { this.draft = ''; this.draftRevision++; }
      if (this.replyRevision === confirmed.replyRevision && this.replyTo === confirmed.replyTo) { this.replyTo = null; this.replyRevision++; }
      this.confirmed = null; this.postError = null; this.emit();
    } catch (error) { this.handle(error, 'read', 'admit'); }
    finally { this.publishing = false; }
  };
  retire = (): void => {
    if (this.retired) return;
    this.retired = true; this.lifetime.abort(); this.options.lifetime.removeEventListener('abort', this.retire); this.cancelReads();
    this.visible.clear(); this.incoming.clear(); this.references.clear(); this.windowIds.clear(); this.cursor = null;
    this.draft = ''; this.replyTo = null; this.detailsId = null; this.readError = null; this.historyError = null; this.referenceError = null; this.postError = null;
    this.confirmed = null; this.reserved = false; this.latestReceipt = null; this.readingAnchor = null; this.hasMoreBefore = false; this.hasMoreAfter = false;
    this.emit();
  };
}
export const createThreadController = (options: ThreadControllerOptions): ThreadController => new ThreadController(options);
