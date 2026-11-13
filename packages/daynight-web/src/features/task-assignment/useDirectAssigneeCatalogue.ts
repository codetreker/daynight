import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjectPeople } from '../../api/auth';
import { authRequestsPauseRevision } from '../../api/client';
import type { ProjectPerson } from '../../api/auth-types';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { isRetryableTaskCacheLifecycleChange } from '../task-cache/project-cache';
import { canSetAssignedTo, useTaskDetailSessions } from '../task-detail/TaskDetailSession';

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
    // Capture the opening synchronously, including while same-account checks
    // suspend requests; a later opening cannot authorize this intent.
    const qualification = sessions.captureDirectQualification(projectId, taskId, true);
    void (async () => {
      try {
        if (qualification === null || !canSetAssignedTo(sessions.snapshot(projectId, taskId))) throw new Error('Task observation is no longer current.');
        // The catalogue is a project resource; a newer receipt can authorize it
        // only within the original opening and history, with current write eligibility.
        const eligible = () => sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification) &&
          sessions.captureDirectQualification(projectId, taskId) !== null && canSetAssignedTo(sessions.snapshot(projectId, taskId));
        const runQualified = async <T,>(work: () => T): Promise<T> => {
          for (;;) {
            const pauseRevision = authRequestsPauseRevision();
            try {
              await scope.ready(signal);
              const current = await sessions.verifyDirectQualificationHistory(projectId, taskId, qualification, signal);
              if (authRequestsPauseRevision() !== pauseRevision && !signal.aborted && !scope.isInvalidated &&
                sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification)) continue;
              signal.throwIfAborted();
              if (!current || !eligible()) throw new Error('Task observation is no longer current.');
              return work();
            } catch (error) {
              if (isRetryableTaskCacheLifecycleChange(error) && authRequestsPauseRevision() !== pauseRevision && !signal.aborted && !scope.isInvalidated &&
                sessions.isDirectQualificationHistoryCurrent(projectId, taskId, qualification)) continue;
              throw error;
            }
          }
        };
        const result = await runQualified(() => listProjectPeople(projectId, { kind: 'catalogue' }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }));
        await runQualified(() => { scope.markProjectReadable(projectId); setState({ status: 'ready', items: result.items, error: null }); });
      } catch (error) {
        if (!signal.aborted && !scope.isInvalidated) setState({ status: 'error', items: [], error });
      }
    })();
  }, [scope, sessions, projectId, taskId, enabled]);
  return { ...state, people: new Map(state.items.map((person) => [person.userId, person])), unresolvedUserIds: new Set<string>(), open, retry: open };
};
