import type { CanvasEdge, CanvasPoint } from './layout';

export type RoutingNode = {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};
type RowInterval = { start: number; end: number };
type Column = { readonly left: number; readonly right: number; readonly occupied: readonly RowInterval[] };
type LocatedNode = { readonly rectangle: RoutingNode; readonly column: number };
const passageClearance = 16;
const middle = (first: number, last: number): number => first + (last - first) / 2;

const buildIndex = (nodes: readonly RoutingNode[]) => {
  const groups = new Map<number, RoutingNode[]>();
  for (const node of nodes) {
    if (![node.left, node.right, node.top, node.bottom].every(Number.isFinite) || node.left >= node.right || node.top >= node.bottom) {
      throw new Error('Task dependency routing received invalid node bounds.');
    }
    const column = groups.get(node.left);
    if (column === undefined) groups.set(node.left, [node]);
    else column.push(node);
  }
  const located = new Map<string, LocatedNode>();
  const columns: Column[] = [...groups.values()].sort((first, second) => first[0]!.left - second[0]!.left).map((members, column) => {
    const sorted = members.sort((first, second) => first.top - second.top);
    const first = sorted[0]!;
    const occupied: RowInterval[] = [];
    for (const [position, rectangle] of sorted.entries()) {
      if (rectangle.right !== first.right || position > 0 && rectangle.top < sorted[position - 1]!.bottom) {
        throw new Error('Task dependency routing requires nonoverlapping node columns.');
      }
      if (located.has(rectangle.id)) throw new Error('Task dependency routing received duplicate node identities.');
      located.set(rectangle.id, { rectangle, column });
      const start = rectangle.top - passageClearance;
      const end = rectangle.bottom + passageClearance;
      const previous = occupied.at(-1);
      if (previous !== undefined && start < previous.end) previous.end = Math.max(previous.end, end);
      else occupied.push({ start, end });
    }
    return { left: first.left, right: first.right, occupied };
  });
  for (let column = 1; column < columns.length; column++) {
    if (columns[column]!.left <= columns[column - 1]!.right) {
      throw new Error('Task dependency routing requires positive rank gaps.');
    }
  }
  return { columns, located };
};

const freeRow = (column: Column, intended: number): number => {
  for (const interval of column.occupied) {
    if (intended <= interval.start) break;
    if (intended < interval.end) return intended - interval.start <= interval.end - intended ? interval.start : interval.end;
  }
  return intended;
};

const append = (points: CanvasPoint[], point: CanvasPoint) => {
  const previous = points.at(-1);
  if (previous !== undefined && previous.x === point.x && previous.y === point.y) return;
  while (points.length > 1 && points.at(-2)!.y === point.y && previous!.y === point.y) points.pop();
  points.push(point);
};

// Dagre determines card placement and intermediate passage intent. Its endpoint
// clipping does not prevent steep spans from crossing other cards in a column:
// https://github.com/dagrejs/dagre/blob/c3ed0802cd98de74c21cff1f754689ebbb0f8dae/lib/layout.ts#L584-L601
// Each changing row is bounded by the empty rank gap. Cubic control points stay
// in that gap, so their convex hull cannot enter a card. Horizontal passages
// cross intermediate columns with sixteen units of clearance.
export const planDependencyRoutes = (nodes: readonly RoutingNode[], edges: readonly CanvasEdge[]): readonly CanvasEdge[] => {
  const { columns, located } = buildIndex(nodes);
  return edges.map((edge) => {
    const source = located.get(edge.source);
    const target = located.get(edge.target);
    if (source === undefined || target === undefined || source.column >= target.column) {
      throw new Error('Task dependency routing requires forward endpoints in distinct columns.');
    }
    const raw = edge.points;
    if (raw.length < 2 || raw.some((point, index) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || index > 0 && point.x < raw[index - 1]!.x)) {
      throw new Error('Task dependency routing received invalid layout waypoints.');
    }
    const from = { x: source.rectangle.right, y: middle(source.rectangle.top, source.rectangle.bottom) };
    const to = { x: target.rectangle.left, y: middle(target.rectangle.top, target.rectangle.bottom) };
    const points: CanvasPoint[] = [from];
    let row = from.y;
    let waypoint = 0;
    for (let column = source.column; column < target.column; column++) {
      const next = columns[column + 1]!;
      let nextRow = to.y;
      if (column + 1 !== target.column) {
        const x = middle(next.left, next.right);
        while (waypoint < raw.length - 2 && raw[waypoint + 1]!.x < x) waypoint++;
        const first = raw[waypoint]!;
        const last = raw[waypoint + 1]!;
        if (first.x > x || last.x < x || first.x === last.x) throw new Error('Task dependency routing lacks an intermediate column passage.');
        nextRow = freeRow(next, first.y + (last.y - first.y) * ((x - first.x) / (last.x - first.x)));
      }
      append(points, { x: columns[column]!.right, y: row });
      append(points, { x: next.left, y: nextRow });
      row = nextRow;
    }
    append(points, to);
    return { ...edge, points };
  });
};
