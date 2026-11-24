import { ApiError, isAbortError } from '../../api/client';
import { getGoalDependencies, type GoalDependencies, type RelatedGoal } from '../../api/goal-dependencies';
import type { TaskSummary } from '../../api/types';
import type { CacheEvent, TaskCacheScope } from '../task-cache/project-cache';
import { projectGoalAcceptance } from './model';
import { combineGoalRelations, contributionConflicts, relationTargets, selectLegalContributions, type GoalRelationContribution } from './relation-projection';
import { reachableGoalSources } from './relation-ownership';

export type GoalRelationPhase = 'queued' | 'loading' | 'partial' | 'ready' | 'failed' | 'unavailable' | 'denied' | 'conflict' | 'interrupted';
export type GoalRelationSource = {
  readonly mode: 'root' | 'inspection' | 'expanded';
  readonly goalId: string;
  readonly projectId: string;
  readonly title: string;
  readonly phase: GoalRelationPhase;
  readonly contribution: GoalRelationContribution | null;
  readonly hiddenCount: number;
  readonly error: unknown;
};
export type GoalRelationSnapshot = { readonly sources: ReadonlyMap<string, GoalRelationSource>; readonly deniedIds: ReadonlySet<string> };
type Source = { generation: number; key: string; controller: AbortController | null; view: GoalRelationSource };
type TargetIdentity = { readonly goalId: string; readonly projectId: string };
type TargetWithdrawal = { readonly projectId: string; readonly historyGeneration: number; readonly generation: number };
const emptySummaries: ReadonlyMap<string, TaskSummary> = new Map();
const deniedError = (error: unknown) => error instanceof ApiError && error.kind === 'server' && [403, 404, 410].includes(error.status ?? 0);
const pageIdentity = (page: GoalDependencies) => JSON.stringify([page.canEdit, page.revision, page.completionBlocked, page.prerequisites]);

export class GoalRelationSession {
  private readonly sources = new Map<string, Source>();
  private readonly listeners = new Set<() => void>();
  private readonly denied = new Set<string>();
  private readonly withdrawnProjects = new Set<string>();
  private readonly prerequisiteTargets = new Map<string, Map<string, TargetIdentity>>();
  private readonly targetWithdrawals = new Map<string, TargetWithdrawal>();
  private readonly projectRegistrations = new Map<string, () => void>();
  private readonly projectionFences = new Map<string, ReadonlyMap<string, string>>();
  private withdrawalGeneration = 0;
  private queue: string[] = [];
  private active = 0;
  private disposed = false;
  private qualified = false;
  private summaries = emptySummaries;
  private focusId: string | null = null;
  private visible: GoalRelationSnapshot = { sources: new Map(), deniedIds: new Set() };
  private readonly unsubscribe: () => void;

  constructor(private readonly scope: TaskCacheScope, private readonly projectId: string,
    private readonly read = getGoalDependencies, private readonly timeoutMilliseconds = 30_000) {
    this.unsubscribe = scope.subscribe(event => {
      if (event.historyChanged && !event.historyHint) this.clearProjectWithdrawals(event.projectId);
      if (event.deletedTaskIds !== undefined || event.baselineRebuilt || event.taskDeletionHint !== undefined) { this.withdrawDeleted(event); if (!event.historyChanged) return; }
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
      this.prune(); this.publish();
    });
  }
  private registerProjects = (projectIds: readonly string[]) => {
    for (const projectId of projectIds) if (!this.projectRegistrations.has(projectId)) this.projectRegistrations.set(projectId, this.scope.registerProjectionProjects([projectId]));
  };
  private withdrawTarget = (goal: TargetIdentity, generation: number) => {
    this.denied.add(goal.goalId);
    this.targetWithdrawals.set(goal.goalId, { projectId: goal.projectId, historyGeneration: this.scope.getHistoryGeneration(goal.projectId), generation });
  };
  private clearProjectWithdrawals = (projectId: string) => {
    for (const [id, withdrawal] of this.targetWithdrawals) if (withdrawal.projectId === projectId) {
      this.targetWithdrawals.delete(id); this.denied.delete(id); this.prerequisiteTargets.delete(id); this.projectionFences.delete(id);
    }
    for (const targets of this.prerequisiteTargets.values()) for (const [edgeId, target] of targets) if (target.projectId === projectId) targets.delete(edgeId);
    for (const [id, source] of this.sources) if (source.view.projectId === projectId) { this.denied.delete(id); this.prerequisiteTargets.delete(id); this.projectionFences.delete(id); }
  };
  private withdrawDeleted = (event: CacheEvent) => {
    if (event.deletedTaskIds?.length === 0 && !event.baselineRebuilt && event.taskDeletionHint === undefined) return;
    const removed = new Set(event.deletedTaskIds ?? (event.taskDeletionHint === undefined ? [] : [event.taskDeletionHint.taskId]));
    const generation = ++this.withdrawalGeneration;
    for (const [id, source] of this.sources) {
      const contribution = source.view.contribution;
      const ownsRemoved = source.view.projectId === event.projectId && removed.has(id);
      const referencesProject = contribution !== null && [...contribution.prerequisites.flatMap(item => item.target === null ? [] : [item.target]), ...contribution.successors].some(goal => goal.projectId === event.projectId);
      const referencesRemoved = contribution !== null && [...contribution.prerequisites.flatMap(item => item.target === null ? [] : [item.target]), ...contribution.successors].some(goal => goal.projectId === event.projectId && removed.has(goal.goalId));
      if (ownsRemoved) {
        this.cancel(source); this.sources.delete(id); this.withdrawTarget({ goalId: id, projectId: event.projectId }, generation); continue;
      }
      if (contribution !== null && referencesRemoved) {
        const prerequisites = contribution.prerequisites.map(item => item.target?.projectId === event.projectId && removed.has(item.target.goalId) ? { ...item, target: null } : item);
        for (const goal of [...contribution.prerequisites.flatMap(item => item.target === null ? [] : [item.target]), ...contribution.successors]) if (goal.projectId === event.projectId && removed.has(goal.goalId)) this.withdrawTarget(goal, generation);
        source.view = { ...source.view, contribution: { ...contribution, prerequisites, successors: contribution.successors.filter(goal => goal.projectId !== event.projectId || !removed.has(goal.goalId)) }, hiddenCount: prerequisites.filter(item => item.target === null).length };
      }
      if (referencesRemoved || (event.baselineRebuilt || event.taskDeletionHint !== undefined) && (source.view.projectId === event.projectId || referencesProject)) {
        if (event.baselineRebuilt) void this.requalify(source);
        this.enqueue(id);
      }
    }
    this.prune(); this.publish();
  };
  private requalify = async (source: Source) => {
    const fence = this.projectionFences.get(source.view.goalId), contribution = source.view.contribution;
    if (fence === undefined || contribution === null) return;
    try {
      const allowed = await this.scope.qualifyProjection(fence, this.contributionCandidates(source, contribution), this.scope.signal);
      if (this.disposed || this.sources.get(source.view.goalId) !== source || this.projectionFences.get(source.view.goalId) !== fence || source.view.contribution !== contribution) return;
      if (this.contributionCandidates(source, contribution).every(item => allowed.has(`${item.projectId}/${item.id}`))) return;
      if (!allowed.has(`${source.view.projectId}/${source.view.goalId}`)) source.view = { ...source.view, contribution: null, hiddenCount: 0, phase: 'interrupted' };
      else {
        const prerequisites = contribution.prerequisites.map(item => item.target !== null && !allowed.has(`${item.target.projectId}/${item.target.goalId}`) ? { ...item, target: null } : item);
        source.view = { ...source.view, contribution: { ...contribution, prerequisites, successors: contribution.successors.filter(goal => allowed.has(`${goal.projectId}/${goal.goalId}`)) }, hiddenCount: prerequisites.filter(item => item.target === null).length };
      }
      this.prune(); this.publish();
    } catch (error) {
      if (!this.disposed && this.sources.get(source.view.goalId) === source && !isAbortError(error)) { source.view = { ...source.view, phase: 'failed', contribution: null, hiddenCount: 0, error }; this.publish(); }
    }
  };
  private contributionCandidates = (source: Source, contribution: GoalRelationContribution) => [
    { projectId: source.view.projectId, id: source.view.goalId },
    ...[...contribution.prerequisites.flatMap(item => item.target === null ? [] : [item.target]), ...contribution.successors].map(goal => ({ projectId: goal.projectId, id: goal.goalId })),
  ];
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.visible;
  private publish = () => {
    this.visible = { sources: new Map([...this.sources].map(([id, source]) => [id, source.view])), deniedIds: new Set(this.denied) };
    for (const listener of this.listeners) listener();
  };
  setRoots = (summaries: ReadonlyMap<string, TaskSummary> | null, focusId: string | null = null) => {
    if (this.disposed) return;
    this.focusId = focusId;
    const previouslyQualified = this.qualified;
    this.qualified = summaries !== null;
    if (summaries === null) {
      this.cancelAll();
      for (const source of this.sources.values()) source.view = { ...source.view, phase: 'interrupted' };
      this.publish(); return;
    }
    this.summaries = summaries;
    for (const withdrawal of this.targetWithdrawals.values()) if (withdrawal.historyGeneration !== this.scope.getHistoryGeneration(withdrawal.projectId)) this.clearProjectWithdrawals(withdrawal.projectId);
    const roots = new Map([...summaries].filter(([, goal]) => goal.type === 'goal' && (goal.id === focusId || goal.status === 'todo' || goal.status === 'in_progress')));
    for (const [id, source] of this.sources) if (source.view.mode === 'root' && !roots.has(id)) source.view = { ...source.view, mode: 'inspection' };
    for (const [id, summary] of roots) {
      if (this.targetWithdrawals.has(id) && this.denied.has(id)) continue;
      const key = `${summary.version}:${this.scope.getHistoryGeneration(this.projectId)}`;
      const existing = this.sources.get(id);
      if (existing === undefined) {
        this.sources.set(id, { generation: 0, key, controller: null,
          view: { mode: 'root', goalId: id, projectId: this.projectId, title: summary.titlePreview, phase: 'queued', contribution: null, hiddenCount: 0, error: null } });
        this.enqueue(id);
      } else {
        existing.view = { ...existing.view, mode: 'root', title: summary.titlePreview };
        if (existing.key !== key || !previouslyQualified && existing.view.phase === 'interrupted') {
          existing.key = key; this.denied.delete(id); this.enqueue(id);
        }
      }
    }
    const baseline = projectGoalAcceptance(summaries, this.focusId);
    const legal = selectLegalContributions(this.projectId, baseline, this.contributions(), this.denied);
    for (const id of legal.conflictingIds) { const source = this.sources.get(id)!; this.cancel(source); source.view = { ...source.view, phase: 'conflict', contribution: null }; }
    this.prune();
    for (const [id, source] of this.sources) {
      if (source.view.mode === 'root') continue;
      const local = summaries.get(id);
      const key = local?.type === 'goal' ? `${local.version}:${this.scope.getHistoryGeneration(this.projectId)}` : `${this.scope.getHistoryGeneration(source.view.projectId)}`;
      if (local?.type === 'goal') source.view = { ...source.view, title: local.titlePreview };
      if (source.key !== key || !previouslyQualified && source.view.phase === 'interrupted') { source.key = key; this.enqueue(id); }
    }
    this.publish(); this.pump();
  };
  private withdrawHiddenTargets = (source: Source, page: GoalDependencies, readGeneration: number) => {
    const prior = source.view.contribution?.prerequisites;
    let known = this.prerequisiteTargets.get(source.view.goalId);
    if (known === undefined) { known = new Map(); this.prerequisiteTargets.set(source.view.goalId, known); }
    // Keep opaque edge identity after public references are scrubbed so repeated losses remain attributable.
    for (const item of page.prerequisites) if (item.edgeId !== undefined && item.target !== null &&
      readGeneration >= (this.targetWithdrawals.get(item.target.goalId)?.generation ?? 0)) known.set(item.edgeId, { goalId: item.target.goalId, projectId: item.target.projectId });
    const hidden = page.prerequisites.flatMap(item => {
      if (item.target !== null || item.edgeId === undefined) return [];
      const target = known.get(item.edgeId) ?? prior?.find(previous => previous.edgeId === item.edgeId)?.target ?? undefined;
      return target === undefined ? [] : [target];
    });
    if (hidden.length === 0) return;
    const generation = ++this.withdrawalGeneration;
    for (const goal of hidden) {
      this.withdrawTarget(goal, generation);
      const target = this.sources.get(goal.goalId);
      if (target !== undefined) { this.cancel(target); this.sources.delete(goal.goalId); }
    }
    const removed = new Set(hidden.map(goal => goal.goalId));
    for (const retained of this.sources.values()) {
      const contribution = retained.view.contribution;
      if (contribution === null) continue;
      const prerequisites = contribution.prerequisites.map(item => item.target !== null && removed.has(item.target.goalId) ? { ...item, target: null } : item);
      retained.view = { ...retained.view, contribution: { ...contribution, prerequisites,
        successors: contribution.successors.filter(goal => !removed.has(goal.goalId)) }, hiddenCount: prerequisites.filter(item => item.target === null).length };
    }
    this.queue = this.queue.filter(id => this.sources.has(id));
    this.prune(); this.publish();
  };
  private admitsTarget = (goal: RelatedGoal, readGeneration: number) => {
    const withdrawal = this.targetWithdrawals.get(goal.goalId);
    if (withdrawal !== undefined && readGeneration < withdrawal.generation || this.withdrawnProjects.has(goal.projectId)) return false;
    if (withdrawal !== undefined) this.denied.delete(goal.goalId);
    return true;
  };
  private canvasContributions = () => [...this.sources.values()].flatMap(source => source.view.mode === 'inspection' || source.view.contribution === null ? [] : [source.view.contribution]);
  private prune = () => {
    const baseline = projectGoalAcceptance(this.summaries, this.focusId);
    const reachable = reachableGoalSources(this.projectId, baseline, { sources: new Map([...this.sources].map(([id, source]) => [id, source.view])), deniedIds: this.denied });
    for (const [id, source] of this.sources) {
      const view = reachable.get(id);
      if (view === undefined) { this.cancel(source); this.sources.delete(id); if (!this.targetWithdrawals.has(id)) this.denied.delete(id); }
      else if (view !== source.view) { this.cancel(source); source.view = view; }
    }
    this.queue = this.queue.filter(id => this.sources.has(id));
  };
  private cover = (id: string, mode: 'inspection' | 'expanded') => {
    if (!this.qualified || this.disposed || this.denied.has(id)) return;
    const baseline = projectGoalAcceptance(this.summaries, this.focusId);
    const visible = combineGoalRelations(this.projectId, baseline, this.canvasContributions(), this.denied);
    if (!visible.goals.has(id)) return;
    const existing = this.sources.get(id);
    if (existing !== undefined) {
      if (mode === 'expanded' && existing.view.mode === 'inspection') {
        existing.view = { ...existing.view, mode }; this.prune(); this.publish();
      }
      return;
    }
    const related = relationTargets(this.canvasContributions(), this.denied).get(id);
    const goal = visible.goals.get(id)!;
    const sourceProjectId = goal.project === undefined ? this.projectId : related!.projectId;
    if (this.withdrawnProjects.has(sourceProjectId)) return;
    const local = this.summaries.get(id);
    const key = local?.type === 'goal' ? `${local.version}:${this.scope.getHistoryGeneration(sourceProjectId)}` : `${this.scope.getHistoryGeneration(sourceProjectId)}`;
    this.sources.set(id, { generation: 0, key, controller: null,
      view: { goalId: id, projectId: sourceProjectId, title: goal.titlePreview, mode, phase: 'queued', contribution: null, hiddenCount: 0, error: null } });
    this.enqueue(id);
  };
  inspect = (id: string) => this.cover(id, 'inspection');
  expand = (id: string) => this.cover(id, 'expanded');
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
    this.setRoots(this.summaries, this.focusId);
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
    // An incomplete replacement prefix cannot prove that later successors disappeared.
    const replacing = source.view.contribution !== null;
    const retainedContribution = () => selectLegalContributions(this.projectId, projectGoalAcceptance(this.summaries, this.focusId), this.contributions(), this.denied).accepted
      .find(contribution => contribution.sourceId === source.view.goalId) ?? null;
    const controller = new AbortController(); source.controller = controller;
    const generation = source.generation;
    const signal = AbortSignal.any([controller.signal, this.scope.signal, this.scope.mismatchSignal]);
    const current = () => !this.disposed && this.qualified && generation === source.generation && !signal.aborted;
    let fence: ReturnType<TaskCacheScope['captureTaskHistoryFence']> = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    let observedEpoch: string | null = null;
    try {
      await this.scope.ready(signal);
      this.registerProjects([source.view.projectId]);
      const projectionFence = await this.scope.prepareProjection(signal);
      await this.requalify(source);
      if (!current()) return;
      fence = this.scope.captureTaskHistoryFence(source.view.projectId, source.view.goalId, generation, generation);
      if (fence === null) { source.view = { ...source.view, phase: 'interrupted' }; this.publish(); return; }
      observedEpoch = this.scope.getObservedHistoryTicket(source.view.projectId)?.epoch ?? null;
      source.view = { ...source.view, phase: 'loading' }; this.publish();
      let cursor: string | null = null, identity: string | null = null;
      const seen = new Set<string>(), successors = new Map<string, RelatedGoal>(), successorGenerations = new Map<string, number>();
      do {
        let readGeneration = this.withdrawalGeneration;
        const result = await this.read(source.view.projectId, source.view.goalId, cursor, signal, {
          userId: this.scope.userId, onPrincipalMismatch: this.scope.principalMismatch,
          onDispatch: () => { readGeneration = this.withdrawalGeneration; timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMilliseconds); },
        });
        if (timeout !== null) clearTimeout(timeout); timeout = null;
        if (!current() || !await this.scope.verifyTaskRead(fence, signal) || !current()) return;
        if (result.kind === 'unavailable') {
          const retained = retainedContribution();
          source.view = { ...source.view, phase: 'unavailable', contribution: retained, hiddenCount: retained === null ? 0 : source.view.hiddenCount, error: null }; this.prune(); this.publish(); return;
        }
        const page = result.page;
        this.withdrawHiddenTargets(source, page, readGeneration);
        if (!current()) return;
        if (identity !== null && identity !== pageIdentity(page)) throw new ApiError('protocol');
        if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new ApiError('protocol');
        identity = pageIdentity(page);
        for (const goal of page.successors) if (this.admitsTarget(goal, readGeneration)) { successors.set(goal.goalId, goal); successorGenerations.set(goal.goalId, readGeneration); }
        for (const [id] of successors) if (this.denied.has(id) || (this.targetWithdrawals.get(id)?.generation ?? 0) > successorGenerations.get(id)!) successors.delete(id);
        const prerequisites = page.prerequisites.map(item => item.target !== null && !this.admitsTarget(item.target, readGeneration) ? { ...item, target: null } : item);
        let candidate: GoalRelationContribution = { sourceId: source.view.goalId, sourceProjectId: source.view.projectId, prerequisites, successors: [...successors.values()] };
        const candidates = this.contributionCandidates(source, candidate);
        this.registerProjects(candidates.map(item => item.projectId));
        const allowed = await this.scope.qualifyProjection(projectionFence, candidates, signal);
        if (!current()) return;
        if (!allowed.has(`${source.view.projectId}/${source.view.goalId}`)) {
          source.view = { ...source.view, phase: 'interrupted', contribution: null, hiddenCount: 0, error: null }; this.prune(); this.publish(); return;
        }
        candidate = { ...candidate, prerequisites: candidate.prerequisites.map(item => item.target !== null && !allowed.has(`${item.target.projectId}/${item.target.goalId}`) ? { ...item, target: null } : item),
          successors: candidate.successors.filter(goal => allowed.has(`${goal.projectId}/${goal.goalId}`)) };
        const denied = new Set(this.denied); denied.delete(source.view.goalId);
        if (contributionConflicts(this.projectId, projectGoalAcceptance(this.summaries, this.focusId), this.contributions(candidate), denied)) {
          const retained = retainedContribution();
          source.view = { ...source.view, phase: 'conflict', contribution: retained, hiddenCount: retained === null ? 0 : source.view.hiddenCount, error: null }; this.prune(); this.publish(); return;
        }
        this.denied.delete(source.view.goalId);
        const complete = page.nextCursor === null;
        source.view = { ...source.view, phase: complete ? 'ready' : 'partial',
          contribution: replacing && !complete ? source.view.contribution : candidate,
          hiddenCount: replacing && !complete ? source.view.hiddenCount : candidate.prerequisites.filter(item => item.target === null).length, error: null };
        if (!replacing || complete) this.projectionFences.set(source.view.goalId, projectionFence);
        this.prune(); this.publish();
        cursor = page.nextCursor;
        if (cursor !== null) seen.add(cursor);
      } while (cursor !== null && current());
    } catch (error) {
      if (this.disposed || !this.qualified || generation !== source.generation || fence === null) return;
      if (timedOut) error = new ApiError('network');
      else if (signal.aborted || isAbortError(error)) return;
      const denied = deniedError(error);
      if (!this.scope.isTaskHistoryPossiblyCurrent(fence)) return;
      if (error instanceof ApiError && error.status === 410 && error.code === 'task_deleted' && this.scope.reportTaskDeleted(fence, observedEpoch)) return;
      if (!denied) {
        try { if (!await this.scope.verifyTaskRead(fence, this.scope.signal)) return; }
        catch (verificationError) { if (isAbortError(verificationError)) return; error = verificationError; }
      }
      if (generation !== source.generation || this.disposed) return;
      if (denied) this.denied.add(source.view.goalId);
      source.view = { ...source.view, phase: denied ? 'denied' : 'failed', contribution: denied ? null : source.view.contribution, hiddenCount: denied ? 0 : source.view.hiddenCount, error };
      this.prune(); this.publish();
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      if (source.controller === controller) source.controller = null;
    }
  };
  dispose = () => { this.disposed = true; this.cancelAll(); this.unsubscribe(); for (const unregister of this.projectRegistrations.values()) unregister(); this.projectRegistrations.clear(); this.projectionFences.clear(); this.listeners.clear(); };
}
