import { ApiError, isAbortError } from '../../api/client';
import { getGoalDependencies, type GoalDependencies, type RelatedGoal } from '../../api/goal-dependencies';
import type { TaskSummary } from '../../api/types';
import type { TaskCacheScope } from '../task-cache/project-cache';
import { projectGoalAcceptance } from './model';
import { contributionConflicts, selectLegalContributions, type GoalRelationContribution } from './relation-projection';

export type GoalRelationPhase = 'queued' | 'loading' | 'partial' | 'ready' | 'failed' | 'unavailable' | 'denied' | 'conflict' | 'interrupted';
export type GoalRelationSource = {
  readonly goalId: string;
  readonly projectId: string;
  readonly title: string;
  readonly phase: GoalRelationPhase;
  readonly contribution: GoalRelationContribution | null;
  readonly hiddenCount: number;
  readonly error: unknown;
};
export type GoalRelationSnapshot = { readonly sources: ReadonlyMap<string, GoalRelationSource>; readonly deniedIds: ReadonlySet<string> };
type Source = { summary: TaskSummary; generation: number; key: string; controller: AbortController | null; view: GoalRelationSource };
const emptySummaries: ReadonlyMap<string, TaskSummary> = new Map();
const deniedError = (error: unknown) => error instanceof ApiError && error.kind === 'server' && [403, 404, 410].includes(error.status ?? 0);
const pageIdentity = (page: GoalDependencies) => JSON.stringify([page.canEdit, page.revision, page.completionBlocked, page.prerequisites]);

export class GoalRelationSession {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<() => void>();
  private readonly denied = new Set<string>();
  private readonly withdrawnProjects = new Set<string>();
  private queue: string[] = [];
  private active = 0;
  private disposed = false;
  private qualified = false;
  private summaries = emptySummaries;
  private visible: GoalRelationSnapshot = { sources: new Map(), deniedIds: new Set() };
  private readonly unsubscribe: () => void;

  constructor(private readonly scope: TaskCacheScope, private readonly projectId: string,
    private readonly read = getGoalDependencies, private readonly timeoutMilliseconds = 30_000) {
    this.unsubscribe = scope.subscribe(event => {
      if (event.accessRestored) {
        this.withdrawnProjects.delete(event.projectId);
        if (this.qualified) for (const id of this.sources.keys()) this.enqueue(id);
        return;
      }
      if (!event.accessRevoked && !event.directAccessUncertain && !event.historyChanged && !event.scopeSuspended) return;
      if (event.accessRevoked || event.directAccessUncertain || event.scopeSuspended) this.withdrawnProjects.add(event.projectId);
      this.cancelAll();
      for (const source of this.sources.values()) {
        const ownLoss = event.projectId === source.view.projectId;
        const contribution = source.view.contribution;
        source.view = { ...source.view, phase: 'interrupted', hiddenCount: ownLoss ? 0 : source.view.hiddenCount,
          contribution: contribution === null || ownLoss ? null : { ...contribution,
            prerequisites: contribution.prerequisites.map(item => item.target?.projectId === event.projectId ? { ...item, target: null } : item),
            successors: contribution.successors.filter(goal => goal.projectId !== event.projectId) } };
      }
      this.publish();
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.visible;
  private publish = () => {
    this.visible = { sources: new Map([...this.sources].map(([id, source]) => [id, source.view])), deniedIds: new Set(this.denied) };
    for (const listener of this.listeners) listener();
  };
  setRoots = (summaries: ReadonlyMap<string, TaskSummary> | null) => {
    if (this.disposed) return;
    const previouslyQualified = this.qualified;
    this.qualified = summaries !== null;
    if (summaries === null) {
      this.cancelAll();
      for (const source of this.sources.values()) source.view = { ...source.view, phase: 'interrupted' };
      this.publish(); return;
    }
    this.summaries = summaries;
    const roots = new Map([...summaries].filter(([, goal]) => goal.type === 'goal' && (goal.status === 'todo' || goal.status === 'in_progress')));
    for (const [id, source] of this.sources) if (!roots.has(id)) { this.cancel(source); this.sources.delete(id); this.denied.delete(id); }
    for (const [id, summary] of roots) {
      const key = `${summary.version}:${this.scope.getHistoryGeneration(this.projectId)}`;
      const existing = this.sources.get(id);
      if (existing === undefined) {
        this.sources.set(id, { summary, generation: 0, key, controller: null,
          view: { goalId: id, projectId: this.projectId, title: summary.titlePreview, phase: 'queued', contribution: null, hiddenCount: 0, error: null } });
        this.enqueue(id);
      } else {
        existing.summary = summary;
        existing.view = { ...existing.view, title: summary.titlePreview };
        if (existing.key !== key || !previouslyQualified && existing.view.phase === 'interrupted') {
          existing.key = key; this.denied.delete(id); this.enqueue(id);
        }
      }
    }
    const baseline = projectGoalAcceptance(summaries);
    const legal = selectLegalContributions(this.projectId, baseline, this.contributions(), this.denied);
    for (const id of legal.conflictingIds) { const source = this.sources.get(id)!; this.cancel(source); source.view = { ...source.view, phase: 'conflict', contribution: null }; }
    this.publish(); this.pump();
  };
  private contributions = (candidate?: GoalRelationContribution) => [...this.sources.values()].flatMap(source =>
    source.view.goalId === candidate?.sourceId ? [candidate] : source.view.contribution === null ? [] : [source.view.contribution]);
  private cancel = (source: Source) => { source.generation++; source.controller?.abort(); source.controller = null; };
  private cancelAll = () => { this.queue = []; for (const source of this.sources.values()) this.cancel(source); };
  private enqueue = (id: string) => {
    const source = this.sources.get(id);
    if (source === undefined || !this.qualified || this.disposed) return;
    this.cancel(source); source.view = { ...source.view, phase: 'queued', error: null };
    if (!this.queue.includes(id)) this.queue.push(id);
    this.publish(); this.pump();
  };
  retry = (id: string) => { this.enqueue(id); };
  reenter = () => {
    if (!this.qualified) return;
    for (const [id, source] of this.sources) if (!['queued', 'loading', 'partial'].includes(source.view.phase)) this.enqueue(id);
  };
  private pump = () => {
    while (!this.disposed && this.qualified && this.active < 4 && this.queue.length > 0) {
      const id = this.queue.shift()!, source = this.sources.get(id);
      if (source === undefined || source.controller !== null) continue;
      this.active++;
      void this.load(source).finally(() => { this.active--; this.pump(); });
    }
  };
  private load = async (source: Source) => {
    const controller = new AbortController(); source.controller = controller;
    const generation = source.generation;
    const signal = AbortSignal.any([controller.signal, this.scope.signal, this.scope.mismatchSignal]);
    const current = () => !this.disposed && this.qualified && generation === source.generation && !signal.aborted;
    let fence: ReturnType<TaskCacheScope['captureTaskHistoryFence']> = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    try {
      await this.scope.ready(signal);
      if (!current()) return;
      fence = this.scope.captureTaskHistoryFence(source.view.projectId, source.view.goalId, generation, generation);
      if (fence === null) { source.view = { ...source.view, phase: 'interrupted' }; this.publish(); return; }
      source.view = { ...source.view, phase: 'loading' }; this.publish();
      let cursor: string | null = null, identity: string | null = null;
      const seen = new Set<string>(), successors = new Map<string, RelatedGoal>();
      do {
        const result = await this.read(source.view.projectId, source.view.goalId, cursor, signal, {
          userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch,
          onDispatch: () => { timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMilliseconds); },
        });
        if (timeout !== null) clearTimeout(timeout); timeout = null;
        if (!current() || !await this.scope.verifyTaskRead(fence, signal) || !current()) return;
        if (result.kind === 'unavailable') { source.view = { ...source.view, phase: 'unavailable', contribution: null, hiddenCount: 0, error: null }; this.publish(); return; }
        const page = result.page;
        if (identity !== null && identity !== pageIdentity(page)) throw new ApiError('protocol');
        if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new ApiError('protocol');
        identity = pageIdentity(page);
        for (const goal of page.successors) if (!this.withdrawnProjects.has(goal.projectId)) successors.set(goal.goalId, goal);
        const prerequisites = page.prerequisites.map(item => item.target !== null && this.withdrawnProjects.has(item.target.projectId) ? { ...item, target: null } : item);
        const candidate: GoalRelationContribution = { sourceId: source.view.goalId, sourceProjectId: source.view.projectId, prerequisites, successors: [...successors.values()] };
        const denied = new Set(this.denied); denied.delete(source.view.goalId);
        if (contributionConflicts(this.projectId, projectGoalAcceptance(this.summaries), this.contributions(candidate), denied)) {
          source.view = { ...source.view, phase: 'conflict', contribution: null, error: null }; this.publish(); return;
        }
        this.denied.delete(source.view.goalId);
        source.view = { ...source.view, phase: page.nextCursor === null ? 'ready' : 'partial', contribution: candidate,
          hiddenCount: prerequisites.filter(item => item.target === null).length, error: null }; this.publish();
        cursor = page.nextCursor;
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null && current());
    } catch (error) {
      if (this.disposed || !this.qualified || generation !== source.generation || fence === null) return;
      if (timedOut) error = new ApiError('network');
      else if (signal.aborted || isAbortError(error)) return;
      const denied = deniedError(error);
      if (!this.scope.isTaskHistoryPossiblyCurrent(fence)) return;
      if (!denied) {
        try { if (!await this.scope.verifyTaskRead(fence, this.scope.signal)) return; }
        catch (verificationError) { if (isAbortError(verificationError)) return; error = verificationError; }
      }
      if (generation !== source.generation || this.disposed) return;
      if (denied) this.denied.add(source.view.goalId);
      source.view = { ...source.view, phase: denied ? 'denied' : 'failed', contribution: denied ? null : source.view.contribution, hiddenCount: denied ? 0 : source.view.hiddenCount, error };
      this.publish();
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (source.controller === controller) source.controller = null;
    }
  };
  dispose = () => { this.disposed = true; this.cancelAll(); this.unsubscribe(); this.listeners.clear(); };
}
