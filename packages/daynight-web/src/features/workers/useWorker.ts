import { useCallback } from 'react';
import { getWorker } from '../../api/workers';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useWorkerObservation, type WorkerReadOptions } from './useWorkerObservation';

export const useWorker = (workerId: string, options: WorkerReadOptions) => {
  const load = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const snapshot = await getWorker(workerId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
    return { snapshot, receivedMonotonic: performance.now() };
  }, [workerId]);
  return useWorkerObservation(`worker:${workerId}`, options, load, true);
};
