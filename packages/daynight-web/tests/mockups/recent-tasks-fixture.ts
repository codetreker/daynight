import type { GraphTask, TaskDetail, TaskGraph, TaskStatus } from '../../src/api/types';
import { taskSyncQuery, taskSyncResponse, TEST_VIEWER_ID, viewerHeaders } from '../helpers/taskSync';
import { wireResponse } from '../helpers/wireJson';

export const recentScenarios = {
  mixed: 'Mixed work · three pages',
  completed: 'Recently completed · 100%',
  empty: 'Empty project',
  loading: 'Loading · release response',
  failure: 'Load failure · recover and retry',
} as const;
export type RecentScenario = keyof typeof recentScenarios;
export const readRecentScenario = (): RecentScenario => {
  const key = location.hash.slice(1);
  return Object.hasOwn(recentScenarios, key) ? key as RecentScenario : 'mixed';
};

const id = (number: number): string => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const observedAt = new Date().toISOString();
const localDay = (offset: number, hour = 12): string => {
  const date = new Date(observedAt);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, hour).toISOString();
};
const timestamp = (number: number): string => new Date(Date.parse(localDay(-30)) + number * 1_000).toISOString();
type Seed = { readonly number: number; readonly title: string; readonly status: TaskStatus;
  readonly dependsOn?: readonly number[]; readonly completedAt?: string | null };
const task = ({ number, title, status, dependsOn = [], completedAt = null }: Seed): GraphTask => ({
  id: id(number), titlePreview: title, titleTruncated: false, status,
  dependsOn: dependsOn.map(id), externalDependsOn: [], blockedBy: [], ready: false,
  workerNeedsAttention: false, allowAgents: false, requiredPlatform: null, startedAt: null, completedAt,
  createdAt: timestamp(number), updatedAt: observedAt,
});

const mixedTasks = (): GraphTask[] => {
  const tasks: GraphTask[] = [];
  for (let goal = 1; goal <= 41; goal++) {
    const root = goal * 100;
    tasks.push(task({ number: root, title: `Goal ${String(goal).padStart(2, '0')} · ${goal === 41 ? '33 complete child rows' : 'Deliver the agreed outcome'}`,
      status: 'done', completedAt: localDay(-14) }));
    for (let child = 1; child <= (goal === 41 ? 33 : 1); child++) {
      tasks.push(task({ number: root + child, title: `Goal ${String(goal).padStart(2, '0')} · Task ${String(child).padStart(2, '0')}`,
        status: child % 3 === 0 ? 'done' : child % 3 === 1 ? 'in_progress' : 'todo', dependsOn: [root],
        completedAt: child % 3 === 0 ? localDay(-14) : null }));
    }
  }
  tasks.push(task({ number: 4200, title: 'Recent Goal · old root, latest child finished today', status: 'done', completedAt: localDay(-14) }),
    task({ number: 4201, title: 'Final acceptance · completed today', status: 'done', dependsOn: [4200], completedAt: observedAt }),
    task({ number: 4300, title: 'Older Goal · visible with Show all', status: 'done', completedAt: localDay(-10) }),
    task({ number: 4301, title: 'Older acceptance', status: 'done', dependsOn: [4300], completedAt: localDay(-9) }),
    task({ number: 4400, title: 'Unknown completion Goal · visible with Show all', status: 'done' }),
    task({ number: 4401, title: 'Historical acceptance', status: 'done', dependsOn: [4400] }));
  for (let number = 1; number <= 41; number++) {
    tasks.push(task({ number: 5000 + number, title: `Independent ${String(number).padStart(2, '0')} · ${number === 41 ? 'A long title that remains readable on a narrow screen without moving pagination outside the viewport' : 'Unfinished work'}`,
      status: number % 4 === 0 ? 'in_progress' : 'todo' }));
  }
  tasks.push(task({ number: 5100, title: 'Completed today · included', status: 'done', completedAt: observedAt }),
    task({ number: 5101, title: 'First included local day · midnight boundary', status: 'done', completedAt: localDay(-6, 0) }),
    task({ number: 5102, title: 'Previous local day · visible with Show all', status: 'done', completedAt: localDay(-7) }),
    task({ number: 5103, title: 'Unknown completion · visible with Show all', status: 'done' }));
  return tasks;
};

const completedTasks = (): GraphTask[] => [
  task({ number: 100, title: 'Completed Goal · 100%', status: 'done', completedAt: localDay(-14) }),
  task({ number: 101, title: 'Acceptance completed today', status: 'done', dependsOn: [100], completedAt: observedAt }),
  task({ number: 200, title: 'Independent completed today', status: 'done', completedAt: observedAt }),
  task({ number: 201, title: 'Independent completed on the first included local day', status: 'done', completedAt: localDay(-6, 0) }),
];

export const createRecentFixture = () => {
  const projectIds = new Map((Object.keys(recentScenarios) as RecentScenario[]).map((scenario) => [scenario, crypto.randomUUID()]));
  const graphs = new Map<string, TaskGraph>();
  for (const [scenario, projectId] of projectIds) {
    const seeds = scenario === 'empty' ? [] : scenario === 'completed' ? completedTasks() : mixedTasks();
    const tasks = seeds.map((item) => {
      const blockedBy = item.dependsOn.filter((dependency) => seeds.find((candidate) => candidate.id === dependency)!.status !== 'done');
      return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
    });
    graphs.set(projectId, { observedAt,
      project: { id: projectId, name: 'Recent work and completed outcomes', repoUrl: 'https://example.com/team/project',
        settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: localDay(-30), updatedAt: observedAt },
      tasks, summary: { total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length,
        inProgress: tasks.filter((item) => item.status === 'in_progress').length, done: tasks.filter((item) => item.status === 'done').length,
        ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length } });
  }
  let loading = true;
  let failure = true;
  const pending = new Set<() => void>();
  const originalFetch = window.fetch;
  const fixtureFetch: typeof window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), location.href), init);
    request.signal.throwIfAborted();
    if (request.method !== 'GET') return wireResponse({ error: { code: 'method_not_allowed', message: 'This preview is read only.', requestId: 'recent-preview-write' } }, { status: 405 });
    const url = new URL(request.url);
    const match = /^\/api\/v1\/projects\/([^/]+)\/(task-sync|tasks\/([^/]+)(\/attachments)?)$/.exec(url.pathname);
    if (match === null) throw new Error(`Unknown recent-task preview request: ${url.pathname}`);
    const graph = graphs.get(match[1]!);
    if (graph === undefined) throw new Error('The preview project does not exist.');
    if (match[2] === 'task-sync') {
      if (match[1] === projectIds.get('failure') && failure) return wireResponse({ error: { code: 'internal_error', message: 'The preview request failed.', requestId: 'recent-preview-failure' } }, { status: 503 });
      if (match[1] === projectIds.get('loading') && loading) await new Promise<void>((resolve, reject) => {
        const abort = () => { pending.delete(release); reject(request.signal.reason); };
        const release = () => { request.signal.removeEventListener('abort', abort); pending.delete(release); resolve(); };
        pending.add(release);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
      return taskSyncResponse(graph, { viewerId: TEST_VIEWER_ID, query: taskSyncQuery(url), versionForTask: () => 1n });
    }
    if (match[4] === '/attachments') return wireResponse({ items: [], nextCursor: null }, { headers: viewerHeaders(TEST_VIEWER_ID) });
    const value = graph.tasks.find((item) => item.id === match[3]);
    if (value === undefined) throw new Error('The preview task does not exist.');
    const detail: TaskDetail = { ...value, projectId: graph.project.id, title: value.titlePreview, version: 1n,
      properties: { pullRequests: [], worker: null }, description: '## Outcome\n\nRead the complete task and its relationships. Recent visibility and pagination do not change Goal membership.' };
    return wireResponse(detail, { headers: viewerHeaders(TEST_VIEWER_ID) });
  };
  window.fetch = fixtureFetch;
  return {
    projectId: (scenario: RecentScenario) => projectIds.get(scenario)!,
    recover: (scenario: RecentScenario) => {
      if (scenario === 'failure') failure = false;
      if (scenario === 'loading') { loading = false; for (const release of [...pending]) release(); }
    },
    dispose: () => { if (window.fetch === fixtureFetch) window.fetch = originalFetch; for (const release of [...pending]) release(); },
  };
};
export type RecentFixture = ReturnType<typeof createRecentFixture>;
