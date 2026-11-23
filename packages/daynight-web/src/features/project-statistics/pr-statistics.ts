import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getProject } from '../../api/project-settings';
import { createReadSession, type ReadSession } from '../pull-requests/read-session';
import type { PullRequestAuthor } from '../pull-requests/api';
import { usePullRequestAuthors } from '../pull-requests/usePullRequestAuthors';
import { getPRStatistics, type PRStatistics } from './pr-statistics-api';

export type PRStatisticsOptions = {
  readonly userId: string; readonly projectId: string; readonly canRead: boolean; readonly active: boolean;
  readonly repositoryId?: string | null;
  readonly endDate: string; readonly window: string;
  readonly onPrincipalMismatch: () => void; readonly onAccessError: (error: ApiError) => void;
};
type Snapshot = { readonly data: PRStatistics | null; readonly window: string; readonly author: PullRequestAuthor | null; readonly loading: boolean; readonly error: ApiError | null };
const empty = (): Snapshot => ({ data: null, window: '', author: null, loading: false, error: null });

/** Reads the aggregation and author directory under one authenticated project admission. */
export const usePRStatistics = (options: PRStatisticsOptions) => {
  const { userId, projectId, repositoryId, canRead, active, endDate, window: dateWindow } = options;
  const key = JSON.stringify([userId, projectId, repositoryId]);
  const current = useRef(options); current.current = options;
  const currentKey = useRef(key); currentKey.current = key;
  const permitted = useCallback(() => currentKey.current === key && current.current.repositoryId !== null && current.current.canRead && current.current.active && document.visibilityState !== 'hidden', [key]);
  const state = useMemo(() => ({ snapshot: empty(), targetAuthor: null as PullRequestAuthor | null, generation: 0, pending: null as AbortController | null }), [key]);
  const [, render] = useState(0);
  const publish = useCallback((snapshot: Snapshot) => { state.snapshot = snapshot; render(value => value + 1); }, [state]);
  const cancel = useCallback(() => { state.generation++; state.pending?.abort(); state.pending = null; }, [state]);
  const scope = useMemo(() => {
    const base = createReadSession({ userId, projectId, isAllowed: permitted,
      onPrincipalMismatch: () => current.current.onPrincipalMismatch(), onAccessError: error => current.current.onAccessError(error) });
    // The statistics page has its own baseline. Rechecking an author directory
    // must not open the unrelated PR list or its connection-status reader.
    const verifyBaseline = async (signal: AbortSignal, onFailure?: (error: ApiError) => void): Promise<boolean> => {
      if (!base.isAllowed()) return false;
      const token = base.capture(), input = current.current, author = state.snapshot.author?.id ?? null;
      const applicable = () => permitted() && current.current.endDate === input.endDate && current.current.window === input.window && (state.snapshot.author?.id ?? null) === author;
      try {
        await base.request(signal, (s, dispatch) => getProject(projectId, s, { userId, onPrincipalMismatch: () => {} }, dispatch));
        await base.request(signal, (s, dispatch) => getPRStatistics(projectId, input.endDate, input.window, author, s, { userId, onPrincipalMismatch: () => {}, onDispatch: dispatch }, repositoryId ?? null));
        return await base.accept(token, signal) && applicable();
      } catch (cause) {
        if (signal.aborted || !applicable()) return false;
        try { if (!await base.accept(token, signal) || !applicable()) return false; } catch { return false; }
        const error = cause instanceof ApiError ? cause : isAbortError(cause) ? new ApiError('network') : new ApiError('protocol', null, 'protocol', null, cause);
        if (error.code === 'principal_mismatch' || error.status === 401 || error.kind === 'server' && (error.status === 403 || error.status === 404)) base.revoke(error);
        else onFailure?.(error);
        return false;
      }
    };
    const recover = async (signal: AbortSignal) => {
      if (!permitted() || !base.isRevoked()) return false;
      const input = current.current, generation = state.generation;
      let failure: ApiError | null = null;
      base.resume();
      const verified = await verifyBaseline(signal, error => { failure = error; });
      if (!verified && !signal.aborted && !base.isRevoked() && permitted() && state.generation === generation &&
          current.current.endDate === input.endDate && current.current.window === input.window) base.revoke(failure ?? new ApiError('network'));
      return verified;
    };
    return { ...base, verifyBaseline, recover } satisfies ReadSession;
  }, [userId, projectId, repositoryId, permitted, state]);
  useLayoutEffect(() => scope.subscribe(error => { cancel(); state.targetAuthor = null; publish(error ? { ...empty(), error } : empty()); }), [scope, cancel, publish, state]);
  useLayoutEffect(() => {
    if (!canRead) scope.revoke();
    else if (scope.isRevoked()) scope.resume();
  }, [canRead, scope]);
  useLayoutEffect(() => () => { if (currentKey.current !== key) scope.revoke(); }, [key, scope]);

  const run = useCallback((replace: boolean) => {
    if (!permitted() || !replace && state.pending !== null) return;
    if (!scope.isAllowed()) {
      if (state.pending !== null) return;
      const recovery = new AbortController(); state.pending = recovery;
      void scope.recover(recovery.signal).then(verified => {
        if (state.pending === recovery) state.pending = null;
        if (verified && !recovery.signal.aborted) run(false);
      });
      return;
    }
    if (replace) cancel();
    const input = current.current, targetAuthor = state.targetAuthor, authorId = targetAuthor?.id ?? null;
    const controller = new AbortController(), generation = ++state.generation, token = scope.capture();
    state.pending = controller;
    const admitted = () => permitted() && state.generation === generation && scope.current(token) &&
      current.current.endDate === input.endDate && current.current.window === input.window && (state.targetAuthor?.id ?? null) === authorId;
    const old = state.snapshot;
    publish({ ...old, data: old.data?.endDate === input.endDate && old.window === input.window ? old.data : null, loading: true, error: null });
    void (async () => {
      try {
        const data = await scope.request(controller.signal, (signal, dispatch) => getPRStatistics(projectId, input.endDate, input.window, authorId, signal, { userId, onPrincipalMismatch: () => {}, onDispatch: dispatch }, repositoryId ?? null));
        if (!await scope.accept(token, controller.signal) || !admitted()) return;
        const author = targetAuthor === null || data.author === null ? null : { ...targetAuthor, login: data.author.login };
        state.targetAuthor = author;
        publish({ data, window: input.window, author, loading: false, error: null });
      } catch (cause: unknown) {
        if (controller.signal.aborted || !admitted()) return;
        try { if (!await scope.accept(token, controller.signal) || !admitted()) return; } catch { if (admitted()) scope.revoke(); return; }
        const error = cause instanceof ApiError ? cause : isAbortError(cause) ? new ApiError('network') : new ApiError('protocol', null, 'protocol', null, cause);
        if (error.code === 'principal_mismatch' || error.status === 401 || error.kind === 'server' && (error.status === 403 || error.status === 404)) scope.revoke(error);
        else publish({ ...state.snapshot, loading: false, error });
      } finally { if (state.pending === controller) state.pending = null; }
    })();
  }, [cancel, permitted, projectId, repositoryId, publish, scope, state, userId]);

  const refresh = useCallback(() => run(false), [run]);
  const setAuthor = useCallback((author: PullRequestAuthor | null) => {
    if (!scope.isAllowed()) return;
    if ((author?.id ?? null) === (state.targetAuthor?.id ?? null)) return;
    cancel(); state.targetAuthor = author;
    publish({ ...state.snapshot, error: null }); run(false);
  }, [cancel, publish, run, scope, state]);
  useEffect(() => {
    if (!canRead || !active) { cancel(); return; }
    run(false);
    const resume = () => { if (permitted()) run(false); else { cancel(); publish({ ...state.snapshot, loading: false }); } };
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); cancel(); };
  }, [active, canRead, endDate, dateWindow, permitted, run, cancel, publish, state]);
  const snapshot = canRead ? state.snapshot : empty();
  const data = snapshot.data?.endDate === endDate && snapshot.window === dateWindow ? snapshot.data : null;
  const authors = usePullRequestAuthors({ userId, projectId, ...(repositoryId === undefined ? {} : { repositoryId }), active: active && canRead && data !== null, scope });
  return { data, error: snapshot.error, loading: snapshot.loading || active && canRead && repositoryId !== null && data === null && snapshot.error === null, author: snapshot.author, setAuthor, refresh, authors };
};
