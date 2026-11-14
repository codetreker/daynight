import { TASK_NODE_COMPACT_HEIGHT, TASK_NODE_WIDTH, type CanvasEdge, type CanvasLayout, type CanvasNode, type CanvasPoint, type GraphDirection } from './layout';
import type { GraphProjection, ProjectionEdge } from './model';
import { planDependencyRoutes } from './routing';

export type GoalLayoutSize = { readonly width: number; readonly height: number };

type Group = { readonly id: string; readonly ranks: readonly (readonly string[])[]; readonly edges: readonly ProjectionEdge[] };
type Rectangle = { readonly group: Group; readonly width: number; readonly height: number };
type Placement = Rectangle & { readonly x: number; readonly y: number };
type Candidate = { readonly columns: number; readonly budget: number; readonly width: number; readonly height: number; readonly placements: readonly Placement[] };

const forwardGap = 64;
const crossGap = 32;
const margin = 32;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const edgeOrder = (a: ProjectionEdge, b: ProjectionEdge): number => compare(a.source, b.source) || compare(a.target, b.target);
const invalid = (reason: string): never => { throw new Error(`Goal graph layout ${reason}.`); };

// Every displayed edge, including external dependencies, joins its endpoints.
const groupsFor = (projection: GraphProjection): readonly Group[] => {
  const ids = [...projection.mainIds, ...projection.externalIds].sort(compare);
  if (new Set(ids).size !== ids.length) invalid('received duplicate node identities');
  const neighbors = new Map(ids.map((id) => [id, [] as string[]]));
  const successors = new Map(ids.map((id) => [id, [] as string[]]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  const edges = [...projection.edges].sort(edgeOrder);
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (!neighbors.has(edge.source) || !neighbors.has(edge.target) || edge.source === edge.target) invalid('received invalid edge endpoints');
    const key = JSON.stringify([edge.source, edge.target]);
    if (edgeIds.has(key)) invalid('received duplicate edges');
    edgeIds.add(key);
    neighbors.get(edge.source)!.push(edge.target);
    neighbors.get(edge.target)!.push(edge.source);
    successors.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
  }
  for (const list of neighbors.values()) list.sort(compare);
  for (const list of successors.values()) list.sort(compare);
  const seen = new Set<string>();
  const groups: Group[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const members = [id]; seen.add(id);
    for (let i = 0; i < members.length; i++) {
      for (const next of neighbors.get(members[i]!)!) if (!seen.has(next)) { seen.add(next); members.push(next); }
    }
    members.sort(compare);
    const memberSet = new Set(members);
    const ready = members.filter((member) => indegree.get(member) === 0);
    const depth = new Map(members.map((member) => [member, 0]));
    let visited = 0;
    while (ready.length > 0) {
      const current = ready.shift()!; visited++;
      for (const target of successors.get(current)!) {
        depth.set(target, Math.max(depth.get(target)!, depth.get(current)! + 1));
        const remaining = indegree.get(target)! - 1; indegree.set(target, remaining);
        if (remaining === 0) {
          const position = ready.findIndex((entry) => compare(entry, target) > 0);
          ready.splice(position < 0 ? ready.length : position, 0, target);
        }
      }
    }
    if (visited !== members.length) invalid('received cyclic dependencies');
    const ranks: string[][] = [];
    for (const member of members) (ranks[depth.get(member)!] ??= []).push(member);
    groups.push({ id: members[0]!, ranks, edges: edges.filter((edge) => memberSet.has(edge.source)) });
  }
  return groups;
};

const axis = (direction: GraphDirection) => direction === 'horizontal'
  ? { nodeF: TASK_NODE_WIDTH, nodeQ: TASK_NODE_COMPACT_HEIGHT }
  : { nodeF: TASK_NODE_COMPACT_HEIGHT, nodeQ: TASK_NODE_WIDTH };

const rankSize = (count: number, columns: number, direction: GraphDirection) => {
  const { nodeF, nodeQ } = axis(direction);
  const cols = Math.min(count, columns); const rows = Math.ceil(count / cols);
  return { cols, f: cols * nodeF + (cols - 1) * forwardGap, q: rows * nodeQ + (rows - 1) * crossGap };
};

const rectangleFor = (group: Group, columns: number, direction: GraphDirection): Rectangle => {
  if (group.ranks.length === 1 && group.ranks[0]!.length === 1) return { group, width: TASK_NODE_WIDTH, height: TASK_NODE_COMPACT_HEIGHT };
  const sizes = group.ranks.map((rank) => rankSize(rank.length, columns, direction));
  const f = sizes.reduce((sum, size) => sum + size.f, (sizes.length - 1) * forwardGap) + 2 * margin;
  const q = sizes.reduce((maximum, size) => Math.max(maximum, size.q), 0) + 2 * margin;
  return direction === 'horizontal' ? { group, width: f, height: q } : { group, width: q, height: f };
};

const pack = (rectangles: readonly Rectangle[], columns: number, budget: number): Candidate => {
  const placements: Placement[] = [];
  let x = 0; let y = 0; let rowHeight = 0; let width = 0;
  for (const rectangle of rectangles) {
    if (x > 0 && x + rectangle.width > budget) { y += rowHeight + margin; x = 0; rowHeight = 0; }
    placements.push({ ...rectangle, x: x + margin, y: y + margin });
    width = Math.max(width, x + rectangle.width);
    x += rectangle.width + margin;
    rowHeight = Math.max(rowHeight, rectangle.height);
  }
  return { columns, budget, width: width + 2 * margin, height: y + rowHeight + 2 * margin, placements };
};

const choose = (groups: readonly Group[], size: GoalLayoutSize, direction: GraphDirection): Candidate => {
  const maxRank = groups.reduce((maximum, group) => group.ranks.reduce((value, rank) => Math.max(value, rank.length), maximum), 0);
  let best: Candidate | undefined;
  const score = (candidate: Candidate) => [Math.max(candidate.width / size.width, candidate.height / size.height),
    candidate.width * candidate.height, candidate.width, candidate.columns, candidate.budget];
  const better = (candidate: Candidate, current: Candidate) => {
    const a = score(candidate); const b = score(current);
    for (let i = 0; i < a.length; i++) { if (a[i]! < b[i]!) return true; if (a[i]! > b[i]!) return false; }
    return false;
  };
  for (let columns = 1; columns <= maxRank; columns++) {
    const rectangles = groups.map((group) => rectangleFor(group, columns, direction)).sort((a, b) =>
      b.height - a.height || b.width - a.width || compare(a.group.id, b.group.id));
    const area = rectangles.reduce((sum, rectangle) => sum + rectangle.width * rectangle.height, 0);
    const maxWidth = rectangles.reduce((maximum, rectangle) => Math.max(maximum, rectangle.width), 0);
    const ideal = Math.sqrt(area * size.width / size.height);
    const budgets = new Set([maxWidth, ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((k) => Math.max(maxWidth, ideal * k)),
      rectangles.reduce((sum, rectangle) => sum + rectangle.width, (rectangles.length - 1) * margin)]);
    for (const budget of budgets) {
      const candidate = pack(rectangles, columns, budget);
      if (best === undefined || better(candidate, best)) best = candidate;
    }
  }
  return best!;
};

const materialize = (placement: Placement, columns: number, projection: GraphProjection, direction: GraphDirection) => {
  const { group } = placement;
  const single = group.ranks.length === 1 && group.ranks[0]!.length === 1;
  const { nodeF, nodeQ } = axis(direction);
  const sizes = group.ranks.map((rank) => rankSize(rank.length, columns, direction));
  const maxQ = sizes.reduce((maximum, size) => Math.max(maximum, size.q), 0);
  let f = single ? 0 : margin;
  const nodes: CanvasNode[] = [];
  for (const [rankIndex, rank] of group.ranks.entries()) {
    const size = sizes[rankIndex]!;
    const q = (single ? 0 : margin) + (maxQ - size.q) / 2;
    for (const [index, id] of rank.entries()) {
      const forward = f + (index % size.cols) * (nodeF + forwardGap);
      const cross = q + Math.floor(index / size.cols) * (nodeQ + crossGap);
      nodes.push({ id, kind: projection.mainIds.has(id) ? 'main' : 'external', width: TASK_NODE_WIDTH, height: TASK_NODE_COMPACT_HEIGHT,
        position: direction === 'horizontal' ? { x: forward, y: cross } : { x: cross, y: forward } });
    }
    f += size.f + forwardGap;
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const port = (node: CanvasNode, source: boolean): CanvasPoint => direction === 'horizontal'
    ? { x: node.position.x + (source ? node.width : 0), y: node.position.y + node.height / 2 }
    : { x: node.position.x + node.width / 2, y: node.position.y + (source ? node.height : 0) };
  const edges: CanvasEdge[] = group.edges.map((edge) => ({ ...edge, id: `${edge.source}->${edge.target}`,
    points: [port(byId.get(edge.source)!, true), port(byId.get(edge.target)!, false)] }));
  const routed = planDependencyRoutes(nodes.map((node) => ({ id: node.id, left: node.position.x, top: node.position.y,
    right: node.position.x + node.width, bottom: node.position.y + node.height })), edges, direction);
  for (const edge of routed) for (const point of edge.points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > placement.width || point.y > placement.height) {
      invalid('returned a route outside its component bounds');
    }
  }
  const translate = (point: CanvasPoint) => ({ x: point.x + placement.x, y: point.y + placement.y });
  return { nodes: nodes.map((node) => ({ ...node, position: translate(node.position) })),
    edges: routed.map((edge) => ({ ...edge, points: edge.points.map(translate) })) };
};

export const layoutGoalGraph = (projection: GraphProjection, size: GoalLayoutSize, direction: GraphDirection): CanvasLayout => {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) invalid('requires positive finite canvas dimensions');
  const groups = groupsFor(projection);
  if (groups.length === 0) return { nodes: [], edges: [], width: 0, height: 0, direction };
  const winner = choose(groups, size, direction);
  if (!Number.isFinite(winner.width) || !Number.isFinite(winner.height)) invalid('returned non-finite bounds');
  const contents = winner.placements.map((placement) => materialize(placement, winner.columns, projection, direction));
  return { nodes: contents.flatMap((content) => content.nodes).sort((a, b) => compare(a.id, b.id)),
    edges: contents.flatMap((content) => content.edges).sort(edgeOrder), width: winner.width, height: winner.height, direction };
};
