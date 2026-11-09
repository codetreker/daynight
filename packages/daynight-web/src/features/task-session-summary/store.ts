import { ApiError, authRequestsPaused, subscribeAuthPause } from '../../api/client';
import type { TaskSync } from '../../api/types';
import { eligibleTaskExecutionBinding, sameTaskExecutionBinding, taskExecutionBinding, type TaskExecutionBinding } from '../task-cache/execution-binding';
import type { CachedProject, TaskCacheScope } from '../task-cache/project-cache';
import type { TaskSessionSummary } from './summary';

const freshness = 30_000;
type Fence = Pick<CachedProject['manifest'], 'userId' | 'projectId' | 'userFence' | 'cacheGeneration' | 'epoch'>;
type Entry = {
  readonly binding: TaskExecutionBinding;
  readonly receivedMonotonic: number;
  readonly summary: TaskSessionSummary;
};
type Observation = {
  readonly project: CachedProject;
  readonly observedBindings: ReadonlyMap<string, TaskExecutionBinding>;
  readonly sessions: TaskSync['sessions'];
  readonly receivedMonotonic: number;
};
const sameFence = (left: Fence, right: Fence): boolean => left.userId === right.userId && left.projectId === right.projectId &&
  left.userFence === right.userFence && left.cacheGeneration === right.cacheGeneration && left.epoch === right.epoch;

/** A page-owned projection of accepted task-sync observations, with no transport or persistence. */
export class TaskSessionSummaryStore {
  private readonly chains = new Map<string, { readonly members: readonly string[]; readonly visible: boolean }>();
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private view: ReadonlyMap<string, TaskSessionSummary> = new Map();
  private fence: Fence | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeAuth: (() => void) | null = null;
  private started = false;
  private enabled = true;
  constructor(private readonly scope: TaskCacheScope, private readonly projectId: string) {}

  snapshot = (): ReadonlyMap<string, TaskSessionSummary> => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.scope.subscribe((event) => { if (event.projectId === this.projectId) this.reconcile(); });
    this.unsubscribeAuth = subscribeAuthPause(this.clear);
    this.scope.signal.addEventListener('abort', this.reconcile);
    document.addEventListener('visibilitychange', this.reconcile);
    this.reconcile();
  }
  setActive(active: boolean): void { this.enabled = active; this.reconcile(); }
  setChain(rootId: string, members: Iterable<string>, visible: boolean): void {
    this.chains.set(rootId, { members: [...members], visible }); this.reconcile();
  }
  removeChain(rootId: string): void { this.chains.delete(rootId); this.reconcile(); }
  clear = (): void => { this.entries.clear(); this.fence = null; this.reconcile(); };
  private project(): CachedProject | null {
    return !this.started || this.scope.isInvalidated || this.scope.signal.aborted || authRequestsPaused()
      ? null : this.scope.getAuthorizedProject(this.projectId);
  }
  replace({ project, observedBindings, sessions, receivedMonotonic }: Observation): void {
    this.reconcile();
    const current = this.project();
    if (current === null || document.visibilityState === 'hidden' || !sameFence(project.manifest, current.manifest) ||
      project.manifest.userId !== this.scope.userId || project.manifest.projectId !== this.projectId ||
      performance.now() - receivedMonotonic > freshness) return;
    for (const taskId of Object.keys(sessions)) {
      const observed = observedBindings.get(taskId);
      if (observed === undefined || !eligibleTaskExecutionBinding(observed)) throw new ApiError('protocol');
    }
    this.fence = current.manifest;
    // Both a value and an omission belong to the response's observed execution,
    // even when Task cache merging has retained a newer execution.
    for (const [taskId, observed] of observedBindings) {
      const acceptedTask = current.summaries.get(taskId);
      if (acceptedTask === undefined) continue;
      const accepted = taskExecutionBinding(acceptedTask);
      if (!eligibleTaskExecutionBinding(accepted) || !sameTaskExecutionBinding(observed, accepted)) continue;
      const previous = this.entries.get(taskId);
      if (previous !== undefined && receivedMonotonic < previous.receivedMonotonic) continue;
      this.entries.delete(taskId);
      if (!Object.hasOwn(sessions, taskId)) continue;
      const state = sessions[taskId]!;
      const indicator = state === 'pending' ? null : state;
      const summary = previous?.summary.indicator === indicator ? previous.summary : { indicator };
      this.entries.set(taskId, { binding: accepted, receivedMonotonic, summary });
    }
    this.reconcile();
  }
  private publish(): void {
    const next = new Map<string, TaskSessionSummary>();
    if (this.enabled && document.visibilityState !== 'hidden') {
      for (const chain of this.chains.values()) if (chain.visible) {
        for (const taskId of chain.members) {
          const entry = this.entries.get(taskId);
          if (entry !== undefined) next.set(taskId, entry.summary);
        }
      }
    }
    if (next.size === this.view.size && [...next].every(([id, summary]) => this.view.get(id) === summary)) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }
  private reconcile = (): void => {
    const project = this.project();
    if (project === null || this.fence !== null && !sameFence(this.fence, project.manifest)) {
      this.entries.clear(); this.fence = null;
    } else {
      const now = performance.now();
      for (const [taskId, entry] of this.entries) {
        const task = project.summaries.get(taskId);
        if (task === undefined || !sameTaskExecutionBinding(entry.binding, taskExecutionBinding(task)) || now - entry.receivedMonotonic > freshness) this.entries.delete(taskId);
      }
    }
    this.publish();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.started && this.entries.size !== 0) {
      const expires = Math.min(...[...this.entries.values()].map((entry) => entry.receivedMonotonic + freshness + 1));
      this.timer = setTimeout(this.reconcile, Math.max(1, expires - performance.now()));
    }
  };
  dispose(): void {
    this.started = false;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.unsubscribeAuth?.(); this.unsubscribeAuth = null;
    this.scope.signal.removeEventListener('abort', this.reconcile);
    document.removeEventListener('visibilitychange', this.reconcile);
    this.chains.clear(); this.clear();
  }
}
