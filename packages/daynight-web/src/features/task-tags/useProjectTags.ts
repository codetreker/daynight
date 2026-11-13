import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, isAbortError } from "../../api/client";
import { listProjectTags, type ProjectTagPage } from "../../api/task-tags";
import { useProjectAccessSession } from "../projects/ProjectAccess";
import { useTaskCacheScope } from "../task-cache/TaskCacheProvider";

type State = {
  readonly scope: object; readonly projectId: string; readonly query: string; readonly cursor: string | null;
  readonly page: ProjectTagPage | null; readonly loading: boolean; readonly refreshing: boolean; readonly error: unknown;
};
const initial = (scope: object, projectId: string, query = ""): State => ({ scope, projectId, query, cursor: null, page: null, loading: true, refreshing: false, error: null });

export const useProjectTags = (projectId: string, active = true) => {
  const scope = useTaskCacheScope();
  const access = useProjectAccessSession(projectId);
  const [state, setState] = useState<State>(() => initial(scope, projectId));
  const stateRef = useRef(state); stateRef.current = state;
  const generation = useRef(0);
  const revoked = useRef<"catalog" | "access" | null>(null);
  const controller = useRef<AbortController | null>(null);
  const request = useCallback(async (query: string, cursor: string | null, background = false) => {
    if (revoked.current) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const signal = AbortSignal.any([current.signal, scope.signal]);
    const ticket = ++generation.current;
    const prior = stateRef.current;
    const recheckCursor = background && prior.scope === scope && prior.projectId === projectId && prior.query === query ? prior.cursor : null;
    setState(previous => {
      const same = previous.scope === scope && previous.projectId === projectId && previous.query === query;
      const page = same ? previous.page : null;
      return { scope, projectId, query, cursor: same ? previous.cursor : null, page, loading: page === null, refreshing: page !== null && !background, error: null };
    });
    try {
      await scope.ready(signal);
      let page = await listProjectTags(projectId, { query, cursor, limit: 50 }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      let resultCursor = cursor;
      if (background && recheckCursor !== null && prior.page?.catalogEpoch === page.catalogEpoch) {
        try {
          const currentPage = await listProjectTags(projectId, { query, cursor: recheckCursor, limit: 50 }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
          if (currentPage.catalogEpoch !== page.catalogEpoch) { if (!signal.aborted && ticket === generation.current) void request(query, null); return; }
          page = currentPage; resultCursor = recheckCursor;
        } catch (error) {
          if (error instanceof ApiError && error.code === "catalog_changed") { if (!signal.aborted && ticket === generation.current) void request(query, null); return; }
          throw error;
        }
      }
      await scope.ready(signal);
      if (signal.aborted || ticket !== generation.current || scope.isInvalidated) return;
      setState(previous => {
        if (previous.scope !== scope || previous.projectId !== projectId || previous.query !== query) return previous;
        return { ...previous, cursor: resultCursor, page, loading: false, refreshing: false, error: null };
      });
    } catch (error) {
      if (signal.aborted || ticket !== generation.current || scope.isInvalidated || isAbortError(error)) return;
      if (cursor !== null && error instanceof ApiError && error.code === "catalog_changed") {
        void request(query, null); return;
      }
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        revoked.current = "catalog";
        // A successful access check permits an explicit retry. It does not
        // prove this catalog request succeeded or justify replaying it.
        void access?.revalidateAfterMutation(true).then(result => {
          if (result !== null && !signal.aborted && ticket === generation.current && !scope.isInvalidated && revoked.current === "catalog") revoked.current = null;
        }).catch(() => {});
        setState({ ...initial(scope, projectId, query), loading: false, error });
        return;
      }
      setState(previous => previous.scope === scope && previous.projectId === projectId && previous.query === query ? { ...previous, loading: false, refreshing: false, error } : previous);
    } finally { if (ticket === generation.current) controller.current = null; }
  }, [scope, projectId, access]);
  const retryAccess = useCallback(async () => {
    if (!active || revoked.current === null || access === null) return;
    const reason = revoked.current;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    const signal = AbortSignal.any([current.signal, scope.signal]);
    const ticket = ++generation.current;
    const query = stateRef.current.query;
    setState(previous => previous.scope === scope && previous.projectId === projectId ? { ...previous, loading: true } : previous);
    try {
      await scope.ready(signal);
      const result = await access.revalidateAfterMutation(true);
      await scope.ready(signal);
      if (signal.aborted || ticket !== generation.current || scope.isInvalidated || revoked.current !== reason) return;
      if (result === null || scope.isProjectSuspended(projectId)) {
        setState(previous => previous.scope === scope && previous.projectId === projectId ? { ...previous, loading: false, error: access.snapshot().error ?? previous.error } : previous);
        return;
      }
      revoked.current = null;
      void request(query, null);
    } catch (error) {
      if (signal.aborted || ticket !== generation.current || scope.isInvalidated || isAbortError(error)) return;
      setState(previous => previous.scope === scope && previous.projectId === projectId ? { ...previous, loading: false, error } : previous);
    } finally { if (ticket === generation.current) controller.current = null; }
  }, [active, access, scope, projectId, request]);
  useEffect(() => {
    const previous = stateRef.current;
    const same = previous.scope === scope && previous.projectId === projectId;
    if (!same) { revoked.current = null; setState(initial(scope, projectId)); }
    if (active && !revoked.current) void request(same ? previous.query : "", null, same && previous.page !== null);
    else if (!active && same && previous.loading) setState(current => ({ ...current, loading: false }));
    const unsubscribe = scope.subscribe(event => {
      if (event.projectId !== projectId) return;
      if (event.accessRevoked || event.directAccessUncertain || event.historyChanged) {
        revoked.current = event.accessRevoked || event.directAccessUncertain ? "access" : null;
        ++generation.current; controller.current?.abort(); controller.current = null;
        setState({ ...initial(scope, projectId, stateRef.current.query), ...(revoked.current === null ? {} : { loading: false, error: event.error ?? new ApiError("server", 404, "not_found") }) });
        if (active && event.historyChanged && !event.accessRevoked && !event.directAccessUncertain) void request(stateRef.current.query, null);
      } else if (event.accessRestored) { revoked.current = null; if (active) void request(stateRef.current.query, null); }
    });
    const refreshVisible = () => { if (active && document.visibilityState === "visible") void request(stateRef.current.query, null, true); };
    const timer = active ? setInterval(refreshVisible, 30_000) : null;
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    return () => { ++generation.current; controller.current?.abort(); controller.current = null; unsubscribe(); if (timer !== null) clearInterval(timer); document.removeEventListener("visibilitychange", refreshVisible); window.removeEventListener("focus", refreshVisible); };
  }, [active, projectId, scope, request]);
  const visible = state.scope === scope && state.projectId === projectId ? state : initial(scope, projectId);
  const setQuery = useCallback((query: string) => { if (active) void request(query, null); }, [active, request]);
  const refresh = useCallback(() => { if (active) { if (revoked.current !== null) void retryAccess(); else void request(stateRef.current.query, null); } }, [active, request, retryAccess]);
  const first = refresh;
  const next = useCallback(() => { const current = stateRef.current; if (active && current.page?.nextCursor != null) void request(current.query, current.page.nextCursor); }, [active, request]);
  return { page: visible.page, cursor: visible.cursor, query: visible.query, loading: visible.loading, refreshing: visible.refreshing, error: visible.error, setQuery, refresh, first, next };
};
