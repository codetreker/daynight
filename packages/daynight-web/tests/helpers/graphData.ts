import type { GraphTask, TaskGraph, TaskStatus } from '../../src/api/types';

type TaskSeed = {
  readonly number: number;
  readonly title: string;
  readonly status: TaskStatus;
  readonly dependencies: readonly number[];
  readonly externalDependencies: readonly number[];
};

const id = (number: number): string => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const graph = (number: number, name: string, seeds: readonly TaskSeed[]): TaskGraph => {
  const statuses = new Map(seeds.map((task) => [task.number, task.status]));
  const tasks: GraphTask[] = [...seeds].sort((left, right) => left.number - right.number).map((task) => {
    const blockedBy = task.dependencies.filter((dependency) => statuses.get(dependency) !== 'done').map(id).sort();
    const createdAt = new Date(Date.UTC(2026, 9, 21, 9, task.number * 10)).toISOString();
    return {
      id: id(task.number), titlePreview: task.title, titleTruncated: false, status: task.status,
      assignedTo: null, requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null,
      dependsOn: task.dependencies.map(id).sort(), externalDependsOn: task.externalDependencies.map(id).sort(), blockedBy,
      ready: task.status === 'todo' && blockedBy.length === 0, createdAt, updatedAt: createdAt,
    };
  });
  return {
    observedAt: '2026-10-20T12:00:00Z',
    project: {
      settings: { version: 1n, executionWarningMinutes: 60 }, id: id(number), name,
      repoUrl: 'https://github.com/example/task-graph', createdAt: '2026-10-21T09:00:00Z', updatedAt: '2026-10-22T09:00:00Z',
    },
    summary: {
      total: tasks.length,
      todo: tasks.filter((task) => task.status === 'todo').length,
      inProgress: tasks.filter((task) => task.status === 'in_progress').length,
      done: tasks.filter((task) => task.status === 'done').length,
      ready: tasks.filter((task) => task.ready).length,
      blocked: tasks.filter((task) => task.status === 'todo' && !task.ready).length,
    },
    tasks,
  };
};

export const completeContextGraph = graph(130, 'Complete upstream context', [
  { number: 30, title: '外部上下文 · 链内交付起点', status: 'todo', dependencies: [], externalDependencies: [] },
  { number: 14, title: '外部祖先 · 已完成基础协议', status: 'done', dependencies: [], externalDependencies: [] },
  { number: 15, title: '外部前置 · 实现共享接口', status: 'done', dependencies: [14], externalDependencies: [] },
  { number: 16, title: '外部前置 · 验证共享接口', status: 'done', dependencies: [14], externalDependencies: [] },
  { number: 17, title: '外部前置 · 菱形合流', status: 'done', dependencies: [15, 16], externalDependencies: [] },
  { number: 31, title: '链内最终交付', status: 'todo', dependencies: [30, 17], externalDependencies: [17] },
  { number: 32, title: '外部前置的无关后续 · 当前链不显示', status: 'todo', dependencies: [17], externalDependencies: [] },
]);

export const progressiveGraph = graph(129, 'Progressive task visibility', [
  ...Array.from({ length: 40 }, (_, position) => ({
    number: 2000 + position, title: `外部前置 ${position + 1} · 已完成共享协议`,
    status: 'done' as const, dependencies: [], externalDependencies: [],
  })),
  { number: 3000, title: '渐进展开 · 主链交付起点', status: 'todo', dependencies: [], externalDependencies: [] },
  ...Array.from({ length: 60 }, (_, position) => ({
    number: 3001 + position, title: position === 0 ? '合流任务 · 40 个外部前置' : `主链后续 ${position + 1}`,
    status: 'todo' as const, dependencies: position === 0 ? [3000, ...Array.from({ length: 40 }, (_, index) => 2000 + index)] : [3000],
    externalDependencies: position === 0 ? Array.from({ length: 40 }, (_, index) => 2000 + index) : [],
  })),
]);
