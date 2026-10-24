import type { TaskDetail, TaskGraph } from '../../src/api/types';
import { stringifyApiJson } from '../../src/api/json';
import type { GraphSnapshot } from '../../src/features/projects/useTaskGraph';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import flowcharts from './files/docs/flowcharts.md?raw';

export const detailProjectId = '00000000-0000-4000-8000-000000000100';
export const detailTaskId = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-24T10:00:00Z';
const task = (id: string, title: string, status: TaskDetail['status']): TaskDetail => ({
  id, projectId: detailProjectId, title, description: '# 任务交付\n\n使用同一套完整任务详情查看资料与操作。\n\n- [方案与验收](docs/guide.md)\n- [交互原型](site/index.html)\n- [长文档](docs/tall.md)',
  status, version: 1n, allowAgents: false, requiredPlatform: null, dependsOn: [], externalDependsOn: [], blockedBy: [],
  ready: status === 'todo', startedAt: null, completedAt: status === 'done' ? timestamp : null,
  properties: { worker: null, pullRequests: [{ title: 'Share complete task details between dialog and page', url: 'https://github.com/example/project/pull/42' }] },
  createdAt: timestamp, updatedAt: timestamp,
});

export const createTaskDetailFixture = (options: { readonly initialStatus?: TaskDetail['status'] } = {}) => {
  const priorId = '00000000-0000-4000-8000-000000000002';
  const nextId = '00000000-0000-4000-8000-000000000003';
  const first = { ...task(detailTaskId, 'Markdown 流程图与完整任务详情', options.initialStatus ?? 'todo'),
    description: `${flowcharts.replaceAll('(../', '(').replace('(guide.md)', '(docs/guide.md)')}\n\n[在附件页阅读相同内容](docs/flowcharts.md)` };
  const prior = task(priorId, '完成资料准备与需求确认', 'done');
  const next = task(nextId, '验证任务详情与附件交互', 'todo');
  const tasks = new Map([[first.id, { ...first, dependsOn: [priorId] }], [prior.id, prior], [next.id, { ...next, dependsOn: [first.id], blockedBy: [first.id], ready: false }]]);
  const listeners = new Set<() => void>();
  let revision = 0;
  let readFailures = 0;
  let failWrite = false;
  let holdGraph = false;
  const build = (): GraphSnapshot => {
    for (const [id, item] of tasks) {
      const blockedBy = item.dependsOn.filter((dependency) => tasks.get(dependency)!.status !== 'done');
      tasks.set(id, { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 });
    }
    const details = [...tasks.values()];
    const graph: TaskGraph = {
      observedAt: timestamp,
      project: { id: detailProjectId, name: '任务详情交互示例', repoUrl: 'https://github.com/example/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: timestamp, updatedAt: timestamp },
      tasks: details.map((item) => ({ id: item.id, titlePreview: item.title, titleTruncated: false, status: item.status,
        allowAgents: item.allowAgents, requiredPlatform: item.requiredPlatform, dependsOn: item.dependsOn, externalDependsOn: item.externalDependsOn,
        blockedBy: item.blockedBy, ready: item.ready, startedAt: item.startedAt, completedAt: item.completedAt, createdAt: item.createdAt, updatedAt: item.updatedAt })),
      summary: { total: details.length, todo: details.filter((item) => item.status === 'todo').length,
        inProgress: details.filter((item) => item.status === 'in_progress').length, done: details.filter((item) => item.status === 'done').length, ready: details.filter((item) => item.ready).length,
        blocked: details.filter((item) => item.status === 'todo' && !item.ready).length },
    };
    return { graph, index: buildGraphIndex(graph), revision: ++revision, receivedAt: Date.now(), receivedMonotonic: performance.now(), observedAt: graph.observedAt };
  };
  let snapshot = build();
  const refresh = () => { if (!holdGraph) snapshot = build(); listeners.forEach((listener) => listener()); };
  const originalFetch = window.fetch;
  const json = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher: typeof window.fetch = async (input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('/api/v1/')) return originalFetch(input, options);
    const match = /^\/api\/v1\/projects\/[^/]+\/tasks\/([^/]+)(?:\/(status))?$/.exec(url);
    const current = match === null ? undefined : tasks.get(match[1]!);
    if (current === undefined) return json({ error: { code: 'not_found', message: 'Fixture task unavailable.', requestId: 'fixture-task' } }, 404);
    if (options?.method === 'PUT' || options?.method === 'PATCH') {
      if (failWrite) { failWrite = false; readFailures = 1; throw new TypeError('Fixture connection interrupted before a write response.'); }
      const patch = JSON.parse(String(options.body));
      if (BigInt(patch.version) !== current.version) return json({ error: { code: 'version_conflict', message: 'Fixture version changed.', requestId: 'fixture-version' } }, 409);
      const status = patch.status as TaskDetail['status'];
      const changedStatus = match![2] === 'status' && status !== current.status;
      if (changedStatus && (status !== 'todo' && current.dependsOn.some((id) => tasks.get(id)!.status !== 'done') || current.status === 'done' && [...tasks.values()].some((item) => item.dependsOn.includes(current.id) && item.status !== 'todo'))) return json({ error: { code: 'dependency_unsatisfied', message: 'Fixture dependencies prevent this status.', requestId: 'fixture-dependencies' } }, 409);
      const timing = status === 'todo' ? { startedAt: null, completedAt: null } : status === 'in_progress' ? { startedAt: new Date().toISOString(), completedAt: null } : { startedAt: current.status === 'in_progress' ? current.startedAt : null, completedAt: new Date().toISOString() };
      const updated = { ...current, ...(match![2] === 'status' ? changedStatus ? { status, ready: status === 'todo' && current.blockedBy.length === 0, ...timing } : {} : Object.hasOwn(patch, 'allowAgents') ? { allowAgents: patch.allowAgents as boolean } : { requiredPlatform: patch.requiredPlatform as TaskDetail['requiredPlatform'] }), version: current.version + (match![2] === 'status' && !changedStatus ? 0n : 1n), updatedAt: match![2] === 'status' && !changedStatus ? current.updatedAt : new Date().toISOString() };
      tasks.set(updated.id, updated); refresh();
      return json(updated);
    }
    if (readFailures > 0) { readFailures--; return json({ error: { code: 'unavailable', message: 'Fixture detail refresh unavailable.', requestId: 'fixture-detail-refresh' } }, 503); }
    return json(current);
  };
  window.fetch = fetcher;
  return {
    failRefresh: () => { readFailures = 1; refresh(); },
    failNextMutation: () => { failWrite = true; },
    holdGraph: () => { holdGraph = true; },
    refreshGraph: () => { holdGraph = false; refresh(); },
    refresh, snapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, dispose: () => { if (window.fetch === fetcher) window.fetch = originalFetch; } };
};
