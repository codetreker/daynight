import { authRequestsPaused } from '../../api/client';
import { createSessionApi } from '../../api/sessions';
import { readWorkerClaim } from '../../api/task-properties';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import type { TaskCacheScope } from '../task-cache/project-cache';
import { sessionIndicator, type TaskSessionSummary } from './summary';

const refreshDelay = 5_000;
const freshness = 15_000;
const concurrency = 4;
type Binding = Pick<WorkerClaim, 'claimId' | 'workerId' | 'worktreeId' | 'state'>;
type Entry = {
  readonly binding: Binding;
  nextRead: number;
  receivedAt: number | null;
  summary: TaskSessionSummary | null;
  flight: Flight | null;
};
type Flight = { readonly taskId: string; readonly controller: AbortController };
const binding = (task: TaskSummary | undefined): Binding | null => {
  if (task?.status !== 'in_progress') return null;
  try { const worker = readWorkerClaim(task.properties); return worker?.agentControlMode === 'web' ? worker : null; }
  catch { return null; }
};
const sameBinding = (a: Binding, b: Binding | null) => b !== null && a.claimId === b.claimId && a.workerId === b.workerId && a.worktreeId === b.worktreeId && a.state === b.state;

/** A page-owned current-session reader. It never loads history or opens channels. */
export class TaskSessionSummaryStore {
  private readonly chains = new Map<string, { readonly members: readonly string[]; readonly visible: boolean }>();
  private readonly entries = new Map<string, Entry>();
  private readonly flights = new Set<Flight>();
  private readonly listeners = new Set<() => void>();
  private view: ReadonlyMap<string, TaskSessionSummary> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private enabled = true;
  constructor(private readonly scope: TaskCacheScope, private readonly projectId: string) {}

  snapshot = (): ReadonlyMap<string, TaskSessionSummary> => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.scope.subscribe((event) => { if (event.projectId === this.projectId) this.reconcile(); });
    this.scope.signal.addEventListener('abort', this.reconcile);
    document.addEventListener('visibilitychange', this.reconcile);
    this.reconcile();
  }
  setActive(active: boolean): void { this.enabled = active; this.reconcile(); }
  setChain(rootId: string, members: Iterable<string>, visible: boolean): void {
    this.chains.set(rootId, { members: [...members], visible }); this.reconcile();
  }
  removeChain(rootId: string): void { this.chains.delete(rootId); this.reconcile(); }
  private admitted(): boolean {
    return this.started && this.enabled && !this.scope.isInvalidated && !this.scope.signal.aborted && !authRequestsPaused() && document.visibilityState !== 'hidden';
  }
  private summaries(): ReadonlyMap<string, TaskSummary> | null {
    if (!this.admitted()) return null;
    try { return this.scope.getAuthorizedProject(this.projectId)?.summaries ?? null; }
    catch { return null; }
  }
  private remove(taskId: string, entry: Entry): void {
    entry.flight?.controller.abort(); this.entries.delete(taskId);
  }
  private publish(): void {
    const next = new Map<string, TaskSessionSummary>();
    for (const [taskId, entry] of this.entries) if (entry.summary !== null) next.set(taskId, entry.summary);
    if (next.size === this.view.size && [...next].every(([id, summary]) => this.view.get(id) === summary)) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || !this.enabled || this.scope.isInvalidated || document.visibilityState === 'hidden' || ![...this.chains.values()].some((chain) => chain.visible)) return;
    // Authentication admission has no event subscription. A bounded local tick
    // clears summaries during identity revalidation without making extra reads.
    let delay = 250;
    const now = performance.now();
    for (const [id, entry] of this.entries) {
      if (entry.summary !== null && entry.receivedAt !== null) delay = Math.min(delay, Math.max(1, entry.receivedAt + freshness + 1 - now));
      if (entry.flight === null && this.flights.size < concurrency && ![...this.flights].some((flight) => flight.taskId === id)) delay = Math.min(delay, Math.max(1, entry.nextRead - now));
    }
    this.timer = setTimeout(this.reconcile, delay);
  }
  private reconcile = (): void => {
    const tasks = this.summaries();
    const wanted = new Set<string>();
    if (tasks !== null) for (const chain of this.chains.values()) if (chain.visible) for (const id of chain.members) wanted.add(id);
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id) || !sameBinding(entry.binding, binding(tasks?.get(id)))) this.remove(id, entry);
    }
    const now = performance.now();
    for (const id of wanted) {
      const current = binding(tasks!.get(id));
      if (current !== null && !this.entries.has(id)) this.entries.set(id, { binding: current, nextRead: now, receivedAt: null, summary: null, flight: null });
    }
    for (const entry of this.entries.values()) if (entry.receivedAt !== null && now - entry.receivedAt > freshness) entry.summary = null;
    this.publish();
    // Give the oldest due read the next slot so slow refreshes cannot starve
    // unread members at the end of a large visible chain.
    const due = [...this.entries].sort((a, b) => a[1].nextRead - b[1].nextRead);
    for (const [id, entry] of due) {
      if (this.flights.size >= concurrency) break;
      if (entry.flight === null && entry.nextRead <= now && ![...this.flights].some((flight) => flight.taskId === id)) this.read(id, entry);
    }
    this.schedule();
  };
  private current(taskId: string, entry: Entry, flight: Flight): boolean {
    return !flight.controller.signal.aborted && this.entries.get(taskId) === entry && entry.flight === flight && sameBinding(entry.binding, binding(this.summaries()?.get(taskId)));
  }
  private read(taskId: string, entry: Entry): void {
    const flight: Flight = { taskId, controller: new AbortController() };
    entry.flight = flight; this.flights.add(flight);
    const api = createSessionApi(this.projectId, taskId, this.scope.userId, this.scope.principalMismatch);
    void api.current(flight.controller.signal).then((response) => {
      if (!this.current(taskId, entry, flight)) return;
      entry.summary = null; entry.receivedAt = null;
      if (response.status !== 'registered') return;
      const s = response.session;
      if (s.claimId !== entry.binding.claimId || s.identity.projectId !== this.projectId || s.identity.taskId !== taskId ||
          s.identity.workerId !== entry.binding.workerId || s.identity.worktreeId !== entry.binding.worktreeId) return;
      if (s.activity === 'unknown' && s.lifecycle === 'active' && s.connectionState !== 'disconnected') return;
      entry.receivedAt = performance.now();
      entry.summary = { sessionId: s.sessionId, claimId: s.claimId, indicator: sessionIndicator(s) };
    }).catch(() => {
      if (this.current(taskId, entry, flight)) { entry.summary = null; entry.receivedAt = null; }
    }).finally(() => {
      // Aborted reads retain their slot until their transport settles. A late
      // completion cannot clear a replacement claim's flight or publish data.
      this.flights.delete(flight);
      if (this.entries.get(taskId) === entry && entry.flight === flight) {
        entry.flight = null; entry.nextRead = performance.now() + refreshDelay;
      }
      this.reconcile();
    });
  }
  dispose(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.scope.signal.removeEventListener('abort', this.reconcile);
    document.removeEventListener('visibilitychange', this.reconcile);
    for (const [id, entry] of this.entries) this.remove(id, entry);
    this.publish();
  }
}
