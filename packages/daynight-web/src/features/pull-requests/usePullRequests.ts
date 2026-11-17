import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getGitHubStatus, getPullRequests, type GitHubStatus, type PullRequestAuthor, type PullRequestPage, type PullRequestState } from './api';
import { createReadSession } from './read-session';

export type PullRequestsOptions = {
  readonly userId: string; readonly projectId: string; readonly canRead: boolean; readonly active: boolean;
  readonly onPrincipalMismatch: () => void; readonly onAccessError?: ((error: ApiError) => void) | undefined;
};
type Counts = Readonly<Record<PullRequestState, string>>;
type Snapshot = {
  readonly status: GitHubStatus | null; readonly page: PullRequestPage | null; readonly counts: Counts | null; readonly projectTotal: string | null;
  readonly statusError: ApiError | null; readonly error: ApiError | null; readonly loading: boolean;
  readonly author: PullRequestAuthor | null; readonly filter: PullRequestState; readonly query: string; readonly pageNumber: number;
  readonly hasUpdates: boolean; readonly refreshKey: number;
};
const empty = (): Snapshot => ({ status: null, page: null, counts: null, projectTotal: null, statusError: null, error: null, loading: false, author: null, filter: 'active', query: '', pageNumber: 1, hasUpdates: false, refreshKey: 0 });
const MAX_NUMBER = 9_223_372_036_854_775_807n;
const firstPageCursor = (projectId: string, filter: PullRequestState, query: string, upper: string, authorId: string | null): string | null => {
  if (BigInt(upper) === MAX_NUMBER) return null;
  const json = JSON.stringify({ v: authorId === null ? 1 : 2, projectId, state: filter, q: query, limit: 6, upperNumber: upper, anchorNumber: String(BigInt(upper) + 1n), direction: 'next', ...(authorId === null ? {} : { authorId }) });
  return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** Keeps one authorized Project's cursor workspace in memory while its tab is hidden. */
export const usePullRequests = (options: PullRequestsOptions) => {
  const { userId, projectId, canRead, active } = options;
  const key = JSON.stringify([userId, projectId]);
  const current = useRef(options); current.current = options;
  const currentKey = useRef(key); currentKey.current = key;
  const permitted = useCallback(() => currentKey.current === key && current.current.canRead && current.current.active && document.visibilityState !== 'hidden', [key]);
  const scope = useMemo(() => createReadSession({ userId, projectId, isAllowed: permitted,
    onPrincipalMismatch: () => current.current.onPrincipalMismatch(), onAccessError: error => current.current.onAccessError?.(error) }), [userId, projectId, permitted]);
  const session = useMemo(() => ({ key, snapshot: empty(), cursor: null as string | null, targetPage: 1, upper: null as string | null, initialized: false, generation: 0, pending: null as AbortController | null, pageRevision: null as string | null, countRevision: null as string | null, projectRevision: null as string | null }), [key]);
  const [, render] = useState(0);
  const publish = useCallback((snapshot: Snapshot) => { session.snapshot = snapshot; render(value => value + 1); }, [session]);
  const cancel = useCallback(() => { session.generation += 1; session.pending?.abort(); session.pending = null; }, [session]);
  const clear = useCallback((error?: ApiError) => {
    cancel(); session.initialized = false; session.cursor = null; session.targetPage = 1; session.upper = null; session.pageRevision = null; session.countRevision = null; session.projectRevision = null;
    publish(error === undefined ? empty() : { ...empty(), error });
  }, [cancel, publish, session]);
  useLayoutEffect(() => scope.subscribe(clear), [scope, clear]);
  const permission = useRef({ scope, canRead });
  useLayoutEffect(() => {
    const previous = permission.current;
    if (previous.scope !== scope) permission.current = { scope, canRead };
    else {
      if (previous.canRead && !canRead) scope.revoke();
      else if (!previous.canRead && canRead) scope.resume();
      permission.current = { scope, canRead };
    }
  }, [scope, canRead]);
  useLayoutEffect(() => () => { if (currentKey.current !== key) scope.revoke(); }, [scope, key]);

  const run = useCallback((replace: boolean) => {
    if (!permitted() || !replace && session.pending !== null) return;
    if (!scope.isAllowed()) {
      if (session.pending !== null) return;
      const recovery = new AbortController(); session.pending = recovery;
      void scope.recover(recovery.signal).then(verified => {
        if (session.pending === recovery) session.pending = null;
        if (verified && !recovery.signal.aborted) run(false);
      });
      return;
    }
    if (replace) cancel();
    const controller = new AbortController(), generation = ++session.generation, token = scope.capture();
    session.pending = controller;
    const admitted = () => permitted() && session.generation === generation && scope.current(token);
    const initial = session.snapshot, initialized = session.initialized, upper = session.upper, cursor = session.cursor, targetPage = session.targetPage;
    const authorId = initial.author?.id ?? null;
    publish({ ...initial, loading: true, error: null, statusError: null });
    let recoverAuth = false;
    const load = async <T,>(read: (signal: AbortSignal, onDispatch: () => void) => Promise<T>, apply: (value: T) => void, failure: 'error' | 'statusError') => {
      try {
        const value = await scope.request(controller.signal, read);
        if (await scope.accept(token, controller.signal) && admitted()) apply(value);
      } catch (cause: unknown) {
        if (!permitted() || session.generation !== generation || controller.signal.aborted) return;
        if (isAbortError(cause)) {
          try { if (await scope.accept(token, controller.signal) && admitted()) recoverAuth = true; } catch { if (admitted()) scope.revoke(); }
          return;
        }
        const error = cause instanceof ApiError ? cause : new ApiError('protocol', null, 'protocol', null, cause);
        try { if (!await scope.accept(token, controller.signal) || !admitted()) return; } catch { if (admitted()) scope.revoke(); return; }
        const denied = error.kind === 'server' && (error.status === 403 || error.status === 404);
        if (error.code === 'principal_mismatch' || error.status === 401 || denied) scope.revoke(error);
        else publish({ ...session.snapshot, [failure]: error });
      }
    };
    const admission = (onDispatch: () => void) => ({ userId, onPrincipalMismatch: () => {}, onDispatch });
    const pageCursor = initialized && cursor === null && upper !== null ? firstPageCursor(projectId, initial.filter, initial.query, upper, authorId) : cursor;
    const syntheticFirstPage = cursor === null && pageCursor !== null;
    const updateCounts = (page: PullRequestPage) => {
      if (session.projectRevision === null || BigInt(page.revision) >= BigInt(session.projectRevision)) {
        session.projectRevision = page.revision;
        publish({ ...session.snapshot, projectTotal: page.projectTotal });
      }
      if (session.countRevision === null || BigInt(page.revision) >= BigInt(session.countRevision)) {
        session.countRevision = page.revision;
        publish({ ...session.snapshot, counts: page.counts });
      }
    };
    const query = { state: initial.filter, q: initial.query, authorId };
    const reads: Promise<void>[] = [
      load((signal, dispatch) => getGitHubStatus(projectId, signal, admission(dispatch)), status => {
        const previous = session.snapshot.status;
        if (previous === null || BigInt(status.revision) >= BigInt(previous.revision)) publish({ ...session.snapshot, status, statusError: null });
      }, 'statusError'),
      load((signal, dispatch) => getPullRequests(projectId, { ...query, cursor: pageCursor }, signal, admission(dispatch)), page => {
        if (session.pageRevision !== null && BigInt(page.revision) < BigInt(session.pageRevision) || session.projectRevision !== null && BigInt(page.revision) < BigInt(session.projectRevision)) {
          if (session.snapshot.page === null) publish({ ...session.snapshot, error: new ApiError('protocol') });
          return;
        }
        session.pageRevision = page.revision; updateCounts(page);
        if (initialized && upper === null && page.items.length > 0) { publish({ ...session.snapshot, hasUpdates: true }); return; }
        if (!initialized) { session.upper = page.items[0]?.number ?? null; session.initialized = true; }
        const visible = syntheticFirstPage ? { ...page, previousCursor: null } : page;
        publish({ ...session.snapshot, page: visible, pageNumber: targetPage, error: null, refreshKey: session.snapshot.refreshKey + 1 });
      }, 'error'),
    ];
    if (initialized && upper !== null && BigInt(upper) !== MAX_NUMBER) reads.push(
      load((signal, dispatch) => getPullRequests(projectId, { ...query, cursor: null }, signal, admission(dispatch)), page => {
        if (session.pageRevision !== null && BigInt(page.revision) < BigInt(session.pageRevision) || session.projectRevision !== null && BigInt(page.revision) < BigInt(session.projectRevision)) return;
        updateCounts(page);
        if (page.items.some(item => BigInt(item.number) > BigInt(upper))) publish({ ...session.snapshot, hasUpdates: true });
      }, 'error'),
    );
    void Promise.all(reads).finally(() => {
      if (session.pending === controller) session.pending = null;
      if (!admitted()) return;
      publish({ ...session.snapshot, loading: false });
      if (recoverAuth) run(false);
    });
  }, [session, userId, projectId, permitted, cancel, publish, scope]);

  const reset = useCallback((filter: PullRequestState, query: string, author: PullRequestAuthor | null, authorChanged: boolean) => {
    cancel(); session.cursor = null; session.targetPage = 1; session.upper = null; session.initialized = false;
    if (authorChanged) session.countRevision = null;
    publish({ ...session.snapshot, author, filter, query, page: null, counts: authorChanged ? null : session.snapshot.counts, error: null, pageNumber: 1, hasUpdates: false });
    run(true);
  }, [cancel, session, publish, run]);
  const refresh = useCallback(() => {
    cancel(); session.cursor = null; session.targetPage = 1; session.upper = null; session.initialized = false;
    publish({ ...session.snapshot, hasUpdates: false }); run(true);
  }, [cancel, session, publish, run]);
  const reconcile = useCallback(() => run(false), [run]);
  const setFilter = useCallback((filter: PullRequestState) => { if (scope.isAllowed() && filter !== session.snapshot.filter) reset(filter, session.snapshot.query, session.snapshot.author, false); }, [reset, session, scope]);
  const setQuery = useCallback((query: string) => { if (scope.isAllowed() && query !== session.snapshot.query) reset(session.snapshot.filter, query, session.snapshot.author, false); }, [reset, session, scope]);
  const setAuthor = useCallback((author: PullRequestAuthor | null) => {
    if (!scope.isAllowed()) return;
    if ((author?.id ?? null) !== (session.snapshot.author?.id ?? null)) reset(session.snapshot.filter, session.snapshot.query, author, true);
    else if (author !== null && (author.login !== session.snapshot.author?.login || author.loginAmbiguous !== session.snapshot.author.loginAmbiguous)) publish({ ...session.snapshot, author });
  }, [reset, session, publish, scope]);
  const move = useCallback((direction: 'next' | 'previous') => {
    const cursor = session.snapshot.page?.[direction === 'next' ? 'nextCursor' : 'previousCursor'];
    if (cursor === undefined || cursor === null || session.snapshot.loading) return;
    cancel(); session.cursor = cursor;
    session.targetPage = Math.max(1, session.snapshot.pageNumber + (direction === 'next' ? 1 : -1));
    run(true);
  }, [cancel, run, session]);
  const next = useCallback(() => move('next'), [move]), previous = useCallback(() => move('previous'), [move]);

  useEffect(() => {
    if (!canRead) return;
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
  return { ...snapshot, scope, loading: snapshot.loading || active && canRead && snapshot.page === null && snapshot.error === null && snapshot.statusError === null, setAuthor, setFilter, setQuery, next, previous, refresh, reconcile };
};
