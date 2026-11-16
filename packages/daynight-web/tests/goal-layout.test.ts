import { describe, expect, it } from 'vitest';
import { layoutGoalGraph } from '../src/features/task-graph/goal-layout';
import { layoutGraph, type CanvasLayout, type GraphDirection } from '../src/features/task-graph/layout';
import type { GraphProjection } from '../src/features/task-graph/model';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { entersRectangle, parseRoute } from './route-geometry';

const size = { width: 1040, height: 640 };
const projection = (ids: readonly string[], edges: readonly (readonly [string, string, boolean?])[] = [], external: readonly string[] = []): GraphProjection => ({
  mainIds: new Set(ids), externalIds: new Set(external), edges: edges.map(([source, target, isExternal]) => ({ source, target, external: isExternal ?? false })),
});

const verify = (layout: CanvasLayout, input: GraphProjection, direction: GraphDirection) => {
  const ids = [...input.mainIds, ...input.externalIds].sort();
  expect(layout.nodes.map((node) => node.id)).toEqual(ids);
  expect(layout.edges.map(({ source, target, external }) => ({ source, target, external }))).toEqual([...input.edges].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)));
  expect(Number.isFinite(layout.width) && Number.isFinite(layout.height)).toBe(true);
  const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
  for (const [index, node] of layout.nodes.entries()) {
    expect(node.kind).toBe(input.mainIds.has(node.id) ? 'main' : 'external');
    expect([node.width, node.height]).toEqual([220, 96]);
    expect(node.position.x).toBeGreaterThanOrEqual(0); expect(node.position.y).toBeGreaterThanOrEqual(0);
    expect(node.position.x + node.width).toBeLessThanOrEqual(layout.width); expect(node.position.y + node.height).toBeLessThanOrEqual(layout.height);
    for (const other of layout.nodes.slice(index + 1)) expect(node.position.x + node.width <= other.position.x || other.position.x + other.width <= node.position.x ||
      node.position.y + node.height <= other.position.y || other.position.y + other.height <= node.position.y).toBe(true);
  }
  for (const edge of layout.edges) {
    const source = nodes.get(edge.source)!; const target = nodes.get(edge.target)!;
    const sourcePort = direction === 'horizontal' ? { x: source.position.x + 220, y: source.position.y + 48 } : { x: source.position.x + 110, y: source.position.y + 96 };
    const targetPort = direction === 'horizontal' ? { x: target.position.x, y: target.position.y + 48 } : { x: target.position.x + 110, y: target.position.y };
    expect(edge.points[0]).toEqual(sourcePort); expect(edge.points.at(-1)).toEqual(targetPort);
    expect(direction === 'horizontal' ? sourcePort.x : sourcePort.y).toBeLessThan(direction === 'horizontal' ? targetPort.x : targetPort.y);
    for (const point of edge.points) {
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(layout.width);
      expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(layout.height);
    }
    const route = compileDependencyRoute(edge.points, edge.external, direction);
    if (edge.external) expect(route.pieces.length).toBeGreaterThan(0);
    const curves = parseRoute(route.d);
    expect(curves[0]!.from).toEqual(sourcePort); expect(curves.at(-1)!.to).toEqual(targetPort);
    for (const curve of curves) {
      // The cubic lies in its control polygon, so these checks bound the whole
      // rendered curve rather than just sampled points along it.
      for (const point of [curve.from, curve.to, ...(curve.first === undefined ? [] : [curve.first, curve.second!])]) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(layout.width);
        expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(layout.height);
      }
      for (const node of layout.nodes) expect(entersRectangle(curve, { left: node.position.x, right: node.position.x + node.width,
        top: node.position.y, bottom: node.position.y + node.height })).toBe(false);
    }
  }
};

describe('Goal graph compact layout', () => {
  it.each(['horizontal', 'vertical'] as const)('packs independent tasks in two dimensions in %s', (direction) => {
    const input = projection(Array.from({ length: 30 }, (_, i) => `task-${String(i).padStart(2, '0')}`));
    const result = layoutGoalGraph(input, size, direction);
    verify(result, input, direction);
    expect(new Set(result.nodes.map((node) => node.position.x)).size).toBeGreaterThan(1);
    expect(new Set(result.nodes.map((node) => node.position.y)).size).toBeGreaterThan(1);
    const previous = layoutGraph(input, undefined, direction);
    expect(Math.max(result.width / size.width, result.height / size.height)).toBeLessThan(Math.max(previous.width / size.width, previous.height / size.height));
  });

  it.each(['horizontal', 'vertical'] as const)('routes wrapped ranks, merges, skipped ranks and shared external predecessors in %s', (direction) => {
    const branches = Array.from({ length: 29 }, (_, i) => `b${String(i).padStart(2, '0')}`);
    const input = projection(['root', ...branches, 'merge', 'end', 'independent', 'a', 'z'], [
      ...branches.map((target) => ['root', target] as const), ['root', 'merge'], ['b00', 'merge'], ['b01', 'merge'],
      ['merge', 'end'], ['outside', 'merge', true], ['outside', 'end', true], ['a', 'z'],
    ], ['outside']);
    const result = layoutGoalGraph(input, size, direction);
    verify(result, input, direction);
    const wrapped = result.nodes.filter((node) => branches.includes(node.id));
    expect(new Set(wrapped.map((node) => direction === 'horizontal' ? node.position.x : node.position.y)).size).toBeGreaterThan(1);
    expect(new Set(wrapped.map((node) => direction === 'horizontal' ? node.position.y : node.position.x)).size).toBeGreaterThan(1);
    const reordered: GraphProjection = { mainIds: new Set([...input.mainIds].reverse()), externalIds: new Set([...input.externalIds].reverse()), edges: [...input.edges].reverse() };
    expect(layoutGoalGraph(reordered, size, direction)).toEqual(result);
  });

  it('returns an empty layout and rejects invalid identities, edges, cycles and dimensions', () => {
    expect(layoutGoalGraph(projection([]), size, 'horizontal')).toEqual({ nodes: [], edges: [], width: 0, height: 0, direction: 'horizontal' });
    expect(() => layoutGoalGraph(projection(['a'], [], ['a']), size, 'horizontal')).toThrow(/duplicate node/);
    expect(() => layoutGoalGraph(projection(['a'], [['a', 'missing']]), size, 'horizontal')).toThrow(/endpoints/);
    expect(() => layoutGoalGraph(projection(['a'], [['a', 'a']]), size, 'horizontal')).toThrow(/endpoints/);
    expect(() => layoutGoalGraph(projection(['a', 'b'], [['a', 'b'], ['a', 'b', true]]), size, 'horizontal')).toThrow(/duplicate edges/);
    expect(() => layoutGoalGraph(projection(['a', 'b'], [['a', 'b'], ['b', 'a']]), size, 'horizontal')).toThrow(/cyclic/);
    expect(() => layoutGoalGraph(projection(['a']), { width: 0, height: 100 }, 'horizontal')).toThrow(/dimensions/);
    expect(() => layoutGoalGraph(projection(['a']), { width: Infinity, height: 100 }, 'horizontal')).toThrow(/dimensions/);
  });
});
