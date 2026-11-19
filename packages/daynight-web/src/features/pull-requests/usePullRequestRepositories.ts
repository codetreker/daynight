import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getPullRequestRepositories, type PullRequestRepository } from './api';
import { createReadSession } from './read-session';

type Options = {
  readonly userId: string; readonly projectId: string; readonly active: boolean; readonly canRead: boolean;
  readonly onPrincipalMismatch: () => void; readonly onAccessError?: ((error: ApiError) => void) | undefined;
};
type Snapshot = { readonly repositories: readonly PullRequestRepository[]; readonly currentRepositoryId: string | null; readonly repositoryId: string | null; readonly loading: boolean; readonly loaded: boolean; readonly error: ApiError | null };
const empty = (): Snapshot => ({ repositories: [], currentRepositoryId: null, repositoryId: null, loading: false, loaded: false, error: null });

/** Reads the complete source catalog before selecting a source. */
export const usePullRequestRepositories = (options: Options) => {
  const { userId, projectId, active, canRead } = options;
  const current = useRef(options); current.current = options;
  const key = JSON.stringify([userId, projectId]);
  const currentKey = useRef(key); currentKey.current = key;
  const allowed = useCallback(() => currentKey.current === key && current.current.canRead && current.current.active && document.visibilityState !== 'hidden', [key]);
  const scope = useMemo(() => createReadSession({ userId, projectId, isAllowed: allowed, repositoryId: () => null,
    onPrincipalMismatch: () => current.current.onPrincipalMismatch(), onAccessError: error => current.current.onAccessError?.(error) }), [userId, projectId, allowed]);
  const state = useMemo(() => ({ snapshot: empty(), pending: null as AbortController | null, generation: 0 }), [key]);
  const [, render] = useState(0);
  const publish = useCallback((snapshot: Snapshot) => { state.snapshot = snapshot; render(value => value + 1); }, [state]);
  const cancel = useCallback(() => { state.generation++; state.pending?.abort(); state.pending = null; }, [state]);
  const run = useCallback(() => {
    if (!allowed() || state.pending !== null) return;
    if (!scope.isAllowed()) {
      const recovery = new AbortController(); state.pending = recovery;
      void scope.recover(recovery.signal).then(verified => {
        if (state.pending === recovery) state.pending = null;
        if (verified && !recovery.signal.aborted) run();
      });
      return;
    }
    const controller = new AbortController(), generation = ++state.generation, token = scope.capture();
    state.pending = controller;
    const admitted = () => allowed() && !controller.signal.aborted && state.generation === generation && scope.current(token);
    if (!state.snapshot.loaded) publish({ ...state.snapshot, loading: true, error: null });
    void (async () => {
      try {
        let cursor: string | null = null, currentRepositoryId: string | null | undefined;
        const repositories: PullRequestRepository[] = [], visited = new Set<string>(), ids = new Set<string>();
        do {
          const page = await scope.request(controller.signal, (signal, onDispatch) => getPullRequestRepositories(projectId, cursor, signal, { userId, onPrincipalMismatch: () => {}, onDispatch }));
          if (!await scope.accept(token, controller.signal) || !admitted()) return;
          if (currentRepositoryId !== undefined && currentRepositoryId !== page.currentRepositoryId) throw new ApiError('protocol');
          currentRepositoryId = page.currentRepositoryId;
          for (const repository of page.items) {
            if (ids.has(repository.repositoryId) || repositories.length > 0 && BigInt(repository.repositoryId) <= BigInt(repositories[repositories.length - 1]!.repositoryId)) throw new ApiError('protocol');
            ids.add(repository.repositoryId); repositories.push(repository);
          }
          if (page.nextCursor !== null && (page.nextCursor === cursor || visited.has(page.nextCursor))) throw new ApiError('protocol');
          cursor = page.nextCursor;
          if (cursor !== null) visited.add(cursor);
        } while (cursor !== null);
        if (!admitted()) return;
        const selected = state.snapshot.repositoryId;
        const repositoryId = selected !== null && ids.has(selected) ? selected : currentRepositoryId !== null && currentRepositoryId !== undefined && ids.has(currentRepositoryId) ? currentRepositoryId : repositories[0]?.repositoryId ?? null;
        publish({ repositories, currentRepositoryId: currentRepositoryId ?? null, repositoryId, loaded: true, loading: false, error: null });
      } catch (cause: unknown) {
        if (!admitted() || isAbortError(cause)) return;
        const error = cause instanceof ApiError ? cause : new ApiError('protocol', null, 'protocol', null, cause);
        try { if (!await scope.accept(token, controller.signal) || !admitted()) return; } catch { return; }
        if (error.code === 'principal_mismatch' || error.status === 401 || error.kind === 'server' && (error.status === 403 || error.status === 404)) scope.revoke(error);
        else publish({ ...state.snapshot, loading: false, error });
      } finally { if (state.pending === controller) state.pending = null; }
    })();
  }, [allowed, projectId, publish, scope, state, userId]);
  const setRepositoryId = useCallback((repositoryId: string) => {
    if (state.snapshot.repositories.some(repository => repository.repositoryId === repositoryId)) publish({ ...state.snapshot, repositoryId });
  }, [publish, state]);
  useEffect(() => scope.subscribe(error => { cancel(); publish(error === undefined ? empty() : { ...empty(), error }); }), [cancel, publish, scope]);
  useEffect(() => {
    if (!canRead) { cancel(); scope.revoke(); return; }
    scope.resume();
    const resume = () => { if (allowed()) run(); else { cancel(); publish({ ...state.snapshot, loading: false }); } };
    resume(); const timer = setInterval(run, 15_000);
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); cancel(); };
  }, [active, allowed, canRead, cancel, publish, run, scope, state]);
  return { ...(canRead ? state.snapshot : empty()), loading: canRead && active && !state.snapshot.loaded && state.snapshot.error === null || state.snapshot.loading, setRepositoryId, retry: run };
};
