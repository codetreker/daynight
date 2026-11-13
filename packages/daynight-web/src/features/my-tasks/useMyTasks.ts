import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { listPersonalTasks, type PersonalTaskItem, type PersonalTaskProject } from '../../api/personal-tasks';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskCacheError } from '../task-cache/database';
import type { CacheEvent } from '../task-cache/project-cache';

type Fence = ReadonlyMap<string, string> | null;
type State = {
  readonly scope: TaskCacheScope; readonly fence: Fence; readonly items: readonly PersonalTaskItem[];
  readonly totalTaskCount: number | null; readonly totalProjectCount: number | null;
  readonly observedAt: string | null; readonly receivedMonotonic: number | null;
  readonly sessionPartial: boolean; readonly loading: boolean; readonly loaded: boolean; readonly stale: boolean; readonly error: unknown;
};
const initial = (scope: TaskCacheScope): State => ({ scope, fence: null, items: [], totalTaskCount: null, totalProjectCount: null,
  observedAt: null, receivedMonotonic: null, sessionPartial: false, loading: true, loaded: false, stale: false, error: null });
const matches = (scope: TaskCacheScope, fence: Fence, event: CacheEvent) => scope.projectionEventMatches(fence, event);
const sameProject = (a: PersonalTaskProject, b: PersonalTaskProject) => a.id === b.id && a.name === b.name &&
  a.ownerTeam.id === b.ownerTeam.id && a.ownerTeam.kind === b.ownerTeam.kind && a.ownerTeam.name === b.ownerTeam.name &&
  a.executionWarningMinutes === b.executionWarningMinutes && a.matchedTaskCount === b.matchedTaskCount;
const visible = (scope: TaskCacheScope, fence: ReadonlyMap<string, string>, items: readonly PersonalTaskItem[]) =>
  items.filter(item => !scope.projectionSnapshotDenied(fence, item.project.id));
const incomplete = (state: State, items: readonly PersonalTaskItem[], error: unknown): State => ({ ...state, items, totalTaskCount: null, totalProjectCount: null, loaded: false, stale: true, error });

export const useMyTasks = (readEnabled: boolean) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<State>(() => initial(scope));
  const refreshAction = useRef<() => void>(() => {});
  const history = useRef<{ scope: TaskCacheScope; fence: Fence; hasComplete: boolean; errors: Map<string, unknown> }>({ scope, fence: null, hasComplete: false, errors: new Map() });
  if (history.current.scope !== scope) history.current = { scope, fence: null, hasComplete: false, errors: new Map() };
  const refresh = useCallback(() => refreshAction.current(), []);
  useLayoutEffect(() => {
    let active = true, generation = 0, queued = false;
    let controller: AbortController | null = null, requestFence: Fence = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const projection = history.current;
    const cleanupErrors = projection.errors;
    const allowed = () => active && readEnabled && !scope.isInvalidated;
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = allowed() ? setTimeout(() => { timer = null; if (controller === null) void load(); else schedule(); }, document.visibilityState === 'hidden' ? 300_000 : 15_000) : null;
    };
    const load = async () => {
      if (!allowed()) return;
      if (controller !== null) { queued = true; return; }
      const request = new AbortController(); controller = request; requestFence = null;
      const signal = AbortSignal.any([request.signal, scope.signal]), attempt = ++generation;
      const current = () => allowed() && !signal.aborted && generation === attempt;
      let fence: ReadonlyMap<string, string> | null = null;
      setState(old => old.scope === scope ? { ...old, loading: !old.loaded } : initial(scope));
      try {
        fence = await scope.prepareProjection(signal);
        if (!current()) return;
        requestFence = fence;
        const prepared = fence;
        await scope.ready(signal);
        if (!current()) return;
        setState(old => {
          if (old.scope !== scope || !current()) return old;
          const filtered = visible(scope, prepared, old.items);
          const denied = scope.projectionSnapshotHasDenials(prepared) || filtered.length !== old.items.length;
          return denied ? incomplete(old, filtered, scope.projectionSnapshotError(prepared) ?? cleanupErrors.values().next().value ?? old.error) : old;
        });
        const items: PersonalTaskItem[] = [], ids = new Set<string>(), cursors = new Set<string>();
        const projects = new Map<string, { project: PersonalTaskProject; count: number }>();
        let cursor: string | null = null, revision: string | null = null, totalTasks = -1, totalProjects = -1, sessionPartial = false;
        let lastObservedAt: string | null = null, lastReceived: number | null = null;
        do {
          await scope.ready(signal);
          if (!current()) return;
          const page = await listPersonalTasks(cursor, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
          const received = performance.now();
          if (!current()) return;
          if (revision === null) { revision = page.inventoryRevision; totalTasks = page.totalTaskCount; totalProjects = page.totalProjectCount; }
          else if (revision !== page.inventoryRevision || totalTasks !== page.totalTaskCount || totalProjects !== page.totalProjectCount) throw new ApiError('protocol');
          for (const item of page.items) {
            if (ids.has(item.task.id)) throw new ApiError('protocol');
            ids.add(item.task.id);
            const group = projects.get(item.project.id);
            if (group !== undefined && !sameProject(group.project, item.project)) throw new ApiError('protocol');
            if (group === undefined) projects.set(item.project.id, { project: item.project, count: 1 });
            else group.count++;
            items.push({ ...item, observedAt: page.observedAt, receivedMonotonic: received });
          }
          sessionPartial ||= page.sessionPartial; lastObservedAt = page.observedAt; lastReceived = received;
          cursor = page.nextCursor;
          if (cursor !== null) { if (cursors.has(cursor)) throw new ApiError('protocol'); cursors.add(cursor); }
          if (items.length > totalTasks || projects.size > totalProjects || [...projects.values()].some(group => group.count > group.project.matchedTaskCount)) throw new ApiError('protocol');
          await scope.ready(signal);
          if (!current()) return;
          if (cursor !== null && !projection.hasComplete) {
            const partial = visible(scope, prepared, items);
            projection.fence = prepared;
            setState(old => old.scope !== scope || !current() || old.loaded ? old : { ...old, fence: prepared, items: partial,
              observedAt: lastObservedAt, receivedMonotonic: lastReceived, sessionPartial, loading: true,
              error: scope.projectionSnapshotError(prepared) ?? cleanupErrors.values().next().value ?? null });
          }
        } while (cursor !== null);
        if (items.length !== totalTasks || projects.size !== totalProjects || [...projects.values()].some(group => group.count !== group.project.matchedTaskCount)) throw new ApiError('protocol');
        await scope.ready(signal);
        if (!current()) return;
        for (const projectId of cleanupErrors.keys()) if (!scope.isProjectionDenied(projectId)) cleanupErrors.delete(projectId);
        const filtered = visible(scope, prepared, items), denied = scope.projectionSnapshotHasDenials(prepared) || filtered.length !== items.length;
        const error = scope.projectionSnapshotError(prepared) ?? cleanupErrors.values().next().value ?? null;
        projection.fence = prepared;
        projection.hasComplete ||= !denied && error === null;
        setState(old => {
          if (old.scope !== scope || !current()) return old;
          const base = { scope, fence: prepared, items: filtered, totalTaskCount: totalTasks, totalProjectCount: totalProjects,
            observedAt: lastObservedAt, receivedMonotonic: lastReceived, sessionPartial, loading: false, loaded: true, stale: false, error };
          return denied || error !== null ? incomplete(base, filtered, error) : base;
        });
      } catch (error) {
        if (!current()) return;
        let readinessFailed = false;
        try { await scope.ready(signal); } catch (readyError) { error = readyError; readinessFailed = true; }
        if (!current()) return;
        const failedFence = fence;
        setState(old => {
          if (old.scope !== scope || !current()) return old;
          const filtered = failedFence === null || readinessFailed ? [] : visible(scope, failedFence, old.items);
          const failure = failedFence === null ? scope.projectionError ?? error : scope.projectionSnapshotError(failedFence) ?? cleanupErrors.values().next().value ?? error;
          const denied = failedFence === null || readinessFailed || scope.projectionSnapshotHasDenials(failedFence) || filtered.length !== old.items.length;
          const base = { ...old, loading: false, stale: true, error: failure };
          return denied ? incomplete(base, filtered, failure) : base;
        });
      } finally {
        if (attempt === generation) {
          controller = null; requestFence = null;
          if (queued && allowed()) { queued = false; void load(); } else schedule();
        }
      }
    };
    const cancel = () => { ++generation; controller?.abort(); controller = null; requestFence = null; };
    const unsubscribe = scope.subscribeProjection(event => {
      if (event.accessRestored) { cancel(); queued = false; void load(); return; }
      if (!event.accessRevoked && !event.scopeSuspended) {
        if (scope.getAuthorizedProject(event.projectId) !== null) cleanupErrors.delete(event.projectId);
        return;
      }
      const affectsPublished = matches(scope, projection.fence, event);
      const affectsRequest = controller !== null && matches(scope, requestFence, event);
      if (!affectsPublished && !affectsRequest) return;
      if (affectsRequest) cancel();
      if (event.error instanceof TaskCacheError) cleanupErrors.set(event.projectId, event.error);
      setState(old => {
        if (old.scope !== scope || !matches(scope, old.fence, event)) return old;
        const kept = old.items.filter(item => item.project.id !== event.projectId);
        return { ...incomplete(old, kept, cleanupErrors.values().next().value ?? old.error), loading: false };
      });
      queued = false;
      if (!(event.error instanceof TaskCacheError)) void load(); else schedule();
    });
    const visibility = () => { if (document.visibilityState !== 'hidden') void load(); schedule(); };
    const invalidate = () => { cancel(); queued = false; setState(initial(scope)); };
    refreshAction.current = () => { void load(); };
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    void load(); schedule();
    return () => { active = false; cancel(); if (timer !== null) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); scope.signal.removeEventListener('abort', invalidate); unsubscribe(); refreshAction.current = () => {}; };
  }, [scope, readEnabled]);
  const current = state.scope === scope && !scope.isInvalidated ? state : initial(scope);
  return { items: current.items, totalTaskCount: current.totalTaskCount, totalProjectCount: current.totalProjectCount,
    observedAt: current.observedAt, receivedMonotonic: current.receivedMonotonic, sessionPartial: current.sessionPartial,
    loading: current.loading, loaded: current.loaded, stale: current.stale, error: current.error, refresh };
};
