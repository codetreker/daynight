import { useCallback, useEffect, useState } from 'react';
import { assertResponsePrincipal, isAbortError, json, request, requestId } from '../../api/client';
import { parseTaskGraph } from '../../api/parse';
import { decodeTaskGraphJson } from '../../api/project-json';
import type { GraphTask } from '../../api/types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskDetailSessions } from './TaskDetailSession';

type Relations = { readonly nodes: ReadonlyMap<string, GraphTask>; readonly successors: readonly string[] };
type RelationState = { readonly relations: Relations | null; readonly error: unknown };

// A chain graph is a partial projection; context nodes may have dependencies outside it.
export const useTaskRelations = (projectId: string, taskId: string, history: number, active: boolean) => {
  const scope = useTaskCacheScope();
  const sessions = useTaskDetailSessions();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<RelationState>({ relations: null, error: null });
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    setState({ relations: null, error: null });
    if (!active) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    void (async () => {
      try {
        await scope.ready(signal);
        const qualification = sessions.captureDirectQualification(projectId, taskId);
        if (qualification === null) return;
        const project = requestId(projectId), task = requestId(taskId);
        const response = await request(`/api/v1/projects/${project}/task-graph?taskId=${encodeURIComponent(task)}`, signal, { headers: { Accept: 'application/json' } });
        assertResponsePrincipal(response, scope.userId, scope.principalMismatch);
        const graph = await json(response, signal, (value) => parseTaskGraph(value, project), decodeTaskGraphJson);
        const nodes = new Map(graph.tasks.map((item) => [item.id, item]));
        if (!nodes.has(task)) throw new Error('Task graph does not contain its requested task.');
        await scope.ready(signal);
        if (signal.aborted) return;
        if (!await sessions.verifyDirectQualification(projectId, taskId, qualification, signal)) {
          if (sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification)) setState({ relations: null, error: new Error('Task observation changed during relation read.') });
          return;
        }
        setState({ relations: { nodes, successors: graph.tasks.filter((item) => item.dependsOn.includes(task)).map((item) => item.id) }, error: null });
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) setState({ relations: null, error });
      }
    })();
    return () => controller.abort();
  }, [scope, sessions, projectId, taskId, history, active, attempt]);
  return { ...state, refresh };
};
