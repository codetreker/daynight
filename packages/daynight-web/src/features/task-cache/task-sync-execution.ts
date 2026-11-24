import { ApiError, getTaskSync, isAbortError } from '../../api/client';
import type { TaskSyncRead } from '../../api/types';
import { taskCacheFailureDiagnostic } from './diagnostics';
import { deriveTaskSyncBindings, deriveTaskSyncVersions, validateTaskSyncObservationBindings, type TaskExecutionBinding } from './execution-binding';
import { TaskCacheLifecycleChanged } from './lifecycle';
import type { CachedProject, TaskCacheScope, TaskSyncTicket } from './project-cache';

type AppliedSync = {
  readonly history: 'current';
  readonly project: CachedProject;
  readonly changed: boolean;
  readonly changedTaskIds: readonly string[];
  readonly observedBindings: ReadonlyMap<string, TaskExecutionBinding>;
  readonly observedVersions: ReadonlyMap<string, bigint>;
} & TaskSyncRead;
export type TaskSyncExecution = AppliedSync | { readonly history: 'retired' } | { readonly history: 'confirm' };

export const taskSyncQuery = (ticket: TaskSyncTicket): { readonly epoch?: string; readonly since?: string } =>
  ticket.epoch === null ? {} : ticket.coverageUpdatedAt === null || ticket.parentTaskFullSync
    ? { epoch: ticket.epoch } : { epoch: ticket.epoch, since: ticket.coverageUpdatedAt };

export const executeTaskSync = async ({ scope, projectId, signal: callerSignal, ticket: preparedTicket, trigger = 'refresh', observingHistory }: {
  readonly scope: TaskCacheScope;
  readonly projectId: string;
  readonly signal: AbortSignal;
  readonly ticket?: TaskSyncTicket;
  readonly trigger?: 'refresh' | 'automatic' | 'deletion-recheck' | 'manual-rebuild';
  readonly observingHistory?: (observing: boolean) => void;
}): Promise<TaskSyncExecution> => {
  const cycleId = crypto.randomUUID();
  const started = performance.now();
  const signal = AbortSignal.any([callerSignal, scope.signal]);
  try {
    const ticket = preparedTicket ?? await scope.beginSync(projectId, signal);
    if (ticket.userId !== scope.userId || ticket.projectId !== projectId) throw new ApiError('protocol');
    const rebuild = trigger === 'manual-rebuild';
    const read = await getTaskSync(projectId, rebuild ? {} : taskSyncQuery(ticket), scope.userId, signal, scope.principalMismatch);
    signal.throwIfAborted();
    if (rebuild && read.sync.mode !== 'snapshot') throw new ApiError('protocol');
    observingHistory?.(true);
    let history: 'current' | 'retired' | 'confirm';
    try { history = rebuild ? 'current' : await scope.observeHistory(ticket, read.sync.epoch, signal); }
    finally { observingHistory?.(false); }
    if (history === 'retired') return { history };
    if (history === 'confirm') return { history };
    const observedBindings = deriveTaskSyncBindings(ticket, read.sync);
    const observedVersions = deriveTaskSyncVersions(ticket, read.sync);
    validateTaskSyncObservationBindings(read.sync, observedBindings, observedVersions);
    const completeParentObservation = read.sync.mode === 'snapshot' || ticket.parentTaskFullSync || ticket.coverageUpdatedAt === null;
    const result = await scope.applySync(ticket, read.sync, signal, completeParentObservation, rebuild ? { rebuild: true, atomicHistory: true } : undefined);
    if (!await scope.isSyncCommitCurrent(result.project.manifest, signal)) throw new TaskCacheLifecycleChanged();
    signal.throwIfAborted();
    console.debug('Task sync', { cycle_id: cycleId, project_id: projectId, trigger, received: read.sync.tasks.length,
      removed: read.sync.deletedTaskIds.length, changed: result.changedTaskIds.length, cache_hit: ticket.epoch !== null,
      elapsed_ms: performance.now() - started, outcome: 'committed' });
    return { history, ...read, ...result, observedBindings, observedVersions };
  } catch (error) {
    console.warn('Task sync failed', { cycle_id: cycleId, project_id: projectId, trigger,
      ...taskCacheFailureDiagnostic(error), outcome: error instanceof TaskCacheLifecycleChanged ? 'stale' : isAbortError(error) ? 'cancelled' : 'failed',
      elapsed_ms: performance.now() - started });
    throw error;
  }
};
