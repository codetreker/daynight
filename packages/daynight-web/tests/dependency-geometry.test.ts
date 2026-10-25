import { describe, expect, it } from 'vitest';
import { captureStableDependencyGeometry, expectedDependencyTopology, inspectDependencySnapshot, parseCurve, referenceLength, summarizeGeometryFailures, type DependencySnapshot, type GeometryExpectation } from './e2e/dependency-geometry';

const d = 'M100,50 L188,50 Q200,50 200,62 L200,88 Q200,100 212,100 L238,100 Q250,100 250,88 L250,62 Q250,50 262,50 L300,50';
const color = 'rgb(171, 178, 199)';
const expected: GeometryExpectation = { nodes: [{ id: 'source' }, { id: 'target' }], edges: [{ id: 'source->target', source: 'source', target: 'target', external: true }] };
const compilerInputs = [{ id: 'source->target', points: [{ x: 100, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 100 }, { x: 250, y: 100 }, { x: 250, y: 50 }, { x: 300, y: 50 }] }];
const snapshot = (): DependencySnapshot => ({
  nodes: [{ id: 'source', left: 0, top: 0, right: 100, bottom: 100 }, { id: 'target', left: 300, top: 0, right: 400, bottom: 100 }],
  edges: [{ id: 'source->target', source: 'source', target: 'target', d, external: 'true', stroke: 'none', fill: 'none', color, bodyMatrix: [1, 0, 0, 1, 0, 0], bodyVisible: true, marker: '#arrow', canonicalVisible: true, pieces: [
    { d, matrix: [1, 0, 0, 1, 0, 0], line: false, phase: 0, dash: '5px, 4px', stroke: color, width: 1.5, cap: 'butt', join: 'miter', hidden: true },
  ] }],
  markers: [{ id: 'arrow', orient: 'auto-start-reverse', units: 'strokeWidth', viewBox: '-10 -10 20 20', width: '16', height: '16', refX: '0', refY: '0', points: '-5,-4 0,0 -5,4 -5,-4', stroke: color, fill: color, strokeWidth: 1, cap: 'round', join: 'round' }],
  declaredPieces: 1, viewport: true, passive: true,
});

describe('independent production dependency geometry oracle', () => {
  it('accepts smooth complete quadratics and native dashed paint independently of production routes', () => {
    expect(inspectDependencySnapshot(snapshot(), expected)).toEqual([]);
  });
  it('accepts rounded rank-gap passages above and below occupied task columns', () => {
    const value = snapshot();
    value.nodes = [
      { id: 'source', left: 32, top: 32, right: 252, bottom: 128 },
      { id: 'a', left: 316, top: 32, right: 536, bottom: 128 },
      { id: 'b', left: 316, top: 160, right: 536, bottom: 256 },
      { id: 'c', left: 600, top: 32, right: 820, bottom: 128 },
      { id: 'target', left: 884, top: 300, right: 1104, bottom: 396 },
    ];
    const route = 'M252,80 L272,80 Q284,80 284,68 L284,28 Q284,16 296,16 L556,16 Q568,16 568,28 L568,132 Q568,144 580,144 L840,144 Q852,144 852,156 L852,336 Q852,348 864,348 L884,348';
    value.edges[0]!.d = route; value.edges[0]!.pieces[0]!.d = route;
    expect(inspectDependencySnapshot(value, { ...expected, nodes: value.nodes.map(({ id }) => ({ id })) })).toEqual([]);
  });
  it('checks fixed ports against each actual compact or expandable card height', () => {
    const value = snapshot();
    value.nodes[0]!.bottom = 136; value.nodes[1]!.bottom = 96;
    const route = 'M100,68 L192,68 Q200,68 200,60 L200,56 Q200,48 208,48 L300,48';
    value.edges[0]!.d = route; value.edges[0]!.pieces[0]!.d = route;
    expect(inspectDependencySnapshot(value, expected)).toEqual([]);
    value.nodes[0]!.bottom = 96;
    expect(inspectDependencySnapshot(value, expected)).toContain('source->target: wrong fixed left-to-right ports');
  });
  it('derives projection identities only from API dependencies, including complete upstream context', () => {
    expect(expectedDependencyTopology([
      { id: 'A', dependsOn: [], externalDependsOn: [] }, { id: 'C', dependsOn: ['A', 'X'], externalDependsOn: ['X'] }, { id: 'P', dependsOn: [], externalDependsOn: [] },
      { id: 'X', dependsOn: ['P'], externalDependsOn: [] }, { id: 'Y', dependsOn: ['X'], externalDependsOn: [] }, { id: 'Z', dependsOn: [], externalDependsOn: [] },
    ], 'A')).toEqual({
      memberIds: ['A', 'C'],
      nodes: [{ id: 'A' }, { id: 'C' }, { id: 'P' }, { id: 'X' }],
      edges: [{ id: 'A->C', source: 'A', target: 'C', external: false }, { id: 'X->C', source: 'X', target: 'C', external: true }, { id: 'P->X', source: 'P', target: 'X', external: false }],
    });
  });
  it('checks actual quadratic bounds without any declared compiler input', () => {
    const value = snapshot(); value.edges[0]!.d = d.replace('Q200,50', 'Q205,50');
    expect(inspectDependencySnapshot(value, expected).some((failure) => failure.includes('bounded symmetric corner'))).toBe(true);
  });
  it('separates declared compiler-input fidelity from independent topology and route validity', () => {
    const value = snapshot();
    expect(inspectDependencySnapshot(value, expected)).toEqual([]);
    expect(inspectDependencySnapshot(value, expected, compilerInputs)).toEqual([]);
    const changedInput = [{ id: 'source->target', points: compilerInputs[0]!.points.map((p) => p.x === 200 && p.y === 50 ? { x: 201, y: 50 } : p) }];
    expect(inspectDependencySnapshot(value, expected, changedInput).some((failure) => failure.includes('declared compiler input'))).toBe(true);
    const wrongTopology: GeometryExpectation = { nodes: expected.nodes, edges: [{ ...expected.edges[0]!, source: 'target', target: 'source' }] };
    expect(inspectDependencySnapshot(value, wrongTopology, compilerInputs).some((failure) => failure.includes('wrong dependency topology'))).toBe(true);
  });
  it('rejects missing edges, wrong arrows, curves through nodes, and true-arclength phase deviations', () => {
    const missing = snapshot(); missing.edges = []; missing.declaredPieces = 0;
    expect(inspectDependencySnapshot(missing, expected)).toContain('edges: incomplete edge coverage');
    const arrow = snapshot(); arrow.markers[0]!.points = '5,-4 0,0 5,4';
    expect(inspectDependencySnapshot(arrow, expected).some((failure) => failure.includes('wrong native arrow marker'))).toBe(true);
    const crossing = snapshot(); crossing.nodes.push({ id: 'obstacle', left: 196, top: 54, right: 201, bottom: 62 });
    expect(inspectDependencySnapshot(crossing, { ...expected, nodes: [...expected.nodes, { id: 'obstacle' }] }).some((failure) => failure.includes('curve passes through node obstacle'))).toBe(true);
    const phase = snapshot(); phase.edges[0]!.pieces[0]!.phase = 0.2;
    expect(inspectDependencySnapshot(phase, expected).some((failure) => failure.includes('dash phase'))).toBe(true);
  });
  it('rejects a valid endpoint path whose native paint skips or changes its curve', () => {
    const skipped = snapshot(); skipped.edges[0]!.pieces[0]!.d = 'M100,50 L300,50';
    expect(inspectDependencySnapshot(skipped, expected).some((failure) => failure.includes('canonical route'))).toBe(true);
    const changed = snapshot(); changed.edges[0]!.pieces[0]!.d = d.replace('Q200,50', 'Q199,50');
    expect(inspectDependencySnapshot(changed, expected).some((failure) => failure.includes('paint curve differs'))).toBe(true);
  });
  it('rejects smooth shortcuts that drop a planned routing corner', () => {
    const value = snapshot(); value.edges[0]!.d = 'M100,50 L300,50'; value.edges[0]!.pieces[0]!.d = 'M100,50 L300,50';
    expect(inspectDependencySnapshot(value, expected, compilerInputs).some((failure) => failure.includes('declared input corner'))).toBe(true);
  });
  it('checks paint seams and phase after a quadratic using true curve arclength', () => {
    const value = snapshot();
    const prefix = 88 + referenceLength(parseCurve('M188,50 Q200,50 200,62')[0]!);
    const seam = Math.ceil((prefix - 7) / 9) * 9 + 7;
    const y = 62 + seam - prefix;
    const original = value.edges[0]!.pieces[0]!;
    value.edges[0]!.pieces = [
      { ...original, d: `M100,50 L188,50 Q200,50 200,62 L200,${y}` },
      { ...original, d: `M200,${y} L200,88 Q200,100 212,100 L238,100 Q250,100 250,88 L250,62 Q250,50 262,50 L300,50`, phase: 7 },
    ];
    value.declaredPieces = 2;
    expect(inspectDependencySnapshot(value, expected)).toEqual([]);
    value.edges[0]!.pieces[1]!.phase = 7.2;
    expect(inspectDependencySnapshot(value, expected).some((failure) => failure.includes('dash phase'))).toBe(true);
  });
  it('rejects obsolete top-port geometry without mistaking native rounding for missing paint', () => {
    const value = snapshot();
    value.nodes = [{ id: 'source', left: 316, top: 32, right: 536, bottom: 128 }, { id: 'target', left: 600, top: 224, right: 820, bottom: 320 }];
    const edge = value.edges[0]!;
    edge.d = 'M536,80 L556,80 Q568,80 575.1355182290425,89.64802464771945 L674.5,224';
    const original = edge.pieces[0]!;
    edge.pieces = [
      { ...original, d: 'M536,80 L556,80 Q568,80 575.1355182290425,89.64802464771945 L586.2503311048174,104.67650402904886' },
      { ...original, d: 'M0,0 L148.41192626953125,0', line: true, phase: 7,
        matrix: [0.5946265459060669, 0.8040021061897278, -0.8040021061897278, 0.5946265459060669, 586.2503051757812, 104.67650604248047] },
    ];
    value.declaredPieces = 2;
    const inputs = [{ id: expected.edges[0]!.id, points: [{ x: 536, y: 80 }, { x: 568, y: 80 }, { x: 674.5, y: 224 }] }];
    const failures = inspectDependencySnapshot(value, expected, inputs);
    expect(failures).toEqual(['source->target: wrong fixed left-to-right ports', 'source->target: endpoint direction is not horizontal left-to-right']);
    const gap = structuredClone(value); gap.edges[0]!.pieces[1]!.d = 'M0,0 L148.31192626953125,0';
    expect(inspectDependencySnapshot(gap, expected, inputs).some((failure) => failure.includes('incomplete canonical paint coverage'))).toBe(true);
    const offRoute = structuredClone(value); offRoute.edges[0]!.pieces[1]!.matrix[4]! += 0.05;
    expect(inspectDependencySnapshot(offRoute, expected, inputs).some((failure) => failure.includes('canonical coverage'))).toBe(true);
    const phase = structuredClone(value); phase.edges[0]!.pieces[1]!.phase = 7.2;
    expect(inspectDependencySnapshot(phase, expected, inputs).some((failure) => failure.includes('dash phase'))).toBe(true);
  });
  it('resolves native SVG rounding at fixed horizontal ports in graph units', () => {
    const value = snapshot();
    const start = 675.12345; const end = start + 148.41192927402753;
    value.nodes = [{ id: 'source', left: start - 220, top: 32, right: start, bottom: 128 }, { id: 'target', left: end, top: 32, right: end + 220, bottom: 128 }];
    value.edges[0]!.d = `M${start},80 L${end},80`;
    value.edges[0]!.pieces[0] = { ...value.edges[0]!.pieces[0]!, d: 'M0,0 L148.41192626953125,0', line: true, matrix: [1, 0, 0, 1, 675.1234741210938, 80] };
    const inputs = [{ id: expected.edges[0]!.id, points: [{ x: start, y: 80 }, { x: end, y: 80 }] }];
    expect(inspectDependencySnapshot(value, expected, inputs)).toEqual([]);
  });
  it('rejects shifted ports and diagonal arrival even when endpoints remain on a card border', () => {
    const shifted = snapshot(); shifted.edges[0]!.d = d.replace('M100,50', 'M100,49');
    expect(inspectDependencySnapshot(shifted, expected).some((failure) => failure.includes('wrong fixed left-to-right ports'))).toBe(true);
    const diagonal = snapshot(); diagonal.edges[0]!.d = d.replace('L300,50', 'Q280,60 300,50');
    expect(inspectDependencySnapshot(diagonal, expected).some((failure) => failure.includes('endpoint direction is not horizontal'))).toBe(true);
  });
  it('accepts full cubic rank-gap passages and checks their declared endpoints', () => {
    const value = snapshot(); const route = 'M100,50 C200,50 200,150 300,150';
    value.nodes[1] = { id: 'target', left: 300, top: 100, right: 400, bottom: 200 };
    value.edges[0]!.d = route; value.edges[0]!.pieces[0]!.d = route;
    const inputs = [{ id: 'source->target', points: [{ x: 100, y: 50 }, { x: 300, y: 150 }] }];
    expect(inspectDependencySnapshot(value, expected, inputs)).toEqual([]);
    const wrongInput = [{ id: 'source->target', points: [{ x: 100, y: 50 }, { x: 200, y: 80 }, { x: 300, y: 150 }] }];
    expect(inspectDependencySnapshot(value, expected, wrongInput)).toContain('source->target: curve differs from declared compiler input passages');
    const wrongControl = structuredClone(value); wrongControl.edges[0]!.d = 'M100,50 C201,50 200,150 300,150';
    expect(inspectDependencySnapshot(wrongControl, expected)).toContain('source->target: cubic leaves its horizontal-tangent rank-gap passage');
    const collision = structuredClone(value); collision.nodes.push({ id: 'obstacle', left: 190, top: 90, right: 210, bottom: 110 });
    expect(inspectDependencySnapshot(collision, { ...expected, nodes: [...expected.nodes, { id: 'obstacle' }] })).toContain('source->target: curve passes through node obstacle');
  });
  it('checks exact cubic dash subcurves and true-arclength gap seams', () => {
    const halfLength = referenceLength(parseCurve('M0,0 C100,0 100,100 200,100')[0]!) / 2;
    const seam = Math.ceil((halfLength - 7) / 9) * 9 + 7; const scale = seam / halfLength;
    const p = (x: number, y: number) => `${100 + x * scale},${50 + y * scale}`;
    const value = snapshot(); const edge = value.edges[0]!; const original = edge.pieces[0]!;
    value.nodes[1] = { id: 'target', left: 100 + 200 * scale, top: 100 * scale, right: 200 + 200 * scale, bottom: 100 + 100 * scale };
    edge.d = `M${p(0, 0)} C${p(100, 0)} ${p(100, 100)} ${p(200, 100)}`;
    edge.pieces = [
      { ...original, d: `M${p(0, 0)} C${p(50, 0)} ${p(75, 25)} ${p(100, 50)}` },
      { ...original, d: `M${p(100, 50)} C${p(125, 75)} ${p(150, 100)} ${p(200, 100)}`, phase: 7 },
    ];
    value.declaredPieces = 2;
    expect(inspectDependencySnapshot(value, expected)).toEqual([]);
    const phase = structuredClone(value); phase.edges[0]!.pieces[1]!.phase = 7.2;
    expect(inspectDependencySnapshot(phase, expected)).toContain('source->target: dash phase deviates from true curve arclength');
    const changed = structuredClone(value); changed.edges[0]!.pieces[1]!.d = `M${p(100, 50)} C${p(125, 75)} ${p(151, 100)} ${p(200, 100)}`;
    expect(inspectDependencySnapshot(changed, expected)).toContain('source->target: paint curve differs from canonical curve');
    const omitted = structuredClone(value); omitted.edges[0]!.pieces.pop(); omitted.declaredPieces = 1;
    expect(inspectDependencySnapshot(omitted, expected)).toContain('source->target: incomplete canonical paint coverage');
  });
  it('rejects native cubic paint whose total arclength exceeds the GPU bound', () => {
    const value = snapshot(); const route = 'M100,50 C200,50 200,10050 300,10050';
    value.nodes[1] = { id: 'target', left: 300, top: 10000, right: 400, bottom: 10100 };
    value.edges[0]!.d = route; value.edges[0]!.pieces[0]!.d = route;
    expect(inspectDependencySnapshot(value, expected)).toContain('source->target: paint piece exceeds bounded arc length');
  });
  it('integrates cubic speed independently, including curves with exact polynomial speed', () => {
    expect(referenceLength(parseCurve('M0,0 C0,1 1,1 1,0')[0]!, 1e-8)).toBeCloseTo(2, 8);
    expect(referenceLength(parseCurve('M0,0 C3,0 7,0 10,0')[0]!, 1e-8)).toBeCloseTo(10, 8);
    const tall = referenceLength(parseCurve('M0,0 C32,0 32,68000000 64,68000000')[0]!);
    expect(tall).toBeGreaterThanOrEqual(68000000); expect(tall).toBeLessThan(68000064);
  });
  it('reports the full failure count with bounded examples without discarding any input failures', () => {
    const failures = Array.from({ length: 25 }, (_, index) => `edge-${index}: collision`);
    expect(summarizeGeometryFailures(failures)).toEqual({ total: 25, examples: failures.slice(0, 12) });
    expect(failures).toHaveLength(25);
    expect(summarizeGeometryFailures([])).toEqual({ total: 0, examples: [] });
  });
  it('requires visible native arrow owners, graph-coordinate body paint and matching marker color', () => {
    for (const mutate of [
      (value: DependencySnapshot) => { value.edges[0]!.marker = null; },
      (value: DependencySnapshot) => { value.edges[0]!.canonicalVisible = false; },
      (value: DependencySnapshot) => { value.edges[0]!.bodyVisible = false; },
      (value: DependencySnapshot) => { value.edges[0]!.bodyMatrix[4] = 1; },
      (value: DependencySnapshot) => { value.markers[0]!.fill = 'rgb(103, 98, 206)'; },
      (value: DependencySnapshot) => { value.markers[0]!.units = 'userSpaceOnUse'; },
    ]) { const value = snapshot(); mutate(value); expect(inspectDependencySnapshot(value, expected).length).toBeGreaterThan(0); }
  });
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
  it('bounds a quadratic arc independently and handles enormous straight distances without sampling them', () => {
    const segment = parseCurve('M0,0 Q0,1 1,1')[0]!;
    const exact = 1 + Math.asinh(1) / Math.SQRT2;
    expect(Math.abs(referenceLength(segment) - exact)).toBeLessThan(0.0001);
    expect(referenceLength(parseCurve('M0,0 L68000000,0')[0]!)).toBe(68000000);
    for (const invalid of ['', 'M0,0 LNaN,2', 'M0,0 C1,2 3,4', 'M0,0 L0,0', 'm0,0 l1,1']) expect(() => parseCurve(invalid)).toThrow();
  });
});

describe('chart-relative dependency stability observation', () => {
  const affine = (a: number, b: number, c: number, d: number, e: number, f: number): DOMMatrix => ({
    a, b, c, d, e, f,
    inverse: () => {
      const determinant = a * d - b * c;
      return affine(d / determinant, -b / determinant, -c / determinant, a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant);
    },
    multiply: (other: DOMMatrix) => affine(a * other.a + c * other.b, b * other.a + d * other.b, a * other.c + c * other.d, b * other.c + d * other.d, a * other.e + c * other.f + e, b * other.e + d * other.f + f),
  }) as DOMMatrix;
  const screen = (x: number, y: number) => affine(0.800000011920929, 0, 0, 0.800000011920929, x, y);
  const fixture = () => {
    document.body.innerHTML = '<div class="task-graph-canvas"><div class="react-flow__viewport" style="transform:translate(6.4px,-3083.1px) scale(0.8)"><svg class="task-dependency-edges"><g class="task-dependency-edge"><g class="task-dependency-body"></g></g></svg></div></div>';
    let root: DOMMatrix | null = screen(237.39999389648438, -1907.5078125);
    let owner: DOMMatrix | null = screen(237.39999389648438, -1907.5078125);
    Object.defineProperty(document.querySelector('svg'), 'getScreenCTM', { value: () => root });
    for (const element of document.querySelectorAll('g')) Object.defineProperty(element, 'getScreenCTM', { value: () => owner });
    return { setRoot: (value: DOMMatrix | null) => { root = value; }, setOwner: (value: DOMMatrix | null) => { owner = value; } };
  };
  it('retains exact chart geometry for actual hosted matrices whose naive inverse product has a residual', () => {
    const initialMatrix = screen(237.39999389648438, -1907.5078125);
    const resetMatrix = screen(237.39999389648438, -2528.5078125);
    expect(initialMatrix.inverse().multiply(initialMatrix).f).toBe(0);
    expect(resetMatrix.inverse().multiply(resetMatrix).f).toBe(4.547473508864641e-13);
    const value = fixture(); const initial = captureStableDependencyGeometry();
    value.setRoot(resetMatrix); value.setOwner(resetMatrix);
    const scrolled = captureStableDependencyGeometry();
    expect(scrolled.geometry).toEqual(initial.geometry);
    expect(scrolled.geometry.owners).toEqual([[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0]]);
    expect(scrolled.diagnostics.rootScreen[5]! - initial.diagnostics.rootScreen[5]!).toBe(-621);
    expect(scrolled.diagnostics.ownerScreens.map((matrix, index) => matrix[5]! - initial.diagnostics.ownerScreens[index]![5]!)).toEqual([-621, -621]);
    value.setOwner(screen(237.39999389648438, -2527.5078125));
    const changed = captureStableDependencyGeometry();
    expect(changed.geometry).not.toEqual(scrolled.geometry);
    const invalid = snapshot(); invalid.edges[0]!.bodyMatrix = changed.geometry.owners[1]!;
    expect(inspectDependencySnapshot(invalid, expected).some((failure) => failure.includes('body owner does not paint in graph coordinates'))).toBe(true);
  });
  it('preserves a nonidentity owner rotation, shear and offset in the actual root coordinate system', () => {
    const value = fixture();
    value.setRoot(affine(1, 1, -1, 1, 100, -200));
    value.setOwner(affine(0.5, 1.5, -0.75, 1.25, 110, -202));
    const initial = captureStableDependencyGeometry();
    expect(initial.geometry.owners).toEqual([[1, 0.5, 0.25, 1, 4, -6], [1, 0.5, 0.25, 1, 4, -6]]);
    value.setRoot(affine(1, 1, -1, 1, 100, -821));
    value.setOwner(affine(0.5, 1.5, -0.75, 1.25, 110, -823));
    expect(captureStableDependencyGeometry().geometry).toEqual(initial.geometry);
  });
  it('rejects missing or nonfinite actual matrices and noninvertible roots', () => {
    for (const missing of [true, false]) for (const which of ['root', 'owner'] as const) {
      const value = fixture(); const matrix = missing ? null : screen(237.4, Number.NaN);
      if (which === 'root') value.setRoot(matrix); else value.setOwner(matrix);
      expect(() => captureStableDependencyGeometry()).toThrow(missing ? /no actual screen matrix/ : /nonfinite matrix/);
    }
    const value = fixture(); value.setRoot(affine(0, 0, 0, 0, 0, 0));
    expect(() => captureStableDependencyGeometry()).toThrow(/nonfinite matrix/);
  });
});
