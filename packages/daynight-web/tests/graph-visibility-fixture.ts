import type { GraphTask, TaskGraph, TaskStatus } from '../src/api/types';
import { buildGraphIndex } from '../src/features/task-graph/model';

export type Seed = { id: string; externalDependsOn?: readonly string[]; dependsOn?: readonly string[]; status?: TaskStatus };
export const indexOf = (seeds: readonly Seed[], defaultStatus: TaskStatus = 'todo') => {
  const statuses = new Map(seeds.map((seed) => [seed.id, seed.status ?? defaultStatus]));
  const tasks: GraphTask[] = seeds.map(({ id, dependsOn = [], externalDependsOn = [] }) => {
    const status = statuses.get(id)!;
    const blockedBy = dependsOn.filter((source) => statuses.get(source) !== 'done');
    return { assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn, startedAt: null, completedAt: null, cancelledAt: null,
      id, type: 'task', parentId: null, dependsOn, blockedBy, ready: status === 'todo' && blockedBy.length === 0, status,
      titlePreview: id, titleTruncated: false, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z',
    };
  });
  const count = (status: TaskStatus) => tasks.filter((task) => task.status === status).length;
  const graph: TaskGraph = { observedAt: "2026-10-20T12:00:00Z",
    project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: 'project', name: 'Project', repoUrl: '', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }, tasks,
    summary: { proposed: tasks.filter((task) => task.status === "proposed").length, total: tasks.length, todo: count('todo'), inProgress: count('in_progress'), done: count('done'), cancelled: 0,
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.status === 'todo' && task.blockedBy.length > 0).length },
  };
  return buildGraphIndex(graph);
};
export const chain = (count: number): Seed[] => Array.from({ length: count }, (_, index) => ({ id: `n${index}`, dependsOn: index === 0 ? [] : [`n${index - 1}`] }));
