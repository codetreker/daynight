import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../src/api/types';
import { acceptanceTopology, projectGoalAcceptance, traceGoalRelations } from '../src/features/goal-acceptance-graph/model';
import { graph } from './graph-model-fixture';

const summaries = (tasks: Parameters<typeof graph>[0]): Map<string, TaskSummary> => new Map(graph(tasks).tasks.map(({ blockedBy: _blocked, ready: _ready, ...task }) =>
  [task.id, { ...task, type: 'goal' as const, title: task.id, titlePreview: task.id, version: 1n, properties: {}, tags: [] } satisfies TaskSummary]));

describe('project-local Goal acceptance projection', () => {
  it('retains isolated active roots and direct terminal prerequisites, excluding unrelated terminal Goals and ordinary edges', () => {
    const input = summaries([{ id: 'done', status: 'done' }, { id: 'cancelled', status: 'cancelled' }, { id: 'root', dependsOn: ['done', 'cancelled'] },
      { id: 'isolated', status: 'in_progress' }, { id: 'unrelated', status: 'done' }, { id: 'ordinary', dependsOn: ['root'] }]);
    input.set('ordinary', { ...input.get('ordinary')!, type: 'task' });
    const result = projectGoalAcceptance(input);
    expect([...result.goals.keys()]).toEqual(['done', 'cancelled', 'root', 'isolated']);
    expect(result.edges).toEqual([{ source: 'done', target: 'root', external: false }, { source: 'cancelled', target: 'root', external: false }]);
    expect(result.successors.get('done')).toEqual(['root']);
  });

  it('explicitly focused terminal Goals keep their direct prerequisites', () => {
    const result = projectGoalAcceptance(summaries([{ id: 'prior', status: 'done' }, { id: 'focused', status: 'cancelled', dependsOn: ['prior'] }]), 'focused');
    expect([...result.mainIds]).toEqual(['focused', 'prior']);
    expect(result.prerequisites.get('focused')).toEqual(['prior']);
  });

  it('traces only loaded relationships and updates the topology on removal of the final edge', () => {
    const input = summaries([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }, { id: 'isolated' }]);
    const before = projectGoalAcceptance(input);
    expect([...traceGoalRelations(before.prerequisites, 'c')]).toEqual(['c', 'b', 'a']);
    expect([...traceGoalRelations(before.successors, 'a')]).toEqual(['a', 'b', 'c']);
    input.set('c', { ...input.get('c')!, dependsOn: [] });
    const after = projectGoalAcceptance(input);
    expect(after.prerequisites.get('c')).toEqual([]);
    expect(acceptanceTopology(after)).not.toBe(acceptanceTopology(before));
    input.set('a', { ...input.get('a')!, titlePreview: 'Renamed', status: 'in_progress' });
    expect(acceptanceTopology(projectGoalAcceptance(input))).toBe(acceptanceTopology(after));
  });
});
