import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';

type Point = { x: number; y: number };
type Segment = { kind: 'L' | 'Q' | 'C'; from: Point; to: Point; control?: Point; control2?: Point };
type Rect = { id: string; left: number; top: number; right: number; bottom: number };
export type GeometryExpectation = import('./visible-topology').DependencyTopology;
export { expectedDependencyTopology } from './visible-topology';
export type DeclaredCurveInput = { id: string; points: readonly Point[] };

type Paint = { d: string; matrix: number[]; line: boolean; phase: number; dash: string; stroke: string; width: number; cap: string; join: string; hidden: boolean };
export type DependencySnapshot = {
  nodes: Rect[];
  edges: { id: string; source: string; target: string; d: string; external: string | null; stroke: string; fill: string; color: string; bodyMatrix: number[]; bodyVisible: boolean; marker: string | null; canonicalVisible: boolean; pieces: Paint[] }[];
  markers: { id: string; orient: string | null; units: string | null; viewBox: string | null; width: string | null; height: string | null; refX: string | null; refY: string | null; points: string | null; stroke: string; fill: string; strokeWidth: number; cap: string; join: string }[];
  declaredPieces: number; viewport: boolean; passive: boolean;
};
const epsilon = 0.04;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const point = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const at = (s: Segment, t: number): Point => {
  if (s.kind === 'L') return point(s.from, s.to, t);
  if (s.kind === 'Q') return point(point(s.from, s.control!, t), point(s.control!, s.to, t), t);
  const a = point(s.from, s.control!, t); const b = point(s.control!, s.control2!, t); const c = point(s.control2!, s.to, t);
  return point(point(a, b, t), point(b, c, t), t);
};
const tangent = (s: Segment, t: number): Point => {
  if (s.kind === 'L') return { x: s.to.x - s.from.x, y: s.to.y - s.from.y };
  if (s.kind === 'Q') return { x: 2 * ((1 - t) * (s.control!.x - s.from.x) + t * (s.to.x - s.control!.x)), y: 2 * ((1 - t) * (s.control!.y - s.from.y) + t * (s.to.y - s.control!.y)) };
  const component = (axis: 'x' | 'y') => 3 * ((1 - t) ** 2 * (s.control![axis] - s.from[axis]) + 2 * (1 - t) * t * (s.control2![axis] - s.control![axis]) + t ** 2 * (s.to[axis] - s.control2![axis]));
  return { x: component('x'), y: component('y') };
};
const parallel = (a: Point, b: Point): boolean => Math.abs(a.x * b.y - a.y * b.x) <= epsilon * Math.max(1, Math.hypot(a.x, a.y), Math.hypot(b.x, b.y)) && a.x * b.x + a.y * b.y > 0;
export const parseCurve = (d: string): Segment[] => {
  const tokens = d.match(/[MLQC]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi) ?? [];
  if (tokens.join('').toLowerCase() !== d.replace(/[\s,]/g, '').toLowerCase()) throw new Error('Unsupported or invalid curve path.');
  let cursor = 0;
  const coordinate = (): Point => {
    const x = Number(tokens[cursor++]); const y = Number(tokens[cursor++]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Nonfinite curve coordinate.');
    return { x, y };
  };
  if (tokens[cursor++] !== 'M') throw new Error('Curve must start with one absolute move.');
  let from = coordinate();
  const result: Segment[] = [];
  while (cursor < tokens.length) {
    const kind = tokens[cursor++];
    if (kind !== 'L' && kind !== 'Q' && kind !== 'C') throw new Error('Curve must use absolute line or Bézier commands.');
    const control = kind === 'Q' || kind === 'C' ? coordinate() : undefined;
    const control2 = kind === 'C' ? coordinate() : undefined;
    const to = coordinate();
    if (distance(from, to) === 0) throw new Error('Zero length curve segment.');
    result.push(control === undefined ? { kind, from, to } : control2 === undefined ? { kind, from, to, control } : { kind, from, to, control, control2 });
    from = to;
  }
  if (result.length === 0) throw new Error('Curve has no body.');
  return result;
};
// Quadratic speed has an analytic integral in acceleration-aligned coordinates;
// cubic speed is integrated below. Almost straight quadratics use their length
// bracket to avoid cancellation. Neither reference shares renderer subdivision.
export const referenceLength = (s: Segment, tolerance = 0.0001): number => {
  const chord = distance(s.from, s.to);
  if (s.kind === 'L') return chord;
  if (s.kind === 'C') {
    // Adaptive Simpson integration uses the derivative, independently of the
    // compiler's control-polygon length enclosure and subdivision decisions.
    const speed = (t: number) => { const value = tangent(s, t); return Math.hypot(value.x, value.y); };
    const integrate = (left: number, right: number, a: number, m: number, b: number, estimate: number, allowance: number, depth: number): number => {
      const center = (left + right) / 2; const first = speed((left + center) / 2); const second = speed((center + right) / 2);
      const before = (center - left) * (a + 4 * first + m) / 6; const after = (right - center) * (m + 4 * second + b) / 6;
      const delta = before + after - estimate;
      if (Math.abs(delta) <= 15 * allowance) return before + after + delta / 15;
      if (depth === 0) throw new Error('Cubic curve-length reference did not converge.');
      return integrate(left, center, a, first, m, before, allowance / 2, depth - 1)
        + integrate(center, right, m, second, b, after, allowance / 2, depth - 1);
    };
    const a = speed(0); const m = speed(0.5); const b = speed(1);
    return integrate(0, 1, a, m, b, (a + 4 * m + b) / 6, tolerance, 30);
  }
  const polygon = distance(s.from, s.control!) + distance(s.control!, s.to);
  if (polygon - chord <= tolerance) return (polygon + chord) / 2;
  const v = { x: s.control!.x - s.from.x, y: s.control!.y - s.from.y };
  const w = { x: s.to.x - s.control!.x - v.x, y: s.to.y - s.control!.y - v.y };
  const acceleration = Math.hypot(w.x, w.y);
  const start = (v.x * w.x + v.y * w.y) / acceleration;
  const end = start + acceleration;
  const height = Math.abs(v.x * w.y - v.y * w.x) / acceleration;
  const primitive = (u: number) => height === 0 ? u * Math.abs(u)
    : u * Math.hypot(u, height) + height * height * Math.asinh(u / height);
  const length = (primitive(end) - primitive(start)) / acceleration;
  if (!Number.isFinite(length) || length < chord - tolerance || length > polygon + tolerance) throw new Error('Analytic curve-length reference lost its geometric bound.');
  return length;
};
const roots = (a: number, b: number, c: number): number[] => {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
  return q === 0 ? [-b / (2 * a)] : [q / a, c / q];
};
const levelParameters = (s: Segment, axis: 'x' | 'y', value: number): number[] => {
  if (s.kind === 'L') return [(value - s.from[axis]) / (s.to[axis] - s.from[axis])];
  if (s.kind === 'Q') return roots(s.from[axis] - 2 * s.control![axis] + s.to[axis], 2 * (s.control![axis] - s.from[axis]), s.from[axis] - value);
  const a = -s.from[axis] + 3 * s.control![axis] - 3 * s.control2![axis] + s.to[axis];
  const b = 3 * s.from[axis] - 6 * s.control![axis] + 3 * s.control2![axis];
  const c = 3 * (s.control![axis] - s.from[axis]); const d = s.from[axis] - value;
  if (a === 0) return roots(b, c, d);
  const evaluate = (t: number) => ((a * t + b) * t + c) * t + d;
  const boundaries = [0, ...roots(3 * a, 2 * b, c).filter((t) => t > 0 && t < 1).sort((first, last) => first - last), 1];
  const result = boundaries.filter((t) => evaluate(t) === 0);
  for (let index = 1; index < boundaries.length; index++) {
    let left = boundaries[index - 1]!; let right = boundaries[index]!; const sign = evaluate(left);
    if (sign === 0 || evaluate(right) === 0 || Math.sign(sign) === Math.sign(evaluate(right))) continue;
    for (let iteration = 0; iteration < 64; iteration++) {
      const center = (left + right) / 2;
      if (Math.sign(evaluate(center)) === Math.sign(sign)) left = center; else right = center;
    }
    result.push((left + right) / 2);
  }
  return result;
};
const parameters = (s: Segment, p: Point): number[] => {
  // SVG numeric DOM values and transformed matrices can round a painted endpoint
  // to either side of its canonical endpoint. Resolve that boundary in graph
  // units; a fixed parameter tolerance would vary with the segment's length.
  if (distance(s.to, p) <= epsilon) return [1];
  if (distance(s.from, p) <= epsilon) return [0];
  const axis = Math.abs(s.to.x - s.from.x) >= Math.abs(s.to.y - s.from.y) ? 'x' : 'y';
  return levelParameters(s, axis, p[axis])
    .filter((t) => t >= 0 && t <= 1 && distance(at(s, t), p) <= epsilon).sort((a, b) => a - b);
};
const slice = (s: Segment, from: number, to: number): Segment => {
  const start = at(s, from); const end = at(s, to);
  if (s.kind === 'L') return { kind: 'L', from: start, to: end };
  const derivative = tangent(s, from);
  if (s.kind === 'Q') return { kind: 'Q', from: start, to: end, control: { x: start.x + derivative.x * (to - from) / 2, y: start.y + derivative.y * (to - from) / 2 } };
  const final = tangent(s, to); const scale = (to - from) / 3;
  return { kind: 'C', from: start, to: end, control: { x: start.x + derivative.x * scale, y: start.y + derivative.y * scale }, control2: { x: end.x - final.x * scale, y: end.y - final.y * scale } };
};
const penetrates = (s: Segment, r: Rect): boolean => {
  const box = { left: r.left + 0.4, top: r.top + 0.4, right: r.right - 0.4, bottom: r.bottom - 0.4 };
  const breaks = [0, 1];
  for (const [axis, values] of [['x', [box.left, box.right]], ['y', [box.top, box.bottom]]] as const) {
    for (const value of values) breaks.push(...levelParameters(s, axis, value).filter((t) => t > 0 && t < 1));
  }
  breaks.sort((a, b) => a - b);
  return breaks.slice(1).some((t, i) => { const p = at(s, (t + breaks[i]!) / 2); return p.x > box.left && p.x < box.right && p.y > box.top && p.y < box.bottom; });
};
const transform = (p: Point, m: number[]): Point => ({ x: m[0]! * p.x + m[2]! * p.y + m[4]!, y: m[1]! * p.x + m[3]! * p.y + m[5]! });


export const inspectDependencySnapshot = (snapshot: DependencySnapshot, expected: GeometryExpectation, compilerInputs?: readonly DeclaredCurveInput[]): string[] => {
  const failures: string[] = [];
  const fail = (id: string, reason: string) => { failures.push(`${id}: ${reason}`); };
  if (!snapshot.viewport || !snapshot.passive) fail('layer', 'incorrect viewport or interaction semantics');
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  if (nodes.size !== expected.nodes.length || snapshot.nodes.length !== nodes.size || expected.nodes.some((node) => !nodes.has(node.id))) fail('nodes', 'incomplete node coverage');
  if (edges.size !== expected.edges.length || snapshot.edges.length !== edges.size || expected.edges.some((edge) => !edges.has(edge.id))) fail('edges', 'incomplete edge coverage');
  if (snapshot.declaredPieces !== snapshot.edges.reduce((total, edge) => total + edge.pieces.length, 0)) fail('pieces', 'incomplete declared paint coverage');

  const inputs = new Map(compilerInputs?.map((input) => [input.id, input.points]));
  if (compilerInputs !== undefined && (inputs.size !== compilerInputs.length || inputs.size !== expected.edges.length || expected.edges.some((edge) => !inputs.has(edge.id)))) fail('curve inputs', 'incomplete declared edge coverage');
  const sortedNodes = [...nodes.values()].sort((a, b) => a.left - b.left);
  for (const expectation of expected.edges) {
    const edge = edges.get(expectation.id); const source = nodes.get(expectation.source); const target = nodes.get(expectation.target);
    if (edge === undefined || source === undefined || target === undefined) continue;
    try {
      const route = parseCurve(edge.d); const first = route[0]!.from; const last = route.at(-1)!.to;
      if (edge.source !== expectation.source || edge.target !== expectation.target) fail(edge.id, 'wrong dependency topology');
      if (distance(first, { x: source.right, y: (source.top + source.bottom) / 2 }) > epsilon
        || distance(last, { x: target.left, y: (target.top + target.bottom) / 2 }) > epsilon) fail(edge.id, 'wrong fixed left-to-right ports');
      const initial = tangent(route[0]!, 0); const final = tangent(route.at(-1)!, 1);
      if (initial.x <= 0 || final.x <= 0 || Math.abs(initial.y) > epsilon || Math.abs(final.y) > epsilon) fail(edge.id, 'endpoint direction is not horizontal left-to-right');
      const cubics = route.filter((segment) => segment.kind === 'C');
      for (const segment of cubics) {
        const midpoint = segment.from.x + (segment.to.x - segment.from.x) / 2;
        if (segment.to.x <= segment.from.x || Math.abs(segment.control!.x - midpoint) > epsilon || Math.abs(segment.control2!.x - midpoint) > epsilon
          || Math.abs(segment.control!.y - segment.from.y) > epsilon || Math.abs(segment.control2!.y - segment.to.y) > epsilon) fail(edge.id, 'cubic leaves its horizontal-tangent rank-gap passage');
      }
      const controls = route.filter((segment) => segment.kind === 'Q');
      for (const segment of controls) {
        if (distance(segment.from, segment.control!) > 12 + epsilon || Math.abs(distance(segment.from, segment.control!) - distance(segment.control!, segment.to)) > epsilon) fail(edge.id, 'curve exceeds its bounded symmetric corner');
      }
      const points = inputs.get(expectation.id);
      if (points !== undefined && cubics.length > 0) {
        const passages = points.filter((p, index) => index === 0 || distance(p, points[index - 1]!) > 1e-8);
        if (distance(first, passages[0]!) > epsilon || distance(last, passages.at(-1)!) > epsilon) fail(edge.id, 'lost declared input endpoints');
        const bends = passages.slice(1).flatMap((to, index) => {
          const from = passages[index]!;
          if (to.x <= from.x) { fail(edge.id, 'invalid declared compiler input passage'); return []; }
          return to.y === from.y ? [] : [{ from, to }];
        });
        if (bends.length !== cubics.length || bends.some((bend, index) => distance(bend.from, cubics[index]!.from) > epsilon || distance(bend.to, cubics[index]!.to) > epsilon)) fail(edge.id, 'curve differs from declared compiler input passages');
      } else if (points !== undefined) {
        if (distance(first, points[0]!) > epsilon || distance(last, points.at(-1)!) > epsilon
          || !parallel(tangent(route[0]!, 0), { x: points[1]!.x - points[0]!.x, y: points[1]!.y - points[0]!.y })
          || !parallel(tangent(route.at(-1)!, 1), { x: points.at(-1)!.x - points.at(-2)!.x, y: points.at(-1)!.y - points.at(-2)!.y })) fail(edge.id, 'lost declared input endpoints or tangents');
        for (const segment of controls) if (!points.some((p) => distance(p, segment.control!) <= epsilon)) fail(edge.id, 'curve control leaves declared compiler input');
        const distinct = points.filter((p, i) => i === 0 || distance(p, points[i - 1]!) > 1e-8);
        for (let i = 1; i < distinct.length - 1; i++) {
          const before = distinct[i - 1]!; const corner = distinct[i]!; const after = distinct[i + 1]!;
          const incoming = { x: corner.x - before.x, y: corner.y - before.y }; const outgoing = { x: after.x - corner.x, y: after.y - corner.y };
          const turn = Math.abs(incoming.x * outgoing.y - incoming.y * outgoing.x) / (distance(before, corner) * distance(corner, after));
          if (turn <= 1e-8) continue;
          const curve = controls.find((segment) => distance(segment.control!, corner) <= epsilon);
          if (curve === undefined || !parallel(tangent(curve, 0), incoming) || !parallel(tangent(curve, 1), outgoing)) fail(edge.id, 'curve omits declared input corner or changes its tangents');
        }
      }
      for (let i = 1; i < route.length; i++) if (!parallel(tangent(route[i - 1]!, 1), tangent(route[i]!, 0))) fail(edge.id, 'nonsmooth route join');
      for (const segment of route) {
        const xs = [segment.from.x, segment.to.x, ...(segment.control === undefined ? [] : [segment.control.x]), ...(segment.control2 === undefined ? [] : [segment.control2.x])];
        const ys = [segment.from.y, segment.to.y, ...(segment.control === undefined ? [] : [segment.control.y]), ...(segment.control2 === undefined ? [] : [segment.control2.y])];
        const left = Math.min(...xs); const right = Math.max(...xs); const top = Math.min(...ys); const bottom = Math.max(...ys);
        for (const node of sortedNodes) { if (node.left >= right) break; if (node.right <= left || node.top >= bottom || node.bottom <= top) continue; if (penetrates(segment, node)) fail(edge.id, `curve passes through node ${node.id}`); }
      }
      if (!edge.bodyVisible || edge.bodyMatrix.length !== 6 || edge.bodyMatrix.some((value, index) => !Number.isFinite(value) || Math.abs(value - [1, 0, 0, 1, 0, 0][index]!) > epsilon)) fail(edge.id, 'body owner does not paint in graph coordinates');
      if (!edge.canonicalVisible) fail(edge.id, 'canonical native arrow owner is hidden');
      const markerId = /(?:^|\()#([^#)]+)\)?$/.exec(edge.marker ?? '')?.[1];
      const marker = snapshot.markers.find((item) => item.id === markerId);
      if (marker === undefined || marker.orient !== 'auto-start-reverse' || marker.units !== 'strokeWidth' || marker.viewBox !== '-10 -10 20 20'
        || marker.width !== '16' || marker.height !== '16' || marker.refX !== '0' || marker.refY !== '0' || marker.points?.replace(/[\s,]+/g, ' ').trim() !== '-5 -4 0 0 -5 4 -5 -4'
        || marker.stroke !== edge.color || marker.fill !== edge.color || marker.strokeWidth !== 1 || marker.cap !== 'round' || marker.join !== 'round') fail(edge.id, 'wrong native arrow marker or color');
      if (edge.fill !== 'none' || edge.external !== String(expectation.external) || expectation.external !== (edge.pieces.length > 0) || (expectation.external ? edge.stroke !== 'none' : edge.stroke !== edge.color)) fail(edge.id, 'incorrect external dash or body semantics');
      let index = 0; let t = 0; let covered = 0;
      for (const paint of edge.pieces) {
        if (!paint.hidden || paint.stroke !== edge.color || paint.width !== 1.5 || paint.cap !== 'butt' || paint.join !== 'miter' || !/^5(?:px)?[, ]+4(?:px)?$/.test(paint.dash)) fail(edge.id, 'changed paint semantics');
        const phase = (covered % 9 + 9) % 9;
        const phaseError = Math.abs(paint.phase - phase);
        if (Math.min(phaseError, Math.abs(phaseError - 9)) > epsilon) fail(edge.id, 'dash phase deviates from true curve arclength');
        if (covered > epsilon && Math.min(Math.abs(phase - 7), Math.abs(phase + 2)) > epsilon) fail(edge.id, 'paint seam lies outside dash gap');
        const local = parseCurve(paint.d);
        if (paint.line && (local.length !== 1 || local[0]!.kind !== 'L' || local[0]!.from.x !== 0 || local[0]!.from.y !== 0 || local[0]!.to.y !== 0 || local[0]!.to.x <= 0
          || Math.abs(Math.hypot(paint.matrix[0]!, paint.matrix[1]!) - 1) > epsilon || Math.abs(paint.matrix[0]! - paint.matrix[3]!) > epsilon || Math.abs(paint.matrix[1]! + paint.matrix[2]!) > epsilon)) fail(edge.id, 'line is not an unscaled local horizontal stroke');
        let paintLength = 0;
        for (const segment of local) {
          const actual: Segment = { ...segment, from: transform(segment.from, paint.matrix), to: transform(segment.to, paint.matrix), ...(segment.control === undefined ? {} : { control: transform(segment.control, paint.matrix) }), ...(segment.control2 === undefined ? {} : { control2: transform(segment.control2, paint.matrix) }) };
          const canonical = route[index];
          if (canonical === undefined || distance(actual.from, at(canonical, t)) > epsilon || actual.kind !== canonical.kind) throw new Error('paint loses canonical coverage');
          const end = parameters(canonical, actual.to).find((candidate) => candidate > t);
          if (end === undefined) throw new Error('paint leaves canonical route');
          const reference = slice(canonical, t, end);
          if (actual.control !== undefined && distance(actual.control, reference.control!) > epsilon || actual.control2 !== undefined && distance(actual.control2, reference.control2!) > epsilon) throw new Error('paint curve differs from canonical curve');
          const length = referenceLength(reference, 0.001 / Math.max(1, edge.pieces.length + route.length));
          covered += length; paintLength += length;
          t = end;
          if (t === 1) { index++; t = 0; }
        }
        if (paintLength > 8192 + epsilon) fail(edge.id, 'paint piece exceeds bounded arc length');
      }
      if (expectation.external && (index !== route.length || t !== 0)) fail(edge.id, 'incomplete canonical paint coverage');
    } catch (error) { fail(edge.id, error instanceof Error ? error.message : 'invalid geometry'); }
  }
  return failures;
};

export const captureStableDependencyGeometry = () => {
  const svg = document.querySelector<SVGSVGElement>('.task-dependency-edges');
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  const canvas = document.querySelector<HTMLElement>('.task-graph-canvas');
  if (svg === null || viewport === null || canvas === null) throw new Error('Dependency stability observation requires its SVG, viewport and canvas.');
  const values = (matrix: DOMMatrix | null): number[] => {
    if (matrix === null) throw new Error('Dependency stability observation has no actual screen matrix.');
    const result = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
    if (!result.every(Number.isFinite)) throw new Error('Dependency stability observation has a nonfinite matrix.');
    return result;
  };
  const rootScreen = svg.getScreenCTM();
  const rootValues = values(rootScreen);
  const inverse = rootScreen!.inverse(); values(inverse);
  const ownerScreens: number[][] = [];
  const owners = [...svg.querySelectorAll<SVGGElement>('.task-dependency-edge,.task-dependency-body')].map((owner) => {
    const screen = owner.getScreenCTM(); ownerScreens.push(values(screen));
    const da = screen!.a - rootScreen!.a; const db = screen!.b - rootScreen!.b;
    const dc = screen!.c - rootScreen!.c; const dd = screen!.d - rootScreen!.d;
    const dx = screen!.e - rootScreen!.e; const dy = screen!.f - rootScreen!.f;
    // Subtract the shared screen origin before inversion. For affine R=[A,t]
    // and O=[B,u], R^-1 O=[I+A^-1(B-A), A^-1(u-t)] avoids cancellation.
    const relative = [
      1 + inverse.a * da + inverse.c * db, inverse.b * da + inverse.d * db,
      inverse.a * dc + inverse.c * dd, 1 + inverse.b * dc + inverse.d * dd,
      inverse.a * dx + inverse.c * dy, inverse.b * dx + inverse.d * dy,
    ];
    if (!relative.every(Number.isFinite)) throw new Error('Dependency stability observation has a nonfinite matrix.');
    return relative;
  });
  const bounds = canvas.getBoundingClientRect();
  return {
    geometry: {
      viewport: viewport.style.transform,
      nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => [node.dataset.id, node.style.transform, node.style.width, node.style.height]),
      paths: [...svg.querySelectorAll('.react-flow__edge-path')].map((path) => [path.getAttribute('data-source'), path.getAttribute('data-target'), path.getAttribute('d')]),
      pieces: [...svg.querySelectorAll('.task-dependency-paint-piece')].map((piece) => ['d', 'transform', 'x1', 'x2', 'y1', 'y2'].map((attribute) => piece.getAttribute(attribute))),
      owners,
    },
    diagnostics: { rootScreen: rootValues, ownerScreens, scroll: { x: window.scrollX, y: window.scrollY },
      canvas: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } },
  };
};

export const captureDependencySnapshot = (page: Page): Promise<DependencySnapshot> => page.evaluate(() => {
  const svg = document.querySelector<SVGSVGElement>('.task-dependency-edges'); const viewport = document.querySelector('.react-flow__viewport');
  if (svg === null) throw new Error('Dependency SVG absent.');
  const matrix = svg.getScreenCTM(); if (matrix === null) throw new Error('Dependency SVG has no geometry.');
  const inverse = matrix.inverse();
  const relativeMatrix = (element: SVGGraphicsElement): number[] => {
    const screen = element.getScreenCTM(); if (screen === null) throw new Error('A visible dependency paint owner has no viewport geometry.');
    const m = inverse.multiply(screen); return [m.a, m.b, m.c, m.d, m.e, m.f];
  };
  const visible = (element: SVGGraphicsElement): boolean => {
    const style = getComputedStyle(element); const bounds = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && (bounds.width > 0 || bounds.height > 0);
  };
  return {
    nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => {
      const bounds = node.getBoundingClientRect(); const a = new DOMPoint(bounds.left, bounds.top).matrixTransform(inverse); const b = new DOMPoint(bounds.right, bounds.bottom).matrixTransform(inverse);
      return { id: node.dataset.id!, left: a.x, top: a.y, right: b.x, bottom: b.y };
    }),
    edges: [...svg.querySelectorAll<SVGGElement>('.task-dependency-edge')].map((group) => {
      const path = group.querySelector<SVGPathElement>('.react-flow__edge-path')!; const body = group.querySelector<SVGGElement>('.task-dependency-body')!; const style = getComputedStyle(path);
      return { id: group.dataset.id!, source: path.dataset.source!, target: path.dataset.target!, d: path.getAttribute('d')!, external: group.getAttribute('data-external'), stroke: style.stroke, fill: style.fill,
        color: getComputedStyle(body).stroke, bodyMatrix: relativeMatrix(body), bodyVisible: visible(body), marker: path.getAttribute('marker-end'), canonicalVisible: visible(path),
        pieces: [...body.querySelectorAll<SVGGraphicsElement>('.task-dependency-paint-piece')].map((piece) => {
          const paint = getComputedStyle(piece); const line = piece instanceof SVGLineElement;
          return { d: line ? `M${piece.x1.baseVal.value},${piece.y1.baseVal.value} L${piece.x2.baseVal.value},${piece.y2.baseVal.value}` : piece.getAttribute('d')!, matrix: relativeMatrix(piece), line,
            phase: Number.parseFloat(paint.strokeDashoffset), dash: paint.strokeDasharray, stroke: paint.stroke, width: Number.parseFloat(paint.strokeWidth), cap: paint.strokeLinecap, join: paint.strokeLinejoin,
            hidden: visible(piece) && piece.getAttribute('aria-hidden') === 'true' && piece.getAttribute('focusable') === 'false' && paint.pointerEvents === 'none' && (!(piece instanceof SVGPathElement) || paint.fill === 'none') };
        }) };
    }),
    markers: [...svg.querySelectorAll<SVGMarkerElement>('marker')].map((marker) => { const shape = marker.querySelector('polyline')!; const style = getComputedStyle(shape); return {
      id: marker.id, orient: marker.getAttribute('orient'), units: marker.getAttribute('markerUnits'), viewBox: marker.getAttribute('viewBox'), width: marker.getAttribute('markerWidth'), height: marker.getAttribute('markerHeight'), refX: marker.getAttribute('refX'), refY: marker.getAttribute('refY'), points: shape.getAttribute('points'), stroke: style.stroke, fill: style.fill,
      strokeWidth: Number.parseFloat(style.strokeWidth), cap: style.strokeLinecap, join: style.strokeLinejoin,
    }; }),
    declaredPieces: Number(svg.dataset.paintPieceCount),
    viewport: svg.closest('.react-flow__viewport') === viewport && !svg.hasAttribute('viewBox'),
    passive: getComputedStyle(svg).pointerEvents === 'none' && svg.querySelectorAll('[tabindex]:not([tabindex="-1"])').length === 0
      && [...svg.querySelectorAll<SVGGElement>('.task-dependency-edge')].every((group) => {
        const path = group.querySelector<SVGPathElement>('.react-flow__edge-path'); if (path === null) return false;
        // The canonical world-coordinate d may be non-painted. Its actual edge
        // owner supplies the viewport matrix; no synthetic identity is inferred.
        const owner = group.getScreenCTM(); if (owner === null) return false;
        const relative = inverse.multiply(owner);
        return group.getAttribute('role') === 'img' && group.getAttribute('focusable') === 'false'
          && (group.getAttribute('aria-label') ?? '').includes(path.dataset.source!) && (group.getAttribute('aria-label') ?? '').includes(path.dataset.target!)
          && path.getAttribute('aria-hidden') === 'true' && path.getAttribute('focusable') === 'false' && getComputedStyle(path).pointerEvents === 'none' && getComputedStyle(path).transform === 'none' && !path.hasAttribute('transform')
          && [relative.a - 1, relative.b, relative.c, relative.d - 1, relative.e, relative.f].every((value) => Math.abs(value) < 0.00001);
      }),
  };
});

export const summarizeGeometryFailures = (failures: readonly string[]): { total: number; examples: string[] } => ({ total: failures.length, examples: failures.slice(0, 12) });
let failureSequence = 0;
export const checkDependencyGeometry = async (page: Page, expected: GeometryExpectation, info: TestInfo, compilerInputs?: readonly DeclaredCurveInput[]): Promise<{ total: number; examples: string[] }> => {
  const snapshot = await captureDependencySnapshot(page);
  const failures = inspectDependencySnapshot(snapshot, expected, compilerInputs);
  if (failures.length > 0) {
    const name = `dependency-geometry-failure-${++failureSequence}`;
    const path = info.outputPath(`${name}.json`);
    await writeFile(path, `${JSON.stringify({ total: failures.length, failures, snapshot, expected, compilerInputs })}\n`);
    await info.attach(name, { path, contentType: 'application/json' });
  }
  return summarizeGeometryFailures(failures);
};
