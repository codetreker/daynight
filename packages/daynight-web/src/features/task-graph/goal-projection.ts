import type { GraphIndex, GraphProjection, ProjectionEdge } from './model';

// Only direct, accessible prerequisites of members belong to the Goal view.
export const projectGoal = (index: GraphIndex, goalId: string): GraphProjection => {
  const mainIds = new Set([...index.nodes.values()].filter((task) => task.parentId === goalId).map((task) => task.id));
  const externalIds = new Set<string>();
  const edges: ProjectionEdge[] = [];
  for (const id of mainIds) {
    const task = index.nodes.get(id)!;
    const external = new Set(task.externalDependsOn);
    for (const source of task.dependsOn) {
      if (!index.nodes.has(source)) continue;
      if (!mainIds.has(source)) externalIds.add(source);
      edges.push({ source, target: id, external: external.has(source) });
    }
  }
  return { mainIds, externalIds, edges };
};

export const goalTopologyKey = (projection: GraphProjection): string => JSON.stringify([
  [...projection.mainIds].sort(), [...projection.externalIds].sort(),
  projection.edges.map(({ source, target, external }) => [source, target, external] as const)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
]);
