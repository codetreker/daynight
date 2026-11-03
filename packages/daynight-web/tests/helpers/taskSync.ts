import type { GraphTask, TaskGraph, TaskProperties, TaskSummary, TaskSync } from '../../src/api/types';
import { stringifyWireJson, wireResponse } from './wireJson';

export const TEST_VIEWER_ID = '00000000-0000-4000-8000-000000000201';
export const TEST_TASK_CACHE_EPOCH = '00000000-0000-4000-8000-000000000900';

export const viewerHeaders = (viewerId: string, initial?: HeadersInit): Headers => {
  const headers = new Headers(initial);
  headers.set('Daynight-User-ID', viewerId);
  return headers;
};

export const taskSyncEpoch = (projectId: string): string => {
  let hash = 2_166_136_261;
  for (const codePoint of projectId) hash = Math.imul(hash ^ codePoint.charCodeAt(0), 16_777_619);
  return `00000000-0000-4000-8000-${(hash >>> 0).toString(16).padStart(12, '0')}`;
};

export type TaskSyncFixtureOptions = {
  readonly query?: { readonly epoch?: string; readonly since?: string };
  readonly epoch?: string;
  readonly versionForTask: (task: GraphTask) => bigint;
  readonly propertiesForTask?: (task: GraphTask) => TaskProperties;
};
type WireTaskSync = Omit<TaskSync, 'tasks'> & {
  readonly tasks: readonly (Omit<TaskSummary, 'version'> & { readonly version: string })[];
};

const nanoseconds = (timestamp: string): bigint => {
  const match = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  if (match === null) throw new TypeError(`Invalid fixture timestamp: ${timestamp}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
};

export const taskSyncFixture = (graph: TaskGraph, { query = {}, epoch = taskSyncEpoch(graph.project.id), versionForTask, propertiesForTask = () => ({}) }: TaskSyncFixtureOptions): WireTaskSync => {
  const mode = query.epoch === epoch ? 'delta' : 'snapshot';
  const lowerBound = mode === 'delta' && query.since !== undefined ? nanoseconds(query.since) - 10_000_000_000n : null;
  const tasks = graph.tasks.filter((task) => lowerBound === null || nanoseconds(task.updatedAt) >= lowerBound).map((task) => ({
    id: task.id, version: versionForTask(task).toString(), properties: propertiesForTask(task), titlePreview: task.titlePreview, titleTruncated: task.titleTruncated,
    status: task.status, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn,
    allowAgents: task.allowAgents, requiredPlatform: task.requiredPlatform, startedAt: task.startedAt, completedAt: task.completedAt,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  }));
  return { mode, epoch, project: graph.project, observedAt: graph.observedAt, tasks };
};

export const taskSyncResponse = (graph: TaskGraph, { viewerId, ...options }: TaskSyncFixtureOptions & { readonly viewerId: string }, init: ResponseInit = {}): Response =>
  wireResponse(taskSyncFixture(graph, options), { ...init, headers: viewerHeaders(viewerId, init.headers) });

export const taskSyncQuery = (url: URL): NonNullable<TaskSyncFixtureOptions['query']> => ({
  ...(url.searchParams.has('epoch') ? { epoch: url.searchParams.get('epoch')! } : {}),
  ...(url.searchParams.has('since') ? { since: url.searchParams.get('since')! } : {}),
});

export const taskSyncFromGraph = (graph: TaskGraph, options: TaskSyncFixtureOptions): TaskSync => {
  const sync = taskSyncFixture(graph, options);
  return { ...sync, tasks: sync.tasks.map((task) => ({ ...task, version: BigInt(task.version) })) };
};

export const createGraphSyncFixture = ({ propertiesForTask = () => ({}) }: { readonly propertiesForTask?: (task: GraphTask, projectId: string) => TaskProperties } = {}) => {
  const projects = new Map<string, Map<string, { version: bigint; signature: string }>>();
  const epochs = new Map<string, string>();
  let generation = 0;
  return {
    reset: () => { projects.clear(); epochs.clear(); generation++; },
    toSync: (graph: TaskGraph, query: NonNullable<TaskSyncFixtureOptions['query']> = {}, epochOverride?: string): TaskSync => {
      let versions = projects.get(graph.project.id);
      if (versions === undefined) { versions = new Map(); projects.set(graph.project.id, versions); }
      const properties = (task: GraphTask) => propertiesForTask(task, graph.project.id);
      const fixture = taskSyncFixture(graph, { versionForTask: () => 1n, propertiesForTask: properties });
      const current = new Map<string, bigint>();
      for (const { version: _version, ...task } of fixture.tasks) {
        const signature = stringifyWireJson(task);
        const previous = versions.get(task.id);
        const version = previous === undefined ? 1n : previous.signature === signature ? previous.version : previous.version + 1n;
        versions.set(task.id, { version, signature });
        current.set(task.id, version);
      }
      const epoch = epochOverride ?? epochs.get(graph.project.id) ?? taskSyncEpoch(generation === 0 ? graph.project.id : `${graph.project.id}:${generation}`);
      epochs.set(graph.project.id, epoch);
      return taskSyncFromGraph(graph, { query, epoch, versionForTask: (task) => current.get(task.id)!, propertiesForTask: properties });
    },
  };
};
