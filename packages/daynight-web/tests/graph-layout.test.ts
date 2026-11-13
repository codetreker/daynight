import { describe, expect, it } from 'vitest';
import type { ChainProjection, GraphProjection } from '../src/features/task-graph/model';
import { layoutGraph, TASK_NODE_COMPACT_HEIGHT, TASK_NODE_EXPANDABLE_HEIGHT, TASK_NODE_WIDTH, type CanvasLayout } from '../src/features/task-graph/layout';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { entersRectangle, parseRoute, tangent } from './route-geometry';

const projection = (
  mainIds: readonly string[],
  edges: readonly (readonly [string, string])[],
  externalIds: readonly string[] = [],
  externalEdges: readonly (readonly [string, string])[] = [],
): ChainProjection => ({
  rootId: mainIds[0] ?? '',
  mainIds: new Set(mainIds),
  externalIds: new Set(externalIds),
  edges: edges.map(([source, target]) => ({ source, target, external: externalEdges.some(([from, to]) => from === source && to === target) })),
  completed: 0,
});

const verifyGeometry = (actual: CanvasLayout, expected: ChainProjection) => {
  const expectedIds = [...expected.mainIds, ...expected.externalIds].sort();
  expect(actual.nodes.map((node) => node.id)).toEqual(expectedIds);
  expect(new Set(actual.nodes.map((node) => node.id)).size).toBe(expectedIds.length);
  expect(actual.edges.map(({ source, target, external }) => ({ source, target, external }))).toEqual(
    [...expected.edges].sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target)),
  );
  expect(new Set(actual.edges.map((edge) => edge.id)).size).toBe(expected.edges.length);
  expect(Number.isFinite(actual.width)).toBe(true);
  expect(Number.isFinite(actual.height)).toBe(true);
  expect(actual.width).toBeGreaterThan(TASK_NODE_WIDTH);
  expect(actual.height).toBeGreaterThan(TASK_NODE_COMPACT_HEIGHT);
  const nodes = new Map(actual.nodes.map((node) => [node.id, node]));
  for (const node of actual.nodes) {
    expect(Number.isFinite(node.position.x)).toBe(true);
    expect(Number.isFinite(node.position.y)).toBe(true);
    expect(node.position.x).toBeGreaterThan(0);
    expect(node.position.y).toBeGreaterThan(0);
    expect(node.position.x + TASK_NODE_WIDTH).toBeLessThan(actual.width);
    expect(node.position.y + node.height).toBeLessThan(actual.height);
    expect(node.kind).toBe(expected.mainIds.has(node.id) ? 'main' : 'external');
  }
  for (const edge of actual.edges) {
    const source = nodes.get(edge.source)!;
    const target = nodes.get(edge.target)!;
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    expect(source.position.x + TASK_NODE_WIDTH).toBeLessThan(target.position.x);
    expect(edge.points.length).toBeGreaterThanOrEqual(2);
    for (const point of edge.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(actual.width);
      expect(point.y).toBeLessThanOrEqual(actual.height);
    }
  }
  for (let leftIndex = 0; leftIndex < actual.nodes.length; leftIndex++) {
    const left = actual.nodes[leftIndex]!;
    for (const right of actual.nodes.slice(leftIndex + 1)) {
      const separateHorizontally = left.position.x + TASK_NODE_WIDTH <= right.position.x ||
        right.position.x + TASK_NODE_WIDTH <= left.position.x;
      const separateVertically = left.position.y + left.height <= right.position.y ||
        right.position.y + right.height <= left.position.y;
      expect(separateHorizontally || separateVertically).toBe(true);
    }
  }
};

describe('horizontal task graph layout', () => {
  it('exports compact and expandable task card dimensions', () => {
    expect(TASK_NODE_WIDTH).toBe(220);
    expect(TASK_NODE_COMPACT_HEIGHT).toBe(96);
    expect(TASK_NODE_EXPANDABLE_HEIGHT).toBe(136);
  });

  it('returns an explicit empty layout without non-finite Dagre bounds', () => {
    expect(layoutGraph(projection([], []))).toEqual({ nodes: [], edges: [], width: 0, height: 0, direction: 'horizontal' });
  });

  it.each(['horizontal', 'vertical'] as const)('lays out a rootless projection with the same geometry in %s', (direction) => {
    const chain = projection(['A', 'B', 'C'], [['A', 'B'], ['X', 'B']], ['X'], [['X', 'B']]);
    const shared: GraphProjection = { mainIds: chain.mainIds, externalIds: chain.externalIds, edges: chain.edges };
    const result = layoutGraph(shared, undefined, direction);
    expect(result).toEqual(layoutGraph(chain, undefined, direction));
    expect(result.nodes.map(({ id }) => id)).toEqual(['A', 'B', 'C', 'X']);
    expect(result.edges.map(({ source, target, external }) => ({ source, target, external }))).toEqual([
      { source: 'A', target: 'B', external: false }, { source: 'X', target: 'B', external: true },
    ]);
  });

  it('routes mixed-height cards to their actual boundaries without overlapping cards', () => {
    const input = projection(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']]);
    const heights = new Map([['A', 96], ['B', 136], ['C', 96], ['D', 136]]);
    const actual = layoutGraph(input, heights);
    verifyGeometry(actual, input);
    const nodes = new Map(actual.nodes.map((node) => [node.id, node]));
    for (const node of actual.nodes) expect(node.height).toBe(heights.get(node.id));
    for (const edge of actual.edges) {
      const source = nodes.get(edge.source)!;
      const target = nodes.get(edge.target)!;
      const first = edge.points[0]!;
      const last = edge.points.at(-1)!;
      for (const [point, node] of [[first, source], [last, target]] as const) {
        expect(point.x).toBeGreaterThanOrEqual(node.position.x);
        expect(point.x).toBeLessThanOrEqual(node.position.x + node.width);
        expect(point.y).toBeGreaterThanOrEqual(node.position.y);
        expect(point.y).toBeLessThanOrEqual(node.position.y + node.height);
        const boundaryDistance = Math.min(Math.abs(point.x - node.position.x), Math.abs(point.x - node.position.x - node.width),
          Math.abs(point.y - node.position.y), Math.abs(point.y - node.position.y - node.height));
        expect(boundaryDistance).toBeCloseTo(0);
      }
    }
  });

  it.each([
    ['single independent task', projection(['独立任务'], [])],
    ['chain', projection(['A', 'B', 'C'], [['A', 'B'], ['B', 'C']])],
    ['diamond', projection(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']])],
    ['fan out and merge', projection(['A', 'B', 'C', 'D', 'E'], [['A', 'B'], ['A', 'C'], ['A', 'D'], ['B', 'E'], ['C', 'E'], ['D', 'E']])],
    ['multiple external predecessors', projection(['A', 'C', 'D'], [['A', 'C'], ['B', 'C'], ['C', 'D'], ['X', 'D']], ['B', 'X'])],
    ['complete external diamond', projection(['A', 'D'], [['A', 'D'], ['B', 'C'], ['B', 'E'], ['C', 'F'], ['E', 'F'], ['F', 'D']], ['B', 'C', 'E', 'F'])],
    ['disconnected independent tasks', projection(['A', 'B', 'C'], [])],
    ['long unicode task identity', projection(['节点甲'.repeat(30), '节点乙'.repeat(30)], [['节点甲'.repeat(30), '节点乙'.repeat(30)]])],
  ])('preserves every node and edge with finite, nonoverlapping LR geometry: %s', (_name, input) => {
    verifyGeometry(layoutGraph(input), input);
  });

  it('retains node identities and context roles independently from explicit edge styles', () => {
    const first = projection(['A', 'C', 'D'], [['A', 'C'], ['B', 'C'], ['C', 'D']], ['B'], [['B', 'C']]);
    const second = projection(['B', 'C', 'D'], [['A', 'C'], ['B', 'C'], ['C', 'D']], ['A'], [['A', 'C']]);
    const a = layoutGraph(first);
    const b = layoutGraph(second);
    verifyGeometry(a, first);
    verifyGeometry(b, second);
    expect(a.nodes.find((node) => node.id === 'C')?.kind).toBe('main');
    expect(b.nodes.find((node) => node.id === 'C')?.kind).toBe('main');
    expect(a.nodes.find((node) => node.id === 'B')?.kind).toBe('external');
    expect(b.nodes.find((node) => node.id === 'A')?.kind).toBe('external');
  });

  it('produces identical layout from reordered sets and edges without mutating the projection', () => {
    const input = projection(['A', 'B', 'C', 'D'], [['X', 'D'], ['C', 'D'], ['A', 'C'], ['B', 'D'], ['A', 'B']], ['X']);
    const original = {
      mainIds: [...input.mainIds], externalIds: [...input.externalIds], edges: structuredClone(input.edges),
    };
    const reordered = {
      ...input,
      mainIds: new Set([...input.mainIds].reverse()),
      externalIds: new Set([...input.externalIds].reverse()),
      edges: [...input.edges].reverse(),
    };
    const first = layoutGraph(input);
    const second = layoutGraph(reordered);
    expect(second).toEqual(first);
    expect(layoutGraph(input)).toEqual(first);
    expect([...input.mainIds]).toEqual(original.mainIds);
    expect([...input.externalIds]).toEqual(original.externalIds);
    expect(input.edges).toEqual(original.edges);
  });

  it('returns fresh geometry so canvas updates cannot contaminate subsequent layouts', () => {
    const input = projection(['A', 'B'], [['A', 'B']]);
    const first = layoutGraph(input);
    const second = layoutGraph(input);
    expect(first).toEqual(second);
    expect(first.nodes).not.toBe(second.nodes);
    expect(first.nodes[0]!.position).not.toBe(second.nodes[0]!.position);
    expect(first.edges[0]!.points).not.toBe(second.edges[0]!.points);
  });
});

describe('vertical task graph layout', () => {
  it('routes complete mixed-height branching and cross-rank dependencies around every card', () => {
    const input = projection(['A', 'B', 'C', 'D', 'E'],
      [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['A', 'D'], ['D', 'E'], ['X', 'E']], ['X'], [['X', 'E']]);
    const heights = new Map([['A', 96], ['B', 136], ['C', 96], ['D', 136], ['E', 96], ['X', 136]]);
    const result = layoutGraph(input, heights, 'vertical');
    expect(result.direction).toBe('vertical');
    expect(result.edges).toHaveLength(input.edges.length);
    const nodes = new Map(result.nodes.map((node) => [node.id, node]));
    for (const [index, node] of result.nodes.entries()) {
      expect(node.height).toBe(heights.get(node.id));
      for (const other of result.nodes.slice(index + 1)) {
        expect(node.position.x + node.width <= other.position.x || other.position.x + other.width <= node.position.x ||
          node.position.y + node.height <= other.position.y || other.position.y + other.height <= node.position.y).toBe(true);
      }
    }
    for (const edge of result.edges) {
      const source = nodes.get(edge.source)!; const target = nodes.get(edge.target)!;
      expect(edge.points[0]).toEqual({ x: source.position.x + source.width / 2, y: source.position.y + source.height });
      expect(edge.points.at(-1)).toEqual({ x: target.position.x + target.width / 2, y: target.position.y });
      expect(source.position.y + source.height).toBeLessThan(target.position.y);
      const compiled = compileDependencyRoute(edge.points, edge.external, 'vertical');
      if (edge.external) expect(compiled.pieces.length).toBeGreaterThan(0);
      const curves = parseRoute(compiled.d);
      const start = tangent(curves[0]!, 0); const end = tangent(curves.at(-1)!, 1);
      expect(start.x).toBeCloseTo(0); expect(start.y).toBeGreaterThan(0);
      expect(end.x).toBeCloseTo(0); expect(end.y).toBeGreaterThan(0);
      for (const curve of curves) for (const node of result.nodes) {
        expect(entersRectangle(curve, { left: node.position.x, top: node.position.y,
          right: node.position.x + node.width, bottom: node.position.y + node.height })).toBe(false);
      }
    }
  });
});
