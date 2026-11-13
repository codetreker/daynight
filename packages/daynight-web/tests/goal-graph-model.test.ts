import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { goalTopologyKey, projectGoal } from '../src/features/task-graph/goal-projection';
import { graph } from './graph-model-fixture';

const input = () => {
  const data = graph([
    { id: 'done', status: 'done' }, { id: 'cancelled', status: 'cancelled' },
    { id: 'progress', status: 'in_progress' }, { id: 'proposed', status: 'proposed' },
    { id: 'other', status: 'done', dependsOn: ['deep'] }, { id: 'deep', status: 'done' },
    { id: 'external', status: 'done' },
    { id: 'todo', dependsOn: ['done', 'other', 'external', 'missing'], externalDependsOn: ['external'] },
    { id: 'second', dependsOn: ['other'] }, { id: 'successor', dependsOn: ['todo'] },
  ]);
  return buildGraphIndex({ ...data, tasks: data.tasks.map((task) => ({ ...task,
    parentId: ['done', 'cancelled', 'progress', 'proposed', 'todo', 'second'].includes(task.id) ? 'goal' : task.id === 'other' ? 'other-goal' : null,
  })) });
};

describe('Goal graph projection', () => {
  it('includes all members and only deduplicated direct accessible prerequisites with actual edge classification', () => {
    const index = input();
    const projection = projectGoal(index, 'goal');
    expect([...projection.mainIds].sort()).toEqual(['cancelled', 'done', 'progress', 'proposed', 'second', 'todo']);
    expect([...projection.externalIds].sort()).toEqual(['external', 'other']);
    expect(projection.edges).toEqual([
      { source: 'done', target: 'todo', external: false }, { source: 'other', target: 'todo', external: false },
      { source: 'external', target: 'todo', external: true }, { source: 'other', target: 'second', external: false },
    ]);
    expect(index.nodes.get('todo')!.blockedBy).toContain('missing');
  });

  it('treats an empty Goal as a valid empty projection', () => {
    const projection = projectGoal(input(), 'empty');
    expect([...projection.mainIds]).toEqual([]);
    expect([...projection.externalIds]).toEqual([]);
    expect(projection.edges).toEqual([]);
  });

  it('keys framing by membership and edge classification, independent of order', () => {
    const projection = projectGoal(input(), 'goal');
    const reordered = { mainIds: new Set([...projection.mainIds].reverse()), externalIds: new Set([...projection.externalIds].reverse()), edges: [...projection.edges].reverse() };
    expect(goalTopologyKey(reordered)).toBe(goalTopologyKey(projection));
    expect(goalTopologyKey({ ...projection, edges: projection.edges.map((edge, i) => i === 0 ? { ...edge, external: !edge.external } : edge) })).not.toBe(goalTopologyKey(projection));
    expect(goalTopologyKey({ ...projection, mainIds: new Set([...projection.mainIds, 'new']) })).not.toBe(goalTopologyKey(projection));
  });
});
