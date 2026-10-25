import { DEPENDENCY_DASH_PERIOD, type DashPiece } from './dashes';
import type { CanvasPoint } from './layout';

type Line = { readonly kind: 'line'; readonly from: CanvasPoint; readonly to: CanvasPoint };
type Cubic = { readonly kind: 'cubic'; readonly from: CanvasPoint; readonly first: CanvasPoint; readonly second: CanvasPoint; readonly to: CanvasPoint };
type Segment = Line | Cubic;
type Arc = { readonly curve: Cubic; readonly from: number; readonly to: number; readonly length: number };
export type DependencyRoute = { readonly d: string; readonly pieces: readonly DashPiece[] };

const gapMiddle = 7;
const joinRoom = 12;
const minimumLine = 128;
// Both native curves and local lines need bounded GPU dash work.
const maximumPiece = 8192;
const arcError = 0.025 / 1.8;
const distance = (from: CanvasPoint, to: CanvasPoint): number => Math.hypot(to.x - from.x, to.y - from.y);
const coordinates = (point: CanvasPoint): string => `${point.x},${point.y}`;
const command = (segment: Segment): string => segment.kind === 'line' ? `L${coordinates(segment.to)}`
  : `C${coordinates(segment.first)} ${coordinates(segment.second)} ${coordinates(segment.to)}`;
const interpolate = (from: CanvasPoint, to: CanvasPoint, t: number): CanvasPoint => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
const nextGap = (value: number): number => Math.ceil((value - gapMiddle) / DEPENDENCY_DASH_PERIOD) * DEPENDENCY_DASH_PERIOD + gapMiddle;
const previousGap = (value: number): number => Math.floor((value - gapMiddle) / DEPENDENCY_DASH_PERIOD) * DEPENDENCY_DASH_PERIOD + gapMiddle;
const path = (segments: readonly Segment[]): string => [`M${coordinates(segments[0]!.from)}`, ...segments.map(command)].join(' ');

const segmentsFor = (points: readonly CanvasPoint[]): readonly Segment[] => {
  const normalized: CanvasPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Task dependency route has non-finite geometry.');
    const previous = normalized.at(-1);
    if (previous !== undefined) {
      if (previous.x === point.x && previous.y === point.y) continue;
      if (point.x <= previous.x || !Number.isFinite(distance(previous, point))) throw new Error('Task dependency route requires finite forward passage geometry.');
      while (normalized.length > 1 && normalized.at(-2)!.y === point.y && previous.y === point.y) normalized.pop();
    }
    normalized.push(point);
  }
  if (normalized.length < 2) throw new Error('Task dependency route requires two distinct points.');
  return normalized.slice(1).map((to, index): Segment => {
    const from = normalized[index]!;
    const x = from.x + (to.x - from.x) / 2;
    return from.y === to.y ? { kind: 'line', from, to }
      : { kind: 'cubic', from, first: { x, y: from.y }, second: { x, y: to.y }, to };
  });
};
const split = (curve: Cubic, t: number): readonly [Cubic, Cubic] => {
  const a = interpolate(curve.from, curve.first, t); const b = interpolate(curve.first, curve.second, t); const c = interpolate(curve.second, curve.to, t);
  const d = interpolate(a, b, t); const e = interpolate(b, c, t); const center = interpolate(d, e, t);
  return [{ kind: 'cubic', from: curve.from, first: a, second: d, to: center }, { kind: 'cubic', from: center, first: e, second: c, to: curve.to }];
};
const portion = (curve: Cubic, from: number, to: number): Cubic => {
  const prefix = to === 1 ? curve : split(curve, to)[0];
  return from === 0 ? prefix : split(prefix, from / to)[1];
};

// Chord/control-polygon bounds enclose true cubic length. Split allowances bound
// the complete route's phase error, independent of its number of curves or cuts.
const arcs = (curve: Cubic, error: number, from = 0, to = 1): readonly Arc[] => {
  const lower = distance(curve.from, curve.to);
  const upper = distance(curve.from, curve.first) + distance(curve.first, curve.second) + distance(curve.second, curve.to);
  if (!Number.isFinite(upper)) throw new Error('Task dependency route has non-finite arc length.');
  if (upper - lower <= error * 2) return [{ curve, from, to, length: (upper + lower) / 2 }];
  const [left, right] = split(curve, 0.5); const center = from + (to - from) / 2;
  return [...arcs(left, error / 2, from, center), ...arcs(right, error / 2, center, to)];
};
const cubicLength = (curve: Cubic, error: number): number => arcs(curve, error).reduce((sum, arc) => sum + arc.length, 0);
const parameter = (table: readonly Arc[], length: number, value: number): number => {
  if (value <= 0) return 0;
  if (value >= length) return 1;
  let cumulative = 0;
  for (const arc of table) {
    if (cumulative + arc.length < value) { cumulative += arc.length; continue; }
    const wanted = value - cumulative;
    let low = 0; let high = 1;
    for (let iteration = 0; iteration < 64; iteration++) {
      const t = low + (high - low) / 2;
      const measured = cubicLength(split(arc.curve, t)[0], arcError / 16);
      if (Math.abs(measured - wanted) <= arcError / 8) return arc.from + (arc.to - arc.from) * t;
      if (measured < wanted) low = t; else high = t;
    }
    throw new Error('Task dependency route could not resolve a dash seam.');
  }
  throw new Error('Task dependency route has inconsistent arc length.');
};

const dashedPieces = (segments: readonly Segment[]): readonly DashPiece[] => {
  const curveCount = segments.filter((segment) => segment.kind === 'cubic').length;
  const tables = segments.map((segment) => segment.kind === 'cubic' ? arcs(segment, arcError / (8 * curveCount)) : []);
  const lengths = segments.map((segment, index) => segment.kind === 'line' ? distance(segment.from, segment.to) : tables[index]!.reduce((sum, arc) => sum + arc.length, 0));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isFinite(total)) throw new Error('Task dependency route has non-finite arc length.');
  const boundaries = new Set([0, total]);
  let cumulative = 0;
  for (const [index, segment] of segments.entries()) {
    const end = cumulative + lengths[index]!;
    if (segment.kind === 'line') {
      const start = index === 0 ? cumulative : nextGap(cumulative + joinRoom);
      const finish = index === segments.length - 1 ? end : previousGap(end - joinRoom);
      if (finish - start >= minimumLine) { boundaries.add(start); boundaries.add(finish); }
    }
    cumulative = end;
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const pieceLimit = curveCount === 0 ? maximumPiece : maximumPiece - arcError;
  const cuts = [0];
  for (const end of ordered.slice(1)) {
    let position = cuts.at(-1)!;
    while (end - position > pieceLimit) {
      position = previousGap(position + pieceLimit);
      cuts.push(position);
    }
    cuts.push(end);
  }
  const pieces: DashPiece[] = [];
  let segmentIndex = 0; let segmentStart = 0;
  for (let index = 1; index < cuts.length; index++) {
    const start = cuts[index - 1]!; const end = cuts[index]!;
    const painted: Segment[] = [];
    const firstSegment = segmentIndex;
    let covered = start;
    while (covered < end) {
      const segment = segments[segmentIndex]!; const length = lengths[segmentIndex]!;
      const segmentEnd = segmentStart + length;
      const limit = Math.min(end, segmentEnd);
      const from = covered === segmentStart ? 0 : covered - segmentStart;
      const to = limit === segmentEnd ? length : limit - segmentStart;
      painted.push(segment.kind === 'line' ? { kind: 'line', from: interpolate(segment.from, segment.to, from / length), to: interpolate(segment.from, segment.to, to / length) }
        : portion(segment, parameter(tables[segmentIndex]!, length, from), parameter(tables[segmentIndex]!, length, to)));
      covered = limit;
      if (limit === segmentEnd) { segmentIndex++; segmentStart = segmentEnd; }
    }
    const only = painted[0]!;
    // Local horizontal lines retain native dash culling under unit-scale rotation:
    // https://github.com/google/skia/blob/95ee33d7ec7791ab9c071675710a14fe6408ae4f/src/utils/SkDashPath.cpp#L117
    if (painted.length === 1 && only.kind === 'line' && lengths[firstSegment]! >= minimumLine) {
      const length = distance(only.from, only.to);
      pieces.push({ kind: 'line', from: only.from, length, cosine: (only.to.x - only.from.x) / length, sine: (only.to.y - only.from.y) / length, startDistance: start });
    } else pieces.push({ kind: 'path', d: path(painted), startDistance: start });
  }
  return pieces;
};

export const compileDependencyRoute = (points: readonly CanvasPoint[], dashed: boolean): DependencyRoute => {
  const segments = segmentsFor(points);
  return { d: path(segments), pieces: dashed ? dashedPieces(segments) : [] };
};
