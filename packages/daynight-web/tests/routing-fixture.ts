import { expect } from 'vitest';
import type { CanvasEdge, CanvasLayout } from '../src/features/task-graph/layout';
import type { ChainProjection } from '../src/features/task-graph/model';
import type { RoutingNode } from '../src/features/task-graph/routing';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { entersRectangle, parseRoute, tangent } from './route-geometry';

export const rectangle = (id: string, left: number, top: number): RoutingNode => ({ id, left, top, right: left + 220, bottom: top + 96 });
export const edge = (source: string, target: string, points: CanvasEdge['points']): CanvasEdge => ({ id: `${source}->${target}`, source, target, external: false, points });
export const layoutRectangles = (actual: CanvasLayout): readonly RoutingNode[] => actual.nodes.map((node) => ({
  id: node.id, left: node.position.x, right: node.position.x + node.width, top: node.position.y, bottom: node.position.y + node.height,
}));
export const verifyRoutes = (nodes: readonly RoutingNode[], edges: readonly CanvasEdge[]) => {
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
export const projection = (size: number, edges: readonly (readonly [number, number])[], external = false): ChainProjection => ({
  rootId: 'n0000', mainIds: new Set(Array.from({ length: size }, (_, index) => `n${String(index).padStart(4, '0')}`)), externalIds: new Set(), completed: 0,
  edges: edges.map(([source, target]) => ({ source: `n${String(source).padStart(4, '0')}`, target: `n${String(target).padStart(4, '0')}`, external })),
});
