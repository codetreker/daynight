import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { normalizeTaskSearchFilters, searchTasks, type TaskSearchFilters, type TaskSearchItem } from '../../api/task-search';
import { pollingInterval } from '../../app/polling';
import type { TaskCacheScope } from '../task-cache/project-cache';
import { taskCacheFailureDiagnostic } from '../task-cache/diagnostics';

type State = {
  readonly draft: string; readonly applied: string | null; readonly filters: TaskSearchFilters;
  readonly items: readonly TaskSearchItem[]; readonly total: number | null; readonly page: number;
  readonly cursors: readonly (string | null)[]; readonly nextCursor: string | null;
  readonly busy: boolean; readonly error: unknown; readonly errorQuery: string | null;
  readonly tagFilterInvalid: boolean;
  readonly serverInvalidRevision: number;
};
const initial = (assignedTo = ''): State => ({ draft: '', applied: null, filters: { status: '', assignedTo, type: 'task', parentId: null, tagIds: [], tagMatch: 'all', untagged: false }, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: false, error: null, errorQuery: null, tagFilterInvalid: false, serverInvalidRevision: 0 });
const invalidTagError = (error: unknown) => error instanceof ApiError && error.code === 'invalid_tag_filter' ? error : new ApiError('server', 400, 'invalid_tag_filter');

export const useTaskSearch = (projectId: string, scope: TaskCacheScope, initialAssignee: string) => {
  const [stored, setStored] = useState<{ projectId: string; scope: TaskCacheScope; state: State }>(() => ({ projectId, scope, state: initial(initialAssignee) }));
  const current = useRef(stored);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const pages = useRef(new Map<number, { ids: readonly string[]; total: number }>());
  const retryPage = useRef<number | null>(null);
  const stoppedOnChange = useRef(false);
  const removedWhileInvalid = useRef(false);
  const assignee = useRef(initialAssignee); assignee.current = initialAssignee;
  if (current.current.projectId !== projectId || current.current.scope !== scope) {
    current.current = { projectId, scope, state: initial(initialAssignee) };
    generation.current++; controller.current?.abort(); controller.current = null; pages.current.clear(); retryPage.current = null; stoppedOnChange.current = false; removedWhileInvalid.current = false;
  }
  const update = useCallback((change: (state: State) => State) => {
    const next = { projectId, scope, state: change(current.current.state) };
    current.current = next; setStored(next);
  }, [projectId, scope]);
  const cancel = useCallback(() => { generation.current++; controller.current?.abort(); controller.current = null; }, []);
  const load = useCallback(async (page: number, automatic = false, recovering = false, revisionRetry = false) => {
    const snapshot = current.current.state;
    if (snapshot.applied === null || snapshot.tagFilterInvalid || scope.isInvalidated || automatic && (controller.current !== null || stoppedOnChange.current) || page < 1 || page > snapshot.cursors.length) return;
    const preserveFailure = automatic && retryPage.current !== null && retryPage.current !== page;
    cancel();
    if (!automatic) { retryPage.current = null; stoppedOnChange.current = false; }
    const local = new AbortController(); controller.current = local;
    const signal = AbortSignal.any([local.signal, scope.signal]);
    const cycleId = crypto.randomUUID(), started = performance.now();
    let requestId: string | null = null;
    const ownGeneration = generation.current, query = snapshot.applied, filters = snapshot.filters, cursor = snapshot.cursors[page - 1]!;
    const stillCurrent = () => !signal.aborted && ownGeneration === generation.current && current.current.projectId === projectId && current.current.scope === scope && !scope.isInvalidated;
    update(state => automatic ? { ...state, busy: false } : { ...state, busy: true, error: null, errorQuery: null });
    try {
      await scope.ready(signal);
      const revision = scope.getProjectRevision(projectId);
      const result = await searchTasks(projectId, query, filters, cursor, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }, { requestId: cycleId, onResponseId: id => { requestId = id; } });
      await scope.ready(signal);
      if (!stillCurrent()) return;
      if (revision !== scope.getProjectRevision(projectId)) {
        pages.current.clear(); retryPage.current = null;
        update(state => ({ ...state, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: !revisionRetry, error: revisionRetry ? new ApiError('protocol') : null, errorQuery: revisionRetry ? query : null }));
        if (!revisionRetry) void load(1, false, recovering, true);
        return;
      }
      if (page > 1) {
        const existing = [...pages.current.entries()].filter(([index]) => index !== page);
        if (existing.some(([, prior]) => prior.total !== result.total || prior.ids.some(id => result.items.some(item => item.id === id)))) throw new ApiError('protocol');
        if (result.nextCursor !== null && snapshot.cursors.slice(0, page).includes(result.nextCursor)) throw new ApiError('protocol');
        const preceding = [...pages.current.entries()].filter(([index]) => index < page);
        const observed = preceding.reduce((sum, [, prior]) => sum + prior.ids.length, result.items.length);
        if (preceding.length !== page - 1 || observed > result.total || (result.nextCursor === null ? observed !== result.total : observed >= result.total)) throw new ApiError('protocol');
      } else if (result.nextCursor === null && result.items.length !== result.total) throw new ApiError('protocol');
      scope.markProjectReadable(projectId);
      console.debug('Task search', { type: 'resource', component: 'task_search', phase: 'read', cycle_id: cycleId, request_id: requestId, project_id: projectId, user_id: scope.userId, duration_ms: performance.now() - started, returned_count: result.items.length, total: result.total });
      if (page === 1) pages.current.clear();
      pages.current.set(page, { ids: result.items.map(item => item.id), total: result.total });
      const cursors = page === 1 ? [null] : snapshot.cursors.slice(0, page);
      if (result.nextCursor !== null) cursors.push(result.nextCursor);
      for (const index of pages.current.keys()) if (index > page) pages.current.delete(index);
      const keepFailure = preserveFailure && retryPage.current !== null && retryPage.current <= cursors.length;
      if (!keepFailure) retryPage.current = null;
      update(state => ({ ...state, items: result.items, total: result.total, page, cursors, nextCursor: result.nextCursor, busy: false,
        error: keepFailure ? state.error : null, errorQuery: keepFailure ? state.errorQuery : null }));
    } catch (error) {
      if (!stillCurrent()) return;
      const safeCodes = new Set(['invalid_input', 'invalid_tag_filter', 'invalid_search_expression', 'search_changed', 'search_timeout', 'not_found', 'unauthenticated', 'forbidden', 'principal_mismatch', 'network', 'protocol']);
      console.warn('Task search failed', { type: 'operation_error', component: 'task_search', phase: 'read', cycle_id: cycleId, request_id: requestId ?? (error instanceof ApiError ? error.requestId : null), project_id: projectId, user_id: scope.userId, duration_ms: performance.now() - started, error_code: error instanceof ApiError && safeCodes.has(error.code) ? error.code : 'unknown', ...taskCacheFailureDiagnostic(error) });
      if (isAbortError(error)) {
        if (!preserveFailure) retryPage.current = page;
        update(state => ({ ...state, busy: false, error: new ApiError('protocol'), errorQuery: query }));
        return;
      }
      if (error instanceof ApiError && error.code === 'invalid_tag_filter' && error.status === 400) {
        pages.current.clear(); retryPage.current = null;
        removedWhileInvalid.current = false;
        update(state => ({ ...state, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: false, error, errorQuery: query, tagFilterInvalid: true, serverInvalidRevision: state.serverInvalidRevision + 1 }));
        return;
      }
      if (error instanceof ApiError && error.code === 'search_changed' && error.status === 409 && !recovering) {
        pages.current.clear(); retryPage.current = null;
        update(state => ({ ...state, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: true, error: null, errorQuery: null }));
        void load(1, false, true); return;
      }
      if (error instanceof ApiError && error.code === 'search_changed' && error.status === 409 && recovering) stoppedOnChange.current = true;
      const denied = error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404 || error.code === 'principal_mismatch');
      if (!denied) {
        try { await scope.ready(signal); } catch { return; }
        if (!stillCurrent()) return;
      }
      retryPage.current = denied ? null : preserveFailure ? retryPage.current : page;
      if (denied) {
        pages.current.clear();
        if (error.status === 404 || error.status === 403) void scope.revalidateProjectAccess(projectId).catch(() => {});
      }
      update(state => ({ ...state, ...(denied ? { items: [], total: null, page: 1, cursors: [null], nextCursor: null } : {}), busy: false, error, errorQuery: query }));
    } finally { if (ownGeneration === generation.current) controller.current = null; }
  }, [projectId, scope, cancel, update]);
  const setDraft = useCallback((draft: string) => {
    if (draft.trim() === '') {
      cancel(); pages.current.clear(); retryPage.current = null; stoppedOnChange.current = false;
      update(state => ({ ...initial(), draft, filters: state.filters, tagFilterInvalid: state.tagFilterInvalid, serverInvalidRevision: state.serverInvalidRevision, error: state.tagFilterInvalid ? invalidTagError(state.error) : null }));
    } else update(state => ({ ...state, draft }));
  }, [cancel, update]);
  const clear = useCallback(() => { cancel(); pages.current.clear(); retryPage.current = null; stoppedOnChange.current = false; update(state => ({ ...initial(), filters: state.filters, tagFilterInvalid: state.tagFilterInvalid, serverInvalidRevision: state.serverInvalidRevision, error: state.tagFilterInvalid ? invalidTagError(state.error) : null })); }, [cancel, update]);
  const submit = useCallback(() => {
    const state = current.current.state;
    if (state.draft.trim() === '') { clear(); return; }
    cancel(); pages.current.clear(); retryPage.current = null;
    update(previous => ({ ...previous, applied: previous.draft, filters: previous.applied === null ? { ...previous.filters, assignedTo: assignee.current } : previous.filters, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: !previous.tagFilterInvalid, error: previous.tagFilterInvalid ? invalidTagError(previous.error) : null, errorQuery: previous.tagFilterInvalid ? previous.draft : null }));
    void load(1);
  }, [cancel, clear, load, update]);
  const setFilters = useCallback((filters: TaskSearchFilters, selectedTagsInvalid?: boolean) => {
    filters = normalizeTaskSearchFilters(filters);
    const previous = current.current.state, old = previous.filters;
    const removed = old.tagIds.some(id => !filters.tagIds.includes(id));
    if (previous.tagFilterInvalid && removed) removedWhileInvalid.current = true;
    const tagFilterInvalid = selectedTagsInvalid === true || previous.tagFilterInvalid && !(removedWhileInvalid.current && selectedTagsInvalid === false);
    if (!tagFilterInvalid) removedWhileInvalid.current = false;
    if (filters.status === old.status && filters.assignedTo === old.assignedTo && filters.type === old.type && filters.parentId === old.parentId && filters.tagMatch === old.tagMatch && filters.untagged === old.untagged && filters.tagIds.length === old.tagIds.length && filters.tagIds.every((id, i) => id === old.tagIds[i]) && tagFilterInvalid === previous.tagFilterInvalid) return;
    cancel(); pages.current.clear(); retryPage.current = null;
    update(state => ({ ...state, filters, tagFilterInvalid, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: state.applied !== null && !tagFilterInvalid, error: tagFilterInvalid ? invalidTagError(state.error) : null, errorQuery: tagFilterInvalid ? state.applied : null }));
    void load(1);
  }, [cancel, load, update]);
  const setTagFilterInvalid = useCallback((invalid: boolean) => {
    if (!invalid || current.current.state.tagFilterInvalid || current.current.state.filters.tagIds.length === 0) return;
    cancel(); pages.current.clear(); retryPage.current = null;
    removedWhileInvalid.current = false;
    update(state => ({ ...state, tagFilterInvalid: true, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: false, error: new ApiError('server', 400, 'invalid_tag_filter'), errorQuery: state.applied }));
  }, [cancel, update]);
  const previous = useCallback(() => { const page = current.current.state.page; if (page > 1) void load(page - 1); }, [load]);
  const next = useCallback(() => { const state = current.current.state; if (state.nextCursor !== null) void load(state.page + 1); }, [load]);
  const retry = useCallback(() => { void load(retryPage.current ?? current.current.state.page); }, [load]);
  useEffect(() => {
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.historyChanged || event.cacheGenerationChanged || event.accessRevoked) {
        cancel(); pages.current.clear(); retryPage.current = null;
        update(state => ({ ...state, items: [], total: null, page: 1, cursors: [null], nextCursor: null, busy: false, error: event.accessRevoked && state.applied !== null ? event.error ?? new ApiError('server', 404, 'not_found') : stoppedOnChange.current || state.tagFilterInvalid ? state.error : null, errorQuery: event.accessRevoked ? state.applied : stoppedOnChange.current || state.tagFilterInvalid ? state.errorQuery : null }));
        if (!event.accessRevoked && !stoppedOnChange.current) void load(1);
      } else if (event.accessRestored && !stoppedOnChange.current && current.current.state.applied !== null) void load(1);
    });
    const retireScope = () => { cancel(); pages.current.clear(); retryPage.current = null; removedWhileInvalid.current = false; update(() => initial(assignee.current)); };
    scope.signal.addEventListener('abort', retireScope, { once: true });
    if (scope.signal.aborted) retireScope();
    let timer: ReturnType<typeof setInterval> | null = null;
    const pause = () => { if (timer !== null) clearInterval(timer); timer = null; };
    const resume = () => { pause(); if (document.visibilityState !== 'hidden') timer = setInterval(() => { void load(current.current.state.page, true); }, pollingInterval('taskSync')); };
    const visibility = () => { resume(); if (document.visibilityState !== 'hidden') void load(current.current.state.page, true); };
    resume(); document.addEventListener('visibilitychange', visibility);
    return () => { pause(); unsubscribe(); scope.signal.removeEventListener('abort', retireScope); document.removeEventListener('visibilitychange', visibility); cancel(); };
  }, [scope, projectId, cancel, load, update]);
  const state = stored.projectId === projectId && stored.scope === scope ? stored.state : initial(initialAssignee);
  return { draft: state.draft, setDraft, applied: state.applied, filters: state.filters, setFilters, setTagFilterInvalid, tagFilterInvalid: state.tagFilterInvalid, serverInvalidRevision: state.serverInvalidRevision, submit, clear,
    page: state.page, pageIndex: state.page, total: state.total, items: state.items, canPrevious: state.page > 1 && !state.busy,
    canNext: state.nextCursor !== null && !state.busy, previous, next, busy: state.busy, error: state.error, errorQuery: state.errorQuery, retry };
};
export type TaskSearchController = ReturnType<typeof useTaskSearch>;
