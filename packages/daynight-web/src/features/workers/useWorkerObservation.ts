import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskCacheError } from '../task-cache/database';
import type { CacheEvent } from '../task-cache/project-cache';
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
type Fence = ReadonlyMap<string, string> | null;
type State<T> = Omit<WorkerReadState<T>, 'refresh'> & { readonly scope: TaskCacheScope; readonly resource: string; readonly fence: Fence };
type Loader<T> = (scope: TaskCacheScope, signal: AbortSignal) => Promise<WorkerObservation<T>>;
type Outcome<T> = { readonly ok: true; readonly value: WorkerObservation<T> } | { readonly ok: false; readonly error: unknown };
const initialState = <T>(scope: TaskCacheScope, resource: string): State<T> => ({ scope, resource, fence: null, snapshot: null, status: 'loading', refreshing: false, error: null, stale: false, serverMilliseconds: null });
const matches = (scope: TaskCacheScope, fence: Fence, event: CacheEvent) => fence === null || scope.projectionEventMatches(fence, event);
const retainAll = <T,>(snapshot: T): T | null => snapshot;

export const useWorkerObservation = <T extends { readonly observedAt: string }>(resource: string, { readEnabled }: WorkerReadOptions, load: Loader<T>, missingIsUnavailable: boolean, withdraw: (snapshot: T, projectId: string) => T, filterDenied: (scope: TaskCacheScope, snapshot: T, fence: ReadonlyMap<string, string>) => T, advanceOnError = false, retainSnapshot: (snapshot: T) => T | null = retainAll): WorkerReadState<T> => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<State<T>>(() => initialState(scope, resource));
  const refreshAction = useRef<() => void>(() => {});
  const history = useRef<{ scope: TaskCacheScope; resource: string; fence: Fence; errors: Map<string, unknown>; anchor: WorkerTimeAnchor | null }>({ scope, resource, fence: null, errors: new Map(), anchor: null });
  if (history.current.scope !== scope || history.current.resource !== resource) history.current = { scope, resource, fence: null, errors: new Map(), anchor: null };
  const manual = useRef<{ scope: TaskCacheScope; resource: string; pending: boolean }>({ scope, resource, pending: false });
  if (manual.current.scope !== scope || manual.current.resource !== resource) manual.current = { scope, resource, pending: false };
  const refresh = useCallback(() => refreshAction.current(), []);

  useLayoutEffect(() => {
    let active = true, visible = document.visibilityState !== 'hidden', generation = 0;
    let controller: AbortController | null = null;
    let requestFence: Fence = null;
    const projection = history.current, cleanupErrors = projection.errors;
    const manualRequest = manual.current;
    let userAwaiting = false;
    let anchor: WorkerTimeAnchor | null = advanceOnError ? projection.anchor : null;
    let polling: ReturnType<typeof setInterval> | null = null, ticking: ReturnType<typeof setInterval> | null = null;
    const allowed = () => active && readEnabled && visible && !scope.isInvalidated;
    const current = (attempt: number, signal: AbortSignal) => allowed() && attempt === generation && !signal.aborted;
    const freeze = () => {
      if (!advanceOnError) anchor = null;
      setState(old => old.scope === scope && old.resource === resource ? { ...old, refreshing: false, stale: old.snapshot !== null } : initialState(scope, resource));
    };
    const cancel = () => {
      if (userAwaiting && !scope.isInvalidated) manualRequest.pending = true;
      userAwaiting = false;
      ++generation;
      controller?.abort(); controller = null;
      if (polling !== null) clearInterval(polling);
      if (ticking !== null) clearInterval(ticking);
      polling = null; ticking = null;
      freeze();
    };
    const markRefreshing = () => setState(old => ({ ...(old.scope === scope && old.resource === resource ? old : initialState<T>(scope, resource)), refreshing: true }));
    const request = async (explicit = false): Promise<void> => {
      if (!allowed() || controller !== null) return;
      const requestController = new AbortController(); controller = requestController;
      requestFence = null;
      const signal = AbortSignal.any([requestController.signal, scope.signal]), attempt = ++generation;
      let preparedFence: ReadonlyMap<string, string> | null = null, snapshotError: TaskCacheError | null = null;
      if (explicit) { userAwaiting = true; markRefreshing(); }
      try {
        let outcome: Outcome<T>;
        try {
          const prepared = await scope.prepareProjection(signal);
          if (!current(attempt, signal)) return;
          requestFence = prepared;
          preparedFence = prepared;
          snapshotError = scope.projectionSnapshotError(prepared);
          if (scope.projectionSnapshotHasDenials(prepared)) setState(old => old.scope === scope && old.resource === resource ? { ...old,
            snapshot: old.snapshot === null ? null : filterDenied(scope, old.snapshot, prepared),
            error: snapshotError ?? scope.projectionError ?? cleanupErrors.values().next().value ?? old.error, stale: old.snapshot !== null } : old);
          outcome = { ok: true, value: await load(scope, signal) };
        } catch (error) { outcome = { ok: false, error }; }
        if (!current(attempt, signal)) return;
        try { await scope.ready(signal); }
        catch (error) { outcome = { ok: false, error }; }
        if (!current(attempt, signal)) return;
        if (outcome.ok) {
          anchor = { observedAt: outcome.value.snapshot.observedAt, receivedMonotonic: outcome.value.receivedMonotonic };
          projection.anchor = anchor;
          for (const projectId of cleanupErrors.keys()) if (!scope.isProjectionDenied(projectId)) cleanupErrors.delete(projectId);
          const cleanupError = snapshotError ?? scope.projectionSnapshotError(preparedFence!) ?? cleanupErrors.values().next().value ?? null;
          projection.fence = requestFence;
          setState({ scope, resource, fence: requestFence, snapshot: filterDenied(scope, outcome.value.snapshot, preparedFence!), status: 'ready', refreshing: false, error: cleanupError, stale: cleanupError !== null, serverMilliseconds: workerServerMilliseconds(anchor, performance.now()) });
        } else {
          if (!advanceOnError) anchor = null;
          const error = outcome.error;
          if (missingIsUnavailable && error instanceof ApiError && error.kind === 'server' && error.status === 404) {
            anchor = null;
            projection.anchor = null;
            setState({ ...initialState<T>(scope, resource), status: 'unavailable', error });
          } else {
            setState(old => ({ ...old, status: old.snapshot === null ? 'error' : 'ready', refreshing: false, error: snapshotError ?? scope.projectionError ?? cleanupErrors.values().next().value ?? error, stale: old.snapshot !== null }));
          }
        }
      } finally { if (attempt === generation) { controller = null; userAwaiting = false; } }
    };
    const resetPolling = () => {
      if (polling !== null) clearInterval(polling);
      polling = allowed() ? setInterval(() => { void request(); }, 30_000) : null;
    };
    const recheck = () => {
      if (!allowed() || controller !== null) return;
      void request();
      resetPolling();
    };
    const refresh = () => {
      if (!active || scope.isInvalidated) return;
      if (!allowed()) { manualRequest.pending = true; markRefreshing(); return; }
      manualRequest.pending = false;
      if (controller !== null) { userAwaiting = true; markRefreshing(); }
      else void request(true);
      resetPolling();
    };
    const start = () => {
      if (!allowed()) return;
      if (advanceOnError && anchor !== null && !authRequestsPaused()) {
        const serverMilliseconds = workerServerMilliseconds(anchor, performance.now());
        setState(old => old.scope === scope && old.resource === resource ? { ...old, serverMilliseconds } : old);
      }
      if (manualRequest.pending) refresh(); else recheck();
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
      manualRequest.pending = false; userAwaiting = false;
      cancel();
      setState(initialState(scope, resource));
    };
    const unsubscribe = scope.subscribeProjection(event => {
      if (event.accessRestored) {
        ++generation; controller?.abort(); controller = null;
        recheck();
        return;
      }
      if (!event.accessRevoked && !event.scopeSuspended) {
        if (scope.getAuthorizedProject(event.projectId) !== null) cleanupErrors.delete(event.projectId);
        return;
      }
      const affectsPublished = matches(scope, projection.fence, event);
      const cancelRequest = controller !== null && matches(scope, requestFence, event)
        && !(event.error instanceof TaskCacheError);
      if (!affectsPublished && !cancelRequest) return;
      if (cancelRequest) { ++generation; controller?.abort(); controller = null; userAwaiting = false; manualRequest.pending = false; }
      if (event.error instanceof TaskCacheError) cleanupErrors.set(event.projectId, event.error);
      const cleanupError = cleanupErrors.values().next().value ?? null;
      setState(old => {
        if (old.scope !== scope || old.resource !== resource || !matches(scope, old.fence, event)) return old;
        return { ...old, snapshot: old.snapshot === null ? null : withdraw(old.snapshot, event.projectId),
          refreshing: cancelRequest ? false : old.refreshing, error: cleanupError, stale: cleanupError !== null || old.stale };
      });
      if (!(event.error instanceof TaskCacheError) && (cancelRequest || controller === null)) recheck();
    });
    setState(old => {
      if (old.scope !== scope || old.resource !== resource) return initialState(scope, resource);
      const snapshot = old.snapshot === null ? null : retainSnapshot(old.snapshot);
      const discarded = old.snapshot !== null && snapshot === null;
      return { ...old, snapshot, status: discarded ? 'loading' : old.status, error: discarded ? null : old.error,
        refreshing: manualRequest.pending, stale: snapshot !== null, serverMilliseconds: discarded ? null : old.serverMilliseconds };
    });
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    refreshAction.current = refresh;
    start();
    return () => {
      if (userAwaiting && manual.current === manualRequest && !scope.isInvalidated) manualRequest.pending = true;
      active = false; ++generation; controller?.abort(); anchor = null;
      if (polling !== null) clearInterval(polling);
      if (ticking !== null) clearInterval(ticking);
      document.removeEventListener('visibilitychange', visibility);
      scope.signal.removeEventListener('abort', invalidate);
      unsubscribe();
      refreshAction.current = () => {};
    };
  }, [scope, resource, readEnabled, load, missingIsUnavailable, withdraw, filterDenied, advanceOnError, retainSnapshot]);

  const current = state.scope === scope && state.resource === resource && !scope.isInvalidated ? state : initialState<T>(scope, resource);
  const snapshot = current.snapshot === null ? null : retainSnapshot(current.snapshot);
  const discarded = current.snapshot !== null && snapshot === null;
  return { snapshot, status: discarded ? 'loading' : current.status, refreshing: current.refreshing, error: discarded ? null : current.error, stale: discarded ? false : current.stale, serverMilliseconds: discarded ? null : current.serverMilliseconds, refresh };
};
