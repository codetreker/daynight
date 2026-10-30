import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { workerServerMilliseconds, type WorkerTimeAnchor } from './observation';

export type WorkerReadState<T> = {
  readonly snapshot: T | null;
  readonly status: 'loading' | 'ready' | 'error' | 'unavailable';
  readonly refreshing: boolean;
  readonly error: unknown;
  readonly stale: boolean;
  readonly serverMilliseconds: number | null;
  readonly refresh: () => void;
};
export type WorkerReadOptions = { readonly readEnabled: boolean };
export type WorkerObservation<T> = { readonly snapshot: T; readonly receivedMonotonic: number };
type State<T> = Omit<WorkerReadState<T>, 'refresh'> & { readonly scope: TaskCacheScope; readonly resource: string };
type Loader<T> = (scope: TaskCacheScope, signal: AbortSignal) => Promise<WorkerObservation<T>>;
type Outcome<T> = { readonly ok: true; readonly value: WorkerObservation<T> } | { readonly ok: false; readonly error: unknown };
const initialState = <T>(scope: TaskCacheScope, resource: string): State<T> => ({ scope, resource, snapshot: null, status: 'loading', refreshing: false, error: null, stale: false, serverMilliseconds: null });

export const useWorkerObservation = <T extends { readonly observedAt: string }>(resource: string, { readEnabled }: WorkerReadOptions, load: Loader<T>, missingIsUnavailable: boolean): WorkerReadState<T> => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<State<T>>(() => initialState(scope, resource));
  const refreshAction = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshAction.current(), []);

  useLayoutEffect(() => {
    let active = true, visible = document.visibilityState !== 'hidden', generation = 0;
    let controller: AbortController | null = null;
    let anchor: WorkerTimeAnchor | null = null;
    let polling: ReturnType<typeof setInterval> | null = null, ticking: ReturnType<typeof setInterval> | null = null;
    const allowed = () => active && readEnabled && visible && !scope.isInvalidated;
    const current = (attempt: number, signal: AbortSignal) => allowed() && attempt === generation && !signal.aborted;
    const freeze = () => {
      anchor = null;
      setState(old => old.scope === scope && old.resource === resource ? { ...old, refreshing: false, stale: old.snapshot !== null } : initialState(scope, resource));
    };
    const cancel = () => {
      ++generation;
      controller?.abort(); controller = null;
      if (polling !== null) clearInterval(polling);
      if (ticking !== null) clearInterval(ticking);
      polling = null; ticking = null;
      freeze();
    };
    const request = async (): Promise<void> => {
      if (!allowed() || controller !== null) return;
      const requestController = new AbortController(); controller = requestController;
      const signal = AbortSignal.any([requestController.signal, scope.signal]), attempt = ++generation;
      setState(old => ({ ...(old.scope === scope && old.resource === resource ? old : initialState<T>(scope, resource)), refreshing: true }));
      try {
        let outcome: Outcome<T>;
        try {
          await scope.ready(signal);
          outcome = { ok: true, value: await load(scope, signal) };
        } catch (error) { outcome = { ok: false, error }; }
        if (!current(attempt, signal)) return;
        try { await scope.ready(signal); }
        catch (error) { outcome = { ok: false, error }; }
        if (!current(attempt, signal)) return;
        if (outcome.ok) {
          anchor = { observedAt: outcome.value.snapshot.observedAt, receivedMonotonic: outcome.value.receivedMonotonic };
          setState({ scope, resource, snapshot: outcome.value.snapshot, status: 'ready', refreshing: false, error: null, stale: false, serverMilliseconds: workerServerMilliseconds(anchor, performance.now()) });
        } else {
          anchor = null;
          const error = outcome.error;
          if (missingIsUnavailable && error instanceof ApiError && error.kind === 'server' && error.status === 404) {
            setState({ ...initialState<T>(scope, resource), status: 'unavailable', error });
          } else {
            setState(old => ({ ...old, status: old.snapshot === null ? 'error' : 'ready', refreshing: false, error, stale: old.snapshot !== null }));
          }
        }
      } finally { if (attempt === generation) controller = null; }
    };
    const start = () => {
      if (!allowed()) return;
      void request();
      polling = setInterval(() => { void request(); }, 5_000);
      ticking = setInterval(() => {
        if (authRequestsPaused()) { freeze(); return; }
        if (anchor !== null && allowed()) {
          const serverMilliseconds = workerServerMilliseconds(anchor, performance.now());
          setState(old => ({ ...old, serverMilliseconds }));
        }
      }, 1_000);
    };
    const visibility = () => {
      const next = document.visibilityState !== 'hidden';
      if (next === visible) return;
      visible = next;
      cancel();
      if (visible) start();
    };
    const invalidate = () => {
      cancel();
      setState(initialState(scope, resource));
    };
    setState(old => old.scope === scope && old.resource === resource ? { ...old, refreshing: false, stale: old.snapshot !== null } : initialState(scope, resource));
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    refreshAction.current = () => { void request(); };
    start();
    return () => {
      active = false; ++generation; controller?.abort(); anchor = null;
      if (polling !== null) clearInterval(polling);
      if (ticking !== null) clearInterval(ticking);
      document.removeEventListener('visibilitychange', visibility);
      scope.signal.removeEventListener('abort', invalidate);
      refreshAction.current = () => {};
    };
  }, [scope, resource, readEnabled, load, missingIsUnavailable]);

  const current = state.scope === scope && state.resource === resource && !scope.isInvalidated ? state : initialState<T>(scope, resource);
  return { snapshot: current.snapshot, status: current.status, refreshing: current.refreshing, error: current.error, stale: current.stale, serverMilliseconds: current.serverMilliseconds, refresh };
};
