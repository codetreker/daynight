import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjectPeople } from '../../api/auth';
import { isAbortError } from '../../api/client';
import type { ProjectPerson } from '../../api/auth-types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskDetailSessions } from '../task-detail/TaskDetailSession';

export const useDirectAssigneeCatalogue = (projectId: string, taskId: string, enabled: boolean, identity: string) => {
  const scope = useTaskCacheScope();
  const sessions = useTaskDetailSessions();
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; items: readonly ProjectPerson[]; error: unknown }>({ status: 'idle', items: [], error: null });
  useEffect(() => {
    active.current?.abort();
    setState({ status: 'idle', items: [], error: null });
    return () => { active.current?.abort(); active.current = null; };
  }, [scope, projectId, taskId, identity, enabled]);
  const open = useCallback(() => {
    if (!enabled) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const signal = AbortSignal.any([controller.signal, scope.signal]);
    setState({ status: 'loading', items: [], error: null });
    void (async () => {
      try {
        await scope.ready(signal);
        const qualification = sessions.captureDirectQualification(projectId, taskId);
        if (qualification === null) throw new Error('Task observation is no longer current.');
        const result = await listProjectPeople(projectId, { kind: 'catalogue' }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
        await scope.ready(signal);
        if (signal.aborted) return;
        if (!await sessions.verifyDirectQualification(projectId, taskId, qualification, signal)) throw new Error('Task observation is no longer current.');
        setState({ status: 'ready', items: result.items, error: null });
      } catch (error) {
        if (!signal.aborted && !isAbortError(error)) setState({ status: 'error', items: [], error });
      }
    })();
  }, [scope, sessions, projectId, taskId, enabled]);
  return { ...state, people: new Map(state.items.map((person) => [person.userId, person])), unresolvedUserIds: new Set<string>(), open, retry: open };
};
