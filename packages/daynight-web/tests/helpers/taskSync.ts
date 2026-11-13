import type { ProjectPersonVersion, ProjectAccess } from "../../src/api/auth-types";
import type { GraphTask, TaskGraph, TaskProperties, TaskSummary, TaskSync, TaskSyncRead, TaskTag } from '../../src/api/types';
import { stringifyWireJson, wireResponse } from './wireJson';

export const TEST_VIEWER_ID = '00000000-0000-4000-8000-000000000201';
export const TEST_PROFILE_VERSION = 'a'.repeat(64);
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

const observedEpochs = new Map<string, string>();
let worldEpoch: string | null = null;
export const beginFixtureWorld = (epoch: string): void => { observedEpochs.clear(); worldEpoch = epoch; };
export const rememberTaskEpoch = (projectId: string, epoch: string): void => { observedEpochs.set(projectId, epoch); };
export const fixtureTaskEpoch = (projectId: string): string => observedEpochs.get(projectId) ?? worldEpoch ?? taskSyncEpoch(projectId);

export type TaskSyncFixtureOptions = {
  readonly sessions?: TaskSync['sessions'];
  readonly actorAccess?: ProjectAccess;
  readonly assigneeVersions?: readonly ProjectPersonVersion[];
  readonly query?: { readonly epoch?: string; readonly since?: string };
  readonly epoch?: string;
  readonly versionForTask: (task: GraphTask) => bigint;
  readonly propertiesForTask?: (task: GraphTask) => TaskProperties;
  readonly tagsForTask?: (task: GraphTask) => readonly TaskTag[];
};
type WireTaskSync = Omit<TaskSync, 'tasks' | 'dependencyStates'> & {
  readonly tasks: readonly (Omit<TaskSummary, 'version'> & { readonly version: string })[];
  readonly dependencyStates: Readonly<Record<string, { readonly taskVersion: string; readonly blockedBy: readonly string[]; readonly ready: boolean }>>;
};

const nanoseconds = (timestamp: string): bigint => {
  const match = /^(.*?)(?:\.(\d{1,9}))?Z$/.exec(timestamp);
  if (match === null) throw new TypeError(`Invalid fixture timestamp: ${timestamp}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
};

export const directAccessFixture = (projectId: string, userId = TEST_VIEWER_ID, role: "member" | "admin" = "member"): ProjectAccess => ({
  projectId, ownerTeam: { id: "00000000-0000-4000-8000-000000000701", kind: "personal", name: null }, ownership: { teamId: "00000000-0000-4000-8000-000000000701", version: 1n }, teamRole: null, canTransfer: false,
  effectiveRole: role, directGrant: { projectId, userId, role, version: 1n, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z" },
});

const graphAssigneeVersions = (graph: TaskGraph): readonly ProjectPersonVersion[] => [...new Set(graph.tasks.flatMap((task) => task.assignedTo === null ? [] : [task.assignedTo]))]
  .sort().map((userId) => ({ userId, version: TEST_PROFILE_VERSION, hasProjectAccess: true }));

export const summariesForGraph = (graph: TaskGraph): ReadonlyMap<string, TaskSummary> => new Map(graph.tasks.map((task) => {
  const { blockedBy: _blockedBy, ready: _ready, ...intrinsic } = task;
  return [task.id, { ...intrinsic, version: 1n, properties: {}, tags: [] }];
}));

export const statesForSummaries = (tasks: readonly TaskSummary[]) => new Map(tasks.map((task) => {
  const blockedBy = task.dependsOn.filter((id) => !['done', 'cancelled'].includes(tasks.find((item) => item.id === id)?.status ?? ''));
  return [task.id, { taskVersion: task.version, blockedBy, ready: task.status === 'todo' && blockedBy.length === 0 }] as const;
}));

export const taskSyncFixture = (graph: TaskGraph, { sessions = {}, assigneeVersions = graphAssigneeVersions(graph), actorAccess = directAccessFixture(graph.project.id), query = {}, epoch = taskSyncEpoch(graph.project.id), versionForTask, propertiesForTask = () => ({}), tagsForTask = () => [] }: TaskSyncFixtureOptions): WireTaskSync => {
  rememberTaskEpoch(graph.project.id, epoch);
  const mode = query.epoch === epoch ? 'delta' : 'snapshot';
  const lowerBound = mode === 'delta' && query.since !== undefined ? nanoseconds(query.since) - 10_000_000_000n : null;
  const tasks = graph.tasks.filter((task) => lowerBound === null || nanoseconds(task.updatedAt) >= lowerBound).map((task) => ({ assignedTo: task.assignedTo,
    id: task.id, type: task.type, parentId: task.parentId, version: versionForTask(task).toString(), properties: propertiesForTask(task), tags: tagsForTask(task), titlePreview: task.titlePreview, titleTruncated: task.titleTruncated,
    status: task.status, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn,
    allowAgents: task.allowAgents, requiredPlatform: task.requiredPlatform, startedAt: task.startedAt, completedAt: task.completedAt, cancelledAt: task.cancelledAt,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  }));
  const selectedIds = new Set(tasks.map((task) => task.id));
  const dependencyStates = Object.fromEntries(graph.tasks.filter((task) => task.type === 'task' && (selectedIds.has(task.id) || task.dependsOn.some((id) => selectedIds.has(id)))).map((task) => [task.id,
    { taskVersion: versionForTask(task).toString(), blockedBy: task.blockedBy, ready: task.ready }]));
  return { assigneeVersions, actorAccess, mode, epoch, project: graph.project, observedAt: graph.observedAt, tasks, dependencyStates, sessions };
};

export const taskSyncResponse = (graph: TaskGraph, { viewerId, ...options }: TaskSyncFixtureOptions & { readonly viewerId: string }, init: ResponseInit = {}): Response =>
  wireResponse(taskSyncFixture(graph, { ...options, actorAccess: options.actorAccess ?? directAccessFixture(graph.project.id, viewerId) }), { ...init, headers: viewerHeaders(viewerId, init.headers) });

export const taskSyncQuery = (url: URL): NonNullable<TaskSyncFixtureOptions['query']> => ({
  ...(url.searchParams.has('epoch') ? { epoch: url.searchParams.get('epoch')! } : {}),
  ...(url.searchParams.has('since') ? { since: url.searchParams.get('since')! } : {}),
});

export const taskSyncFromGraph = (graph: TaskGraph, options: TaskSyncFixtureOptions): TaskSync => {
  const sync = taskSyncFixture(graph, options);
  return { ...sync, tasks: sync.tasks.map((task) => ({ ...task, version: BigInt(task.version) })),
    dependencyStates: Object.fromEntries(Object.entries(sync.dependencyStates).map(([id, state]) => [id, { ...state, taskVersion: BigInt(state.taskVersion) }])) };
};

export const taskSyncReadFixture = (sync: TaskSync, receivedMonotonic = performance.now()): TaskSyncRead => ({ sync, receivedMonotonic });

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
