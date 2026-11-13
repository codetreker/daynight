import './local-only';
import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import { projectGoal } from '../../src/features/task-graph/goal-projection';
import { layoutGraph } from '../../src/features/task-graph/layout';
import { graph } from '../graph-model-fixture';

const goalId = 'goal';
const id = (position: number) => `task-${String(position).padStart(4, '0')}`;

describe('Goal graph bounded capacity', () => {
  it.each(['chain', 'dense', 'disconnected'] as const)('projects and lays out 1000 distinct tasks in %s topology', (shape) => {
    const seeds = Array.from({ length: 1000 }, (_, i) => ({
      id: id(i),
      dependsOn: shape === 'chain' ? (i === 0 ? [] : [id(i - 1)])
        : shape === 'dense' && i >= 500 ? Array.from({ length: 10 }, (_, j) => id((i * 7 + j * 31) % 500)) : [],
    }));
    const input = graph(seeds);
    const index = buildGraphIndex({ ...input, tasks: input.tasks.map((task, i) => ({ ...task, parentId: shape === 'dense' && i < 500 ? null : goalId })) });
    const projection = projectGoal(index, goalId);
    expect(new Set([...projection.mainIds, ...projection.externalIds]).size).toBe(1000);
    expect(projection.edges).toHaveLength(shape === 'chain' ? 999 : shape === 'dense' ? 5000 : 0);
    expect(projection.externalIds.size).toBe(shape === 'dense' ? 500 : 0);
    const geometry = layoutGraph(projection);
    expect(geometry.nodes).toHaveLength(1000);
    expect(geometry.edges).toHaveLength(projection.edges.length);
    expect(geometry.nodes.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y) && node.width === 220 && node.height === 96)).toBe(true);
    expect(geometry.edges.every(edge => edge.points.length >= 2 && edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))).toBe(true);
  }, 180_000);
});
