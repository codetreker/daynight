import { isAbortError, requestId } from '../../api/client';
import { canonicalId } from '../../api/parse';
import { parseSessionHistory, type SessionHistoryItem } from '../../api/terminal-sessions';
import { TaskCacheError, type ProjectRecord, type SessionHistoryRecord } from '../task-cache/database';
import type { SyncTicket, TaskCacheScope } from '../task-cache/project-cache';

export type CachedSessionHistory = { items: SessionHistoryItem[]; nextCursor: string | null };
export const SESSION_HISTORY_CACHE_LIMITS = { records: 32, totalBytes: 2 * 1024 * 1024, recordBytes: 256 * 1024 } as const;
export const SESSION_HISTORY_LEASE_MS = 30_000;
const sizeOf = (page: CachedSessionHistory | null): number => page === null ? 0 : new TextEncoder().encode(JSON.stringify(page)).byteLength;

function validate(row: SessionHistoryRecord, ticket: SyncTicket, manifest: ProjectRecord): SessionHistoryRecord {
  try {
    if (row.userId !== ticket.userId || row.projectId !== ticket.projectId || canonicalId(row.taskId) !== row.taskId ||
      row.userFence !== manifest.userFence || row.cacheGeneration !== manifest.cacheGeneration || canonicalId(row.requestToken) !== row.requestToken ||
      (row.clearedToken !== null && (typeof row.clearedToken !== 'string' || canonicalId(row.clearedToken) !== row.clearedToken || row.page !== null)) ||
      (row.leaseExpiresAt !== null && (!Number.isSafeInteger(row.leaseExpiresAt) || row.leaseExpiresAt < 0)) ||
      (row.settled !== null && row.settled !== 'saved' && row.settled !== 'failed' && row.settled !== 'cancelled') ||
      (row.leaseExpiresAt !== null && row.settled !== null) ||
      !Number.isSafeInteger(row.lastUsedAt) || row.lastUsedAt < 0 || !Number.isSafeInteger(row.byteSize) || row.byteSize < 0) throw new Error('Invalid session history ownership.');
    const page = row.page === null ? null : parseSessionHistory(row.page);
    if (row.byteSize !== sizeOf(page) || row.byteSize > SESSION_HISTORY_CACHE_LIMITS.recordBytes) throw new Error('Invalid session history size.');
    return { ...row, page };
  } catch (error) { throw new TaskCacheError('corrupt', error); }
}

async function recover<T>(scope: TaskCacheScope, ticket: SyncTicket, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (!(error instanceof TaskCacheError) || error.category !== 'corrupt') throw error;
    await scope.sessionHistoryTransaction(ticket, signal, async store => {
      for await (const cursor of store.index('by-project').iterate([scope.userId, ticket.projectId])) await cursor.delete();
    });
    throw error;
  }
}

export const readCachedSessionHistory = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<CachedSessionHistory | null> => {
  taskId = requestId(taskId);
  if (scope.isHistoryUncertain(ticket, taskId)) return null;
  const page = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined || !summaries.has(taskId)) return null;
    const valid = validate(row, ticket, manifest);
    await store.put({ ...valid, lastUsedAt: Date.now() });
    return valid.page;
  }));
  return scope.isHistoryUncertain(ticket, taskId) ? null : page;
};

export const getSessionHistoryToken = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<string | null> => {
  taskId = requestId(taskId);
  return recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return null;
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    return row === undefined ? null : validate(row, ticket, manifest).requestToken;
  }));
};

export const readSessionHistoryPaginationState = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<{ token: string; refreshing: boolean; page: CachedSessionHistory | null } | null> => {
  taskId = requestId(taskId);
  if (scope.isHistoryUncertain(ticket, taskId)) return null;
  const state = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return null;
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return null;
    const valid = validate(row, ticket, manifest);
    return { token: valid.requestToken, refreshing: valid.leaseExpiresAt !== null && valid.leaseExpiresAt > Date.now(), page: valid.page };
  }));
  return scope.isHistoryUncertain(ticket, taskId) ? null : state;
};

export const isSessionHistoryClearCurrent = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, token: string, signal: AbortSignal): Promise<{ current: boolean; refreshing: boolean }> => {
  taskId = requestId(taskId); token = requestId(token);
  return recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest) => {
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return { current: false, refreshing: false };
    const valid = validate(row, ticket, manifest);
    return { current: valid.clearedToken === token, refreshing: valid.clearedToken === token && valid.leaseExpiresAt !== null && valid.leaseExpiresAt > Date.now() };
  }));
};

// Reserve before making the network request. A newer reservation prevents an older
// response in another component or tab from replacing the newer directory.
export const beginSessionHistoryRefresh = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<{ kind: 'lease'; token: string; acquired: boolean; expiresAt: number } | { kind: 'capacity'; expiresAt: number } | null> => {
  taskId = requestId(taskId);
  const uncertaintyRevision = scope.getHistoryUncertaintyRevision(ticket, taskId);
  const result = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return { kind: 'absent' as const };
    const rows = (await store.index('by-project').getAll([scope.userId, ticket.projectId])).map(row => validate(row, ticket, manifest));
    if (rows.length > SESSION_HISTORY_CACHE_LIMITS.records || rows.reduce((sum, row) => sum + row.byteSize, 0) > SESSION_HISTORY_CACHE_LIMITS.totalBytes) throw new TaskCacheError('corrupt');
    const existing = rows.find(row => row.taskId === taskId);
    const now = Date.now();
    if (existing?.leaseExpiresAt !== null && existing?.leaseExpiresAt !== undefined && existing.leaseExpiresAt > now)
      return { kind: 'lease' as const, token: existing.requestToken, acquired: false, expiresAt: existing.leaseExpiresAt };
    const others = rows.filter(row => row.taskId !== taskId).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.taskId.localeCompare(b.taskId));
    let count = others.length + 1;
    for (const row of others) {
      if (count <= SESSION_HISTORY_CACHE_LIMITS.records) break;
      if (row.clearedToken !== null || row.leaseExpiresAt !== null && row.leaseExpiresAt > now) continue;
      await store.delete([scope.userId, ticket.projectId, row.taskId]); count--;
    }
    if (count > SESSION_HISTORY_CACHE_LIMITS.records) {
      const active = others.flatMap(row => row.leaseExpiresAt !== null && row.leaseExpiresAt > now ? [row.leaseExpiresAt] : []);
      return active.length ? { kind: 'capacity' as const, expiresAt: Math.min(...active) } : { kind: 'rotate' as const };
    }
    const requestToken = crypto.randomUUID();
    const leaseExpiresAt = now + SESSION_HISTORY_LEASE_MS;
    await store.put({ userId: scope.userId, projectId: ticket.projectId, taskId, userFence: manifest.userFence,
      cacheGeneration: manifest.cacheGeneration, requestToken, clearedToken: existing?.clearedToken ?? null,
      leaseExpiresAt, settled: null, page: existing?.page ?? null, byteSize: existing?.byteSize ?? 0, lastUsedAt: now });
    return { kind: 'lease' as const, token: requestToken, acquired: true, expiresAt: leaseExpiresAt };
  }));
  if (result.kind === 'rotate') {
    if (await scope.rotateSessionHistoryGeneration(ticket, SESSION_HISTORY_CACHE_LIMITS.records, signal))
      throw new DOMException('The project cache generation changed.', 'AbortError');
    return beginSessionHistoryRefresh(scope, ticket, taskId, signal);
  }
  if (result.kind === 'lease' && result.acquired) scope.allowHistoryUncertainToken(ticket, taskId, uncertaintyRevision, result.token);
  return result.kind === 'lease' ? { kind: 'lease', token: result.token, acquired: result.acquired, expiresAt: result.expiresAt }
    : result.kind === 'capacity' ? result : null;
};

// The marker proves a denial to other tabs and invalidates earlier request tokens.
export const clearSessionHistory = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, expectedToken: string | null, signal: AbortSignal): Promise<boolean> => {
  taskId = requestId(taskId);
  if (expectedToken !== null) expectedToken = requestId(expectedToken);
  let clearedToken: { kind: 'stale' } | { kind: 'overflow' } | { kind: 'cleared'; marker: string };
  try { clearedToken = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest) => {
    const rows = (await store.index('by-project').getAll([scope.userId, ticket.projectId])).map(row => validate(row, ticket, manifest));
    if (rows.length > SESSION_HISTORY_CACHE_LIMITS.records || rows.reduce((sum, row) => sum + row.byteSize, 0) > SESSION_HISTORY_CACHE_LIMITS.totalBytes) throw new TaskCacheError('corrupt');
    const existing = rows.find(row => row.taskId === taskId);
    if ((existing?.requestToken ?? null) !== expectedToken || existing?.leaseExpiresAt !== null && existing?.leaseExpiresAt !== undefined && existing.leaseExpiresAt <= Date.now()) return { kind: 'stale' as const };
    const others = rows.filter(row => row.taskId !== taskId).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.taskId.localeCompare(b.taskId));
    let count = others.length + 1;
    for (const evicted of others) {
      if (count <= SESSION_HISTORY_CACHE_LIMITS.records) break;
      if (evicted.clearedToken !== null) continue;
      await store.delete([scope.userId, ticket.projectId, evicted.taskId]); count--;
    }
    if (count > SESSION_HISTORY_CACHE_LIMITS.records) return { kind: 'overflow' as const };
    const marker = crypto.randomUUID();
    await store.put({ userId: scope.userId, projectId: ticket.projectId, taskId, userFence: manifest.userFence,
      cacheGeneration: manifest.cacheGeneration, requestToken: crypto.randomUUID(), clearedToken: marker,
      leaseExpiresAt: null, settled: 'cancelled', page: null, byteSize: 0, lastUsedAt: Date.now() });
    return { kind: 'cleared' as const, marker };
  })); }
  catch (error) {
    if (!isAbortError(error)) {
      try { if (!await scope.reportHistoryUncertain(ticket, taskId, expectedToken, signal)) return false; }
      catch { /* The original storage error remains the actionable failure. */ }
    }
    throw error;
  }
  if (clearedToken.kind === 'stale') return false;
  if (clearedToken.kind === 'overflow') {
    try { return await scope.rotateSessionHistoryGeneration(ticket, SESSION_HISTORY_CACHE_LIMITS.records, signal); }
    catch (error) {
      if (!isAbortError(error)) {
        try { if (!await scope.reportHistoryUncertain(ticket, taskId, expectedToken, signal)) return false; }
        catch { /* The original storage error remains the actionable failure. */ }
      }
      throw error;
    }
  }
  scope.sessionHistoryCleared(ticket, taskId, clearedToken.marker, signal);
  return true;
};

export const saveSessionHistory = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, page: CachedSessionHistory, requestToken: string, signal: AbortSignal): Promise<boolean> => {
  taskId = requestId(taskId); requestToken = requestId(requestToken);
  const parsed = parseSessionHistory(page); const byteSize = sizeOf(parsed);
  const result = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return { saved: false, changed: false };
    const rows = (await store.index('by-project').getAll([scope.userId, ticket.projectId])).map(row => validate(row, ticket, manifest));
    if (rows.length > SESSION_HISTORY_CACHE_LIMITS.records || rows.reduce((sum, row) => sum + row.byteSize, 0) > SESSION_HISTORY_CACHE_LIMITS.totalBytes) throw new TaskCacheError('corrupt');
    const existing = rows.find(row => row.taskId === taskId);
    if (existing === undefined || existing.requestToken !== requestToken || existing.leaseExpiresAt === null || existing.leaseExpiresAt <= Date.now() ||
      !scope.canSaveHistoryAfterUncertain(ticket, taskId, requestToken)) return { saved: false, changed: false };
    let storedPage: CachedSessionHistory | null = byteSize <= SESSION_HISTORY_CACHE_LIMITS.recordBytes ? parsed : null;
    let storedBytes = storedPage === null ? 0 : byteSize;
    const others = rows.filter(row => row.taskId !== taskId).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.taskId.localeCompare(b.taskId));
    let bytes = others.reduce((sum, row) => sum + row.byteSize, storedBytes);
    for (const row of others) {
      if (bytes <= SESSION_HISTORY_CACHE_LIMITS.totalBytes) break;
      if (row.clearedToken !== null || row.leaseExpiresAt !== null && row.leaseExpiresAt > Date.now()) continue;
      await store.delete([scope.userId, ticket.projectId, row.taskId]); bytes -= row.byteSize;
    }
    if (bytes > SESSION_HISTORY_CACHE_LIMITS.totalBytes) { storedPage = null; storedBytes = 0; }
    await store.put({ ...existing, clearedToken: null, leaseExpiresAt: null, settled: 'saved', page: storedPage, byteSize: storedBytes, lastUsedAt: Date.now() });
    return { saved: true, changed: JSON.stringify(existing.page) !== JSON.stringify(storedPage) };
  }));
  if (!result.saved || !scope.canSaveHistoryAfterUncertain(ticket, taskId, requestToken)) return false;
  scope.clearHistoryUncertain(ticket, taskId, requestToken);
  scope.sessionHistorySettled(ticket, taskId, requestToken, 'saved', signal);
  return true;
};

export const releaseSessionHistoryRefresh = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, token: string, outcome: 'failed' | 'cancelled', signal: AbortSignal): Promise<boolean> => {
  taskId = requestId(taskId); token = requestId(token);
  const released = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest) => {
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return false;
    const valid = validate(row, ticket, manifest);
    if (valid.requestToken !== token || valid.leaseExpiresAt === null) return false;
    await store.put({ ...valid, leaseExpiresAt: null, settled: outcome });
    return true;
  }));
  if (released) scope.sessionHistorySettled(ticket, taskId, token, outcome, signal);
  return released;
};
