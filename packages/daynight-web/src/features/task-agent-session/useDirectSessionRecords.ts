import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, authRequestsPauseRevision, isAbortError } from '../../api/client';
import { createTerminalSessionApi, SessionDenialProtocolError, type SessionHistoryItem } from '../../api/terminal-sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskDetailSessions, type DirectQualification } from '../task-detail/TaskDetailSession';
import { isRetryableTaskCacheLifecycleChange, type SyncTicket } from '../task-cache/project-cache';
import { clearSessionHistory, readSessionHistoryOwnership, type SessionHistoryOwnership } from './session-history-cache';

type Page = { readonly items: SessionHistoryItem[]; readonly cursor: string | null };
type State = { readonly page: Page | null; readonly error: unknown; readonly loading: boolean; readonly checking: boolean; readonly denied: boolean };
const initial = (): State => ({ page: null, error: null, loading: false, checking: true, denied: false });

// Direct detail receipts authorize only this opening. Session records obtained
// under them are never installed in the project-summary cache.
export function useDirectSessionRecords(projectId: string, taskId: string, active: boolean, automatic = false) {
  const scope = useTaskCacheScope();
  const sessions = useTaskDetailSessions();
  const api = useMemo(() => createTerminalSessionApi(projectId, taskId, scope.userId, scope.principalMismatch), [projectId, taskId, scope]);
  const subscribe = useCallback((listener: () => void) => sessions.subscribe(projectId, taskId, listener), [sessions, projectId, taskId]);
  const snapshot = useCallback(() => sessions.snapshot(projectId, taskId), [sessions, projectId, taskId]);
  const detail = useSyncExternalStore(subscribe, snapshot);
  const [state, setState] = useState<State>(initial);
  const [request, setRequest] = useState<{ cursor: string | null; sequence: number }>({ cursor: null, sequence: 0 });
  const [retryInactive, setRetryInactive] = useState(false);
  const qualificationRef = useRef<DirectQualification | null>(null);
  if (qualificationRef.current === null || !sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualificationRef.current)) {
    qualificationRef.current = sessions.captureDirectSessionQualification(projectId, taskId);
  }
  const qualification = qualificationRef.current;
  const readReady = sessions.captureDirectSessionQualification(projectId, taskId) !== null;
  const blocked = useRef(false);
  const directAccessPending = useRef<'uncertain' | 'failed' | null>(null);
  const denialOrigin = useRef(Symbol('direct-session-records'));
  const activeRead = useRef<AbortController | null>(null);

  // Remain subscribed while a tab is hidden: a peer's negative observation must
  // withdraw its retained page before the tab can be shown again.
  useEffect(() => scope.subscribe(event => {
    if (event.projectId !== projectId || event.sessionHistoryUncertain?.origin === denialOrigin.current || event.sessionHistoryCleared?.origin === denialOrigin.current ||
      blocked.current && (event.sessionHistoryUncertain?.taskId === taskId || event.sessionHistoryCleared?.taskId === taskId)) return;
    if (event.directAccessUncertain) {
      activeRead.current?.abort(); setRetryInactive(false); blocked.current = true; directAccessPending.current = 'uncertain';
      setRequest(old => ({ cursor: null, sequence: old.sequence + 1 }));
      setState({ page: null, error: event.error ?? null, loading: false, checking: false, denied: true });
      return;
    }
    if (event.directAccessRecheck) {
      activeRead.current?.abort();
      directAccessPending.current = event.error !== undefined ? 'failed' : null;
      blocked.current = event.error !== undefined;
      setRequest(old => ({ cursor: null, sequence: old.sequence + 1 }));
      // Keep selection withdrawn until a new first page is actually admitted,
      // even when the uncertainty and recheck are batched in one render.
      setState({ page: null, error: event.error ?? null, loading: false, checking: event.error === undefined, denied: true });
      return;
    }
    if (event.accessRevoked || event.scopeSuspended || event.historyChanged || event.sessionHistoryUncertain?.taskId === taskId || event.sessionHistoryCleared?.taskId === taskId) {
      activeRead.current?.abort();
      setRetryInactive(false);
      if (event.historyChanged || event.accessRevoked && !event.scopeSuspended) {
        // A confirmed withdrawal or retired history ends the old uncertainty,
        // but the replacement must still obtain a fresh direct receipt.
        directAccessPending.current = 'failed';
        blocked.current = true;
        setRequest(old => ({ cursor: null, sequence: old.sequence + 1 }));
      } else blocked.current = true;
      setState({ page: null, error: event.error ?? null, loading: false, checking: false, denied: true });
    } else if (event.accessRestored) {
      blocked.current = directAccessPending.current !== null;
      setRequest(old => ({ cursor: null, sequence: old.sequence + 1 }));
    }
  }), [scope, projectId, taskId]);

  useEffect(() => {
    // A fresh Task observation can recover a failed access check, withdrawal,
    // or retired history. The prior opening was retired, and its page discarded.
    if (directAccessPending.current !== 'failed' || qualification === null || !readReady) return;
    directAccessPending.current = null;
    blocked.current = false;
  }, [qualification, readReady]);

  useEffect(() => {
    if ((!active && !retryInactive) || qualification === null || !readReady || blocked.current) return;
    const controller = new AbortController(); activeRead.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    const current = () => !signal.aborted && sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification);
    setState(old => ({ ...old, error: null, loading: true, checking: false }));
    void (async () => {
      let historyTicket: SyncTicket | null = null;
      let manifestAbsent = false;
      let historyOwner: SessionHistoryOwnership | null = null;
      try {
        await scope.ready(signal);
        if (!current()) return;
        const fresh = sessions.captureDirectSessionQualification(projectId, taskId);
        if (fresh === null) return;
        // A captured matching manifest fences the negative hint; it never grants
        // direct reads and its absence or failure does not block the network.
        try {
          historyTicket = await sessions.captureDirectSessionHistoryTicket(projectId, taskId, fresh, signal);
          manifestAbsent = historyTicket === null;
          if (historyTicket !== null) historyOwner = await readSessionHistoryOwnership(scope, historyTicket, taskId, signal);
        } catch {
          if (signal.aborted || !current()) return;
          historyTicket = null; historyOwner = null; manifestAbsent = false;
          await scope.ready(signal);
        }
        if (!current()) return;
        let result = await api.history(request.cursor, signal);
        if (automatic && request.cursor === null) {
          const visited = new Set<string>();
          while (result.items.length === 0 && result.nextCursor !== null) {
            if (visited.has(result.nextCursor)) throw new ApiError('protocol');
            visited.add(result.nextCursor);
            await scope.ready(signal);
            if (!current()) return;
            result = await api.history(result.nextCursor, signal);
          }
        }
        // A same-account pause may interrupt the fence transaction after the
        // network result arrives. Retry admission, never the history request.
        for (;;) {
          const pauseRevision = authRequestsPauseRevision();
          try {
            await scope.ready(signal);
            const verified = await sessions.verifyDirectQualificationHistory(projectId, taskId, qualification, signal);
            if (pauseRevision !== authRequestsPauseRevision() && current()) continue;
            if (!verified || !current()) return;
            setState(old => {
              const previous = request.cursor === null ? [] : old.page?.items ?? [];
              const items = [...previous, ...result.items.filter(item => !previous.some(existing => existing.sessionId === item.sessionId))];
              return { page: { items, cursor: result.nextCursor }, error: null, loading: false, checking: false, denied: false };
            });
            break;
          } catch (error) {
            if (isRetryableTaskCacheLifecycleChange(error) && pauseRevision !== authRequestsPauseRevision() && current()) continue;
            throw error;
          }
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) return;
        const denied = error instanceof ApiError && (error.kind === 'server' || error instanceof SessionDenialProtocolError) && [401, 403, 404, 410].includes(error.status ?? 0);
        if (denied) { if (!current()) return; }
        else {
          try { await scope.ready(signal); } catch { return; }
          if (!current()) return;
        }
        if (denied) blocked.current = true;
        setState(old => ({ ...old, page: denied ? null : old.page, error, loading: false, checking: false, denied }));
        if (denied) {
          let broadcast = historyTicket === null || historyOwner === null;
          // Without a captured owner there is no newer token to compare; the
          // epoch-bound negative hint can retire peers even during identity checks.
          let broadcasted = false;
          if (broadcast) broadcasted = sessions.reportDirectHistoryDenied(projectId, taskId, qualification, manifestAbsent, denialOrigin.current);
          try {
            if (historyTicket !== null && historyOwner === null) {
              await scope.reportHistoryUncertain(historyTicket, taskId, null, scope.signal, true, undefined, undefined, denialOrigin.current);
            } else if (historyTicket !== null) {
              const observed = historyOwner?.kind === 'present' ? historyOwner : null;
              await clearSessionHistory(scope, historyTicket, taskId, observed?.token ?? null, scope.signal,
                observed?.paginationToken ?? null, observed?.leaseExpiresAt ?? null, denialOrigin.current);
              // The durable marker has its own token-checked peer notification.
              broadcast = false;
            }
          } catch (failure) { broadcast = !isAbortError(failure); }
          try {
            if (broadcast && !broadcasted) sessions.reportDirectHistoryDenied(projectId, taskId, qualification, manifestAbsent, denialOrigin.current);
          } catch { /* Identity retirement or a new history fences this denial. */ }
        }
      }
    })().finally(() => { if (!signal.aborted) setRetryInactive(false); });
    return () => { controller.abort(); if (activeRead.current === controller) activeRead.current = null; };
  }, [scope, sessions, api, projectId, taskId, active, retryInactive, automatic, qualification, readReady, request]);
  const denied = scope.isInvalidated || scope.isProjectSuspended(projectId) || detail.detail === null || detail.status === 'deleted' || state.denied;
  const page = denied ? null : state.page;
  return { api, scope, items: page?.items ?? [], cursor: page?.cursor ?? null, error: state.error,
    loading: state.loading, checking: state.checking, confirmedEmpty: page !== null && page.items.length === 0 && page.cursor === null,
    denied, refresh: () => { if (directAccessPending.current !== null) return; blocked.current = false; if (!active) setRetryInactive(true); setRequest(old => ({ cursor: null, sequence: old.sequence + 1 })); },
    more: () => { if (page?.cursor) setRequest(old => ({ cursor: page.cursor, sequence: old.sequence + 1 })); } };
}
