import type { TaskSummary } from '../src/api/types';
import { describe, expect, it } from 'vitest';
import { resolveProjectGraphTarget } from '../src/features/projects/project-graph-target';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { graph } from './graph-model-fixture';

const root = '00000000-0000-4000-8000-000000000001';
const witness = '00000000-0000-4000-8000-000000000002';
const replacement = '00000000-0000-4000-8000-000000000003';
const missing = '00000000-0000-4000-8000-000000000004';

describe('project graph target', () => {
  it('resolves the actual witness to its current ordinary component after merge and split', () => {
    const before = buildGraphIndex(graph([{ id: root }, { id: witness, dependsOn: [root] }, { id: replacement }]));
    const merged = buildGraphIndex(graph([{ id: replacement }, { id: root, dependsOn: [replacement] }, { id: witness, dependsOn: [root] }]));
    const split = buildGraphIndex(graph([{ id: root }, { id: replacement }, { id: witness, dependsOn: [replacement] }]));
    expect(resolveProjectGraphTarget(witness, before)).toEqual({ kind: 'chain', witnessTaskId: witness, rootId: root });
    expect(resolveProjectGraphTarget(witness, merged)).toEqual({ kind: 'chain', witnessTaskId: witness, rootId: replacement });
    expect(resolveProjectGraphTarget(witness, split)).toEqual({ kind: 'chain', witnessTaskId: witness, rootId: replacement });
  });

  it('admits typed Goals independently of their membership, and rejects absent resources', () => {
    const data = graph([{ id: root }, { id: witness }]);
    const index = buildGraphIndex({ ...data, tasks: data.tasks.map((task) => task.id === witness ? { ...task, parentId: missing } : task) });
    const summaries = new Map([[missing, { id: missing, type: 'goal' } as TaskSummary]]);
    expect(resolveProjectGraphTarget(missing, index, summaries)).toEqual({ kind: 'goal', goalId: missing });
    expect(resolveProjectGraphTarget(missing, buildGraphIndex(graph([])), summaries)).toEqual({ kind: 'goal', goalId: missing });
    expect(resolveProjectGraphTarget(missing, index, new Map())).toBeNull();
  });

  it('rejects missing snapshots, absent or singleton witnesses, and non-Task resources', () => {
    const input = graph([{ id: root }, { id: witness, dependsOn: [root] }, { id: replacement }]);
    const index = buildGraphIndex(input);
    expect(resolveProjectGraphTarget(null, index)).toBeNull();
    expect(resolveProjectGraphTarget(witness, null)).toBeNull();
    expect(resolveProjectGraphTarget(missing, index)).toBeNull();
    expect(resolveProjectGraphTarget(replacement, index)).toBeNull();
    const goal = buildGraphIndex({ ...input, tasks: input.tasks.map(task => task.id === root ? { ...task, type: 'goal' as const } : task) });
    expect(resolveProjectGraphTarget(root, goal)).toBeNull();
  });
});
