import { describe, expect, it } from 'vitest';
import { prioritizeActiveTasks } from '../src/features/task-graph/active-viewport';
import type { CanvasLayout, CanvasNode } from '../src/features/task-graph/layout';
import type { GraphIndex } from '../src/features/task-graph/model';

const node = (id: string, x: number, y: number, width = 20, height = 20): CanvasNode =>
  ({ id, position: { x, y }, width, height, kind: 'main' });
const layout = (...nodes: CanvasNode[]): CanvasLayout => ({ nodes, edges: [], width: 1000, height: 1000 });
const index = (...ids: string[]): GraphIndex => ({ nodes: new Map(ids.map((id) => [id, { status: 'in_progress' }])) } as unknown as GraphIndex);
const base = { x: 0, y: 0, zoom: 1 };

describe('initial active task framing', () => {
  it('keeps the original viewport when no active cards or all are already visible', () => {
    const graph = layout(node('a', 10, 10), node('b', 60, 60));
    expect(prioritizeActiveTasks(base, 100, 100, graph, index())).toBe(base);
    expect(prioritizeActiveTasks(base, 100, 100, graph, index('a', 'b'))).toBe(base);
  });

  it('moves an offscreen active card by the shortest distance and preserves zoom', () => {
    const graph = layout(node('a', 240, 40, 40, 40));
    expect(prioritizeActiveTasks({ ...base, zoom: 0.5 }, 100, 100, graph, index('a'))).toEqual({ x: -40, y: 0, zoom: 0.5 });
  });

  it('uses the fractional canvas boundary without rounding a card outside it', () => {
    const graph = layout(node('a', 0, 100, 20, 20));
    expect(prioritizeActiveTasks(base, 100, 99.5, graph, index('a'))).toEqual({ x: 0, y: -20.5, zoom: 1 });
  });

  it('maximizes complete cards at closed boundaries and breaks ties by distance', () => {
    const graph = layout(node('a', 0, 0), node('b', 80, 80), node('c', 160, 160), node('d', 240, 240));
    expect(prioritizeActiveTasks(base, 100, 100, graph, index('a', 'b', 'c', 'd'))).toEqual(base);
    expect(prioritizeActiveTasks({ x: -100, y: -100, zoom: 1 }, 100, 100, graph, index('a', 'b', 'c', 'd'))).toEqual({ x: -80, y: -80, zoom: 1 });
  });

  it('uses ascending coordinates for equal-distance optima', () => {
    const graph = layout(node('a', -100, 0), node('b', 180, 0));
    expect(prioritizeActiveTasks(base, 100, 100, graph, index('a', 'b'))).toEqual({ x: -100, y: 0, zoom: 1 });
  });

  it('ignores oversized cards when another fits and centers the nearest when none fit', () => {
    const graph = layout(node('large', 0, 0, 120, 120), node('fit', 160, 10), node('larger', 300, 0, 200, 200));
    expect(prioritizeActiveTasks(base, 100, 100, graph, index('large', 'fit'))).toEqual({ x: -80, y: 0, zoom: 1 });
    expect(prioritizeActiveTasks(base, 100, 100, graph, index('large', 'larger'))).toEqual({ x: -10, y: -10, zoom: 1 });
  });
});
