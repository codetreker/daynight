import './local-only';
import { describe, expect, it } from 'vitest';
import { layoutGraph, TASK_NODE_COMPACT_HEIGHT, TASK_NODE_EXPANDABLE_HEIGHT } from '../../src/features/task-graph/layout';
import type { ChainProjection } from '../../src/features/task-graph/model';
import { layoutRectangles, projection, verifyRoutes as verify } from '../routing-fixture';

const capacity = (kind: 'chain' | 'merge' | 'shared' | 'external'): ChainProjection => {
  const edges: [number, number][] = [];
  if (kind === 'chain') for (let index = 1; index < 1000; index++) edges.push([index - 1, index]);
  if (kind === 'merge') {
    let previous = Array.from({ length: 99 }, (_, index) => index + 1); let next = 100; let additional = 401;
    for (const task of previous) edges.push([0, task]);
    for (let layer = 2; layer <= 10; layer++) {
      const current: number[] = [];
      for (let index = 0; index < 100; index++) {
        const task = next++; current.push(task); const count = additional > 0 ? 6 : 5; if (additional > 0) additional--;
        for (let offset = 0; offset < count; offset++) edges.push([previous[(index * 5 + offset) % previous.length]!, task]);
      }
      previous = current;
    }
  }
  if (kind === 'shared') for (let index = 0; index < 499; index++) {
    edges.push([0, 500 + index]);
    for (let offset = 0; offset < (index < 10 ? 9 : 8); offset++) edges.push([1 + (index * 8 + offset) % 499, 500 + index]);
    edges.push([500 + index, 999]);
  }
  if (kind === 'external') {
    let previous = Array.from({ length: 99 }, (_, index) => index + 1); let next = 100; let additional = 397;
    for (let layer = 1; layer <= 9; layer++) {
      const current: number[] = [];
      for (let index = 0; index < 99; index++) {
        const task = next++; current.push(task); const count = additional > 0 ? 6 : 5; if (additional > 0) additional--;
        for (let offset = 0; offset < count; offset++) edges.push([previous[(index * 5 + offset) % previous.length]!, task]);
      }
      previous = current;
    }
    const tails: number[] = [];
    for (let index = 0; index < 8; index++) { tails.push(next); for (let offset = 0; offset < 5; offset++) edges.push([previous[index * 5 + offset]!, next]); next++; }
    for (const source of [0, ...previous, ...tails]) edges.push([source, 999]);
  }
  return projection(1000, edges, kind === 'shared' || kind === 'external');
};

describe('complete dependency-routing capacity', () => {
  it.each(['chain', 'merge', 'shared', 'external'] as const)('proves all real routes and cubics avoid cards in the complete %s input', (kind) => {
    const actual = layoutGraph(capacity(kind)); expect(actual.nodes).toHaveLength(1000); expect(actual.edges).toHaveLength(kind === 'chain' ? 999 : 5000);
    const cost = verify(layoutRectangles(actual), actual.edges);
    expect(cost.curves).toBeLessThan(kind === 'chain' ? 1 : 30_000); expect(cost.pieces).toBeLessThan(30_000);
    for (const edge of actual.edges) for (const point of edge.points) {
      expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(actual.width);
      expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(actual.height);
    }
  }, 60_000);
  it.each(['chain', 'merge', 'shared', 'external'] as const)('proves the complete %s input with mixed card heights', (kind) => {
    const input = capacity(kind);
    const heights = new Map([...input.mainIds, ...input.externalIds].map((id, index) => [id, index % 2 === 0 ? TASK_NODE_COMPACT_HEIGHT : TASK_NODE_EXPANDABLE_HEIGHT]));
    const actual = layoutGraph(input, heights);
    expect(actual.nodes).toHaveLength(1000); expect(actual.edges).toHaveLength(kind === 'chain' ? 999 : 5000);
    const cost = verify(layoutRectangles(actual), actual.edges);
    expect(cost.curves).toBeLessThan(kind === 'chain' ? 1 : 30_000); expect(cost.pieces).toBeLessThan(30_000);
    for (const node of actual.nodes) expect(node.height).toBe(heights.get(node.id));
  }, 60_000);
  it('proves varied forward routes in deterministic random DAGs', () => {
    let state = 0x7316ab; const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    for (let attempt = 0; attempt < 24; attempt++) {
      const edges: [number, number][] = [];
      for (let target = 1; target < 30; target++) for (let source = 0; source < target; source++) if (random() < 0.16) edges.push([source, target]);
      const input = projection(30, edges, true);
      const heights = new Map([...input.mainIds].map((id, index) => [id, index % 2 === 0 ? TASK_NODE_COMPACT_HEIGHT : TASK_NODE_EXPANDABLE_HEIGHT]));
      const actual = layoutGraph(input, heights); verify(layoutRectangles(actual), actual.edges);
    }
  }, 60_000);
});
