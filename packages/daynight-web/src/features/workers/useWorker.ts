import { useCallback } from 'react';
import { getWorker, type WorkerDetailResponse } from '../../api/workers';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useWorkerObservation, type WorkerReadOptions } from './useWorkerObservation';

const withdraw = (snapshot: WorkerDetailResponse, projectId: string): WorkerDetailResponse => {
  const tasks = snapshot.worker.tasks.filter(task => task.projectId !== projectId);
  if (tasks.length === snapshot.worker.tasks.length) return snapshot;
  return { ...snapshot, worker: snapshot.worker.taskObservationState === 'unavailable'
    ? { ...snapshot.worker, tasks }
    : { ...snapshot.worker, tasks, activeTaskCount: tasks.length } };
};
const filterDenied = (scope: TaskCacheScope, snapshot: WorkerDetailResponse, fence: ReadonlyMap<string, string>): WorkerDetailResponse => {
  if (scope.projectionSnapshotFailed(fence) || scope.hasGlobalProjectionFailure) return { ...snapshot, worker: { ...snapshot.worker, taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null, inventoryObservedAt: null, tasks: [] } };
  const denied = new Set(snapshot.worker.tasks.filter(task => scope.projectionSnapshotDenied(fence, task.projectId)).map(task => task.projectId));
  return [...denied].reduce(withdraw, snapshot);
};

export const useWorker = (workerId: string, options: WorkerReadOptions) => {
  const load = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const snapshot = await getWorker(workerId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
    return { snapshot, receivedMonotonic: performance.now() };
  }, [workerId]);
  return useWorkerObservation(`worker:${workerId}`, options, load, true, withdraw, filterDenied);
};
