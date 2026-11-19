import type { TaskCacheScope } from '../task-cache/project-cache';

export type GoalDependencyPosition = {
  readonly projectId: string; readonly goalId: string; readonly history: number;
  readonly cursor: string | null; readonly previous: readonly (string | null)[];
};
type ReturnReading = { readonly position: GoalDependencyPosition; readonly href: string; departed: boolean };
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

export const rememberGoalDependencyReading = (scope: TaskCacheScope, entryId: string, position: GoalDependencyPosition, href: string): void => {
  if (scope.signal.aborted || scope.hasIdentityMismatch || scope.isProjectSuspended(position.projectId)) return;
  entriesFor(scope).set(entryId, { position: { ...position, previous: [...position.previous] }, href, departed: false });
};
export const markGoalDependencyDeparture = (scope: TaskCacheScope, entryId: string, destination: string): void => {
  const entries = readings.get(scope), reading = entries?.get(entryId);
  if (reading === undefined || reading.departed) return;
  if (reading.href === destination) reading.departed = true;
  else entries!.delete(entryId);
};
export const goalDependencyReturn = (scope: TaskCacheScope, entryId: string | null,
  resource: Pick<GoalDependencyPosition, 'projectId' | 'goalId' | 'history'>): ReturnReading | null => {
  if (entryId === null || scope.signal.aborted || scope.hasIdentityMismatch || scope.isProjectSuspended(resource.projectId)) return null;
  const reading = readings.get(scope)?.get(entryId);
  return reading?.departed === true && sameResource(reading.position, resource) ? reading : null;
};
export const finishGoalDependencyReturn = (scope: TaskCacheScope, entryId: string, reading: ReturnReading): boolean => {
  const entries = readings.get(scope);
  if (goalDependencyReturn(scope, entryId, reading.position) !== reading) return false;
  entries!.delete(entryId); return true;
};
