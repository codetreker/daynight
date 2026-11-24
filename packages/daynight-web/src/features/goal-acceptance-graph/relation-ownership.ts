import type { RelatedGoal } from '../../api/goal-dependencies';
import type { GoalAcceptanceProjection } from './model';
import { selectLegalContributions } from './relation-projection';
import { canDiscoverGoalRelation } from './relation-discovery';
import type { GoalRelationSnapshot, GoalRelationSource } from './relation-session';

const isCanvasSource = (baseline: GoalAcceptanceProjection, source: GoalRelationSource) => source.mode === 'expanded' || source.mode === 'root' &&
  (baseline.availableGoals.get(source.goalId)?.status === 'todo' || baseline.availableGoals.get(source.goalId)?.status === 'in_progress');

export const reachableGoalSources = (projectId: string, baseline: GoalAcceptanceProjection, snapshot: GoalRelationSnapshot): ReadonlyMap<string, GoalRelationSource> => {
  let sources = new Map(snapshot.sources);
  while (true) {
    const reachable = new Set(baseline.goals.keys()), pending = [...reachable];
    const discover = (source: GoalRelationSource, goal: RelatedGoal, direction: 'prerequisite' | 'successor') => {
      if (reachable.has(goal.goalId) || !canDiscoverGoalRelation(projectId, baseline, source.projectId, goal, direction)) return;
      reachable.add(goal.goalId); pending.push(goal.goalId);
    };
    for (let index = 0; index < pending.length; index++) {
      const source = sources.get(pending[index]!);
      if (source === undefined || snapshot.deniedIds.has(source.goalId) || !isCanvasSource(baseline, source) || source.contribution === null) continue;
      for (const relation of source.contribution.prerequisites) if (relation.target !== null) discover(source, relation.target, 'prerequisite');
      for (const goal of source.contribution.successors) discover(source, goal, 'successor');
    }
    const admitted = new Map([...sources].filter(([id]) => reachable.has(id)));
    const legal = selectLegalContributions(projectId, baseline, [...admitted.values()].flatMap(source =>
      !isCanvasSource(baseline, source) || source.contribution === null ? [] : [source.contribution]), snapshot.deniedIds);
    const next = new Map([...admitted].map(([id, source]) => [id, legal.conflictingIds.has(id)
      ? { ...source, phase: 'conflict' as const, contribution: null } : source]));
    if (next.size === sources.size && legal.conflictingIds.size === 0) return next;
    sources = next;
  }
};

export const canvasGoalContributions = (baseline: GoalAcceptanceProjection, sources: Iterable<GoalRelationSource>) => [...sources].flatMap(source =>
  !isCanvasSource(baseline, source) || source.contribution === null ? [] : [source.contribution]);
