import { fixtureTaskEpoch } from "./taskSync";
import { readTaskPaused } from "../../src/api/task-properties";
import type { TaskDetail, TaskGraph } from '../../src/api/types';
import { stringifyWireJson } from './wireJson';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import type { GraphSnapshot } from '../../src/features/projects/useTaskGraph';
import { taskSyncQuery, taskSyncResponse, TEST_VIEWER_ID, viewerHeaders } from './taskSync';

const timestamp = '2026-10-22T10:00:00Z';
export const detailFixture = (projectId: string, taskId: string, changes: Partial<TaskDetail> = {}): TaskDetail => ({ assignedTo: null,
  id: taskId, type: 'task', parentId: null, projectId, title: '完整任务详情', description: '', status: 'todo', version: 1n,
  allowAgents: false, requiredPlatform: null, tags: [], dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true,
  startedAt: null, completedAt: null, cancelledAt: null, properties: { pullRequests: [] }, createdAt: timestamp, updatedAt: timestamp, ...changes,
});
export const graphFixture = (details: readonly TaskDetail[]): TaskGraph => {
  const projectId = details[0]!.projectId;
  const current = details.map((task) => {
    const blockedBy = task.dependsOn.filter((id) => details.find((item) => item.id === id)!.status !== 'done' && details.find((item) => item.id === id)!.status !== 'cancelled');
    return { ...task, blockedBy, ready: task.status === 'todo' && blockedBy.length === 0 };
  });
  return {
    observedAt: timestamp,
    project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: projectId, name: '任务项目', repoUrl: 'https://github.com/example/project', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: timestamp, updatedAt: timestamp },
    tasks: current.map((task) => ({ assignedTo: task.assignedTo, id: task.id, type: task.type, parentId: task.parentId, titlePreview: Array.from(task.title).slice(0, 160).join(''), titleTruncated: Array.from(task.title).length > 160, status: task.status,
      allowAgents: task.allowAgents, requiredPlatform: task.requiredPlatform, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn,
      blockedBy: task.blockedBy, ready: task.ready, startedAt: task.startedAt, completedAt: task.completedAt, cancelledAt: task.cancelledAt, createdAt: task.createdAt, updatedAt: task.updatedAt })),
    summary: { proposed: current.filter((task) => task.status === "proposed").length, total: details.length, todo: current.filter((task) => task.status === 'todo').length, inProgress: current.filter((task) => task.status === 'in_progress').length,
      done: current.filter((task) => task.status === 'done').length, cancelled: current.filter((task) => task.status === 'cancelled').length, ready: current.filter((task) => task.ready).length,
      blocked: current.filter((task) => task.status === 'todo' && !task.ready).length },
  };
};
export const snapshotFixture = (details: readonly TaskDetail[], revision = 1): GraphSnapshot => {
  const graph = graphFixture(details);
  const summaries = new Map(graph.tasks.map((task) => {
    const detail = details.find((item) => item.id === task.id)!;
    const { blockedBy: _blockedBy, ready: _ready, ...intrinsic } = task;
    return [task.id, { ...intrinsic, version: detail.version, properties: detail.properties, tags: detail.tags }] as const;
  }));
  return { graph, index: buildGraphIndex(graph), summaries, workerMachines: new Map(), pausedTaskIds: new Set(details.filter((task) => readTaskPaused(task.properties) === true).map((task) => task.id)), revision, observedAt: graph.observedAt, receivedMonotonic: performance.now(), receivedAt: Date.now() };
};
export const resourceResponse = (body: unknown, viewerId?: string): Response => {
  const headers = viewerId === undefined ? new Headers({ 'Content-Type': 'application/json' }) : viewerHeaders(viewerId, { 'Content-Type': 'application/json' });
  if (typeof body === 'object' && body !== null && 'projectId' in body && 'version' in body && typeof body.projectId === 'string') headers.set('Daynight-Task-Epoch', fixtureTaskEpoch(body.projectId));
  return new Response(stringifyWireJson(body), { headers });
};
export const withDetailResources = (projectId: string, taskId: string, fallback: (url: string, options?: RequestInit) => Response | Promise<Response>, changes: Partial<TaskDetail> = {}, viewer: string | (() => string) = TEST_VIEWER_ID) =>
  (url: string, options?: RequestInit): Response | Promise<Response> => {
    const task = detailFixture(projectId, taskId, changes);
    const parsed = new URL(url, location.origin);
    if (parsed.pathname === `/api/v1/projects/${projectId}/task-sync`) return taskSyncResponse(graphFixture([task]), { query: taskSyncQuery(parsed), versionForTask: () => task.version, propertiesForTask: () => task.properties, tagsForTask: () => task.tags, viewerId: typeof viewer === 'string' ? viewer : viewer() });
    if (url === `/api/v1/projects/${projectId}/tasks/${taskId}`) return resourceResponse(task, typeof viewer === 'string' ? viewer : viewer());
    if (parsed.pathname === `/api/v1/projects/${projectId}/tasks/${taskId}/sessions`) return resourceResponse({ items: [], nextCursor: null }, typeof viewer === 'string' ? viewer : viewer());
    return fallback(url, options);
  };
