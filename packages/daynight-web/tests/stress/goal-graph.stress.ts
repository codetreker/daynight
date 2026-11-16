import './local-only';
import { describe, expect, it } from 'vitest';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import { projectGoal } from '../../src/features/task-graph/goal-projection';
import { layoutGoalGraph } from '../../src/features/task-graph/goal-layout';
import { graph } from '../graph-model-fixture';

const goalId = 'goal';
const id = (position: number) => `task-${String(position).padStart(4, '0')}`;

describe('Goal graph bounded capacity', () => {
  it.each(['disconnected', 'chain', 'fanout', 'mixed'] as const)('projects and lays out 1000 distinct tasks in %s topology', (shape) => {
    const seeds = Array.from({ length: 1000 }, (_, i) => ({
      id: id(i),
      dependsOn: shape === 'chain' && i > 0 ? [id(i - 1)]
        : shape === 'fanout' && i > 0 ? [id(0)]
        : shape === 'mixed' && i >= 500 ? Array.from({ length: 10 }, (_, j) => id((i * 7 + j * 31) % 500)) : [],
      externalDependsOn: shape === 'mixed' && i >= 500 ? [id((i * 7) % 500)] : [],
    }));
    const input = graph(seeds);
    const index = buildGraphIndex({ ...input, tasks: input.tasks.map((task, i) => ({ ...task, parentId: shape === 'mixed' && i < 500 ? null : goalId })) });
    const projection = projectGoal(index, goalId);
    expect(new Set([...projection.mainIds, ...projection.externalIds]).size).toBe(1000);
    expect(projection.edges).toHaveLength(shape === 'fanout' || shape === 'chain' ? 999 : shape === 'mixed' ? 5000 : 0);
    expect(projection.externalIds.size).toBe(shape === 'mixed' ? 500 : 0);

    for (const direction of ['horizontal', 'vertical'] as const) {
      const start = performance.now();
      const geometry = layoutGoalGraph(projection, { width: 1040, height: 640 }, direction);
      const elapsedMs = Math.round(performance.now() - start);
      console.info(`${shape} ${direction}: ${geometry.nodes.length} nodes, ${geometry.edges.length} edges, ${elapsedMs} ms`);
      expect(new Set(geometry.nodes.map(node => node.id))).toEqual(new Set([...projection.mainIds, ...projection.externalIds]));
      expect(geometry.edges.map(({ source, target, external }) => `${source}->${target}:${external}`).sort())
        .toEqual(projection.edges.map(({ source, target, external }) => `${source}->${target}:${external}`).sort());
      expect(Number.isFinite(geometry.width) && Number.isFinite(geometry.height)).toBe(true);
      expect(geometry.nodes.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y)
        && node.width === 220 && node.height === 96 && node.position.x >= 0 && node.position.y >= 0
        && node.position.x + node.width <= geometry.width && node.position.y + node.height <= geometry.height)).toBe(true);
      expect(geometry.edges.every(edge => edge.points.length >= 2 && edge.points.every(point =>
        Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0
        && point.x <= geometry.width && point.y <= geometry.height))).toBe(true);
    }
  }, 180_000);
});
