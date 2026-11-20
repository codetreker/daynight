import { createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { ApiError, isAbortError } from '../../api/client';
import { getTaskUsageSummaries, getUsageCapabilities, type UsageSummary } from '../../api/usage';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

export type TaskUsageCapability = 'pending' | 'available' | 'unsupported' | 'error';
export type TaskUsageState = { readonly summary: UsageSummary | null; readonly error: unknown; readonly pending: boolean; readonly capability: TaskUsageCapability };
const empty: TaskUsageState = { summary: null, error: null, pending: true, capability: 'pending' };
const ActivityContext = createContext(true);
export const UsageActivityProvider = ({ active, children }: { readonly active: boolean; readonly children: ReactNode }) => createElement(ActivityContext, { value: active }, children);
type Entry = { state: TaskUsageState; accessDenied: boolean; readonly listeners: Set<() => void> };
const isInaccessible = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404);
class UsageStore {
  private readonly projects = new Map<string, Map<string, Entry>>();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private dirty = false;
  private requestAbort: AbortController | null = null;
  constructor(private readonly scope: TaskCacheScope) {
    const visible = () => {
      if (document.visibilityState === 'hidden') {
        this.requestAbort?.abort();
        if (this.poll !== null) { clearInterval(this.poll); this.poll = null; }
        if (this.scheduled !== null) { clearTimeout(this.scheduled); this.scheduled = null; }
      } else if (this.hasSubscribers()) { this.startPolling(); this.schedule(); }
    };
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = scope.subscribe(event => {
      if (event.scopeSuspended) this.requestAbort?.abort();
      if (event.accessRestored) this.schedule();
      if (event.accessRevoked || event.taskNotFound) {
        this.requestAbort?.abort();
        const tasks = this.projects.get(event.projectId);
        if (tasks !== undefined) for (const entry of tasks.values()) {
          entry.accessDenied = true;
          this.update(entry, { summary: null, pending: false, capability: 'error', error: new ApiError('server', 404, 'resource_unavailable') });
        }
      }
    });
    scope.signal.addEventListener('abort', () => { document.removeEventListener('visibilitychange', visible); unsubscribe(); if (this.poll !== null) clearInterval(this.poll); if (this.scheduled !== null) clearTimeout(this.scheduled); this.projects.clear(); }, { once: true });
  }
  private entry(project: string, task: string): Entry {
    let tasks = this.projects.get(project);
    if (tasks === undefined) { tasks = new Map(); this.projects.set(project, tasks); }
    let entry = tasks.get(task);
    if (entry === undefined) { entry = { state: empty, accessDenied: false, listeners: new Set() }; tasks.set(task, entry); }
    return entry;
  }
  snapshot = (project: string, task: string): TaskUsageState => this.scope.isInvalidated ? empty : this.entry(project, task).state;
  subscribe = (project: string, task: string, listener: () => void): (() => void) => {
    const entry = this.entry(project, task); entry.listeners.add(listener); this.schedule();
    this.startPolling();
    return () => {
      entry.listeners.delete(listener);
      if (![...this.projects.values()].some(tasks => [...tasks.values()].some(item => item.listeners.size > 0))) {
        if (this.poll !== null) { clearInterval(this.poll); this.poll = null; }
        if (this.scheduled !== null) { clearTimeout(this.scheduled); this.scheduled = null; }
        this.requestAbort?.abort();
      }
    };
  };
  refresh = (): void => this.schedule();
  private hasSubscribers(): boolean { return [...this.projects.values()].some(tasks => [...tasks.values()].some(entry => entry.listeners.size > 0)); }
  private startPolling(): void { if (this.poll === null && document.visibilityState !== 'hidden' && this.hasSubscribers()) this.poll = setInterval(() => this.schedule(), 15_000); }
  private schedule(): void {
    if (this.scheduled !== null || this.scope.isInvalidated || !this.hasSubscribers()) return;
    if (this.running) { this.dirty = true; return; }
    this.scheduled = setTimeout(() => { this.scheduled = null; if (document.visibilityState !== 'hidden') void this.load(); }, 0);
  }
  private update(entry: Entry, state: TaskUsageState): void { entry.state = state; for (const listener of entry.listeners) listener(); }
  private async load(): Promise<void> {
    this.running = true;
    this.requestAbort = new AbortController();
    const signal = AbortSignal.any([this.requestAbort.signal, this.scope.signal, this.scope.mismatchSignal]);
    const admission = { userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch };
    try {
      await this.scope.ready(signal);
      await getUsageCapabilities(signal, admission);
      signal.throwIfAborted();
      for (const [project, tasks] of this.projects) {
        if (this.scope.isProjectSuspended(project)) continue;
        const selected = [...tasks].filter(([, entry]) => entry.listeners.size > 0);
        for (const [, entry] of selected) if (!entry.accessDenied) this.update(entry, {
          ...entry.state, capability: 'available',
          ...(entry.state.capability !== 'available' ? { error: null, pending: entry.state.summary === null } : {}),
        });
        for (let offset = 0; offset < selected.length; offset += 100) {
          const batch = selected.slice(offset, offset + 100);
          try {
            const values = await getTaskUsageSummaries(project, batch.map(([id]) => id), signal, admission);
            signal.throwIfAborted();
            for (const item of values) {
              const entry = tasks.get(item.taskId)!;
              entry.accessDenied = false;
              this.update(entry, { ...entry.state, capability: 'available', summary: item.summary, pending: false, error: null });
            }
          } catch (error) {
            if (isAbortError(error)) throw error;
            for (const [, entry] of batch) {
              if (isInaccessible(error)) entry.accessDenied = true;
              this.update(entry, { ...entry.state, capability: entry.accessDenied ? 'error' : entry.state.capability, summary: entry.accessDenied ? null : entry.state.summary, pending: false, error });
            }
          }
        }
      }
    } catch (error) {
      if (!isAbortError(error)) for (const tasks of this.projects.values()) for (const entry of tasks.values()) if (entry.listeners.size > 0) {
        const unsupported = error instanceof ApiError && error.code === 'usage_unsupported';
        const inaccessible = isInaccessible(error);
        if (inaccessible && !unsupported) entry.accessDenied = true;
        const capability = unsupported ? 'unsupported' : inaccessible || entry.state.capability !== 'available' ? 'error' : 'available';
        this.update(entry, { summary: unsupported || inaccessible ? null : entry.state.summary, pending: false, error, capability });
      }
    } finally { this.requestAbort = null; this.running = false; if (this.dirty) { this.dirty = false; this.schedule(); } }
  }
}
const stores = new WeakMap<TaskCacheScope, UsageStore>();
export const useTaskUsage = (projectId: string, taskId: string, active = true) => {
  const workspaceActive = useContext(ActivityContext);
  active = active && workspaceActive;
  const scope = useTaskCacheScope();
  let store = stores.get(scope);
  if (store === undefined) { store = new UsageStore(scope); stores.set(scope, store); }
  const current = store;
  const subscribe = useCallback((listener: () => void) => active ? current.subscribe(projectId, taskId, listener) : () => {}, [current, projectId, taskId, active]);
  const snapshot = useCallback(() => current.snapshot(projectId, taskId), [current, projectId, taskId]);
  const state = useSyncExternalStore(subscribe, snapshot);
  return { ...state, retry: current.refresh };
};
