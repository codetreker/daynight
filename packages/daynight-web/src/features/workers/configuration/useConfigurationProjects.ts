import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import type { Project } from '../../../api/types';
import { listWorkerConfigurationProjects } from '../../../api/worker-configuration';
import { useTaskCacheScope } from '../../task-cache/TaskCacheProvider';

export const useConfigurationProjects = (readEnabled: boolean) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<{ readonly scope: typeof scope; readonly items: readonly Project[]; readonly loading: boolean; readonly error: unknown }>({ scope, items: [], loading: true, error: null });
  const refreshAction = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshAction.current(), []);
  useLayoutEffect(() => {
    let active = true, generation = 0;
    let controller: AbortController | null = null;
    const live = () => active && readEnabled && !scope.isInvalidated;
    const load = async () => {
      if (!live() || document.visibilityState === 'hidden') return;
      controller?.abort();
      const request = new AbortController(); controller = request;
      const signal = AbortSignal.any([request.signal, scope.signal]), attempt = ++generation;
      const current = () => live() && attempt === generation && !signal.aborted;
      setState(old => ({ scope, items: old.scope === scope ? old.items : [], loading: true, error: null }));
      try {
        await scope.ready(signal);
        const projects = new Map<string, Project>(), cursors = new Set<string>();
        let cursor: string | null = null;
        do {
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
        if (current()) setState({ scope, items: [...projects.values()], loading: false, error: null });
      } catch (error) {
        if (current()) setState({ scope, items: [], loading: false, error });
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') { ++generation; controller?.abort(); }
      else void load();
    };
    const invalidate = () => { ++generation; controller?.abort(); setState({ scope, items: [], loading: false, error: null }); };
    refreshAction.current = () => { void load(); };
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    void load();
    return () => { active = false; ++generation; controller?.abort(); refreshAction.current = () => {}; document.removeEventListener('visibilitychange', visibility); scope.signal.removeEventListener('abort', invalidate); };
  }, [scope, readEnabled]);
  const current = state.scope === scope && !scope.isInvalidated ? state : { items: [], loading: true, error: null };
  return { items: current.items, loading: current.loading, error: current.error, refresh };
};
