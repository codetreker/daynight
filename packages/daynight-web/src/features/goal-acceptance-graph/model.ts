import type { TaskSummary } from '../../api/types';
import type { GraphProjection } from '../task-graph/model';

export type GoalAcceptanceGoal = Pick<TaskSummary, 'id' | 'titlePreview' | 'titleTruncated' | 'status'> & {
  readonly project?: { readonly id: string; readonly name: string };
};

export type GoalAcceptanceProjection = GraphProjection & {
  readonly goals: ReadonlyMap<string, GoalAcceptanceGoal>;
  readonly availableGoals: ReadonlyMap<string, GoalAcceptanceGoal>;
  readonly availableEdges: GraphProjection['edges'];
  readonly prerequisites: ReadonlyMap<string, readonly string[]>;
  readonly successors: ReadonlyMap<string, readonly string[]>;
  readonly progress: ReadonlyMap<string, { readonly done: number; readonly total: number }>;
};

export const projectGoalRelations = (summaries: ReadonlyMap<string, TaskSummary>) => {
  const available = new Map([...summaries].filter(([, task]) => task.type === 'goal'));
  const goals = new Map<string, GoalAcceptanceGoal>([...available].map(([id, goal]) => [id, { id, titlePreview: goal.titlePreview, titleTruncated: goal.titleTruncated, status: goal.status }]));
  const prerequisites = new Map([...goals.keys()].map(id => [id, [] as string[]])), successors = new Map([...goals.keys()].map(id => [id, [] as string[]]));
  const edges: GraphProjection['edges'][number][] = [];
  for (const goal of available.values()) for (const source of goal.dependsOn) if (goals.has(source)) {
    prerequisites.get(goal.id)!.push(source); successors.get(source)!.push(goal.id);
    edges.push({ source, target: goal.id, external: false });
  }
  return { goals, prerequisites, successors, edges };
};

export const projectGoalAcceptance = (summaries: ReadonlyMap<string, TaskSummary>, focusId: string | null = null): GoalAcceptanceProjection => {
  const known = projectGoalRelations(summaries);
  const visible = new Set([...known.goals.values()].filter(goal => goal.status === 'todo' || goal.status === 'in_progress').map(goal => goal.id));
  if (focusId !== null && known.goals.has(focusId)) visible.add(focusId);
  for (const id of [...visible]) for (const prerequisite of known.prerequisites.get(id)!) visible.add(prerequisite);
  const goals = new Map([...known.goals].filter(([id]) => visible.has(id)));
  const prerequisites = new Map([...goals.keys()].map(id => [id, [] as string[]]));
  const successors = new Map([...goals.keys()].map(id => [id, [] as string[]]));
  const progress = new Map([...known.goals.keys()].map(id => [id, { done: 0, total: 0 }]));
  for (const task of summaries.values()) {
    if (task.type !== 'task' || task.parentId === null) continue;
    const parent = progress.get(task.parentId);
    if (parent !== undefined) { parent.total++; if (task.status === 'done') parent.done++; }
  }
  const edges = known.edges.filter(edge => goals.has(edge.source) && goals.has(edge.target));
  for (const edge of edges) { prerequisites.get(edge.target)!.push(edge.source); successors.get(edge.source)!.push(edge.target); }
  return { goals, availableGoals: known.goals, availableEdges: known.edges, prerequisites, successors, progress, mainIds: visible, externalIds: new Set(), edges };
};

export const traceGoalRelations = (relations: ReadonlyMap<string, readonly string[]>, selected: string | null): ReadonlySet<string> => {
  const result = new Set<string>();
  const pending = selected === null ? [] : [selected];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...relations.get(id)!);
  }
  return result;
};

export const acceptanceTopology = (projection: GoalAcceptanceProjection): string => JSON.stringify([
  [...projection.goals.keys()].sort(), projection.edges.map(edge => `${edge.source}:${edge.target}`).sort(),
]);
