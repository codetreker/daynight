import { describe, expect, it } from 'vitest';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { verifyDashes as verify } from './dash-fixture';

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
  it('preserves accumulated phase across successive curves and a paint seam', () => {
    const points = Array.from({ length: 7 }, (_, index) => ({ x: index * 240, y: index % 2 === 0 ? 0 : 3000 }));
    const pieces = verify(points);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.kind === 'path')).toBe(true);
  });
  it('splits long horizontal bodies only at global dash-gap midpoints', () => {
    expect(verify([{ x: 0, y: 0 }, { x: 8192, y: 0 }])).toHaveLength(1);
    const shortTail = verify([{ x: 0, y: 0 }, { x: 8192.01, y: 0 }]);
    expect(shortTail).toHaveLength(2); expect(shortTail[1]!.startDistance).toBe(8188);
  });
  it('bounds tall cubic paint and preserves exact subcurves on both sides of every seam', () => {
    const pieces = verify([{ x: 0, y: 0 }, { x: 64, y: 10000 }, { x: 284, y: 10000 }, { x: 348, y: -10000 }, { x: 400, y: -10000 }]);
    expect(pieces.length).toBeGreaterThan(3); expect(pieces.some((piece) => piece.kind === 'line')).toBe(true);
  });
  it.each([
    [], [{ x: 0, y: 0 }], [{ x: 1, y: 2 }, { x: 1, y: 2 }], [{ x: 0, y: 0 }, { x: NaN, y: 0 }],
    [{ x: Infinity, y: 0 }, { x: 1, y: 2 }], [{ x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }],
  ].map((points) => ({ points })))('rejects invalid passage geometry explicitly ($points)', ({ points }) => {
    expect(() => compileDependencyRoute(points, true)).toThrow(/Task dependency route/);
  });
});
