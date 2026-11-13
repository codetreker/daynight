import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError, readAuthRequestGeneration, waitForAuthRequests } from '../../api/client';
import { getGitHubStatus, getPullRequests, type GitHubStatus, type PullRequestPage, type PullRequestState } from './api';

export type PullRequestsOptions = {
  readonly userId: string; readonly projectId: string; readonly canRead: boolean; readonly active: boolean;
  readonly onPrincipalMismatch: () => void; readonly onAccessError?: ((error: ApiError) => void) | undefined;
};
type Snapshot = {
  readonly status: GitHubStatus | null; readonly page: PullRequestPage | null;
  readonly statusError: ApiError | null; readonly error: ApiError | null; readonly loading: boolean;
  readonly filter: PullRequestState; readonly query: string; readonly pageNumber: number;
  readonly hasUpdates: boolean; readonly refreshKey: number;
};
const empty = (): Snapshot => ({ status: null, page: null, statusError: null, error: null, loading: false, filter: 'active', query: '', pageNumber: 1, hasUpdates: false, refreshKey: 0 });
const MAX_NUMBER = 9_223_372_036_854_775_807n;
const firstPageCursor = (projectId: string, filter: PullRequestState, query: string, upper: string): string | null => {
  if (BigInt(upper) === MAX_NUMBER) return null;
  const json = JSON.stringify({ v: 1, projectId, state: filter, q: query, limit: 6, upperNumber: upper, anchorNumber: String(BigInt(upper) + 1n), direction: 'next' });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** Keeps one authorized Project's cursor workspace in memory while its tab is hidden. */
export const usePullRequests = (options: PullRequestsOptions) => {
  const { userId, projectId, canRead, active } = options;
  const key = JSON.stringify([userId, projectId]);
  const session = useMemo(() => ({ key, snapshot: empty(), cursor: null as string | null, targetPage: 1, upper: null as string | null, initialized: false, generation: 0, pending: null as AbortController | null }), [key]);
  const [, render] = useState(0);
  const current = useRef(options); current.current = options;
  const currentKey = useRef(key); currentKey.current = key;
  const permitted = useCallback(() => currentKey.current === key && current.current.canRead && current.current.active && document.visibilityState !== 'hidden', [key]);
  const publish = useCallback((snapshot: Snapshot) => { session.snapshot = snapshot; render(value => value + 1); }, [session]);
  const cancel = useCallback(() => { session.generation += 1; session.pending?.abort(); session.pending = null; }, [session]);

  const run = useCallback((replace: boolean) => {
    if (!permitted() || !replace && session.pending !== null) return;
    if (replace) cancel();
    const controller = new AbortController(), generation = ++session.generation, authGeneration = readAuthRequestGeneration();
    session.pending = controller;
    const admitted = () => permitted() && session.generation === generation;
    const initial = session.snapshot, initialized = session.initialized, upper = session.upper, cursor = session.cursor, targetPage = session.targetPage;
    publish({ ...initial, loading: true, error: null, statusError: null });
    let recoverAuth = false;
    const accept = async () => {
      await waitForAuthRequests(controller.signal);
      if (!admitted()) return false;
      if (authGeneration !== readAuthRequestGeneration()) { session.initialized = false; session.upper = null; session.cursor = null; session.targetPage = 1; publish(empty()); return false; }
      return true;
    };
    const load = async <T,>(read: (signal: AbortSignal, onDispatch: () => void) => Promise<T>, apply: (value: T) => void, failure: 'error' | 'statusError') => {
      const request = new AbortController(), signal = AbortSignal.any([controller.signal, request.signal]);
      let timeout: ReturnType<typeof setTimeout> | undefined, timedOut = false;
      try {
        const value = await read(signal, () => { timeout = setTimeout(() => { timedOut = true; request.abort(); }, 30_000); });
        if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined; }
        if (await accept() && admitted()) apply(value);
      } catch (cause: unknown) {
        if (timeout !== undefined) { clearTimeout(timeout); timeout = undefined; }
        if (!admitted() || controller.signal.aborted) return;
        if (!timedOut && isAbortError(cause)) {
          try { if (await accept() && admitted()) recoverAuth = true; } catch { if (admitted()) publish(empty()); }
          return;
        }
        const error = timedOut ? new ApiError('network') : cause instanceof ApiError ? cause : new ApiError('protocol', null, 'protocol', null, cause);
        try { if (!await accept() || !admitted()) return; } catch { if (admitted()) publish(empty()); return; }
        const denied = error.kind === 'server' && (error.status === 403 || error.status === 404);
        if (error.code === 'principal_mismatch' || error.status === 401 || denied) {
          publish({ ...empty(), [failure]: error });
          session.initialized = false; session.cursor = null; session.targetPage = 1; session.upper = null;
          cancel();
          if (error.code === 'principal_mismatch') current.current.onPrincipalMismatch();
          if (denied) current.current.onAccessError?.(error);
        } else publish({ ...session.snapshot, [failure]: error });
      } finally { if (timeout !== undefined) clearTimeout(timeout); }
    };
    const admission = (onDispatch: () => void) => ({ userId, onPrincipalMismatch: () => {}, onDispatch });
    const pageCursor = initialized && cursor === null && upper !== null ? firstPageCursor(projectId, initial.filter, initial.query, upper) : cursor;
    const syntheticFirstPage = cursor === null && pageCursor !== null;
    const reads: Promise<void>[] = [
      load((signal, dispatch) => getGitHubStatus(projectId, signal, admission(dispatch)), status => {
        const previous = session.snapshot.status;
        if (previous === null || BigInt(status.revision) >= BigInt(previous.revision)) publish({ ...session.snapshot, status, statusError: null });
      }, 'statusError'),
      load((signal, dispatch) => getPullRequests(projectId, { state: initial.filter, q: initial.query, cursor: pageCursor }, signal, admission(dispatch)), page => {
        const previous = session.snapshot.page;
        if (previous !== null && BigInt(page.revision) < BigInt(previous.revision)) return;
        if (initialized && upper === null && page.items.length > 0) { publish({ ...session.snapshot, hasUpdates: true }); return; }
        if (!initialized) { session.upper = page.items[0]?.number ?? null; session.initialized = true; }
        // The synthetic first-page anchor is a read bound, not a navigable earlier page.
        const visible = syntheticFirstPage ? { ...page, previousCursor: null } : page;
        publish({ ...session.snapshot, page: visible, pageNumber: targetPage, error: null, refreshKey: session.snapshot.refreshKey + 1 });
      }, 'error'),
    ];
    if (initialized && upper !== null && BigInt(upper) !== MAX_NUMBER) reads.push(
      load((signal, dispatch) => getPullRequests(projectId, { state: initial.filter, q: initial.query, cursor: null }, signal, admission(dispatch)), page => {
        if (page.items.some(item => BigInt(item.number) > BigInt(upper))) publish({ ...session.snapshot, hasUpdates: true });
      }, 'error'),
    );
    void Promise.all(reads).finally(() => {
      if (session.pending === controller) session.pending = null;
      if (!admitted()) return;
      publish({ ...session.snapshot, loading: false });
      if (recoverAuth) run(false);
    });
  }, [session, userId, projectId, permitted, cancel, publish]);

  const reset = useCallback((filter: PullRequestState, query: string) => {
    cancel(); session.cursor = null; session.targetPage = 1; session.upper = null; session.initialized = false;
    publish({ ...session.snapshot, filter, query, page: null, error: null, pageNumber: 1, hasUpdates: false });
    run(true);
  }, [cancel, session, publish, run]);
  const refresh = useCallback(() => {
    cancel(); session.cursor = null; session.targetPage = 1; session.upper = null; session.initialized = false;
    publish({ ...session.snapshot, hasUpdates: false }); run(true);
  }, [cancel, session, publish, run]);
  const reconcile = useCallback(() => run(false), [run]);
  const setFilter = useCallback((filter: PullRequestState) => { if (filter !== session.snapshot.filter) reset(filter, session.snapshot.query); }, [reset, session]);
  const setQuery = useCallback((query: string) => { if (query !== session.snapshot.query) reset(session.snapshot.filter, query); }, [reset, session]);
  const move = useCallback((direction: 'next' | 'previous') => {
    const cursor = session.snapshot.page?.[direction === 'next' ? 'nextCursor' : 'previousCursor'];
    if (cursor === undefined || cursor === null || session.snapshot.loading) return;
    cancel(); session.cursor = cursor;
    session.targetPage = Math.max(1, session.snapshot.pageNumber + (direction === 'next' ? 1 : -1));
    run(true);
  }, [cancel, publish, run, session]);
  const next = useCallback(() => move('next'), [move]), previous = useCallback(() => move('previous'), [move]);

  useEffect(() => {
    if (!canRead) { cancel(); session.cursor = null; session.targetPage = 1; session.upper = null; session.initialized = false; publish(empty()); return; }
    const resume = () => {
      if (permitted()) run(false);
      else { cancel(); publish({ ...session.snapshot, loading: false }); }
    };
    resume();
    const timer = setInterval(() => run(false), 15_000);
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); cancel(); };
  }, [session, canRead, active, permitted, run, cancel, publish]);

  const snapshot = canRead ? session.snapshot : empty();
  return { ...snapshot, loading: snapshot.loading || active && canRead && snapshot.page === null && snapshot.error === null && snapshot.statusError === null, setFilter, setQuery, next, previous, refresh, reconcile };
};
