import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useBrowserLocation } from './browser-location';
import { browserNavigation } from './navigation';
import { accountHistory, emptyMyTasksReading, emptyResourceReading, myTasksHistory, projectHistory, readAccountHistory, readMyTasksHistory, readProjectHistory, readResourceHistory, resourceHistory, workerHistory, readWorkerHistory, type AccountTab, type MyTasksReading, type ProjectReading, type ResourcePageReading, type WorkerSection } from './page-history';
import { parseAuthRoute, parseRoute } from './router';
import type { TaskCacheScope } from '../features/task-cache/project-cache';

type ResourceFence = { generation: number; readonly entries: Map<string, number>; readonly listeners: Set<() => void> };
const resourceFences = new WeakMap<TaskCacheScope, Map<string, ResourceFence>>();
const resourceFencesFor = (scope: TaskCacheScope): Map<string, ResourceFence> => {
  let projects = resourceFences.get(scope);
  if (projects !== undefined) return projects;
  projects = new Map();
  resourceFences.set(scope, projects);
  const all = projects;
  const unsubscribe = scope.subscribe(event => {
    if (!(event.historyChanged || event.accessRevoked)) return;
    let fence = all.get(event.projectId);
    if (fence === undefined) { fence = { generation: 0, entries: new Map(), listeners: new Set() }; all.set(event.projectId, fence); }
    fence.generation++;
    for (const listener of fence.listeners) listener();
  });
  scope.signal.addEventListener('abort', unsubscribe, { once: true });
  return projects;
};
const resourceFence = (scope: TaskCacheScope, projectId: string): ResourceFence => {
  const projects = resourceFencesFor(scope);
  let fence = projects.get(projectId);
  if (fence !== undefined) return fence;
  fence = { generation: 0, entries: new Map(), listeners: new Set() };
  projects.set(projectId, fence);
  return fence;
};

/** Observe only Project history and access retirement, not ordinary cache changes. */
export function useProjectHistoryGeneration(scope: TaskCacheScope, projectId: string): number {
  const fence = resourceFence(scope, projectId);
  const subscribe = useCallback((listener: () => void) => {
    fence.listeners.add(listener);
    return () => { fence.listeners.delete(listener); };
  }, [fence]);
  return useSyncExternalStore(subscribe, () => fence.generation);
}

/** A numbered entry may carry a selection from a retired project history. */
export const isRetiredResourceEntry = (scope: TaskCacheScope, projectId: string, entryId: string): boolean => {
  const fence = resourceFence(scope, projectId);
  return fence.entries.get(entryId) !== fence.generation;
};

/** Restored entries are admitted until this identity observes a retirement. */
export const isRetiredMyTasksEntry = (scope: TaskCacheScope, projectId: string, entryId: string): boolean => {
  const fence = resourceFence(scope, projectId);
  return (fence.entries.get(entryId) ?? 0) !== fence.generation;
};

/** The overview retains page positions and resource readers, never their contents. */
export function useMyTasksHistory(userId: string, active: boolean, scope: TaskCacheScope) {
  resourceFencesFor(scope);
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const retained = useRef<{ userId: string; scope: TaskCacheScope; selection: MyTasksReading; onPage: boolean; fence: ResourceFence | null; generation: number }>({ userId, scope, selection: emptyMyTasksReading(), onPage: false, fence: null, generation: 0 });
  if (retained.current.userId !== userId || retained.current.scope !== scope) retained.current = { userId, scope, selection: emptyMyTasksReading(), onPage: false, fence: null, generation: 0 };
  const onPage = active && parseAuthRoute(location.pathname, location.search).kind === 'myTasks';
  if (onPage && !retained.current.onPage) retained.current.selection = emptyMyTasksReading();
  retained.current.onPage = onPage;
  let selected: MyTasksReading | null = null;
  let error = false;
  if (onPage) {
    try { selected = readMyTasksHistory(location.view, userId); }
    catch { error = true; }
  }
  const projectId = selected?.detail?.projectId ?? retained.current.selection.detail?.projectId;
  const fence = projectId === undefined ? null : resourceFence(scope, projectId);
  const subscribe = useCallback((listener: () => void) => {
    if (fence === null) return () => {};
    fence.listeners.add(listener);
    return () => { fence.listeners.delete(listener); };
  }, [fence]);
  const generation = useSyncExternalStore(subscribe, () => fence?.generation ?? 0);
  if (retained.current.fence === fence && retained.current.generation !== generation) retained.current.selection = { ...retained.current.selection, detail: null };
  retained.current.fence = fence;
  retained.current.generation = generation;
  const retired = selected?.detail !== null && selected?.detail !== undefined && location.entryId !== null &&
    isRetiredMyTasksEntry(scope, selected.detail.projectId, location.entryId);
  if (retired && selected !== null) selected = { ...selected, detail: null };
  const selection = !onPage || location.entryId === null ? retained.current.selection : selected ?? emptyMyTasksReading();
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.selection = selection;
    if (location.entryId !== null && (selected === null || retired)) navigation.setView(myTasksHistory(userId, selection), { replace: true });
  }, [onPage, error, selection, selected, retired, location.entryId, navigation, userId, generation]);
  const select = (next: MyTasksReading, replace = false, onCommit?: () => void) => {
    if (!onPage || error) return;
    if (location.entryId !== null && selected === null) navigation.setView(myTasksHistory(userId, selection), { replace: true });
    navigation.setView(myTasksHistory(userId, next), { replace, onCommit: () => {
      const entryId = navigation.snapshot().entryId;
      if (next.detail !== null && entryId !== null) {
        const nextFence = resourceFence(scope, next.detail.projectId);
        nextFence.entries.set(entryId, nextFence.generation);
      }
      onCommit?.();
    } });
  };
  return { selection, select, error };
}

/** The active account page consumes only admitted, identity-bound selections. */
export function useAccountHistory(userId: string, active: boolean) {
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const retained = useRef<{ userId: string; tab: AccountTab }>({ userId, tab: 'profile' });
  if (retained.current.userId !== userId) retained.current = { userId, tab: 'profile' };
  const onPage = active && location.pathname === '/account';
  let selected: AccountTab | null = null;
  let error = false;
  if (onPage) {
    try { selected = readAccountHistory(location.view, userId); }
    catch { error = true; }
  }
  const tab = !onPage || location.entryId === null ? retained.current.tab : selected ?? 'profile';
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.tab = tab;
    if (location.entryId !== null && selected === null) navigation.setView(accountHistory(userId, tab), { replace: true });
  }, [onPage, error, tab, selected, location.entryId, navigation, userId]);
  const select = (next: AccountTab, replace = false) => {
    if (!onPage || error) return;
    if (location.entryId !== null && selected === null) navigation.setView(accountHistory(userId, tab), { replace: true });
    if (next !== tab) navigation.setView(accountHistory(userId, next), { replace });
  };
  return { tab, select, error };
}

/** Project entries hold the complete reading position, while preferences remain user actions. */
export function useProjectHistory(userId: string, projectId: string, active: boolean, defaults: Pick<ProjectReading, 'section' | 'view'>, scope: TaskCacheScope) {
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const fence = resourceFence(scope, projectId);
  const subscribe = useCallback((listener: () => void) => {
    fence.listeners.add(listener);
    return () => { fence.listeners.delete(listener); };
  }, [fence]);
  const generation = useSyncExternalStore(subscribe, () => fence.generation);
  const key = `${userId}/${projectId}`;
  const empty = (): ProjectReading => ({ ...defaults, projectGraphWitness: null, detail: null });
  const retained = useRef<{ key: string; generation: number; selection: ProjectReading; onPage: boolean }>({ key, generation, selection: empty(), onPage: false });
  if (retained.current.key !== key || retained.current.generation !== generation) retained.current = { key, generation, selection: empty(), onPage: false };
  const route = parseRoute(location.pathname, location.search);
  const onPage = active && route.kind === 'project' && route.projectId === projectId;
  if (onPage && !retained.current.onPage) retained.current.selection = empty();
  retained.current.onPage = onPage;
  let selected: ProjectReading | null = null;
  let error = false;
  if (onPage) {
    try { selected = readProjectHistory(location.view, userId, projectId); }
    catch { error = true; }
  }
  const readSelection = selected;
  const retired = location.entryId !== null && selected !== null && isRetiredResourceEntry(scope, projectId, location.entryId);
  if (retired) selected = null;
  const selection = !onPage || location.entryId === null ? retained.current.selection : selected ?? empty();
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.selection = selection;
    if (retired && location.entryId !== null && readSelection?.projectGraphWitness === null && readSelection.detail === null) fence.entries.set(location.entryId, generation);
    if (location.entryId !== null && selected === null) navigation.setView(projectHistory(userId, projectId, selection), { replace: true, onCommit: () => {
      const entryId = navigation.snapshot().entryId;
      if (entryId !== null) fence.entries.set(entryId, generation);
    } });
  }, [onPage, error, selection, selected, location.entryId, navigation, userId, projectId, fence, generation, retired, readSelection]);
  const select = (next: ProjectReading, replace = false, onCommit?: () => void) => {
    if (!onPage || error) return;
    const record = () => { const entryId = navigation.snapshot().entryId; if (entryId !== null) fence.entries.set(entryId, generation); };
    if (location.entryId !== null && selected === null) navigation.setView(projectHistory(userId, projectId, selection), { replace: true, onCommit: record });
    navigation.setView(projectHistory(userId, projectId, next), { replace, onCommit: () => { record(); onCommit?.(); } });
  };
  return { selection, select, error };
}

/** The URL owns the root tab and path; this state owns only nested readers. */
export function useResourceHistory(userId: string, projectId: string, taskId: string, active: boolean, scope?: TaskCacheScope) {
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const fence = scope === undefined ? null : resourceFence(scope, projectId);
  const subscribe = useCallback((listener: () => void) => {
    if (fence === null) return () => {};
    fence.listeners.add(listener);
    return () => { fence.listeners.delete(listener); };
  }, [fence]);
  const generation = useSyncExternalStore(subscribe, () => fence?.generation ?? 0);
  const key = `${userId}/${projectId}/${taskId}`;
  const retained = useRef<{ key: string; generation: number; selection: ResourcePageReading; onPage: boolean }>({ key, generation, selection: emptyResourceReading(), onPage: false });
  if (retained.current.key !== key || retained.current.generation !== generation) retained.current = { key, generation, selection: emptyResourceReading(), onPage: false };
  const route = parseRoute(location.pathname, location.search);
  const onPage = active && (route.kind === 'task' || route.kind === 'attachment') && route.projectId === projectId && route.taskId === taskId;
  if (onPage && !retained.current.onPage) retained.current.selection = emptyResourceReading();
  retained.current.onPage = onPage;
  let selected: ResourcePageReading | null = null;
  let error = false;
  if (onPage) {
    try { selected = readResourceHistory(location.view, userId, projectId, taskId); }
    catch { error = true; }
  }
  const readSelection = selected;
  const retired = scope !== undefined && location.entryId !== null && selected !== null && isRetiredResourceEntry(scope, projectId, location.entryId);
  if (retired) selected = null;
  // URL navigation creates an unpopulated controlled entry. Carry the current
  // nested selection only within the same active resource, then save it there.
  const selection = !onPage || location.entryId === null || location.view === undefined
    ? retained.current.selection : selected ?? emptyResourceReading();
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.selection = selection;
    // Replacing an already empty entry is a no-op, so there is no commit callback.
    if (retired && fence !== null && location.entryId !== null && readSelection?.goalChildren === null && readSelection.externalGoal === null) fence.entries.set(location.entryId, generation);
    if (location.entryId !== null && selected === null) navigation.setView(resourceHistory(userId, projectId, taskId, selection), { replace: true, onCommit: () => {
      const entryId = navigation.snapshot().entryId;
      if (fence !== null && entryId !== null) fence.entries.set(entryId, generation);
    } });
  }, [onPage, error, selection, selected, location.entryId, navigation, userId, projectId, taskId, fence, generation, retired, readSelection]);
  const select = (next: ResourcePageReading, replace = false, onCommit?: () => void) => {
    if (!onPage || error) return;
    const record = () => { const entryId = navigation.snapshot().entryId; if (fence !== null && entryId !== null) fence.entries.set(entryId, generation); };
    if (location.entryId !== null && selected === null) navigation.setView(resourceHistory(userId, projectId, taskId, selection), { replace: true, onCommit: record });
    navigation.setView(resourceHistory(userId, projectId, taskId, next), { replace, onCommit: () => { record(); onCommit?.(); } });
  };
  return { selection, select, error };
}

/** Only the active Worker consumes its identity- and resource-bound selection. */
export function useWorkerHistory(userId: string, workerId: string, active: boolean) {
  const location = useBrowserLocation();
  const navigation = browserNavigation();
  const retained = useRef<{ userId: string; workerId: string; section: WorkerSection }>({ userId, workerId, section: 'overview' });
  if (retained.current.userId !== userId || retained.current.workerId !== workerId) retained.current = { userId, workerId, section: 'overview' };
  const route = parseAuthRoute(location.pathname, location.search);
  const onPage = active && route.kind === 'worker' && route.workerId === workerId;
  let selected: WorkerSection | null = null;
  let error = false;
  if (onPage) {
    try { selected = readWorkerHistory(location.view, userId, workerId); }
    catch { error = true; }
  }
  const section = !onPage || location.entryId === null ? retained.current.section : selected ?? 'overview';
  useLayoutEffect(() => {
    if (!onPage || error) return;
    retained.current.section = section;
    if (location.entryId !== null && selected === null) navigation.setView(workerHistory(userId, workerId, section), { replace: true });
  }, [onPage, error, section, selected, location.entryId, navigation, userId, workerId]);
  const select = (next: WorkerSection, replace = false) => {
    if (!onPage || error) return;
    if (location.entryId !== null && selected === null) navigation.setView(workerHistory(userId, workerId, section), { replace: true });
    if (next !== section) navigation.setView(workerHistory(userId, workerId, next), { replace });
  };
  return { section, select, error };
}
