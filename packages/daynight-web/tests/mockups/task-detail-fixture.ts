import type { TaskDetail, TaskGraph, WorkerClaim } from '../../src/api/types';
import { readWorkerClaim } from '../../src/api/task-properties';
import { stringifyApiJson } from '../../src/api/json';
import type { GraphSnapshot } from '../../src/features/projects/useTaskGraph';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import { admitTaskGraph } from '../helpers/taskSessions';
import { createTaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import { TEST_VIEWER_ID, viewerHeaders } from '../helpers/taskSync';
import flowcharts from './files/docs/flowcharts.md?raw';

export const detailProjectId = '00000000-0000-4000-8000-000000000100';
export const detailTaskId = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-10-24T10:00:00Z';
const task = (id: string, title: string, status: TaskDetail['status']): TaskDetail => ({
  id, projectId: detailProjectId, title, description: '# 任务交付\n\n使用同一套完整任务详情查看资料与操作。\n\n- [方案与验收](docs/guide.md)\n- [交互原型](site/index.html)\n- [长文档](docs/tall.md)',
  status, version: 1n, allowAgents: false, requiredPlatform: null, dependsOn: [], externalDependsOn: [], blockedBy: [],
  ready: status === 'todo', startedAt: null, completedAt: status === 'done' ? timestamp : null,
  properties: { pullRequests: [{ title: 'Share complete task details between dialog and page', url: 'https://github.com/example/project/pull/42' }] },
  createdAt: timestamp, updatedAt: timestamp,
});

export type ClaimScenario = 'owner' | 'other' | 'admin' | 'released' | 'former' | 'completed';
export const createTaskDetailFixture = (options: { readonly initialStatus?: TaskDetail['status']; readonly claim?: ClaimScenario; readonly longClaim?: boolean } = {}) => {
  const priorId = '00000000-0000-4000-8000-000000000002';
  const nextId = '00000000-0000-4000-8000-000000000003';
  const otherOwnerId = '00000000-0000-4000-8000-000000000910';
  const claimOwner = options.claim === 'other' || options.claim === 'admin' || options.claim === 'former' ? otherOwnerId : TEST_VIEWER_ID;
  const viewerRole = options.claim === 'admin' ? 'admin' : 'member';
  const worker: WorkerClaim | null = options.claim === undefined ? null : {
    claimId: '00000000-0000-4000-8000-000000000901', state: options.claim === 'released' ? 'released' : options.claim === 'completed' ? 'completed' : 'active',
    userId: claimOwner, workerId: '00000000-0000-4000-8000-000000000902', machine: { id: '00000000-0000-4000-8000-000000000903', name: options.longClaim ? 'Machine-'.repeat(24) + 'complete' : 'macmini.local' },
    platform: 'macos', agent: 'codex', agentControlMode: 'herdr', worktreeId: '00000000-0000-4000-8000-000000000904', phase: 'paused', herdr: null, nativeSessionId: null, claimedAt: timestamp,
  };
  const member = (userId: string, name: string, role: string) => ({ projectId: detailProjectId, userId, name: options.longClaim ? 'Claim owner '.repeat(16) + 'complete' : name, email: `${options.longClaim ? 'account'.repeat(24) : userId === TEST_VIEWER_ID ? 'jianjun' : 'teammate'}@example.com`, avatarUrl: null, role, version: 1, createdAt: timestamp, updatedAt: timestamp });
  const members = [member(TEST_VIEWER_ID, 'Jianjun', viewerRole), ...(claimOwner === otherOwnerId && options.claim !== 'former' ? [member(otherOwnerId, 'Alex Chen', 'member')] : [])];
  const firstBase = task(detailTaskId, 'Markdown 流程图与完整任务详情', options.claim === undefined ? options.initialStatus ?? 'todo' : worker!.state === 'active' ? 'in_progress' : worker!.state === 'completed' ? 'done' : 'todo');
  const first: TaskDetail = { ...firstBase, properties: { ...firstBase.properties, ...(worker === null ? {} : { worker }) }, allowAgents: options.claim !== undefined, startedAt: worker?.state === 'active' ? timestamp : null,
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
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: () => { throw new Error('The detail fixture returned another principal.'); } });
  const epoch = crypto.randomUUID();
  let snapshot = build();
  const admit = async (next: GraphSnapshot) => {
    const current = await admitTaskGraph(scope, next.graph, { epoch, versionForTask: (task) => tasks.get(task.id)!.version });
    return { ...next, graph: current.graph, index: current.index };
  };
  const ready = admit(snapshot).then((current) => { snapshot = current; });
  let syncing = ready;
  const refresh = (): Promise<void> => {
    syncing = syncing.then(async () => {
      if (!holdGraph) snapshot = await admit(build());
      listeners.forEach((listener) => listener());
    });
    return syncing;
  };
  const originalFetch = window.fetch;
  const json = (value: unknown, status = 200) => new Response(stringifyApiJson(value), { status, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
  const fetcher: typeof window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/v1/')) return originalFetch(input, options);
    await ready;
    if (url.pathname === `/api/v1/projects/${detailProjectId}/members`) return json({ items: members });
    const match = /^\/api\/v1\/projects\/[^/]+\/tasks\/([^/]+)(?:\/(status|worker-claim\/withdraw))?$/.exec(url.pathname);
    const current = match === null ? undefined : tasks.get(match[1]!);
    if (current === undefined) return json({ error: { code: 'not_found', message: 'Fixture task unavailable.', requestId: 'fixture-task' } }, 404);
    if (options?.method === 'PUT' || options?.method === 'PATCH' || options?.method === 'POST') {
      if (failWrite) { failWrite = false; readFailures = 1; throw new TypeError('Fixture connection interrupted before a write response.'); }
      const patch = JSON.parse(String(options.body));
      if (BigInt(patch.version) !== current.version) return json({ error: { code: 'version_conflict', message: 'Fixture version changed.', requestId: 'fixture-version' } }, 409);
      if (match![2] === 'worker-claim/withdraw') {
        const worker = readWorkerClaim(current.properties);
        if (worker === undefined || worker.state === 'completed' || patch.claimId !== worker.claimId) return json({ error: { code: 'claim_conflict', message: 'Fixture claim changed.', requestId: 'fixture-claim' } }, 409);
        if (worker.userId !== TEST_VIEWER_ID && viewerRole !== 'admin') return json({ error: { code: 'forbidden', message: 'Fixture withdrawal refused.', requestId: 'fixture-permission' } }, 403);
        const { worker: _worker, ...properties } = current.properties;
        const updated: TaskDetail = { ...current, status: 'todo', allowAgents: false, startedAt: null, completedAt: null, properties, version: current.version + 1n, updatedAt: new Date().toISOString() };
        tasks.set(current.id, updated); await refresh();
        return json(tasks.get(current.id)!);
      }
      const status = patch.status as TaskDetail['status'];
      const changedStatus = match![2] === 'status' && status !== current.status;
      if (changedStatus && (status !== 'todo' && current.dependsOn.some((id) => tasks.get(id)!.status !== 'done') || current.status === 'done' && [...tasks.values()].some((item) => item.dependsOn.includes(current.id) && item.status !== 'todo'))) return json({ error: { code: 'dependency_unsatisfied', message: 'Fixture dependencies prevent this status.', requestId: 'fixture-dependencies' } }, 409);
      const timing = status === 'todo' ? { startedAt: null, completedAt: null } : status === 'in_progress' ? { startedAt: new Date().toISOString(), completedAt: null } : { startedAt: current.status === 'in_progress' ? current.startedAt : null, completedAt: new Date().toISOString() };
      const updated = { ...current, ...(match![2] === 'status' ? changedStatus ? { status, ready: status === 'todo' && current.blockedBy.length === 0, ...timing } : {} : Object.hasOwn(patch, 'allowAgents') ? { allowAgents: patch.allowAgents as boolean } : { requiredPlatform: patch.requiredPlatform as TaskDetail['requiredPlatform'] }), version: current.version + (match![2] === 'status' && !changedStatus ? 0n : 1n), updatedAt: match![2] === 'status' && !changedStatus ? current.updatedAt : new Date().toISOString() };
      tasks.set(updated.id, updated); await refresh();
      return json(tasks.get(updated.id)!);
    }
    if (readFailures > 0) { readFailures--; return json({ error: { code: 'unavailable', message: 'Fixture detail refresh unavailable.', requestId: 'fixture-detail-refresh' } }, 503); }
    return json(current);
  };
  window.fetch = fetcher;
  return {
    scope, ready,
    failRefresh: () => {
      readFailures = 1;
      const current = tasks.get(detailTaskId)!;
      tasks.set(current.id, { ...current, version: current.version + 1n, description: `${current.description}\n`, updatedAt: new Date().toISOString() });
      void refresh();
    },
    failNextMutation: () => { failWrite = true; },
    holdGraph: () => { holdGraph = true; },
    refreshGraph: () => { holdGraph = false; refresh(); },
    refresh, snapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, dispose: () => { scope.dispose(); if (window.fetch === fetcher) window.fetch = originalFetch; } };
};
