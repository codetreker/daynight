import { authRequestsPaused, subscribeAuthPause } from '../../api/client';
import type { TaskSync, TaskSummary } from '../../api/types';
import { sameTaskExecutionBinding, taskExecutionBinding, type TaskExecutionBinding } from '../task-cache/execution-binding';
import type { CachedProject, TaskCacheScope } from '../task-cache/project-cache';
import { normalizeTaskSession, taskSessionNextChange } from './observation';

type Fence = Pick<CachedProject['manifest'], 'userId' | 'projectId' | 'userFence' | 'cacheGeneration' | 'epoch'>;
type Entry = {
  readonly binding: TaskExecutionBinding;
  readonly version: bigint;
  readonly startedAt: string | null;
  readonly observation: TaskSync['taskObservations'][string];
  readonly responseTaskAt: number;
  readonly responseSessionAt: number;
  readonly receivedMonotonic: number;
};
export type ProjectTaskObservation = {
  readonly state: TaskSync['taskObservations'][string]['state'] | 'unobserved' | 'expired' | null;
  readonly needsAttention: boolean | null;
  readonly canOpen: boolean;
};
export const unobserved: ProjectTaskObservation = Object.freeze({ state: 'unobserved', needsAttention: null, canOpen: false });
const unavailable: ProjectTaskObservation = Object.freeze({ state: 'unavailable', needsAttention: null, canOpen: false });
const sameFence = (a: Fence, b: Fence) => a.userId === b.userId && a.projectId === b.projectId && a.userFence === b.userFence && a.cacheGeneration === b.cacheGeneration && a.epoch === b.epoch;

/** Project list observations are ephemeral and independent of the sparse chain summary. */
export class ProjectTaskObservationsStore {
  private entries = new Map<string, Entry>();
  private view: ReadonlyMap<string, ProjectTaskObservation> = new Map();
  private fence: Fence | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private started = false;
  private enabled = true;
  private failed = false;
  constructor(private readonly scope: TaskCacheScope, private readonly projectId: string) {}
  snapshot = () => this.view;
  matches(task: TaskSummary): boolean {
    const entry = this.entries.get(task.id);
    const current = this.failed ? this.project()?.summaries.get(task.id) : undefined;
    if (current !== undefined && current.type === 'task' && current.status === 'in_progress' && current.version === task.version && sameTaskExecutionBinding(taskExecutionBinding(current), taskExecutionBinding(task))) return true;
    return entry !== undefined && task.type === 'task' && task.status === 'in_progress' && entry.version === task.version && sameTaskExecutionBinding(entry.binding, taskExecutionBinding(task));
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start() {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.scope.subscribe(event => { if (event.projectId === this.projectId) this.reconcile(); });
    this.unsubscribeAuth = subscribeAuthPause(this.clear);
    this.scope.signal.addEventListener('abort', this.reconcile);
    document.addEventListener('visibilitychange', this.reconcile);
    this.reconcile();
  }
  setActive(active: boolean) { this.enabled = active; this.reconcile(); }
  clear = () => { this.entries.clear(); this.fence = null; this.failed = false; this.reconcile(); };
  fail = () => { this.entries.clear(); this.fence = this.project()?.manifest ?? null; this.failed = true; this.reconcile(); };
  private project() {
    return !this.started || this.scope.isInvalidated || this.scope.signal.aborted || authRequestsPaused() ? null : this.scope.getAuthorizedProject(this.projectId);
  }
  replace({ project, observedBindings, observedVersions, sync, receivedMonotonic }: { project: CachedProject; observedBindings: ReadonlyMap<string, TaskExecutionBinding>; observedVersions: ReadonlyMap<string, bigint>; sync: TaskSync; receivedMonotonic: number }) {
    this.reconcile();
    const current = this.project();
    if (current === null || document.visibilityState === 'hidden' || !sameFence(project.manifest, current.manifest) || current.manifest.userId !== this.scope.userId || current.manifest.projectId !== this.projectId) return;
    this.failed = false;
    this.fence = current.manifest;
    for (const [id, task] of current.summaries) {
      if (task.type !== 'task' || task.status !== 'in_progress') continue;
      const binding = observedBindings.get(id);
      const observation = sync.taskObservations[id];
      const old = this.entries.get(id);
      if (old !== undefined && old.receivedMonotonic > receivedMonotonic) continue;
      // An older request cannot clear or renew a newer Task execution.
      if (binding === undefined || observedVersions.get(id) !== task.version || !sameTaskExecutionBinding(binding, taskExecutionBinding(task))) continue;
      this.entries.delete(id);
      if (observation === undefined || task.version !== observation.taskVersion) continue;
      this.entries.set(id, { binding, version: task.version, startedAt: task.startedAt, observation, responseTaskAt: Date.parse(sync.responseTaskAt), responseSessionAt: Date.parse(sync.responseSessionAt), receivedMonotonic });
    }
    this.reconcile();
  }
  private reconcile = () => {
    const project = this.project();
    if (project === null || this.fence !== null && !sameFence(this.fence, project.manifest)) { this.entries.clear(); this.fence = null; this.failed = false; }
    const now = performance.now();
    const next = new Map<string, ProjectTaskObservation>();
    let nextChange = Infinity;
    if (project !== null && this.enabled && document.visibilityState !== 'hidden') {
      if (this.failed) {
        for (const [id, task] of project.summaries) if (task.type === 'task' && task.status === 'in_progress') next.set(id, unavailable);
      }
      for (const [id, entry] of this.entries) {
        const task = project.summaries.get(id);
        if (task === undefined || task.type !== 'task' || task.status !== 'in_progress' || task.version !== entry.version || !sameTaskExecutionBinding(entry.binding, taskExecutionBinding(task))) { this.entries.delete(id); continue; }
        const value = normalizeTaskSession(entry.observation, entry, now);
        const previous = this.view.get(id);
        next.set(id, previous?.state === value.state && previous.needsAttention === value.needsAttention && previous.canOpen === value.canOpen ? previous : value);
        const remaining = taskSessionNextChange(entry.observation, entry, now);
        if (remaining !== null) nextChange = Math.min(nextChange, remaining);
      }
    }
    if (next.size !== this.view.size || [...next].some(([id, value]) => this.view.get(id) !== value)) { this.view = next; for (const listener of this.listeners) listener(); }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.started && Number.isFinite(nextChange)) this.timer = setTimeout(this.reconcile, Math.max(1, nextChange));
  };
  dispose() {
    this.started = false; this.unsubscribe?.(); this.unsubscribeAuth?.();
    this.scope.signal.removeEventListener('abort', this.reconcile); document.removeEventListener('visibilitychange', this.reconcile);
    this.clear();
  }
}
export function observationFor(view: ReadonlyMap<string, ProjectTaskObservation>, task: Pick<TaskSummary, 'id' | 'status'>): ProjectTaskObservation | null {
  return task.status === 'in_progress' ? view.get(task.id) ?? unobserved : null;
}
