import { describe, expect, it } from 'vitest';
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
const verify = (points: readonly CanvasPoint[]): readonly DashPiece[] => {
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

describe('cubic dependency routes and native dashes', () => {
  it('keeps horizontal dependencies as unit-scale local lines', () => {
    const points = [{ x: 10, y: 20 }, { x: 2010, y: 20 }];
    expect(verify(points)).toEqual([{ kind: 'line', from: points[0], length: 2000, cosine: 1, sine: 0, startDistance: 0 }]);
    expect(compileDependencyRoute(points, false)).toEqual({ d: 'M10,20 L2010,20', pieces: [] });
  });
  it('uses one full cubic between changing passage rows with horizontal endpoint tangents', () => {
    const points = [{ x: 0, y: 0 }, { x: 64, y: 1000 }];
    const solid = compileDependencyRoute(points, false);
    expect(solid).toEqual({ d: 'M0,0 C32,0 32,1000 64,1000', pieces: [] });
    expect(compileDependencyRoute(points, true).d).toBe(solid.d);
    expect(verify(points)).toEqual([{ kind: 'path', d: solid.d, startDistance: 0 }]);
    for (const y of [-1000, 0.00001]) verify([{ x: 0, y: 0 }, { x: 0.00001, y }]);
  });
  it('coalesces horizontal passages without erasing diagonal passage boundaries', () => {
    const points = Object.freeze([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 264, y: 100 }, { x: 328, y: 200 }].map((point) => Object.freeze(point)));
    const original = structuredClone(points);
    expect(compileDependencyRoute(points, false).d).toBe('M0,0 L200,0 C232,0 232,100 264,100 C296,100 296,200 328,200');
    verify(points); expect(points).toEqual(original);
  });
  it('retains short native paths and the established long-line threshold', () => {
    expect(compileDependencyRoute([{ x: 0, y: 0 }, { x: 127.99, y: 0 }], true).pieces[0]!.kind).toBe('path');
    expect(compileDependencyRoute([{ x: 0, y: 0 }, { x: 128, y: 0 }], true).pieces[0]!.kind).toBe('line');
    verify([{ x: 0, y: 0 }, { x: 10, y: 6 }, { x: 20, y: 6 }]);
  });
  it('bounds accumulated phase across 240 curves with complete canonical coverage', () => {
    const points = Array.from({ length: 241 }, (_, index) => ({ x: index * 240, y: index % 2 === 0 ? 0 : 300 }));
    const pieces = verify(points);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.kind === 'path')).toBe(true);
  });
  it('splits long horizontal bodies only at global dash-gap midpoints', () => {
    const pieces = verify([{ x: 0, y: 0 }, { x: 100000, y: 0 }]);
    expect(pieces.length).toBeGreaterThan(1); expect(pieces.every((piece) => piece.kind === 'line')).toBe(true);
    expect(verify([{ x: 0, y: 0 }, { x: 8192, y: 0 }])).toHaveLength(1);
    const shortTail = verify([{ x: 0, y: 0 }, { x: 8192.01, y: 0 }]);
    expect(shortTail).toHaveLength(2); expect(shortTail[1]!.startDistance).toBe(8188);
  });
  it('bounds tall cubic paint and preserves exact subcurves on both sides of every seam', () => {
    const pieces = verify([{ x: 0, y: 0 }, { x: 64, y: 100000 }, { x: 284, y: 100000 }, { x: 348, y: -100000 }, { x: 400, y: -100000 }]);
    expect(pieces.length).toBeGreaterThan(30); expect(pieces.some((piece) => piece.kind === 'line')).toBe(true);
  });
  it('retains millions of units of curved geometry with bounded native path pieces', () => {
    const pieces = verify([{ x: 0, y: 0 }, { x: 64, y: 2_000_000 }, { x: 164, y: 2_000_000 }]);
    expect(pieces.length).toBeGreaterThan(200);
  });
  it.each([
    [], [{ x: 0, y: 0 }], [{ x: 1, y: 2 }, { x: 1, y: 2 }], [{ x: 0, y: 0 }, { x: NaN, y: 0 }],
    [{ x: Infinity, y: 0 }, { x: 1, y: 2 }], [{ x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }],
  ].map((points) => ({ points })))('rejects invalid passage geometry explicitly ($points)', ({ points }) => {
    expect(() => compileDependencyRoute(points, true)).toThrow(/Task dependency route/);
  });
});
