import './local-only';
import { describe, expect, it } from 'vitest';
import { verifyDashes as verify } from '../dash-fixture';

describe('full-scale native dash coverage', () => {
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
});
