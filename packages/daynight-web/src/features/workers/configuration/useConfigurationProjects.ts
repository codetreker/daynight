import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import type { Project } from '../../../api/types';
import { listWorkerConfigurationProjects } from '../../../api/worker-configuration';
import { useTaskCacheScope } from '../../task-cache/TaskCacheProvider';
import { TaskCacheError } from '../../task-cache/database';
import type { CacheEvent } from '../../task-cache/project-cache';
import type { TaskCacheScope } from '../../task-cache/TaskCacheProvider';

type Fence = ReadonlyMap<string, string> | null;
const matches = (scope: TaskCacheScope, fence: Fence, event: CacheEvent) => fence === null || scope.projectionEventMatches(fence, event);

export const useConfigurationProjects = (readEnabled: boolean) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<{ readonly scope: typeof scope; readonly fence: Fence; readonly items: readonly Project[]; readonly loading: boolean; readonly loaded: boolean; readonly error: unknown }>({ scope, fence: null, items: [], loading: true, loaded: false, error: null });
  const refreshAction = useRef<() => void>(() => {});
  const history = useRef<{ scope: typeof scope; fence: Fence; errors: Map<string, unknown> }>({ scope, fence: null, errors: new Map() });
  if (history.current.scope !== scope) history.current = { scope, fence: null, errors: new Map() };
  const refresh = useCallback(() => refreshAction.current(), []);
  useLayoutEffect(() => {
    let active = true, generation = 0;
    let controller: AbortController | null = null;
    let requestFence: Fence = null;
    const projection = history.current, cleanupErrors = projection.errors;
    const live = () => active && readEnabled && !scope.isInvalidated;
    const load = async () => {
      if (!live() || document.visibilityState === 'hidden') return;
      controller?.abort();
      const request = new AbortController(); controller = request;
      requestFence = null;
      const signal = AbortSignal.any([request.signal, scope.signal]), attempt = ++generation;
      let preparedFence: ReadonlyMap<string, string> | null = null, snapshotError: TaskCacheError | null = null;
      const current = () => live() && attempt === generation && !signal.aborted;
      setState(old => old.scope === scope ? { ...old, loading: !old.loaded, error: cleanupErrors.values().next().value ?? null } : { scope, fence: null, items: [], loading: true, loaded: false, error: cleanupErrors.values().next().value ?? null });
      try {
        const prepared = await scope.prepareProjection(signal);
        if (!current()) return;
        requestFence = prepared;
        preparedFence = prepared; snapshotError = scope.projectionSnapshotError(prepared);
        if (scope.projectionSnapshotHasDenials(prepared)) setState(old => old.scope === scope ? { ...old,
          items: old.items.filter(project => !scope.projectionSnapshotDenied(prepared, project.id)),
          error: snapshotError ?? cleanupErrors.values().next().value ?? old.error } : old);
        const projects = new Map<string, Project>(), cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          await scope.ready(signal);
          const page = await listWorkerConfigurationProjects(cursor === null ? { limit: 100 } : { limit: 100, cursor }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
          if (!current()) return;
          for (const project of page.items) projects.set(project.id, project);
          cursor = page.nextCursor;
          if (cursor !== null) {
            if (cursors.has(cursor)) throw new ApiError('protocol');
            cursors.add(cursor);
          }
        } while (cursor !== null);
        await scope.ready(signal);
        if (current()) {
          controller = null; projection.fence = prepared;
          for (const projectId of cleanupErrors.keys()) if (!scope.isProjectionDenied(projectId)) cleanupErrors.delete(projectId);
          setState({ scope, fence: prepared, items: [...projects.values()].filter(project => !scope.projectionSnapshotDenied(prepared, project.id)), loading: false, loaded: true, error: snapshotError ?? scope.projectionSnapshotError(prepared) ?? cleanupErrors.values().next().value ?? null });
        }
      } catch (error) {
        if (current()) {
          controller = null;
          const failure = snapshotError ?? (preparedFence === null ? scope.projectionError : scope.projectionSnapshotError(preparedFence)) ?? cleanupErrors.values().next().value ?? error;
          setState(old => old.scope === scope ? { ...old, loading: false, error: failure } : { scope, fence: null, items: [], loading: false, loaded: false, error: failure });
        }
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') { ++generation; controller?.abort(); }
      else void load();
    };
    const invalidate = () => { ++generation; controller?.abort(); setState({ scope, fence: null, items: [], loading: false, loaded: false, error: null }); };
    const unsubscribe = scope.subscribeProjection(event => {
      if (event.accessRestored) {
        ++generation; controller?.abort(); controller = null;
        void load();
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
      if (cancelRequest) { ++generation; controller?.abort(); controller = null; }
      if (event.error instanceof TaskCacheError) cleanupErrors.set(event.projectId, event.error);
      const cleanupError = cleanupErrors.values().next().value ?? null;
      setState(old => {
        if (old.scope !== scope || !matches(scope, old.fence, event)) return old;
        return { ...old, items: old.items.filter(project => project.id !== event.projectId), loading: cancelRequest ? false : old.loading, error: cleanupError };
      });
      if (!(event.error instanceof TaskCacheError) && (cancelRequest || controller === null)) void load();
    });
    refreshAction.current = () => { void load(); };
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    void load();
    return () => { active = false; ++generation; controller?.abort(); refreshAction.current = () => {}; document.removeEventListener('visibilitychange', visibility); scope.signal.removeEventListener('abort', invalidate); unsubscribe(); };
  }, [scope, readEnabled]);
  const current = state.scope === scope && !scope.isInvalidated ? state : { items: [], loading: true, error: null };
  return { items: current.items, loading: current.loading, error: current.error, refresh };
};
