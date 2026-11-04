import { Graph, layout } from '@dagrejs/dagre';
import { describe, expect, it } from 'vitest';
import { layoutGraph, TASK_NODE_COMPACT_HEIGHT, TASK_NODE_EXPANDABLE_HEIGHT, TASK_NODE_WIDTH } from '../src/features/task-graph/layout';
import { planDependencyRoutes } from '../src/features/task-graph/routing';
import { entersRectangle, parseRoute } from './route-geometry';
import { edge, layoutRectangles, projection, rectangle, verifyRoutes as verify } from './routing-fixture';

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
