import { describe, expect, it } from 'vitest';
import type { RelatedGoal } from '../src/api/goal-dependencies';
import type { TaskSummary } from '../src/api/types';
import { projectGoalAcceptance } from '../src/features/goal-acceptance-graph/model';
import { combineGoalRelations, contributionConflicts, relationTargets, type GoalRelationContribution } from '../src/features/goal-acceptance-graph/relation-projection';
import { detailFixture } from './helpers/taskDetail';

const project = '00000000-0000-4000-8000-000000000100';
const other = '00000000-0000-4000-8000-000000000200';
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const goal = (n: number): TaskSummary => {
  const { description: _description, projectId: _project, blockedBy: _blocked, ready: _ready, ...summary } = detailFixture(project, id(n), { type: 'goal', ready: false });
  return { ...summary, titlePreview: summary.title, titleTruncated: false };
};
const external = (n: number, status: RelatedGoal['status'] = 'todo'): RelatedGoal => ({ goalId: id(n), projectId: other, projectName: 'Other Project', status, kind: 'external', title: `Goal ${n}` });
const source = (n: number, prerequisites: RelatedGoal[] = [], successors: RelatedGoal[] = []): GoalRelationContribution => ({ sourceId: id(n), sourceProjectId: project, prerequisites: prerequisites.map(target => ({ target })), successors });

describe('Goal graph external projection', () => {
  it('preserves two-hop relationships within a foreign Project even when the source API calls them internal', () => {
    const baseline = projectGoalAcceptance(new Map([[id(1), goal(1)]]));
    const branch = { ...source(10, [{ ...external(11), kind: 'internal' }]), sourceProjectId: other };
    const result = combineGoalRelations(project, baseline, [source(1, [external(10)]), branch], new Set());
    expect(result.goals.get(id(11))?.project).toEqual({ id: other, name: 'Other Project' });
    expect(result.edges).toContainEqual({ source: id(11), target: id(10), external: true });
  });

  it('uses committed local metadata and local edges when expansion returns to the graph Project', () => {
    const second = { ...goal(2), status: 'done' as const, titlePreview: 'Committed title', dependsOn: [id(3)] };
    const third = { ...goal(3), status: 'done' as const };
    const baseline = projectGoalAcceptance(new Map([[id(1), goal(1)], [id(2), second], [id(3), third]]));
    const local = (n: number): RelatedGoal => ({ ...external(n), projectId: project, projectName: 'Graph Project', title: 'Stale API title' });
    const branch = { ...source(10, [local(2), local(3)]), sourceProjectId: other };
    const result = combineGoalRelations(project, baseline, [source(1, [external(10)]), branch], new Set());
    expect(result.goals.get(id(2))).toEqual(baseline.availableGoals.get(id(2)));
    expect(result.externalIds.has(id(2))).toBe(false);
    expect(result.edges).toContainEqual({ source: id(3), target: id(2), external: false });
    expect(result.edges).toContainEqual({ source: id(2), target: id(10), external: true });
  });

  it('rejects a cycle including synchronized edges between newly exposed local context Goals', () => {
    const second = { ...goal(2), status: 'done' as const, dependsOn: [id(3)] };
    const third = { ...goal(3), status: 'done' as const };
    const baseline = projectGoalAcceptance(new Map<string, TaskSummary>([[id(1), { ...goal(1), dependsOn: [id(3)] }], [id(2), second], [id(3), third]]));
    const local = (n: number): RelatedGoal => ({ ...external(n), projectId: project, projectName: 'Graph Project' });
    const branch = { ...source(10, [local(2)], [local(3)]), sourceProjectId: other };
    expect(contributionConflicts(project, baseline, [source(1, [external(10)]), branch], new Set())).toBe(true);
  });
  it('uses real Project labels and never adds progress or fabricated summary fields to external cards', () => {
    const baseline = projectGoalAcceptance(new Map([[id(1), goal(1)]]));
    const result = combineGoalRelations(project, baseline, [source(1, [external(10, 'done')], [external(20)])], new Set());
    expect(result.goals.get(id(10))).toEqual({ id: id(10), titlePreview: 'Goal 10', titleTruncated: false, status: 'done', project: { id: other, name: 'Other Project' } });
    expect(result.progress.has(id(10))).toBe(false);
    expect(result.edges).toEqual([{ source: id(10), target: id(1), external: true }, { source: id(1), target: id(20), external: true }]);
  });

  it('keeps terminal successors inspection-only unless also eligible as prerequisites', () => {
    const baseline = projectGoalAcceptance(new Map([[id(1), goal(1)], [id(2), goal(2)]]));
    const contribution = source(1, [], [external(10, 'done')]);
    const direct = combineGoalRelations(project, baseline, [contribution], new Set());
    expect(direct.goals.has(id(10))).toBe(false);
    expect(relationTargets([contribution], new Set()).get(id(10))?.status).toBe('done');
    const extended = combineGoalRelations(project, baseline, [contribution, source(2, [external(10, 'done')])], new Set());
    expect(extended.goals.has(id(10))).toBe(true);
    expect(extended.edges).toHaveLength(2);
  });

  it('ignores read API project-local edges and deduplicates the same visible cross-project edge', () => {
    const baseline = projectGoalAcceptance(new Map([[id(1), goal(1)]]));
    const local: RelatedGoal = { ...external(2), projectId: project, projectName: 'Local', kind: 'internal' };
    const contribution = source(1, [external(10), local]);
    const result = combineGoalRelations(project, baseline, [contribution, contribution], new Set());
    expect(result.goals.has(id(2))).toBe(false);
    expect(result.edges).toEqual([{ source: id(10), target: id(1), external: true }]);
  });

  it('filters trusted source denial from cards and edges and retains legal local edges when stale external sets conflict', () => {
    const second = { ...goal(2), dependsOn: [id(1)] };
    const baseline = projectGoalAcceptance(new Map([[id(1), goal(1)], [id(2), second]]));
    const contributions = [source(1, [external(10)]), source(2, [], [external(10)])];
    expect(contributionConflicts(project, baseline, contributions, new Set())).toBe(true);
    const result = combineGoalRelations(project, baseline, contributions, new Set());
    expect(result.edges.some(edge => edge.source === id(1) && edge.target === id(2) && !edge.external)).toBe(true);
    expect(result.edges.some(edge => edge.source === id(2) && edge.target === id(10))).toBe(false);
    const denied = combineGoalRelations(project, baseline, contributions, new Set([id(1)]));
    expect(denied.goals.has(id(1))).toBe(false);
    expect(denied.edges.some(edge => edge.source === id(1) || edge.target === id(1))).toBe(false);
  });
});
