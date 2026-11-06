import { ApiError, isAbortError, requestId } from '../../api/client';
import { canonicalId } from '../../api/parse';
import { parseSessionHistory, type SessionHistoryItem } from '../../api/terminal-sessions';
import { TaskCacheError, type ProjectRecord, type SessionHistoryRecord } from '../task-cache/database';
import type { SyncTicket, TaskCacheScope } from '../task-cache/project-cache';

export type SessionHistoryPage = { items: SessionHistoryItem[]; nextCursor: string | null };
export type CachedSessionHistory = SessionHistoryPage & { confirmedCompleteEmpty: boolean };
export const SESSION_HISTORY_CACHE_LIMITS = { records: 32, totalBytes: 2 * 1024 * 1024, recordBytes: 256 * 1024 } as const;
export const SESSION_HISTORY_LEASE_MS = 30_000;
const sizeOf = (page: SessionHistoryPage | null): number => page === null ? 0 : new TextEncoder().encode(JSON.stringify(page)).byteLength;

function validate(row: SessionHistoryRecord, ticket: SyncTicket, manifest: ProjectRecord): SessionHistoryRecord {
  try {
    if (row.userId !== ticket.userId || row.projectId !== ticket.projectId || canonicalId(row.taskId) !== row.taskId ||
      row.userFence !== manifest.userFence || row.cacheGeneration !== manifest.cacheGeneration || canonicalId(row.requestToken) !== row.requestToken ||
      (row.clearedToken !== null && (typeof row.clearedToken !== 'string' || canonicalId(row.clearedToken) !== row.clearedToken || row.page !== null)) ||
      (row.leaseExpiresAt !== null && (!Number.isSafeInteger(row.leaseExpiresAt) || row.leaseExpiresAt < 0)) ||
      (row.settled !== null && row.settled !== 'saved' && row.settled !== 'failed' && row.settled !== 'cancelled') ||
      (row.leaseExpiresAt !== null && row.settled !== null) ||
      (row.paginationToken !== null && (typeof row.paginationToken !== 'string' || canonicalId(row.paginationToken) !== row.paginationToken)) ||
      typeof row.confirmedCompleteEmpty !== 'boolean' || typeof row.observedNonEmpty !== 'boolean' || row.confirmedCompleteEmpty && row.observedNonEmpty ||
      !Number.isSafeInteger(row.lastUsedAt) || row.lastUsedAt < 0 || !Number.isSafeInteger(row.byteSize) || row.byteSize < 0) throw new Error('Invalid session history ownership.');
    const page = row.page === null ? null : parseSessionHistory(row.page);
    if (row.confirmedCompleteEmpty && (page === null || page.items.length !== 0 || page.nextCursor === null)) throw new Error('Invalid complete empty history proof.');
    if (row.observedNonEmpty && (page === null || page.items.length !== 0 || page.nextCursor === null)) throw new Error('Invalid non-empty history observation.');
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
  const read = () => recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    return row === undefined || !summaries.has(taskId) ? null : validate(row, ticket, manifest);
  }));
  const same = (left: SessionHistoryRecord, right: SessionHistoryRecord | null): boolean => right !== null &&
    left.requestToken === right.requestToken && left.paginationToken === right.paginationToken && left.clearedToken === right.clearedToken &&
    left.leaseExpiresAt === right.leaseExpiresAt && left.settled === right.settled && left.confirmedCompleteEmpty === right.confirmedCompleteEmpty &&
    left.observedNonEmpty === right.observedNonEmpty && left.byteSize === right.byteSize && JSON.stringify(left.page) === JSON.stringify(right.page);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (scope.isHistoryUncertain(ticket, taskId)) return null;
    const cached = await read();
    if (cached === null || cached.page === null) return null;
    let unchanged: boolean;
    try {
      unchanged = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest) => {
        const row = await store.get([scope.userId, ticket.projectId, taskId]);
        const valid = row === undefined ? null : validate(row, ticket, manifest);
        if (!same(cached, valid)) return false;
        await store.put({ ...valid!, lastUsedAt: Date.now() });
        return true;
      }));
    } catch (error) {
      if (!(error instanceof TaskCacheError) || error.category === 'corrupt') throw error;
      unchanged = same(cached, await read());
    }
    if (unchanged) return scope.isHistoryUncertain(ticket, taskId) ? null : { ...cached.page, confirmedCompleteEmpty: cached.confirmedCompleteEmpty };
  }
  throw new TaskCacheError('storage');
};

export const getSessionHistoryToken = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<string | null> => {
  taskId = requestId(taskId);
  return recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return null;
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    return row === undefined ? null : validate(row, ticket, manifest).requestToken;
  }));
};

export type SessionHistoryOwnership =
  | { kind: 'present'; token: string; paginationToken: string | null; leaseExpiresAt: number | null; refreshing: boolean; cleared: boolean; uncertain: boolean }
  | { kind: 'absent' | 'task_absent'; uncertain: boolean };

// Metadata remains usable for fencing an authenticated denial while an uncertain
// directory is withheld. It never grants access to the cached page.
export const readSessionHistoryOwnership = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<SessionHistoryOwnership> => {
  taskId = requestId(taskId);
  const result = await scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return { kind: 'task_absent' as const };
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return { kind: 'absent' as const };
    try {
      if (row.userId !== scope.userId || row.projectId !== ticket.projectId || row.taskId !== taskId ||
        row.userFence !== manifest.userFence || row.cacheGeneration !== manifest.cacheGeneration ||
        typeof row.requestToken !== 'string' || canonicalId(row.requestToken) !== row.requestToken ||
        row.paginationToken !== null && (typeof row.paginationToken !== 'string' || canonicalId(row.paginationToken) !== row.paginationToken) ||
        row.clearedToken !== null && (typeof row.clearedToken !== 'string' || canonicalId(row.clearedToken) !== row.clearedToken) ||
        row.leaseExpiresAt !== null && (!Number.isSafeInteger(row.leaseExpiresAt) || row.leaseExpiresAt < 0)) throw new Error('Invalid session history ownership.');
      return { kind: 'present' as const, token: row.requestToken, paginationToken: row.paginationToken, leaseExpiresAt: row.leaseExpiresAt,
        refreshing: row.leaseExpiresAt !== null && row.leaseExpiresAt > Date.now(), cleared: row.clearedToken !== null };
    } catch (error) { throw new TaskCacheError('corrupt', error); }
  });
  return { ...result, uncertain: scope.isHistoryUncertain(ticket, taskId) };
};

export type SessionHistoryPaginationState = { token: string; paginationToken: string | null; refreshing: boolean; leaseExpiresAt: number | null; page: SessionHistoryPage | null; confirmedCompleteEmpty: boolean };
export const readSessionHistoryPaginationState = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<SessionHistoryPaginationState | null> => {
  taskId = requestId(taskId);
  if (scope.isHistoryUncertain(ticket, taskId)) return null;
  const state = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return null;
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return null;
    const valid = validate(row, ticket, manifest);
    return { token: valid.requestToken, paginationToken: valid.paginationToken, refreshing: valid.leaseExpiresAt !== null && valid.leaseExpiresAt > Date.now(), leaseExpiresAt: valid.leaseExpiresAt, page: valid.page, confirmedCompleteEmpty: valid.confirmedCompleteEmpty };
  }));
  return scope.isHistoryUncertain(ticket, taskId) ? null : state;
};

export const beginSessionHistoryPagination = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, signal: AbortSignal): Promise<SessionHistoryPaginationState | null> => {
  taskId = requestId(taskId);
  if (scope.isHistoryUncertain(ticket, taskId)) return null;
  const state = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return null;
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return null;
    const valid = validate(row, ticket, manifest);
    if (valid.leaseExpiresAt !== null || valid.page === null) return { token: valid.requestToken, paginationToken: valid.paginationToken, refreshing: true, leaseExpiresAt: valid.leaseExpiresAt, page: valid.page, confirmedCompleteEmpty: valid.confirmedCompleteEmpty };
    const paginationToken = crypto.randomUUID();
    await store.put({ ...valid, paginationToken });
    return { token: valid.requestToken, paginationToken, refreshing: false, leaseExpiresAt: null, page: valid.page, confirmedCompleteEmpty: valid.confirmedCompleteEmpty };
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
      leaseExpiresAt, settled: null, paginationToken: null, page: existing?.page ?? null, confirmedCompleteEmpty: existing?.confirmedCompleteEmpty ?? false, observedNonEmpty: existing?.observedNonEmpty ?? false,
      byteSize: existing?.byteSize ?? 0, lastUsedAt: now });
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
export const clearSessionHistory = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, expectedToken: string | null, signal: AbortSignal, expectedPaginationToken?: string | null, expectedLeaseExpiresAt?: number | null, origin?: symbol): Promise<boolean> => {
  taskId = requestId(taskId);
  if (expectedToken !== null) expectedToken = requestId(expectedToken);
  if (expectedPaginationToken !== undefined && expectedPaginationToken !== null) expectedPaginationToken = requestId(expectedPaginationToken);
  if (expectedLeaseExpiresAt !== undefined && expectedLeaseExpiresAt !== null && (!Number.isSafeInteger(expectedLeaseExpiresAt) || expectedLeaseExpiresAt < 0)) throw new ApiError('protocol');
  let clearedToken: { kind: 'stale' } | { kind: 'overflow' } | { kind: 'cleared'; marker: string };
  try { clearedToken = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest) => {
    const rows = (await store.index('by-project').getAll([scope.userId, ticket.projectId])).map(row => validate(row, ticket, manifest));
    if (rows.length > SESSION_HISTORY_CACHE_LIMITS.records || rows.reduce((sum, row) => sum + row.byteSize, 0) > SESSION_HISTORY_CACHE_LIMITS.totalBytes) throw new TaskCacheError('corrupt');
    const existing = rows.find(row => row.taskId === taskId);
    if ((existing?.requestToken ?? null) !== expectedToken || expectedPaginationToken !== undefined && (existing?.paginationToken ?? null) !== expectedPaginationToken ||
      (expectedLeaseExpiresAt !== undefined ? (existing?.leaseExpiresAt ?? null) !== expectedLeaseExpiresAt :
        existing?.leaseExpiresAt !== null && existing?.leaseExpiresAt !== undefined && existing.leaseExpiresAt <= Date.now())) return { kind: 'stale' as const };
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
      leaseExpiresAt: null, settled: 'cancelled', paginationToken: null, page: null, confirmedCompleteEmpty: false, observedNonEmpty: false, byteSize: 0, lastUsedAt: Date.now() });
    return { kind: 'cleared' as const, marker };
  })); }
  catch (error) {
    if (!isAbortError(error)) {
      try { if (!await scope.reportHistoryUncertain(ticket, taskId, expectedToken, signal, false, expectedPaginationToken, expectedLeaseExpiresAt, origin)) return false; }
      catch { /* The original storage error remains the actionable failure. */ }
    }
    throw error;
  }
  if (clearedToken.kind === 'stale') return false;
  if (clearedToken.kind === 'overflow') {
    try {
      return await scope.rotateSessionHistoryGeneration(ticket, SESSION_HISTORY_CACHE_LIMITS.records, signal, {
        taskId, expectedToken, marker: crypto.randomUUID(), requestToken: crypto.randomUUID(),
        ...(expectedPaginationToken === undefined ? {} : { expectedPaginationToken }),
        ...(expectedLeaseExpiresAt === undefined ? {} : { expectedLeaseExpiresAt }),
        ...(origin === undefined ? {} : { origin }),
      });
    }
    catch (error) {
      if (!isAbortError(error)) {
        try { if (!await scope.reportHistoryUncertain(ticket, taskId, expectedToken, signal, false, expectedPaginationToken, expectedLeaseExpiresAt, origin)) return false; }
        catch { /* The original storage error remains the actionable failure. */ }
      }
      throw error;
    }
  }
  scope.sessionHistoryCleared(ticket, taskId, clearedToken.marker, signal, origin);
  return true;
};

export const saveSessionHistory = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, page: SessionHistoryPage, requestToken: string, signal: AbortSignal, confirmedCompleteEmpty?: boolean): Promise<boolean> => {
  taskId = requestId(taskId); requestToken = requestId(requestToken);
  const parsed = parseSessionHistory(page); const byteSize = sizeOf(parsed);
  if (confirmedCompleteEmpty === true && (parsed.items.length !== 0 || parsed.nextCursor === null)) throw new ApiError('protocol');
  const result = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId)) return { saved: false, changed: false };
    const rows = (await store.index('by-project').getAll([scope.userId, ticket.projectId])).map(row => validate(row, ticket, manifest));
    if (rows.length > SESSION_HISTORY_CACHE_LIMITS.records || rows.reduce((sum, row) => sum + row.byteSize, 0) > SESSION_HISTORY_CACHE_LIMITS.totalBytes) throw new TaskCacheError('corrupt');
    const existing = rows.find(row => row.taskId === taskId);
    if (existing === undefined || existing.requestToken !== requestToken || existing.leaseExpiresAt === null || existing.leaseExpiresAt <= Date.now() ||
      !scope.canSaveHistoryAfterUncertain(ticket, taskId, requestToken)) return { saved: false, changed: false };
    let storedPage: SessionHistoryPage | null = byteSize <= SESSION_HISTORY_CACHE_LIMITS.recordBytes ? parsed : null;
    let storedBytes = storedPage === null ? 0 : byteSize;
    const others = rows.filter(row => row.taskId !== taskId).sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.taskId.localeCompare(b.taskId));
    let bytes = others.reduce((sum, row) => sum + row.byteSize, storedBytes);
    for (const row of others) {
      if (bytes <= SESSION_HISTORY_CACHE_LIMITS.totalBytes) break;
      if (row.clearedToken !== null || row.leaseExpiresAt !== null && row.leaseExpiresAt > Date.now()) continue;
      await store.delete([scope.userId, ticket.projectId, row.taskId]); bytes -= row.byteSize;
    }
    if (bytes > SESSION_HISTORY_CACHE_LIMITS.totalBytes) { storedPage = null; storedBytes = 0; }
    const emptyProof = storedPage !== null && (confirmedCompleteEmpty ?? (JSON.stringify(existing.page) === JSON.stringify(storedPage) && existing.confirmedCompleteEmpty));
    const observedNonEmpty = storedPage !== null && confirmedCompleteEmpty === false && storedPage.items.length === 0 && storedPage.nextCursor !== null;
    await store.put({ ...existing, clearedToken: null, leaseExpiresAt: null, settled: 'saved', page: storedPage, confirmedCompleteEmpty: emptyProof, observedNonEmpty, byteSize: storedBytes, lastUsedAt: Date.now() });
    return { saved: true, changed: JSON.stringify(existing.page) !== JSON.stringify(storedPage) };
  }));
  if (!result.saved || !scope.canSaveHistoryAfterUncertain(ticket, taskId, requestToken)) return false;
  scope.clearHistoryUncertain(ticket, taskId, requestToken);
  scope.sessionHistorySettled(ticket, taskId, requestToken, 'saved', signal);
  return true;
};

export const completeSessionHistoryPagination = async (scope: TaskCacheScope, ticket: SyncTicket, taskId: string, firstPage: SessionHistoryPage, token: string, paginationToken: string, completeEmpty: boolean | null, signal: AbortSignal): Promise<boolean> => {
  taskId = requestId(taskId); token = requestId(token); paginationToken = requestId(paginationToken);
  const parsed = parseSessionHistory(firstPage);
  if (completeEmpty && (parsed.items.length !== 0 || parsed.nextCursor === null)) throw new ApiError('protocol');
  const result = await recover(scope, ticket, signal, () => scope.sessionHistoryTransaction(ticket, signal, async (store, manifest, summaries) => {
    if (!summaries.has(taskId) || !scope.canSaveHistoryAfterUncertain(ticket, taskId, token)) return { saved: false, changed: false };
    const row = await store.get([scope.userId, ticket.projectId, taskId]);
    if (row === undefined) return { saved: false, changed: false };
    const valid = validate(row, ticket, manifest);
    if (valid.requestToken !== token || valid.paginationToken !== paginationToken || valid.leaseExpiresAt !== null || JSON.stringify(valid.page) !== JSON.stringify(parsed)) return { saved: false, changed: false };
    if (completeEmpty && valid.observedNonEmpty) return { saved: false, changed: false };
    const confirmedCompleteEmpty = completeEmpty ?? valid.confirmedCompleteEmpty;
    const observedNonEmpty = completeEmpty === null ? valid.observedNonEmpty : !completeEmpty && parsed.items.length === 0 && parsed.nextCursor !== null;
    const changed = valid.confirmedCompleteEmpty !== confirmedCompleteEmpty || valid.observedNonEmpty !== observedNonEmpty;
    await store.put({ ...valid, paginationToken: crypto.randomUUID(), confirmedCompleteEmpty, observedNonEmpty, settled: 'saved' });
    return { saved: true, changed };
  }));
  if (result.changed) scope.sessionHistorySettled(ticket, taskId, token, 'saved', signal);
  return result.saved;
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
