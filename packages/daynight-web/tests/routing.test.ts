import { Graph, layout } from '@dagrejs/dagre';
import { describe, expect, it } from 'vitest';
import { layoutGraph, TASK_NODE_COMPACT_HEIGHT, TASK_NODE_EXPANDABLE_HEIGHT, TASK_NODE_WIDTH, type CanvasEdge, type CanvasLayout } from '../src/features/task-graph/layout';
import type { ChainProjection } from '../src/features/task-graph/model';
import { planDependencyRoutes, type RoutingNode } from '../src/features/task-graph/routing';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { entersRectangle, parseRoute, tangent } from './route-geometry';

const rectangle = (id: string, left: number, top: number): RoutingNode => ({ id, left, top, right: left + 220, bottom: top + 96 });
const edge = (source: string, target: string, points: CanvasEdge['points']): CanvasEdge => ({ id: `${source}->${target}`, source, target, external: false, points });
const layoutRectangles = (actual: CanvasLayout): readonly RoutingNode[] => actual.nodes.map((node) => ({
  id: node.id, left: node.position.x, right: node.position.x + node.width, top: node.position.y, bottom: node.position.y + node.height,
}));
const verify = (nodes: readonly RoutingNode[], edges: readonly CanvasEdge[]) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const failures: string[] = [];
  let curves = 0; let pieces = 0;
  for (const dependency of edges) {
    const source = byId.get(dependency.source)!; const target = byId.get(dependency.target)!;
    const compiled = compileDependencyRoute(dependency.points, dependency.external);
    const route = parseRoute(compiled.d); pieces += compiled.pieces.length;
    const first = route[0]!; const last = route.at(-1)!;
    if (first.from.x !== source.right || first.from.y !== (source.top + source.bottom) / 2 || last.to.x !== target.left || last.to.y !== (target.top + target.bottom) / 2) failures.push(`${dependency.id}: ports`);
    const initial = tangent(first, 0); const final = tangent(last, 1);
    if (initial.x <= 0 || final.x <= 0 || initial.y !== 0 || final.y !== 0) failures.push(`${dependency.id}: horizontal tangents`);
    for (const segment of route) {
      if (segment.to.x < segment.from.x || segment.first !== undefined && (segment.first.x < segment.from.x || segment.second!.x > segment.to.x)) failures.push(`${dependency.id}: backward`);
      if (segment.kind === 'C') curves++;
      const xs = [segment.from.x, segment.to.x, ...(segment.first === undefined ? [] : [segment.first.x, segment.second!.x])];
      const ys = [segment.from.y, segment.to.y, ...(segment.first === undefined ? [] : [segment.first.y, segment.second!.y])];
      const left = Math.min(...xs); const right = Math.max(...xs); const top = Math.min(...ys); const bottom = Math.max(...ys);
      for (const node of nodes) {
        if (node.right <= left || node.left >= right || node.bottom <= top || node.top >= bottom) continue;
        if (entersRectangle(segment, node)) failures.push(`${dependency.id}: crosses ${node.id}`);
      }
    }
    for (let index = 1; index < dependency.points.length; index++) {
      const from = dependency.points[index - 1]!; const to = dependency.points[index]!;
      if (from.x >= to.x) failures.push(`${dependency.id}: non-forward passage`);
      if (index === dependency.points.length - 1) continue;
      const after = dependency.points[index + 1]!;
      if (from.y === to.y && to.y === after.y) failures.push(`${dependency.id}: redundant horizontal passage`);
    }
  }
  expect(failures.slice(0, 10)).toEqual([]);
  return { curves, pieces };
};
const projection = (size: number, edges: readonly (readonly [number, number])[], external = false): ChainProjection => ({
  rootId: 'n0000', mainIds: new Set(Array.from({ length: size }, (_, index) => `n${String(index).padStart(4, '0')}`)), externalIds: new Set(), completed: 0,
  edges: edges.map(([source, target]) => ({ source: `n${String(source).padStart(4, '0')}`, target: `n${String(target).padStart(4, '0')}`, external })),
});
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

describe('uniform node-safe dependency channels', () => {
  it('replaces a steep colliding boundary span without changing any card position', () => {
    const nodes = [rectangle('s', 32, 32), rectangle('obstacle', 32, 160), rectangle('t', 316, 500)];
    const input = edge('s', 't', [{ x: 150, y: 128 }, { x: 284, y: 900 }, { x: 420, y: 500 }]);
    const original = structuredClone({ nodes, input });
    expect(entersRectangle(parseRoute('M150,128 L284,900')[0]!, nodes[1]!)).toBe(true);
    const result = planDependencyRoutes(nodes, [input]);
    expect(result[0]!.points).toEqual([{ x: 252, y: 80 }, { x: 316, y: 548 }]);
    verify(nodes, result); expect({ nodes, input }).toEqual(original);
  });
  it('routes every intermediate column through a free passage and keeps turns in rank gaps', () => {
    const nodes = [rectangle('s', 32, 32), rectangle('a', 316, 32), rectangle('b', 316, 160), rectangle('c', 600, 32), rectangle('t', 884, 300)];
    const input = edge('s', 't', [{ x: 252, y: 80 }, { x: 284, y: 80 }, { x: 426, y: 80 }, { x: 568, y: 144 }, { x: 710, y: 144 }, { x: 852, y: 348 }, { x: 884, y: 348 }]);
    expect(entersRectangle(parseRoute('M426,16 L710,144')[0]!, nodes[3]!)).toBe(true);
    const result = planDependencyRoutes(nodes, [input]); verify(nodes, result);
    expect(result[0]!.points).toEqual([{ x: 252, y: 80 }, { x: 316, y: 16 }, { x: 536, y: 16 }, { x: 600, y: 144 }, { x: 820, y: 144 }, { x: 884, y: 348 }]);
  });
  it('coalesces equal passage rows across many columns into one long straight body', () => {
    const nodes = [rectangle('s', 32, 300), rectangle('a', 316, 32), rectangle('b', 600, 32), rectangle('c', 884, 32), rectangle('t', 1168, 300)];
    const result = planDependencyRoutes(nodes, [edge('s', 't', [{ x: 252, y: 348 }, { x: 426, y: 348 }, { x: 710, y: 348 }, { x: 994, y: 348 }, { x: 1168, y: 348 }])]);
    expect(result[0]!.points).toEqual([{ x: 252, y: 348 }, { x: 1168, y: 348 }]); verify(nodes, result);
  });
  it('chooses both sides of occupied rows, interpolates missing column anchors, and unions tight clearances', () => {
    const nodes = [rectangle('s', 32, 32), rectangle('a', 316, 32), rectangle('b', 316, 140), rectangle('t', 600, 250)];
    const high = planDependencyRoutes(nodes, [edge('s', 't', [{ x: 252, y: 80 }, { x: 600, y: 298 }])]);
    const low = planDependencyRoutes(nodes, [edge('s', 't', [{ x: 252, y: 80 }, { x: 426, y: 240 }, { x: 600, y: 298 }])]);
    verify(nodes, high); verify(nodes, low);
    expect(high[0]!.points.some((point) => point.y === 252)).toBe(true);
    expect(low[0]!.points.some((point) => point.y === 252)).toBe(true);
  });
  it('preserves native Dagre placement and bounds with mixed compact and expandable cards', () => {
    const input = projection(6, [[0, 1], [0, 2], [1, 3], [2, 3], [0, 5], [3, 4], [5, 4]]);
    const heights = new Map([...input.mainIds].map((id, index) => [id, index % 2 === 0 ? TASK_NODE_COMPACT_HEIGHT : TASK_NODE_EXPANDABLE_HEIGHT]));
    const raw = new Graph({ directed: true }); raw.setGraph({ rankdir: 'LR', ranker: 'longest-path', nodesep: 32, ranksep: 64, marginx: 32, marginy: 32 });
    for (const id of [...input.mainIds].sort()) raw.setNode(id, { width: TASK_NODE_WIDTH, height: heights.get(id)! });
    for (const edge of [...input.edges].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))) raw.setEdge(edge.source, edge.target, {});
    layout(raw); const actual = layoutGraph(input, heights);
    expect(actual.width).toBe(raw.graph().width); expect(actual.height).toBe(raw.graph().height);
    for (const node of actual.nodes) {
      expect(node.position).toEqual({ x: raw.node(node.id).x! - node.width / 2, y: raw.node(node.id).y! - node.height / 2 });
      expect(node.width).toBe(TASK_NODE_WIDTH); expect(node.height).toBe(heights.get(node.id));
    }
    verify(layoutRectangles(actual), actual.edges);
  });
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
  it('rejects invalid nodes, unsupported columns and invalid forward geometry', () => {
    const source = rectangle('s', 32, 32); const target = rectangle('t', 600, 32);
    const input = edge('s', 't', [{ x: 252, y: 80 }, { x: 600, y: 80 }]);
    expect(() => planDependencyRoutes([{ ...source, left: NaN }, target], [input])).toThrow(/invalid node bounds/);
    expect(() => planDependencyRoutes([source, { ...source, id: 'other', right: 260 }, target], [input])).toThrow(/nonoverlapping node columns/);
    expect(() => planDependencyRoutes([source, rectangle('other', 252, 32), target], [input])).toThrow(/positive rank gaps/);
    expect(() => planDependencyRoutes([source, rectangle('s', 316, 160), target], [input])).toThrow(/duplicate node identities/);
    expect(() => planDependencyRoutes([source, target], [edge('s', 'missing', input.points)])).toThrow(/forward endpoints/);
    expect(() => planDependencyRoutes([source, target], [edge('t', 's', input.points)])).toThrow(/forward endpoints/);
    expect(() => planDependencyRoutes([source, target], [edge('s', 't', [])])).toThrow(/invalid layout waypoints/);
    expect(() => planDependencyRoutes([source, target], [edge('s', 't', [{ x: 300, y: 1 }, { x: 299, y: 2 }])])).toThrow(/invalid layout waypoints/);
    expect(() => planDependencyRoutes([source, target], [edge('s', 't', [{ x: NaN, y: 1 }, { x: 600, y: 2 }])])).toThrow(/invalid layout waypoints/);
    expect(() => planDependencyRoutes([source, rectangle('m', 316, 32), target], [edge('s', 't', [{ x: 500, y: 80 }, { x: 600, y: 80 }])])).toThrow(/intermediate column passage/);
  });
});
