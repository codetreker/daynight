import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, assertResponsePrincipal, isAbortError, json, request, requestId, responseSignal } from '../../api/client';
import { parseTaskGraph } from '../../api/parse';
import { decodeTaskGraphJson } from '../../api/project-json';
import type { GraphTask } from '../../api/types';
import { pollingInterval } from '../../app/polling';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskDetailSessions } from './TaskDetailSession';

type Relations = { readonly nodes: ReadonlyMap<string, GraphTask>; readonly successors: readonly string[] };
type RelationState = { readonly owner: object; readonly relations: Relations | null; readonly error: unknown };

// A chain graph is a partial projection; context nodes may have dependencies outside it.
export const useTaskRelations = (projectId: string, taskId: string, history: number, active: boolean) => {
  const scope = useTaskCacheScope();
  const sessions = useTaskDetailSessions();
  const owner = useMemo(() => ({}), [scope, sessions, projectId, taskId, history]);
  const [state, setState] = useState<RelationState>({ owner, relations: null, error: null });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    setState({ owner, relations: null, error: null });
    if (!active) return;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    let pendingTimeout: ReturnType<typeof sessions.captureDirectQualification> = null;
    let sequence = 0;
    const showTimeout = () => {
      const qualification = pendingTimeout;
      if (qualification === null) return;
      void scope.ready(scope.signal).then(() => {
        if (disposed || pendingTimeout !== qualification || document.visibilityState === 'hidden' ||
          !sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification) ||
          sessions.captureDirectQualification(projectId, taskId) === null) return;
        setState(old => old.owner === owner ? { ...old, error: new ApiError('network') } : old);
      }).catch(() => {});
    };
    const read = () => {
      if (disposed || document.visibilityState === 'hidden' || controller !== null) return;
      const current = new AbortController(); controller = current;
      const requestSequence = ++sequence;
      const signal = AbortSignal.any([current.signal, scope.signal]);
      void (async () => {
        let qualification: ReturnType<typeof sessions.captureDirectQualification> = null;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        try {
          await scope.ready(signal);
          qualification = sessions.captureDirectQualification(projectId, taskId);
          if (qualification === null) return;
          const project = requestId(projectId), task = requestId(taskId);
          const response = await request(`/api/v1/projects/${project}/task-graph?taskId=${encodeURIComponent(task)}`, signal, { headers: { Accept: 'application/json' } }, () => {
            deadline = setTimeout(() => {
              if (disposed || sequence !== requestSequence || signal.aborted) return;
              pendingTimeout = qualification;
              current.abort();
              if (controller === current) controller = null;
              // Timeout is an ordinary failure, so publication waits for the
              // identity gate and still belongs to this opening and request.
              showTimeout();
            }, 30_000);
          });
          assertResponsePrincipal(response, scope.userId, scope.principalMismatch);
          const graph = await json(response, signal, (value) => parseTaskGraph(value, project), decodeTaskGraphJson);
          const responseLifetime = responseSignal(response, signal);
          responseLifetime.throwIfAborted();
          const nodes = new Map(graph.tasks.map((item) => [item.id, item]));
          if (!nodes.has(task)) throw new Error('Task graph does not contain its requested task.');
          await scope.ready(responseLifetime);
          // A same-history Task refresh may replace its receipt while this
          // independent graph read is in flight. Both the original opening and
          // the current Task must still be admitted before publishing it.
          if (responseLifetime.aborted || !await sessions.verifyDirectQualificationHistory(projectId, taskId, qualification, responseLifetime) ||
            sessions.captureDirectQualification(projectId, taskId) === null || responseLifetime.aborted) return;
          pendingTimeout = null;
          setState({ owner, relations: { nodes, successors: graph.tasks.filter((item) => item.dependsOn.includes(task)).map((item) => item.id) }, error: null });
        } catch (error) {
          if (signal.aborted || isAbortError(error)) return;
          const denied = error instanceof ApiError && error.kind === 'server' && [401, 403, 404, 410].includes(error.status ?? 0);
          if (!denied) { try { await scope.ready(signal); } catch { return; } }
          if (signal.aborted || qualification !== null && (!sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification) ||
            !denied && sessions.captureDirectQualification(projectId, taskId) === null)) return;
          pendingTimeout = null;
          setState(old => old.owner === owner ? { owner, relations: denied ? null : old.relations, error } : old);
        } finally { if (deadline !== null) clearTimeout(deadline); if (controller === current) controller = null; }
      })();
    };
    const visibility = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (document.visibilityState === 'hidden') { sequence++; controller?.abort(); controller = null; return; }
      showTimeout();
      read();
      timer = setInterval(read, pollingInterval('taskSync'));
    };
    refreshRef.current = () => { sequence++; controller?.abort(); controller = null; pendingTimeout = null; read(); };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; refreshRef.current = () => {}; if (timer !== null) clearInterval(timer); controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [scope, sessions, projectId, taskId, history, active, owner]);
  const visible = active && state.owner === owner ? state : { owner, relations: null, error: null };
  return { relations: visible.relations, error: visible.error, refresh };
};
