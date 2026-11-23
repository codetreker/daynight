import { ApiError, authRequestsPaused, authRequestsPauseRevision, subscribeAuthPause } from '../../api/client';
import { canonicalId } from '../../api/parse';
import { BotDeletionUnknown, deleteBot, getBot, parseBot, type BotDefinition, type DeletedBot, type DeleteBotInput } from '../../api/bots';
import { getBotDeletionRecovery, parseBotDeletionRecovery, type BotDeletionRecovery } from '../../api/bot-deletion-recovery';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { clearBotStoredSessionState, type BotSessionCache } from './session-cache';
import { getBotDisplaySnapshotCoordinator, type BotDisplaySnapshotCoordinator } from './display-snapshot-coordinator';

export type BotDeletionRecord = {
  readonly id: string;
  readonly name: string;
  readonly sessionId: string | null;
  readonly workerId: string | null;
  readonly request: DeleteBotInput | null;
  readonly result: DeletedBot | null;
  readonly phase: 'submitting' | 'unknown' | 'pending' | 'failed' | 'completed' | 'settled' | 'rejected' | 'unavailable';
  readonly recovery?: BotRecoveryState;
  readonly busy: boolean;
  readonly error: unknown;
};
export type BotRecoveryState = {
  readonly value: BotDeletionRecovery | null;
  readonly phase: 'ready' | 'unsupported';
};
type Cache = Pick<BotSessionCache, 'blockBot' | 'unblockBot' | 'invalidateBot'>;
type Saved = { readonly record: BotDeletionRecord; readonly rejected: boolean };
type OperationFields = { readonly revision: number; readonly request: DeleteBotInput | null; readonly controller: AbortController; promise: Promise<void> };
type Operation = OperationFields & ({ readonly kind: 'mutation' } | { readonly kind: 'check'; readonly owner: AbortSignal; readonly onAbort: () => void });
const sameRequest = (left: DeleteBotInput | null, right: DeleteBotInput | null): boolean => left === right || left !== null && right !== null && left.deletionId === right.deletionId && left.ifVersion === right.ifVersion;
const owners = new WeakMap<TaskCacheScope, BotDeletionCoordinator>();
const cleared = new Set<string>();
const storageKey = (userId: string) => `daynight.bot.deletions:${userId}`;
const decimal = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
const unavailable = (error: unknown) => error instanceof ApiError && error.kind === 'server' && [403, 404, 410].includes(error.status ?? 0);
const phase = (bot: DeletedBot): BotDeletionRecord['phase'] => bot.deletion.workerCleanup.state === 'completed' && bot.deletion.serverCleanup.state === 'completed' ? 'completed' : bot.deletion.workerCleanup.state === 'failed' || bot.deletion.serverCleanup.state === 'failed' ? 'failed' : 'pending';
const settled = (value: BotDeletionRecovery | null | undefined) => value?.decision !== null && value?.decision !== undefined && value.serverCleanup.state === 'completed';
const evidenceMissing = (bot: DeletedBot | null) => bot?.deletion.workerCleanup.code === 'execution_evidence_missing';

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
  private readonly operations = new Map<string, Operation>();
  private view: readonly BotDeletionRecord[] = [];
  private readonly displaySnapshots: BotDisplaySnapshotCoordinator;
  constructor(private readonly scope: TaskCacheScope) {
    this.displaySnapshots = getBotDisplaySnapshotCoordinator(scope);
    if (!scope.isInvalidated && !cleared.has(scope.userId)) this.restore();
    for (const { record } of this.records.values()) this.applyDisplaySnapshots(record);
    scope.signal.addEventListener('abort', () => {
      this.records.clear(); this.view = []; clearPendingBotDeletions(scope.userId);
      for (const [id, operation] of this.operations) if (operation.kind === 'check') this.retireCheck(id, operation);
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
  private applyDisplaySnapshots(record: BotDeletionRecord): void {
    if (record.result || record.phase === 'unavailable') this.displaySnapshots.invalidateBot(record.id);
    else if (record.phase === 'rejected') this.displaySnapshots.unblockBot(record.id);
    else this.displaySnapshots.blockBot(record.id);
  }
  private save(record: BotDeletionRecord, rejected = this.records.get(record.id)?.rejected ?? false): void {
    if (this.scope.isInvalidated) return;
    this.records.set(record.id, { record, rejected }); this.view = [...this.records.values()].map(value => value.record);
    this.applyDisplaySnapshots(record);
    // The original request outlives navigation; its result must clear stored
    // conversation state even after the page has detached its last cache.
    if (record.result || record.phase === 'unavailable') clearBotStoredSessionState(this.scope.userId, record.id, record.sessionId ?? undefined, undefined, record.result ? 'deleted' : 'revoked');
    for (const cache of this.caches) this.apply(cache, record);
    this.persist();
    for (const listener of this.listeners) listener();
  }
  private persist(): void {
    cleared.delete(this.scope.userId);
    try {
      const values = [...this.records.values()].map(({ record, rejected }) => ({ id: record.id, name: record.name, sessionId: record.sessionId, workerId: record.workerId, request: record.request, result: record.result, phase: record.phase === 'submitting' ? 'unknown' : record.phase, rejected, ...(record.recovery ? { recovery: record.recovery } : {}) }));
      window.sessionStorage.setItem(storageKey(this.scope.userId), JSON.stringify(values));
    } catch { /* Memory preserves the original request even when storage is unavailable. */ }
  }
  private restore(): void {
    try {
      const raw: unknown = JSON.parse(window.sessionStorage.getItem(storageKey(this.scope.userId)) ?? '[]');
      if (!Array.isArray(raw)) return;
      const restored = new Map<string, Saved>();
      for (const value of raw) {
        if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['id', 'name', 'sessionId', 'workerId', 'request', 'result', 'phase', 'rejected', 'recovery'].includes(key))) return;
        if (canonicalId(value.id ?? '') !== value.id || typeof value.name !== 'string' || [...value.name].length > 40 || /\p{Cc}/u.test(value.name) || typeof value.rejected !== 'boolean') return;
        if (value.sessionId !== null && canonicalId(value.sessionId ?? '') !== value.sessionId || value.workerId !== null && canonicalId(value.workerId ?? '') !== value.workerId || restored.has(value.id)) return;
        const request = value.request;
        if (request !== null && (!request || typeof request !== 'object' || Object.keys(request).length !== 2 || !decimal(request.ifVersion) || canonicalId(request.deletionId ?? '') !== request.deletionId)) return;
        const result = value.result === null ? null : parseBot(value.result, this.scope.userId, value.id);
        if (result?.deletion === null || result && value.workerId !== null && result.workerId !== value.workerId) return;
        let recovery: BotRecoveryState | undefined;
        if (value.recovery !== undefined) {
          const saved = value.recovery;
          if (!saved || typeof saved !== 'object' || Object.keys(saved).length !== 2 || !['ready', 'unsupported'].includes(saved.phase)) return;
          const resource = saved.value === null ? null : parseBotDeletionRecovery(saved.value, value.id, this.scope.userId);
          if (!result || resource && (resource.deletionId !== result.deletion.deletionId || resource.workerId !== result.workerId)) return;
          recovery = { value: resource, phase: saved.phase };
        }
        if (!['unknown', 'pending', 'failed', 'completed', 'settled', 'rejected', 'unavailable'].includes(value.phase)) return;
        if (result === null && ['pending', 'failed', 'completed', 'settled'].includes(value.phase) || result && (settled(recovery?.value) ? 'settled' : phase(result)) !== value.phase && value.phase !== 'unavailable') return;
        if (value.phase === 'rejected' && !value.rejected || result === null && value.phase === 'unknown' && request === null) return;
        restored.set(value.id, { record: { id: value.id, name: value.name, sessionId: value.sessionId, workerId: value.workerId, request, result, phase: value.phase, busy: false, error: null, ...(recovery ? { recovery } : {}) }, rejected: value.rejected });
      }
      for (const [id, value] of restored) this.records.set(id, value);
      this.view = [...this.records.values()].map(value => value.record);
    } catch { /* Malformed or inaccessible storage never supplies an executable request. */ }
  }
  private admitted = (): boolean => !this.scope.isInvalidated && !authRequestsPaused();
  private admission = () => ({ userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch });
  private current(id: string, operation: Operation): boolean {
    return !this.scope.isInvalidated && this.operations.get(id) === operation;
  }
  private uninterrupted(operation: Operation): boolean {
    return this.admitted() && authRequestsPauseRevision() === operation.revision;
  }
  // Cancel only preparation. Once dispatched, an authenticated response remains
  // evidence even if a temporary identity check starts before it arrives.
  private async prepare<T>(operation: Operation, action: (signal: AbortSignal, dispatched: () => void) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new DOMException('Identity admission paused.', 'AbortError'));
    const unsubscribe = subscribeAuthPause(cancel);
    if (!this.uninterrupted(operation)) cancel();
    try { return await action(AbortSignal.any([this.scope.signal, operation.controller.signal, controller.signal]), unsubscribe); }
    finally { unsubscribe(); }
  }
  private run(id: string, request: DeleteBotInput | null, action: (operation: Operation) => Promise<void>): Promise<void> {
    const existing = this.operations.get(id); if (existing) return existing.promise;
    if (!this.admitted()) return Promise.resolve();
    const operation: Operation = { kind: 'mutation', revision: authRequestsPauseRevision(), request, controller: new AbortController(), promise: Promise.resolve() };
    operation.promise = Promise.resolve().then(() => action(operation)).finally(() => {
      if (this.operations.get(id) === operation) this.operations.delete(id);
    });
    this.operations.set(id, operation);
    return operation.promise;
  }
  private retireCheck(id: string, operation: Extract<Operation, { kind: 'check' }>): void {
    if (this.operations.get(id) !== operation) return;
    this.operations.delete(id);
    operation.owner.removeEventListener('abort', operation.onAbort);
    operation.controller.abort();
    // Aborting can synchronously reenter through listeners. Never clear a new
    // operation's busy state or overwrite the operation it installed.
    if (!this.operations.has(id)) {
      const current = this.records.get(id)?.record;
      if (current?.busy) this.save({ ...current, busy: false });
    }
  }
  begin = (bot: BotDefinition): Promise<void> => {
    if (!this.admitted() || bot.ownerUserId !== this.scope.userId || this.operations.has(bot.id)) return Promise.resolve();
    const old = this.records.get(bot.id)?.record;
    if (old && old.phase !== 'rejected') return Promise.resolve();
    const request = Object.freeze({ ifVersion: bot.version, deletionId: crypto.randomUUID() });
    const promise = this.run(bot.id, request, operation => this.submit(bot.id, request, operation));
    this.save({ id: bot.id, name: bot.name, sessionId: bot.sessionId, workerId: bot.workerId, request, result: null, phase: 'submitting', busy: true, error: null }, false);
    return promise;
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
    const request = { ifVersion: bot.deletion.requestedVersion, deletionId: bot.deletion.deletionId };
    const operation = this.operations.get(bot.id);
    const superseded = operation !== undefined && !sameRequest(operation.request, request);
    if (superseded) {
      this.operations.delete(bot.id);
      if (operation.kind === 'check') operation.owner.removeEventListener('abort', operation.onAbort);
      operation.controller.abort(new DOMException('Deletion operation superseded.', 'AbortError'));
    }
    this.save({ id: bot.id, name: previous?.name ?? '', sessionId: previous?.sessionId ?? null, workerId: bot.workerId, request, result: bot, phase: settled(previous?.recovery?.value) ? 'settled' : phase(bot), busy: superseded ? this.operations.has(bot.id) : previous?.busy ?? false, error: null, ...(previous?.recovery ? { recovery: previous.recovery } : {}) }, false);
  }
  /** A rejected replay cannot settle an earlier request whose response was lost. */
  private async submit(id: string, request: DeleteBotInput, operation: Operation, earlierUnknown = false): Promise<void> {
    let dispatched = false;
    try {
      const bot = await this.prepare(operation, async (signal, releasePreparation) => {
        await this.scope.ready(signal);
        signal.throwIfAborted();
        return deleteBot(id, request, signal, this.admission(), () => { dispatched = true; releasePreparation(); });
      });
      if (!this.current(id, operation)) return;
      const expectedWorker = this.records.get(id)?.record.workerId;
      if (expectedWorker && bot.workerId !== expectedWorker) throw new BotDeletionUnknown(id, request, new ApiError('protocol'));
      this.retainDeletion(bot);
    } catch (error) {
      if (!this.current(id, operation)) return;
      const current = this.records.get(id); if (!current) return;
      const cancelledBeforeDispatch = !dispatched && !this.uninterrupted(operation);
      const rejected = !earlierUnknown && (cancelledBeforeDispatch || error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500);
      this.save({ ...current.record, phase: current.record.result ? current.record.phase : cancelledBeforeDispatch && !earlierUnknown ? 'rejected' : 'unknown', error }, rejected);
      if (!cancelledBeforeDispatch && this.uninterrupted(operation) && this.current(id, operation)) await this.read(id, operation);
    } finally {
      if (this.current(id, operation)) {
        const current = this.records.get(id)?.record;
        if (current) this.save({ ...current, busy: false });
      }
    }
  }
  private async read(id: string, operation: Operation): Promise<boolean> {
    if (!this.current(id, operation) || !this.uninterrupted(operation)) return false;
    const current = this.records.get(id)?.record; if (!current) return false;
    try {
      const bot = await this.prepare(operation, async (signal, releasePreparation) => {
        await this.scope.ready(signal);
        signal.throwIfAborted();
        return getBot(id, signal, this.admission(), releasePreparation);
      });
      if (!this.current(id, operation)) return false;
      const expectedWorker = this.records.get(id)?.record.workerId;
      if (expectedWorker !== null && expectedWorker !== undefined && expectedWorker !== bot.workerId) throw new ApiError('protocol');
      if (bot.deletion !== null) {
        this.retainDeletion(bot);
        if (evidenceMissing(bot) || this.records.get(id)?.record.recovery) await this.readRecovery(id, operation);
        return true;
      }
      // An active observation may release input only after identity is verified.
      await this.prepare(operation, signal => this.scope.ready(signal));
      if (!this.current(id, operation) || !this.uninterrupted(operation)) return false;
      const latest = this.records.get(id); if (!latest) return false;
      if (!latest.record.result && latest.record.phase !== 'unavailable') {
        if (latest.record.sessionId !== null && latest.record.sessionId !== bot.sessionId) throw new ApiError('protocol');
        this.save({ ...latest.record, sessionId: bot.sessionId, phase: latest.rejected ? 'rejected' : 'unknown', error: latest.rejected ? latest.record.error : null });
      }
      return true;
    } catch (error) {
      if (!this.current(id, operation)) return false;
      const latest = this.records.get(id)?.record;
      if (latest && (this.uninterrupted(operation) || unavailable(error))) this.save({ ...latest, phase: ['completed', 'settled'].includes(latest.phase) ? latest.phase : unavailable(error) ? 'unavailable' : latest.phase, error });
      return false;
    }
  }
  check = (id: string, owner: AbortSignal): Promise<void> => {
    if (owner.aborted || !this.admitted()) return Promise.resolve();
    let existing = this.operations.get(id);
    while (existing) {
      if (existing.kind === 'mutation') return Promise.resolve();
      if (existing.owner === owner) return existing.promise;
      this.retireCheck(id, existing);
      if (owner.aborted || !this.admitted()) return Promise.resolve();
      existing = this.operations.get(id);
    }
    const operation: Extract<Operation, { kind: 'check' }> = {
      kind: 'check', owner, revision: authRequestsPauseRevision(), request: this.records.get(id)?.record.request ?? null,
      controller: new AbortController(), promise: Promise.resolve(), onAbort: () => this.retireCheck(id, operation),
    };
    operation.promise = Promise.resolve().then(async () => {
      if (!this.current(id, operation)) return;
      const current = this.records.get(id)?.record; if (!current) return;
      this.save({ ...current, busy: true });
      await this.read(id, operation);
    }).finally(() => {
      operation.owner.removeEventListener('abort', operation.onAbort);
      if (this.current(id, operation)) {
        this.operations.delete(id);
        const latest = this.records.get(id)?.record;
        if (latest?.busy && !this.operations.has(id)) this.save({ ...latest, busy: false });
      }
    });
    this.operations.set(id, operation);
    owner.addEventListener('abort', operation.onAbort, { once: true });
    if (owner.aborted) this.retireCheck(id, operation);
    return operation.promise;
  };
  retry = (id: string): Promise<void> => this.run(id, this.records.get(id)?.record.request ?? null, async operation => {
    if (!this.current(id, operation)) return;
    const current = this.records.get(id)?.record;
    if (!current || evidenceMissing(current.result) || current.recovery?.value?.decision || ['completed', 'settled', 'unavailable', 'rejected'].includes(current.phase)) return;
    this.save({ ...current, busy: true });
    try {
      if (!await this.read(id, operation) || !this.current(id, operation) || !this.uninterrupted(operation)) return;
      const latest = this.records.get(id)?.record;
      if (!latest || evidenceMissing(latest.result) || latest.recovery?.value?.decision || latest.request === null || !sameRequest(latest.request, operation.request) || ['completed', 'settled', 'unavailable', 'rejected'].includes(latest.phase)) return;
      await this.submit(id, latest.request, operation, latest.phase === 'unknown');
    } finally {
      if (this.current(id, operation)) { const latest = this.records.get(id)?.record; if (latest) this.save({ ...latest, busy: false }); }
    }
  });

  private retainRecovery(id: string, value: BotDeletionRecovery): void {
    const current = this.records.get(id)?.record;
    if (!current?.result || value.deletionId !== current.result.deletion.deletionId || value.requestedVersion !== current.result.deletion.requestedVersion || value.workerId !== current.workerId) throw new ApiError('protocol');
    if (BigInt(value.version) < BigInt(current.result.version)) return;
    const previous = current.recovery;
    if (previous?.value && BigInt(value.version) < BigInt(previous.value.version)) return;
    if (settled(previous?.value) && !settled(value)) return;
    const recovery: BotRecoveryState = { value, phase: 'ready' };
    const result: DeletedBot = { id, workerId: value.workerId, version: value.version, deletion: { deletionId: value.deletionId, requestedVersion: value.requestedVersion, workerCleanup: value.workerCleanup, serverCleanup: value.serverCleanup } };
    this.save({ ...current, result, recovery, phase: settled(value) ? 'settled' : phase(result), error: null });
  }
  private async readRecovery(id: string, operation: Operation): Promise<void> {
    if (!this.current(id, operation) || !this.uninterrupted(operation)) return;
    try {
      const value = await this.prepare(operation, async (signal, releasePreparation) => {
        await this.scope.ready(signal); signal.throwIfAborted();
        return getBotDeletionRecovery(id, signal, this.admission(), releasePreparation);
      });
      if (this.current(id, operation)) this.retainRecovery(id, value);
    } catch (error) {
      const current = this.records.get(id)?.record;
      if (!current || !this.current(id, operation) || !this.uninterrupted(operation)) return;
      const unsupported = error instanceof ApiError && error.kind === 'server' && error.status === 404;
      this.save({ ...current, recovery: { value: current.recovery?.value ?? null, phase: unsupported && !current.recovery?.value ? 'unsupported' : current.recovery?.phase ?? 'ready' }, error });
    }
  }
}
