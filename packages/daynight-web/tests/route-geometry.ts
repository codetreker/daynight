export type Point = { x: number; y: number };
export type Curve = { kind: 'L' | 'C'; from: Point; to: Point; first?: Point; second?: Point };
export type Rectangle = { left: number; right: number; top: number; bottom: number };
export const distance = (from: Point, to: Point) => Math.hypot(to.x - from.x, to.y - from.y);
export const parseRoute = (d: string): Curve[] => {
  const tokens = d.match(/[MLC]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)!;
  if (tokens.join('').toLowerCase() !== d.replace(/[\s,]/g, '').toLowerCase()) throw new Error('Unexpected route syntax.');
  let cursor = 0;
  const point = (): Point => ({ x: Number(tokens[cursor++]), y: Number(tokens[cursor++]) });
  if (tokens[cursor++] !== 'M') throw new Error('Route must start with M.');
  let from = point();
  const result: Curve[] = [];
  while (cursor < tokens.length) {
    const kind = tokens[cursor++];
    if (kind !== 'L' && kind !== 'C') throw new Error('Unexpected route command.');
    const controls = kind === 'C' ? { first: point(), second: point() } : {};
    const to = point();
    result.push({ kind, from, to, ...controls }); from = to;
  }
  return result;
};
export const at = (curve: Curve, t: number): Point => {
  const u = 1 - t;
  const value = (axis: 'x' | 'y') => curve.kind === 'L' ? curve.from[axis] + (curve.to[axis] - curve.from[axis]) * t
    : u ** 3 * curve.from[axis] + 3 * u * u * t * curve.first![axis] + 3 * u * t * t * curve.second![axis] + t ** 3 * curve.to[axis];
  return { x: value('x'), y: value('y') };
};
export const tangent = (curve: Curve, t: number): Point => {
  const value = (axis: 'x' | 'y') => curve.kind === 'L' ? curve.to[axis] - curve.from[axis]
    : 3 * ((1 - t) ** 2 * (curve.first![axis] - curve.from[axis]) + 2 * (1 - t) * t * (curve.second![axis] - curve.first![axis]) + t * t * (curve.to[axis] - curve.second![axis]));
  return { x: value('x'), y: value('y') };
};

// Derivative integration is independent of the compiler's polygon enclosure.
export const arcLength = (curve: Curve): number => {
  if (curve.kind === 'L') return distance(curve.from, curve.to);
  const speed = (t: number) => { const v = tangent(curve, t); return Math.hypot(v.x, v.y); };
  const integrate = (a: number, b: number, fa: number, fm: number, fb: number, sum: number, error: number, depth: number): number => {
    const m = (a + b) / 2; const l = speed((a + m) / 2); const r = speed((m + b) / 2);
    const left = (m - a) * (fa + 4 * l + fm) / 6; const right = (b - m) * (fm + 4 * r + fb) / 6;
    if (depth === 0 || Math.abs(left + right - sum) <= 15 * error) return left + right + (left + right - sum) / 15;
    return integrate(a, m, fa, l, fm, left, error / 2, depth - 1) + integrate(m, b, fm, r, fb, right, error / 2, depth - 1);
  };
  const fa = speed(0); const fm = speed(0.5); const fb = speed(1);
  return integrate(0, 1, fa, fm, fb, (fa + 4 * fm + fb) / 6, 1e-8, 24);
};
const levelParameters = (curve: Curve, axis: 'x' | 'y', value: number): number[] => {
  // Planner cubics are monotonic in both axes, including exact subcurves.
  const start = curve.from[axis]; const end = curve.to[axis];
  if (value <= Math.min(start, end) || value >= Math.max(start, end)) return [];
  let low = 0; let high = 1;
  for (let iteration = 0; iteration < 64; iteration++) {
    const t = (low + high) / 2;
    if ((at(curve, t)[axis] < value) === (end > start)) low = t; else high = t;
  }
  return [(low + high) / 2];
};

// Boundary roots partition each monotonic segment into constant-membership spans.
export const entersRectangle = (curve: Curve, rectangle: Rectangle): boolean => {
  const breaks = [0, 1];
  for (const [axis, limits] of [['x', [rectangle.left, rectangle.right]], ['y', [rectangle.top, rectangle.bottom]]] as const) {
    for (const value of limits) breaks.push(...levelParameters(curve, axis, value));
  }
  breaks.sort((first, second) => first - second);
  return breaks.slice(1).some((end, index) => {
    const p = at(curve, (end + breaks[index]!) / 2);
    return p.x > rectangle.left + 1e-7 && p.x < rectangle.right - 1e-7 && p.y > rectangle.top + 1e-7 && p.y < rectangle.bottom - 1e-7;
  });
};
