import { expect } from 'vitest';
import type { DashPiece } from '../src/features/task-graph/dashes';
import type { CanvasPoint } from '../src/features/task-graph/layout';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { arcLength, at, distance, parseRoute, tangent, type Curve } from './route-geometry';

const pieceCurves = (piece: DashPiece): Curve[] => piece.kind === 'path' ? parseRoute(piece.d) : [{ kind: 'L', from: piece.from,
  to: { x: piece.from.x + piece.length * piece.cosine, y: piece.from.y + piece.length * piece.sine } }];
const expectPoint = (actual: CanvasPoint, expected: CanvasPoint) => {
  expect(actual.x).toBeCloseTo(expected.x, 6); expect(actual.y).toBeCloseTo(expected.y, 6);
};
const parameterAt = (curve: Curve, point: CanvasPoint): number => {
  if (distance(point, curve.from) < 1e-7) return 0;
  if (distance(point, curve.to) < 1e-7) return 1;
  let low = 0; let high = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const t = (low + high) / 2;
    if (at(curve, t).x < point.x) low = t; else high = t;
  }
  return (low + high) / 2;
};
export const verifyDashes = (points: readonly CanvasPoint[]): readonly DashPiece[] => {
  const compiled = compileDependencyRoute(points, true);
  const route = parseRoute(compiled.d);
  let position = 0; let current = route[0]!.from; let covered = 0;
  for (const piece of compiled.pieces) {
    expect(Math.abs(piece.startDistance - covered) * 1.8).toBeLessThan(0.025);
    if (piece.startDistance > 0) expect(piece.startDistance % 9).toBeCloseTo(7, 7);
    let pieceLength = 0;
    for (const curve of pieceCurves(piece)) {
      const expected = route[position]!;
      expectPoint(curve.from, current); expect(curve.kind).toBe(expected.kind);
      const from = parameterAt(expected, curve.from); const to = parameterAt(expected, curve.to);
      expect(to).toBeGreaterThan(from);
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) expectPoint(at(curve, fraction), at(expected, from + (to - from) * fraction));
      if (curve.kind === 'C') {
        const initial = tangent(expected, from); const final = tangent(expected, to);
        expectPoint(curve.first!, { x: curve.from.x + initial.x * (to - from) / 3, y: curve.from.y + initial.y * (to - from) / 3 });
        expectPoint(curve.second!, { x: curve.to.x - final.x * (to - from) / 3, y: curve.to.y - final.y * (to - from) / 3 });
      }
      const length = arcLength(curve); pieceLength += length; covered += length; current = curve.to;
      if (distance(current, expected.to) < 1e-7) position++;
    }
    expect(pieceLength).toBeLessThanOrEqual(8192.001);
    if (piece.kind === 'line') expect(Math.hypot(piece.cosine, piece.sine)).toBeCloseTo(1, 12);
  }
  expect(position).toBe(route.length); expectPoint(current, route.at(-1)!.to);
  expect(covered).toBeCloseTo(route.reduce((sum, curve) => sum + arcLength(curve), 0), 5);
  return compiled.pieces;
};

