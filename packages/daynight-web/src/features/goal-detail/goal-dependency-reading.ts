import type { TaskCacheScope } from '../task-cache/project-cache';

export type GoalDependencyPosition = {
  readonly projectId: string; readonly goalId: string; readonly history: number;
  readonly cursor: string | null; readonly previous: readonly (string | null)[];
};
type ReturnReading = { readonly position: GoalDependencyPosition; readonly href: string | null; readonly departed: boolean };
// Only reading coordinates survive a route remount. Relation rows require a
// new authorized GET before either content or the originating link is restored.
const readings = new WeakMap<TaskCacheScope, Map<string, ReturnReading>>();
const sameResource = (left: GoalDependencyPosition, right: Pick<GoalDependencyPosition, 'projectId' | 'goalId' | 'history'>) =>
  left.projectId === right.projectId && left.goalId === right.goalId && left.history === right.history;

const entriesFor = (scope: TaskCacheScope) => {
  let entries = readings.get(scope);
  if (entries !== undefined) return entries;
  entries = new Map(); readings.set(scope, entries);
  const saved = entries;
  const unsubscribe = scope.subscribe(event => {
    if (!event.accessRevoked && !event.directAccessUncertain && !event.historyChanged) return;
    for (const [entryId, reading] of saved) if (reading.position.projectId === event.projectId) saved.delete(entryId);
  });
  const retire = () => { saved.clear(); unsubscribe(); scope.signal.removeEventListener('abort', retire); scope.mismatchSignal.removeEventListener('abort', retire); };
  scope.signal.addEventListener('abort', retire, { once: true }); scope.mismatchSignal.addEventListener('abort', retire, { once: true });
  return entries;
};

const readingKey = (entryId: string, resource: Pick<GoalDependencyPosition, 'projectId' | 'goalId'>) => `${entryId}/${resource.projectId}/${resource.goalId}`;

const admittedReading = (scope: TaskCacheScope, entryId: string | null,
  resource: Pick<GoalDependencyPosition, 'projectId' | 'goalId' | 'history'>): ReturnReading | null => {
  if (entryId === null || scope.signal.aborted || scope.hasIdentityMismatch || scope.isProjectSuspended(resource.projectId)) return null;
  const reading = readings.get(scope)?.get(readingKey(entryId, resource));
  return reading !== undefined && sameResource(reading.position, resource) ? reading : null;
};

export const goalDependencyPosition = (scope: TaskCacheScope, entryId: string | null,
  resource: Pick<GoalDependencyPosition, 'projectId' | 'goalId' | 'history'>): GoalDependencyPosition | undefined =>
  admittedReading(scope, entryId, resource)?.position;

export const saveGoalDependencyPosition = (scope: TaskCacheScope, entryId: string, position: GoalDependencyPosition): void => {
  if (scope.signal.aborted || scope.hasIdentityMismatch || scope.isProjectSuspended(position.projectId)) return;
  const current = admittedReading(scope, entryId, position);
  entriesFor(scope).set(readingKey(entryId, position), { position: { ...position, previous: [...position.previous] },
    href: current === null ? null : current.href, departed: current !== null && current.departed });
};

export const rememberGoalDependencyReading = (scope: TaskCacheScope, entryId: string, position: GoalDependencyPosition, href: string): void => {
  saveGoalDependencyPosition(scope, entryId, position);
  const current = admittedReading(scope, entryId, position);
  if (current === null) return;
  const entries = entriesFor(scope);
  for (const [key, reading] of entries) {
    if (key.startsWith(`${entryId}/`)) entries.set(key, { ...reading, href: null, departed: false });
  }
  entries.set(readingKey(entryId, position), { ...current, href, departed: false });
};
export const markGoalDependencyDeparture = (scope: TaskCacheScope, entryId: string, destination: string): void => {
  const entries = readings.get(scope);
  if (entries === undefined) return;
  for (const [key, reading] of entries) {
    if (!key.startsWith(`${entryId}/`)) continue;
    entries.set(key, { ...reading, href: reading.href === destination ? reading.href : null,
      departed: reading.href !== null && reading.href === destination });
  }
};
export const goalDependencyReturn = (scope: TaskCacheScope, entryId: string | null,
  resource: Pick<GoalDependencyPosition, 'projectId' | 'goalId' | 'history'>): ReturnReading | null => {
  const reading = admittedReading(scope, entryId, resource);
  return reading?.departed === true ? reading : null;
};
export const finishGoalDependencyReturn = (scope: TaskCacheScope, entryId: string, reading: ReturnReading): boolean => {
  if (goalDependencyReturn(scope, entryId, reading.position) !== reading) return false;
  // Consuming focus leaves the entry's reading position and destination available
  // for later native Forward/Back traversals, which do not run a link handler.
  readings.get(scope)!.set(readingKey(entryId, reading.position), { ...reading, departed: false }); return true;
};
