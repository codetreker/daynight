import { canonicalId } from '../api/validation';
import { isAttachmentPath } from '../api/parse';
import type { TaskDetailNavigation } from './router';
import type { ProjectSection, TaskView } from '../features/projects/useProjectViewPreferences';

export type AccountTab = 'profile' | 'tokens' | 'prompt';
export type WorkerSection = 'overview' | 'configuration' | 'prompt';
export type ResourceReading = { readonly id: string; readonly navigation: TaskDetailNavigation };
export type GoalChildren = { readonly graphRootId: string | null; readonly task: ResourceReading | null };
export type ProjectReading = {
  readonly section: ProjectSection;
  readonly view: TaskView;
  readonly projectGraphWitness: string | null;
  readonly detail: (ResourceReading & { readonly source: 'summary' | 'direct'; readonly insideProjectGraph: boolean; readonly goalChildren: GoalChildren | null }) | null;
};
export type ResourcePageReading = {
  readonly goalChildren: GoalChildren | null;
  readonly externalGoal: (ResourceReading & { readonly witness: string; readonly goalChildren: GoalChildren | null }) | null;
};
export type MyTasksReading = {
  readonly projectPages: Readonly<Record<string, number>>;
  readonly detail: (ResourceReading & { readonly projectId: string; readonly goalChildren: GoalChildren | null }) | null;
};
type HistoryEnvelope<Key extends string, Selection> = {
  readonly version: 1;
  readonly userId: string;
  readonly pageKey: Key;
  readonly selection: Selection;
};
export type PageHistoryState = HistoryEnvelope<'account', { readonly tab: AccountTab }>
  | HistoryEnvelope<`worker:${string}`, { readonly workerId: string; readonly section: WorkerSection }>
  | HistoryEnvelope<`project:${string}`, ProjectReading>
  | HistoryEnvelope<'my-tasks', MyTasksReading>
  | HistoryEnvelope<`resource:${string}/${string}`, ResourcePageReading>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = (value: unknown): value is string => typeof value === 'string' && canonicalId(value) === value;
const validNavigation = (value: unknown): value is TaskDetailNavigation => record(value) && exact(value, ['tab', 'path']) &&
  (value.tab === 'description' || value.tab === 'overview' || value.tab === 'steps' || value.tab === 'attachments' || value.tab === 'discussion' || value.tab === 'session') &&
  (value.path === null || typeof value.path === 'string' && isAttachmentPath(value.path));
const validResource = (value: unknown): value is ResourceReading => record(value) && exact(value, ['id', 'navigation']) && validId(value.id) && validNavigation(value.navigation);
const validChildren = (value: unknown): value is GoalChildren => record(value) && exact(value, ['graphRootId', 'task']) &&
  (value.graphRootId === null || validId(value.graphRootId)) && (value.task === null || validResource(value.task));
const resourceKey = (projectId: string, taskId: string): `resource:${string}/${string}` => `resource:${projectId}/${taskId}`;

/** Empty selections contain no resource data, only the absence of nested readers. */
export const emptyResourceReading = (): ResourcePageReading => ({ goalChildren: null, externalGoal: null });

/** Returns null for a missing or differently scoped selection; rejects malformed state. */
export function readAccountHistory(value: unknown, userId: string): AccountTab | null {
  if (value === undefined) return null;
  if (!record(value) || !exact(value, ['version', 'userId', 'pageKey', 'selection']) || value.version !== 1 || typeof value.userId !== 'string' || canonicalId(value.userId) !== value.userId || typeof value.pageKey !== 'string') throw new Error('Invalid page navigation state.');
  if (value.userId !== userId || value.pageKey !== 'account') return null;
  const selection = value.selection;
  if (!record(selection) || !exact(selection, ['tab']) || (selection.tab !== 'profile' && selection.tab !== 'tokens' && selection.tab !== 'prompt')) throw new Error('Invalid account navigation state.');
  return selection.tab;
}

export const accountHistory = (userId: string, tab: AccountTab): PageHistoryState => ({ version: 1, userId, pageKey: 'account', selection: { tab } });

/** Read only the selection for the current identity and resource; malformed matching state is an error. */
export function readResourceHistory(value: unknown, userId: string, projectId: string, taskId: string): ResourcePageReading | null {
  if (value === undefined) return null;
  if (!record(value) || !exact(value, ['version', 'userId', 'pageKey', 'selection']) || value.version !== 1 || !validId(value.userId) || typeof value.pageKey !== 'string') throw new Error('Invalid page navigation state.');
  if (value.userId !== userId || value.pageKey !== resourceKey(projectId, taskId)) return null;
  const selection = value.selection;
  if (!record(selection) || !exact(selection, ['goalChildren', 'externalGoal']) ||
    !(selection.goalChildren === null || validChildren(selection.goalChildren))) throw new Error('Invalid resource navigation state.');
  const external = selection.externalGoal;
  if (external !== null && (!record(external) || !exact(external, ['id', 'navigation', 'witness', 'goalChildren']) ||
    !validId(external.id) || !validNavigation(external.navigation) || !validId(external.witness) ||
    !(external.goalChildren === null || validChildren(external.goalChildren)))) throw new Error('Invalid resource navigation state.');
  return selection as ResourcePageReading;
}

export const resourceHistory = (userId: string, projectId: string, taskId: string, selection: ResourcePageReading): PageHistoryState =>
  ({ version: 1, userId, pageKey: resourceKey(projectId, taskId), selection });

export const emptyMyTasksReading = (): MyTasksReading => ({ projectPages: {}, detail: null });

/** Read the account's overview position without accepting resource data or drafts. */
export function readMyTasksHistory(value: unknown, userId: string): MyTasksReading | null {
  if (value === undefined) return null;
  if (!record(value) || !exact(value, ['version', 'userId', 'pageKey', 'selection']) || value.version !== 1 || !validId(value.userId) || typeof value.pageKey !== 'string') throw new Error('Invalid page navigation state.');
  if (value.userId !== userId || value.pageKey !== 'my-tasks') return null;
  const selection = value.selection;
  if (!record(selection) || !exact(selection, ['projectPages', 'detail']) || !record(selection.projectPages) ||
      !Object.entries(selection.projectPages).every(([id, page]) => validId(id) && typeof page === 'number' && Number.isSafeInteger(page) && page >= 1)) throw new Error('Invalid my-tasks navigation state.');
  const detail = selection.detail;
  if (detail !== null && (!record(detail) || !exact(detail, ['projectId', 'id', 'navigation', 'goalChildren']) ||
      !validId(detail.projectId) || !validId(detail.id) || !validNavigation(detail.navigation) ||
      !(detail.goalChildren === null || validChildren(detail.goalChildren)))) throw new Error('Invalid my-tasks navigation state.');
  return selection as MyTasksReading;
}

export const myTasksHistory = (userId: string, selection: MyTasksReading): PageHistoryState =>
  ({ version: 1, userId, pageKey: 'my-tasks', selection });

/** Read the project selection only for its authenticated identity and project. */
export function readProjectHistory(value: unknown, userId: string, projectId: string): ProjectReading | null {
  if (value === undefined) return null;
  if (!record(value) || !exact(value, ['version', 'userId', 'pageKey', 'selection']) || value.version !== 1 || !validId(value.userId) || typeof value.pageKey !== 'string') throw new Error('Invalid page navigation state.');
  if (value.userId !== userId || value.pageKey !== `project:${projectId}`) return null;
  const selection = value.selection;
  if (!record(selection) || !exact(selection, ['section', 'view', 'projectGraphWitness', 'detail']) ||
      (selection.section !== 'overview' && selection.section !== 'tasks' && selection.section !== 'prs' && selection.section !== 'tags') ||
      (selection.view !== 'standalone' && selection.view !== 'chains' && selection.view !== 'goals') ||
      !(selection.projectGraphWitness === null || validId(selection.projectGraphWitness))) throw new Error('Invalid project navigation state.');
  const detail = selection.detail;
  if (detail !== null && (!record(detail) || !exact(detail, ['id', 'navigation', 'source', 'insideProjectGraph', 'goalChildren']) ||
      !validId(detail.id) || !validNavigation(detail.navigation) || (detail.source !== 'summary' && detail.source !== 'direct') ||
      typeof detail.insideProjectGraph !== 'boolean' || !(detail.goalChildren === null || validChildren(detail.goalChildren)))) throw new Error('Invalid project navigation state.');
  return selection as ProjectReading;
}

export const projectHistory = (userId: string, projectId: string, selection: ProjectReading): PageHistoryState =>
  ({ version: 1, userId, pageKey: `project:${projectId}`, selection });

export function readWorkerHistory(value: unknown, userId: string, workerId: string): WorkerSection | null {
  if (value === undefined) return null;
  if (!record(value) || !exact(value, ['version', 'userId', 'pageKey', 'selection']) || value.version !== 1 || typeof value.userId !== 'string' || canonicalId(value.userId) !== value.userId || typeof value.pageKey !== 'string') throw new Error('Invalid page navigation state.');
  if (value.userId !== userId || value.pageKey !== `worker:${workerId}`) return null;
  const selection = value.selection;
  if (!record(selection) || !exact(selection, ['workerId', 'section']) || selection.workerId !== workerId || (selection.section !== 'overview' && selection.section !== 'configuration' && selection.section !== 'prompt')) throw new Error('Invalid worker navigation state.');
  return selection.section;
}

export const workerHistory = (userId: string, workerId: string, section: WorkerSection): PageHistoryState => ({ version: 1, userId, pageKey: `worker:${workerId}`, selection: { workerId, section } });
