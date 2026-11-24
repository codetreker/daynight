import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getGoalDependencies, type GoalDependencies } from '../../api/goal-dependencies';
import { pollingInterval } from '../../app/polling';
import { browserNavigation } from '../../app/navigation';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskDetailSessions } from '../task-detail/TaskDetailSession';
import { goalDependencyPosition, saveGoalDependencyPosition, type GoalDependencyPosition } from './goal-dependency-reading';

type State = { readonly owner: object; readonly page: GoalDependencies | null; readonly unavailable: boolean; readonly error: unknown;
  readonly pending: boolean; readonly cursor: string | null; readonly previous: readonly (string | null)[] };
const initial = (owner: object, position?: Pick<GoalDependencyPosition, 'cursor' | 'previous'>): State => ({ owner, page: null, unavailable: false, error: null, pending: false,
  cursor: position === undefined ? null : position.cursor, previous: position === undefined ? [] : position.previous });
const denied = (error: unknown) => error instanceof ApiError && error.kind === 'server' && [401, 403, 404, 410].includes(error.status ?? 0);

export const useGoalDependencies = (projectId: string, goalId: string, history: number, active: boolean, onSourceDenied: () => void) => {
  const scope = useTaskCacheScope(), sessions = useTaskDetailSessions();
  const entryId = browserNavigation().snapshot().entryId;
  const resource = useMemo(() => ({}), [scope, sessions, projectId, goalId, history]);
  const retained = useRef<{ readonly resource: object; readonly position: Pick<GoalDependencyPosition, 'cursor' | 'previous'> } | null>(null);
  const owner = useMemo(() => ({}), [resource, entryId]);
  const opening = useMemo(() => {
    const position = goalDependencyPosition(scope, entryId, { projectId, goalId, history });
    // New tab entries inherit the current reader; revisited entries reread their
    // own coordinates, even when the same Goal component remains mounted.
    if (position === undefined && retained.current?.resource === resource) return initial(owner, retained.current.position);
    return initial(owner, position);
  }, [scope, projectId, goalId, history, resource, owner, entryId]);
  const [state, setState] = useState<State>(() => opening);
  const stateRef = useRef(state); stateRef.current = state;
  const sourceDenied = useRef(onSourceDenied); sourceDenied.current = onSourceDenied;
  const readRef = useRef<(cursor: string | null, previous: readonly (string | null)[], replace: boolean) => void>(() => {});
  useEffect(() => {
    if (stateRef.current.owner !== owner) setState(opening);
    let disposed = false, sequence = 0;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let publishedFence: ReadonlyMap<string, string> | null = null;
    const registrations = new Map<string, () => void>();
    const register = (projectIds: readonly string[]) => { for (const id of projectIds) if (!registrations.has(id)) registrations.set(id, scope.registerProjectionProjects([id])); };
    register([projectId]);
    const candidates = (page: GoalDependencies) => [{ projectId, id: goalId }, ...[...page.prerequisites.flatMap(item => item.target === null ? [] : [item.target]), ...page.successors].map(item => ({ projectId: item.projectId, id: item.goalId }))];
    const qualifiedPage = (page: GoalDependencies, allowed: ReadonlySet<string>): GoalDependencies => candidates(page).every(item => allowed.has(`${item.projectId}/${item.id}`)) ? page : ({ ...page,
      prerequisites: page.prerequisites.map(item => item.target !== null && !allowed.has(`${item.target.projectId}/${item.target.goalId}`) ? { ...item, target: null } : item),
      successors: page.successors.filter(item => allowed.has(`${item.projectId}/${item.goalId}`)) });
    const cancel = () => { sequence++; controller?.abort(); controller = null; };
    const read = (cursor: string | null, previous: readonly (string | null)[], replace: boolean) => {
      if (!active || disposed || document.visibilityState === 'hidden') return;
      if (controller !== null) { if (!replace) return; cancel(); }
      const current = new AbortController(); controller = current;
      const requestSequence = ++sequence;
      const signal = AbortSignal.any([current.signal, scope.signal, scope.mismatchSignal]);
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let qualification: ReturnType<typeof sessions.captureDirectQualification> = null;
      const currentRequest = () => !disposed && sequence === requestSequence && !signal.aborted;
      const publishError = async (error: unknown) => {
        const accessDenied = denied(error);
        if (!accessDenied) { try { await scope.ready(scope.signal); } catch { return; } }
        if (disposed || sequence !== requestSequence || qualification === null ||
          !sessions.isDirectQualificationHistoryCurrent(projectId, goalId, qualification) ||
          !accessDenied && sessions.captureDirectQualification(projectId, goalId) === null) return;
        if (error instanceof ApiError && error.status === 410 && error.code === 'task_deleted' && sessions.reportDirectTaskDeleted(projectId, goalId, qualification)) return;
        setState(old => old.owner === owner ? { ...old, page: accessDenied ? null : old.page, unavailable: false, pending: false, error } : old);
        if (accessDenied) sourceDenied.current();
      };
      void (async () => {
        try {
          await scope.ready(signal);
          if (!currentRequest()) return;
          qualification = sessions.captureDirectQualification(projectId, goalId);
          if (qualification === null) return;
          const projectionFence = await scope.prepareProjection(signal);
          const retainedState = stateRef.current;
          if (retainedState.owner === owner && retainedState.page !== null && publishedFence !== null) {
            const allowed = await scope.qualifyProjection(publishedFence, candidates(retainedState.page), signal);
            if (!currentRequest()) return;
            const retained = allowed.has(`${projectId}/${goalId}`) ? qualifiedPage(retainedState.page, allowed) : null;
            setState(old => old.owner === owner && old.page === retainedState.page ? { ...old, page: retained } : old);
          }
          setState(old => old.owner === owner ? { ...old, pending: true } : { ...opening, pending: true });
          const result = await getGoalDependencies(projectId, goalId, cursor, signal, {
            userId: scope.userId, onPrincipalMismatch: scope.principalMismatch,
            onDispatch: () => { timeout = setTimeout(() => {
              if (!currentRequest()) return;
              current.abort(); if (controller === current) controller = null;
              void publishError(new ApiError('network'));
            }, 30_000); },
          });
          await scope.ready(signal);
          if (!currentRequest() || qualification === null ||
            !await sessions.verifyDirectQualificationHistory(projectId, goalId, qualification, signal) ||
            sessions.captureDirectQualification(projectId, goalId) === null || !currentRequest()) return;
          let page: GoalDependencies | null = null;
          if (result.kind === 'available') {
            const targets = candidates(result.page); register(targets.map(item => item.projectId));
            const allowed = await scope.qualifyProjection(projectionFence, targets, signal);
            if (!currentRequest()) return;
            if (!allowed.has(`${projectId}/${goalId}`)) { setState(old => old.owner === owner ? { ...initial(owner), error: null } : old); sourceDenied.current(); return; }
            page = qualifiedPage(result.page, allowed);
          }
          if (entryId !== null && browserNavigation().snapshot().entryId === entryId) {
            saveGoalDependencyPosition(scope, entryId, { projectId, goalId, history, cursor, previous });
          }
          publishedFence = projectionFence;
          setState({ owner, page, unavailable: result.kind === 'unavailable',
            error: null, pending: false, cursor, previous });
        } catch (error) {
          if (!currentRequest() || isAbortError(error)) return;
          await publishError(error);
        } finally {
          if (timeout !== null) clearTimeout(timeout);
          if (controller === current) { controller = null; if (!disposed && sequence === requestSequence) setState(old => old.owner === owner ? { ...old, pending: false } : old); }
        }
      })();
    };
    readRef.current = read;
    const refresh = () => {
      const current = stateRef.current.owner === owner ? stateRef.current : opening;
      read(current.cursor, current.previous, false);
    };
    const visibility = () => {
      if (timer !== null) clearInterval(timer); timer = null;
      if (!active || document.visibilityState === 'hidden') { cancel(); return; }
      refresh(); timer = setInterval(refresh, pollingInterval('taskSync'));
    };
    const unsubscribe = scope.subscribe(event => {
      if (event.deletedTaskIds !== undefined || event.baselineRebuilt || event.taskDeletionHint !== undefined) {
        if (event.deletedTaskIds?.length === 0 && !event.baselineRebuilt && event.taskDeletionHint === undefined) return;
        if (!registrations.has(event.projectId)) return;
        const removed = new Set(event.deletedTaskIds ?? (event.taskDeletionHint === undefined ? [] : [event.taskDeletionHint.taskId]));
        const currentPage = stateRef.current.owner === owner ? stateRef.current.page : null;
        if (!event.baselineRebuilt && event.taskDeletionHint === undefined && !(event.projectId === projectId && removed.has(goalId)) &&
          (currentPage === null || !candidates(currentPage).some(item => item.projectId === event.projectId && removed.has(item.id)))) return;
        cancel();
        const previous = stateRef.current, fence = publishedFence;
        setState(old => {
          if (old.owner !== owner) return old;
          if (event.projectId === projectId && removed.has(goalId)) return initial(owner);
          return { ...old, cursor: null, previous: [], pending: false, page: old.page === null ? null : { ...old.page, nextCursor: null,
            prerequisites: old.page.prerequisites.map(item => item.target?.projectId === event.projectId && removed.has(item.target.goalId) ? { ...item, target: null } : item),
            successors: old.page.successors.filter(item => item.projectId !== event.projectId || !removed.has(item.goalId)) } };
        });
        if (event.projectId === projectId && removed.has(goalId)) { sourceDenied.current(); return; }
        if (event.baselineRebuilt && previous.owner === owner && previous.page !== null && fence !== null) {
          const page = previous.page;
          void scope.qualifyProjection(fence, candidates(page), scope.signal).then(allowed => {
            if (disposed || publishedFence !== fence) return;
            setState(old => old.owner !== owner || old.page === null ? old : { ...old, page: allowed.has(`${projectId}/${goalId}`) ? qualifiedPage(old.page, allowed) : null });
            if (!allowed.has(`${projectId}/${goalId}`)) sourceDenied.current();
          }).catch(error => { if (!disposed && !isAbortError(error)) setState(old => old.owner === owner ? { ...old, page: null, error } : old); });
        }
        read(null, [], false); return;
      }
      if (!event.accessRevoked && !event.directAccessUncertain && !event.historyChanged) return;
      // An in-flight page may contain a peer not present in the displayed page.
      // Every permission withdrawal invalidates that page before it can publish.
      cancel();
      setState(old => {
        if (old.owner !== owner) return old;
        if (event.projectId === projectId) return { ...initial(owner), error: event.error ?? new ApiError('server', 403, 'forbidden') };
        if (old.page === null) return { ...old, pending: false };
        return { ...old, pending: false, page: { ...old.page,
          prerequisites: old.page.prerequisites.map(item => item.target?.projectId === event.projectId
            ? { ...(item.edgeId === undefined ? {} : { edgeId: item.edgeId }), target: null } : item),
          successors: old.page.successors.filter(item => item.projectId !== event.projectId) } };
      });
    });
    visibility();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', refresh);
    return () => { disposed = true; cancel(); readRef.current = () => {}; unsubscribe(); for (const unregister of registrations.values()) unregister(); if (timer !== null) clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', refresh); };
  }, [scope, sessions, projectId, goalId, history, owner, opening, active, entryId]);
  const visible = state.owner === owner ? state : opening;
  retained.current = { resource, position: { cursor: visible.cursor, previous: visible.previous } };
  const refresh = useCallback(() => { const current = stateRef.current.owner === owner ? stateRef.current : opening; readRef.current(current.cursor, current.previous, true); }, [owner, opening]);
  const next = useCallback(() => { const current = stateRef.current; if (current.owner === owner && current.page?.nextCursor != null && !current.pending) readRef.current(current.page.nextCursor, [...current.previous, current.cursor], true); }, [owner]);
  const previous = useCallback(() => { const current = stateRef.current; if (current.owner === owner && current.previous.length > 0 && !current.pending) readRef.current(current.previous.at(-1)!, current.previous.slice(0, -1), true); }, [owner]);
  return { page: visible.page, unavailable: visible.unavailable, error: visible.error, pending: visible.pending,
    position: { projectId, goalId, history, cursor: visible.cursor, previous: visible.previous },
    hasPrevious: visible.previous.length > 0, refresh, next, previous };
};
