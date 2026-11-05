import { ApiError, authRequestsPaused } from '../../api/client';
import { canonicalId } from '../../api/parse';
import { BotDeletionUnknown, deleteBot, getBot, parseBot, type BotDefinition, type DeletedBot, type DeleteBotInput } from '../../api/bots';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { clearBotStoredSessionState, type BotSessionCache } from './session-cache';

export type BotDeletionRecord = {
  readonly id: string;
  readonly name: string;
  readonly sessionId: string | null;
  readonly workerId: string | null;
  readonly request: DeleteBotInput | null;
  readonly result: DeletedBot | null;
  readonly phase: 'submitting' | 'unknown' | 'pending' | 'failed' | 'completed' | 'rejected' | 'unavailable';
  readonly busy: boolean;
  readonly error: unknown;
};
type Cache = Pick<BotSessionCache, 'blockBot' | 'unblockBot' | 'invalidateBot'>;
type Saved = { readonly record: BotDeletionRecord; readonly rejected: boolean };
const owners = new WeakMap<TaskCacheScope, BotDeletionCoordinator>();
const cleared = new Set<string>();
const storageKey = (userId: string) => `daynight.bot.deletions:${userId}`;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const unavailable = (error: unknown) => error instanceof ApiError && error.kind === 'server' && [403, 404, 410].includes(error.status ?? 0);
const phase = (bot: DeletedBot): BotDeletionRecord['phase'] => bot.deletion.workerCleanup.state === 'completed' && bot.deletion.serverCleanup.state === 'completed' ? 'completed' : bot.deletion.workerCleanup.state === 'failed' || bot.deletion.serverCleanup.state === 'failed' ? 'failed' : 'pending';

/** Account cleanup also removes cold requests before the Bot page has mounted. */
export function clearPendingBotDeletions(userId: string): void {
  cleared.add(userId);
  try { window.sessionStorage.removeItem(storageKey(userId)); } catch { /* Ignore inaccessible old identities for this document. */ }
}
export function getBotDeletionCoordinator(scope: TaskCacheScope): BotDeletionCoordinator {
  let owner = owners.get(scope);
  if (!owner) { owner = new BotDeletionCoordinator(scope); owners.set(scope, owner); }
  return owner;
}

/** Retain exact deletion identities across navigation; only explicit actions submit DELETE. */
export class BotDeletionCoordinator {
  private readonly records = new Map<string, Saved>();
  private readonly listeners = new Set<() => void>();
  private readonly caches = new Set<Cache>();
  private readonly operations = new Map<string, Promise<void>>();
  private view: readonly BotDeletionRecord[] = [];
  constructor(private readonly scope: TaskCacheScope) {
    if (!scope.isInvalidated && !cleared.has(scope.userId)) this.restore();
    scope.signal.addEventListener('abort', () => {
      this.records.clear(); this.view = []; clearPendingBotDeletions(scope.userId);
      for (const listener of this.listeners) listener();
      this.caches.clear();
    }, { once: true });
  }
  snapshot = (): readonly BotDeletionRecord[] => this.view;
  /** Independent URLs share the Bot's admission boundary for its known Session. */
  sessionAdmission = (sessionId: string): 'allowed' | 'blocked' | 'revoked' => {
    const records = this.view.filter(record => record.sessionId === sessionId);
    if (records.some(record => record.result || record.phase === 'unavailable')) return 'revoked';
    return records.some(record => record.phase !== 'rejected') ? 'blocked' : 'allowed';
  };
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  attachCache = (cache: Cache): (() => void) => {
    this.caches.add(cache);
    for (const value of this.records.values()) this.apply(cache, value.record);
    return () => this.caches.delete(cache);
  };
  private apply(cache: Cache, record: BotDeletionRecord): void {
    if (record.result || record.phase === 'unavailable') cache.invalidateBot(record.id, record.sessionId ?? undefined);
    else if (record.phase === 'rejected') cache.unblockBot(record.id);
    else cache.blockBot(record.id);
  }
  private save(record: BotDeletionRecord, rejected = this.records.get(record.id)?.rejected ?? false): void {
    if (this.scope.isInvalidated) return;
    this.records.set(record.id, { record, rejected }); this.view = [...this.records.values()].map(value => value.record);
    // The original request outlives navigation; its result must clear stored
    // conversation state even after the page has detached its last cache.
    if (record.result || record.phase === 'unavailable') clearBotStoredSessionState(this.scope.userId, record.id, record.sessionId ?? undefined);
    for (const cache of this.caches) this.apply(cache, record);
    this.persist();
    for (const listener of this.listeners) listener();
  }
  private persist(): void {
    cleared.delete(this.scope.userId);
    try {
      const values = [...this.records.values()].map(({ record, rejected }) => ({ id: record.id, name: record.name, sessionId: record.sessionId, workerId: record.workerId, request: record.request, result: record.result, phase: record.phase === 'submitting' ? 'unknown' : record.phase, rejected }));
      window.sessionStorage.setItem(storageKey(this.scope.userId), JSON.stringify(values));
    } catch { /* Memory preserves the original request even when storage is unavailable. */ }
  }
  private restore(): void {
    try {
      const raw: unknown = JSON.parse(window.sessionStorage.getItem(storageKey(this.scope.userId)) ?? '[]');
      if (!Array.isArray(raw)) return;
      const restored = new Map<string, Saved>();
      for (const value of raw) {
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'name', 'sessionId', 'workerId', 'request', 'result', 'phase', 'rejected'].includes(key))) return;
        if (canonicalId(value.id ?? '') !== value.id || typeof value.name !== 'string' || [...value.name].length > 40 || /\p{Cc}/u.test(value.name) || typeof value.rejected !== 'boolean') return;
        if (value.sessionId !== null && canonicalId(value.sessionId ?? '') !== value.sessionId || value.workerId !== null && canonicalId(value.workerId ?? '') !== value.workerId || restored.has(value.id)) return;
        const request = value.request;
        if (request !== null && (!request || typeof request !== 'object' || Object.keys(request).length !== 2 || !decimal(request.ifVersion) || canonicalId(request.deletionId ?? '') !== request.deletionId)) return;
        const result = value.result === null ? null : parseBot(value.result, this.scope.userId, value.id);
        if (result?.deletion === null || result && value.workerId !== null && result.workerId !== value.workerId) return;
        if (!['unknown', 'pending', 'failed', 'completed', 'rejected', 'unavailable'].includes(value.phase)) return;
        if (result === null && ['pending', 'failed', 'completed'].includes(value.phase) || result && phase(result) !== value.phase && value.phase !== 'unavailable') return;
        if (value.phase === 'rejected' && !value.rejected || result === null && value.phase === 'unknown' && request === null) return;
        restored.set(value.id, { record: { id: value.id, name: value.name, sessionId: value.sessionId, workerId: value.workerId, request, result, phase: value.phase, busy: false, error: null }, rejected: value.rejected });
      }
      for (const [id, value] of restored) this.records.set(id, value);
      this.view = [...this.records.values()].map(value => value.record);
    } catch { /* Malformed or inaccessible storage never supplies an executable request. */ }
  }
  private admitted = (): boolean => !this.scope.isInvalidated && !authRequestsPaused();
  private admission = () => ({ userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
  private async run(id: string, action: () => Promise<void>): Promise<void> {
    const existing = this.operations.get(id); if (existing) return existing;
    if (!this.admitted()) return;
    const operation = Promise.resolve().then(action).finally(() => { if (this.operations.get(id) === operation) this.operations.delete(id); });
    this.operations.set(id, operation); return operation;
  }
  begin = (bot: BotDefinition): Promise<void> => {
    if (!this.admitted() || bot.ownerUserId !== this.scope.userId || this.operations.has(bot.id)) return Promise.resolve();
    const old = this.records.get(bot.id)?.record;
    if (old && old.phase !== 'rejected') return Promise.resolve();
    const request = Object.freeze({ ifVersion: bot.version, deletionId: crypto.randomUUID() });
    this.save({ id: bot.id, name: bot.name, sessionId: bot.sessionId, workerId: bot.workerId, request, result: null, phase: 'submitting', busy: true, error: null }, false);
    return this.run(bot.id, () => this.submit(bot.id, request));
  };
  observe = (bot: DeletedBot): void => {
    this.retainDeletion(bot);
  };
  /** An authenticated response remains authoritative during temporary identity verification. */
  private retainDeletion(bot: DeletedBot): void {
    if (this.scope.isInvalidated) return;
    const previous = this.records.get(bot.id)?.record;
    if (previous?.workerId !== null && previous?.workerId !== undefined && previous.workerId !== bot.workerId) return;
    if (previous?.result && BigInt(previous.result.version) > BigInt(bot.version)) return;
    if (previous?.result && previous.result.deletion.deletionId !== bot.deletion.deletionId) return;
    if (previous?.phase === 'completed' && phase(bot) !== 'completed') return;
    this.save({ id: bot.id, name: previous?.name ?? '', sessionId: previous?.sessionId ?? null, workerId: bot.workerId, request: { ifVersion: bot.deletion.requestedVersion, deletionId: bot.deletion.deletionId }, result: bot, phase: phase(bot), busy: previous?.busy ?? false, error: null }, false);
  }
  /** A rejected replay cannot settle an earlier request whose response was lost. */
  private async submit(id: string, request: DeleteBotInput, earlierUnknown = false): Promise<void> {
    try {
      await this.scope.ready(this.scope.signal);
      if (!this.admitted()) return;
      const bot = await deleteBot(id, request, this.scope.signal, this.admission());
      const expectedWorker = this.records.get(id)?.record.workerId;
      if (expectedWorker && bot.workerId !== expectedWorker) throw new BotDeletionUnknown(id, request, new ApiError('protocol'));
      this.retainDeletion(bot);
    } catch (error) {
      if (this.scope.isInvalidated) return;
      const current = this.records.get(id)!;
      // Preserve the response classification while paused, without releasing
      // input or starting another request. Lifecycle errors are not rejections.
      const rejected = !earlierUnknown && error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500;
      this.save({ ...current.record, phase: current.record.result ? current.record.phase : 'unknown', error }, rejected);
      await this.read(id);
    } finally {
      const current = this.records.get(id)?.record;
      if (current) this.save({ ...current, busy: false });
    }
  }
  private async read(id: string): Promise<boolean> {
    if (!this.admitted()) return false;
    const current = this.records.get(id)?.record; if (!current) return false;
    try {
      await this.scope.ready(this.scope.signal);
      const bot = await getBot(id, this.scope.signal, this.admission());
      if (this.scope.isInvalidated) return false;
      const expectedWorker = this.records.get(id)?.record.workerId;
      if (expectedWorker !== null && expectedWorker !== undefined && expectedWorker !== bot.workerId) throw new ApiError('protocol');
      if (bot.deletion !== null) { this.retainDeletion(bot); return true; }
      // An active observation may release input only after identity is verified.
      await this.scope.ready(this.scope.signal);
      if (!this.admitted()) return false;
      const latest = this.records.get(id)!;
      if (!latest.record.result && latest.record.phase !== 'unavailable') {
        if (latest.record.sessionId !== null && latest.record.sessionId !== bot.sessionId) throw new ApiError('protocol');
        this.save({ ...latest.record, sessionId: bot.sessionId, phase: latest.rejected ? 'rejected' : 'unknown', error: latest.rejected ? latest.record.error : null });
      }
      return true;
    } catch (error) {
      if (this.scope.isInvalidated) return false;
      const latest = this.records.get(id)?.record;
      if (latest) this.save({ ...latest, phase: latest.phase === 'completed' ? 'completed' : unavailable(error) ? 'unavailable' : latest.phase, error });
      return false;
    }
  }
  check = (id: string): Promise<void> => this.run(id, async () => {
    const current = this.records.get(id)?.record; if (!current) return;
    this.save({ ...current, busy: true });
    try { await this.read(id); } finally { const latest = this.records.get(id)?.record; if (latest) this.save({ ...latest, busy: false }); }
  });
  retry = (id: string): Promise<void> => this.run(id, async () => {
    const current = this.records.get(id)?.record;
    if (!current || ['completed', 'unavailable', 'rejected'].includes(current.phase)) return;
    this.save({ ...current, busy: true });
    try {
      if (!await this.read(id) || !this.admitted()) return;
      const latest = this.records.get(id)!.record;
      if (latest.request === null || ['completed', 'unavailable', 'rejected'].includes(latest.phase)) return;
      await this.submit(id, latest.request, latest.phase === 'unknown');
    } finally { const latest = this.records.get(id)?.record; if (latest) this.save({ ...latest, busy: false }); }
  });
}
