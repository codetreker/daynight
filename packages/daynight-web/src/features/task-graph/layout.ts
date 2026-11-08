import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import type { ChainProjection } from './model';
import { planDependencyRoutes } from './routing';
import type { TaskExpansions } from './visibility';

export const TASK_NODE_WIDTH = 220;
export const TASK_NODE_COMPACT_HEIGHT = 96;
export const TASK_NODE_EXPANDABLE_HEIGHT = 136;
export const getTaskNodeHeight = (expansions: TaskExpansions, external = false): number =>
  external || expansions.prerequisites.ids.length > 0 || expansions.successors.ids.length > 0
    ? TASK_NODE_EXPANDABLE_HEIGHT : TASK_NODE_COMPACT_HEIGHT;

export type CanvasPoint = {
  readonly x: number;
  readonly y: number;
};

export type GraphDirection = 'horizontal' | 'vertical';

export type CanvasNode = {
  readonly id: string;
  readonly position: CanvasPoint;
  readonly kind: 'main' | 'external';
  readonly width: number;
  readonly height: number;
};

export type CanvasEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly external: boolean;
  readonly points: readonly CanvasPoint[];
};

export type CanvasLayout = {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly width: number;
  readonly height: number;
  readonly direction?: GraphDirection;
};

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const finite = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) throw new Error('Task graph layout returned non-finite geometry.');
  return value;
};

export const layoutGraph = (projection: ChainProjection, nodeHeights: ReadonlyMap<string, number> = new Map(
  [...projection.mainIds, ...projection.externalIds].map((id) => [id, TASK_NODE_COMPACT_HEIGHT]),
), direction: GraphDirection = 'horizontal'): CanvasLayout => {
  const ids = [...projection.mainIds, ...projection.externalIds].sort(compare);
  if (ids.length === 0) return { nodes: [], edges: [], width: 0, height: 0, direction };

  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ directed: true });
  graph.setGraph({ rankdir: direction === 'horizontal' ? 'LR' : 'TB', ranker: 'longest-path', nodesep: 32, ranksep: 64, marginx: 32, marginy: 32 });
  for (const id of ids) graph.setNode(id, { width: TASK_NODE_WIDTH, height: finite(nodeHeights.get(id)) });
  const sortedEdges = [...projection.edges].sort((left, right) =>
    compare(left.source, right.source) || compare(left.target, right.target));
  for (const edge of sortedEdges) graph.setEdge(edge.source, edge.target, {});
  layout(graph);

  const width = finite(graph.graph().width);
  const height = finite(graph.graph().height);
  if (width <= 0 || height <= 0) throw new Error('Task graph layout returned invalid bounds.');

  const nodes: CanvasNode[] = ids.map((id) => {
    const node = graph.node(id);
    const nodeHeight = finite(node.height);
    const x = finite(node.x) - TASK_NODE_WIDTH / 2;
    const y = finite(node.y) - nodeHeight / 2;
    if (x < 0 || y < 0 || x + TASK_NODE_WIDTH > width || y + nodeHeight > height) {
      throw new Error('Task graph layout placed a node outside its bounds.');
    }
    return { id, position: { x, y }, width: TASK_NODE_WIDTH, height: nodeHeight, kind: projection.mainIds.has(id) ? 'main' : 'external' };
  });

  const edges: CanvasEdge[] = sortedEdges.map((edge) => {
    const points = graph.edge(edge.source, edge.target).points;
    if (points === undefined || points.length === 0) throw new Error('Task graph layout returned an edge without geometry.');
    return {
      id: `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      external: edge.external,
      points: points.map((point) => ({ x: finite(point.x), y: finite(point.y) })),
    };
  });

  return { nodes, edges: planDependencyRoutes(nodes.map((node) => ({
    id: node.id, left: node.position.x, top: node.position.y,
    right: node.position.x + node.width, bottom: node.position.y + node.height,
  })), edges, direction), width, height, direction };
};
