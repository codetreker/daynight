import type { RelatedGoal, GoalDependencies } from '../../api/goal-dependencies';
import type { GoalAcceptanceGoal, GoalAcceptanceProjection } from './model';
import type { ProjectionEdge } from '../task-graph/model';

export type GoalRelationContribution = {
  readonly sourceId: string;
  readonly sourceProjectId: string;
  readonly prerequisites: GoalDependencies['prerequisites'];
  readonly successors: readonly RelatedGoal[];
};

export const externalRelations = (projectId: string, contributions: Iterable<GoalRelationContribution>, denied: ReadonlySet<string>) => {
  const goals = new Map<string, RelatedGoal>(), edges = new Map<string, ProjectionEdge>();
  const sources = [...contributions], eligible = new Set<string>();
  for (const contribution of sources) {
    for (const relation of contribution.prerequisites) if (relation.target !== null) eligible.add(relation.target.goalId);
    for (const goal of contribution.successors) if (goal.status === 'todo' || goal.status === 'in_progress') eligible.add(goal.goalId);
  }
  for (const contribution of sources) {
    if (denied.has(contribution.sourceId)) continue;
    const include = (goal: RelatedGoal, source: string, target: string) => {
      if (denied.has(goal.goalId) || !eligible.has(goal.goalId) || goal.projectId === projectId && contribution.sourceProjectId === projectId) return;
      goals.set(goal.goalId, goal);
      edges.set(`${source}:${target}`, { source, target, external: true });
    };
    for (const relation of contribution.prerequisites) if (relation.target !== null) include(relation.target, relation.target.goalId, contribution.sourceId);
    for (const relation of contribution.successors) include(relation, contribution.sourceId, relation.goalId);
  }
  return { goals, edges: [...edges.values()] };
};

export const relationTargets = (contributions: Iterable<GoalRelationContribution>, denied: ReadonlySet<string>): ReadonlyMap<string, RelatedGoal> => {
  const targets = new Map<string, RelatedGoal>();
  for (const source of contributions) {
    if (denied.has(source.sourceId)) continue;
    for (const relation of source.prerequisites) if (relation.target !== null && !denied.has(relation.target.goalId)) targets.set(relation.target.goalId, relation.target);
    for (const goal of source.successors) if (!denied.has(goal.goalId)) targets.set(goal.goalId, goal);
  }
  return targets;
};

export const hasGoalRelationCycle = (edges: readonly ProjectionEdge[]): boolean => {
  const indegrees = new Map<string, number>(), successors = new Map<string, string[]>();
  for (const edge of edges) {
    if (!indegrees.has(edge.source)) indegrees.set(edge.source, 0);
    indegrees.set(edge.target, (indegrees.get(edge.target) ?? 0) + 1);
    const next = successors.get(edge.source);
    if (next === undefined) successors.set(edge.source, [edge.target]); else next.push(edge.target);
  }
  const ready = [...indegrees].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]!; visited++;
    for (const target of successors.get(id) ?? []) {
      const remaining = indegrees.get(target)! - 1; indegrees.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  return visited !== indegrees.size;
};

export const contributionConflicts = (projectId: string, baseline: GoalAcceptanceProjection, contributions: Iterable<GoalRelationContribution>, denied: ReadonlySet<string>) =>
  hasGoalRelationCycle([...baseline.edges.filter(edge => !denied.has(edge.source) && !denied.has(edge.target)), ...externalRelations(projectId, contributions, denied).edges]);

export const selectLegalContributions = (projectId: string, baseline: GoalAcceptanceProjection, contributions: Iterable<GoalRelationContribution>, denied: ReadonlySet<string>) => {
  const accepted: GoalRelationContribution[] = [], conflictingIds = new Set<string>();
  for (const contribution of contributions) {
    if (contributionConflicts(projectId, baseline, [...accepted, contribution], denied)) conflictingIds.add(contribution.sourceId);
    else accepted.push(contribution);
  }
  return { accepted, conflictingIds };
};

export const combineGoalRelations = (projectId: string, baseline: GoalAcceptanceProjection, contributions: Iterable<GoalRelationContribution>, denied: ReadonlySet<string>): GoalAcceptanceProjection => {
  const legal = selectLegalContributions(projectId, baseline, contributions, denied);
  const external = externalRelations(projectId, legal.accepted, denied);
  const goals = new Map<string, GoalAcceptanceGoal>([...baseline.goals].filter(([id]) => !denied.has(id)));
  for (const related of external.goals.values()) goals.set(related.goalId, { id: related.goalId, titlePreview: related.title, titleTruncated: false,
    status: related.status, project: { id: related.projectId, name: related.projectName } });
  const edges = [...baseline.edges, ...external.edges].filter(edge => goals.has(edge.source) && goals.has(edge.target));
  const prerequisites = new Map([...goals.keys()].map(id => [id, [] as string[]])), successors = new Map([...goals.keys()].map(id => [id, [] as string[]]));
  for (const edge of edges) { prerequisites.get(edge.target)!.push(edge.source); successors.get(edge.source)!.push(edge.target); }
  return { goals, edges, prerequisites, successors, progress: baseline.progress,
    mainIds: new Set([...baseline.mainIds].filter(id => goals.has(id))), externalIds: new Set([...external.goals.keys()].filter(id => goals.has(id))) };
};
