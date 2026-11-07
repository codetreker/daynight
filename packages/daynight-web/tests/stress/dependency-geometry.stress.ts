import './local-only';
import { describe, expect, it } from 'vitest';
import { inspectDependencySnapshot } from '../helpers/dependency-geometry';
import { expected, snapshot } from '../dependency-geometry-fixture';

describe('full-scale dependency paint coverage', () => {
  it('rejects real endpoint gaps on long lines without a length-dependent parameter allowance', () => {
    const value = snapshot();
    value.nodes[1] = { id: 'target', left: 68000100, top: 0, right: 68000200, bottom: 100 };
    value.edges[0]!.d = 'M100,50 L68000100,50';
    const original = value.edges[0]!.pieces[0]!;
    value.edges[0]!.pieces = [];
    for (let position = 0; position < 68000000;) {
      const limit = 68000000 - position <= 8192 ? 68000000 : Math.floor((position + 8192 - 7) / 9) * 9 + 7;
      value.edges[0]!.pieces.push({ ...original, d: `M0,0 L${limit - position},0`, line: true, matrix: [1, 0, 0, 1, 100 + position, 50], phase: position % 9 });
      position = limit;
    }
    value.declaredPieces = value.edges[0]!.pieces.length;
    const inputs = [{ id: expected.edges[0]!.id, points: [{ x: 100, y: 50 }, { x: 68000100, y: 50 }] }];
    expect(inspectDependencySnapshot(value, expected, inputs)).toEqual([]);
    const last = value.edges[0]!.pieces.at(-1)!; last.d = `M0,0 L${68000100 - last.matrix[4]! - 0.1},0`;
    expect(inspectDependencySnapshot(value, expected, inputs).some((failure) => failure.includes('incomplete canonical paint coverage'))).toBe(true);
  });
});
