import { ApiError } from '../../api/client';
import { listWorkers, type WorkerSummary } from '../../api/workers';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useWorkerObservation, type WorkerObservation, type WorkerReadOptions } from './useWorkerObservation';

// Keep service creation order in the snapshot; online grouping belongs to rendering.
export type WorkerListSnapshot = { readonly observedAt: string; readonly items: readonly WorkerSummary[] };
const loadWorkers = async (scope: TaskCacheScope, signal: AbortSignal): Promise<WorkerObservation<WorkerListSnapshot>> => {
  const items = new Map<string, WorkerSummary>(), cursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    await scope.ready(signal);
    const page = await listWorkers(cursor === null ? { limit: 50 } : { limit: 50, cursor }, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
    const receivedMonotonic = performance.now();
    for (const worker of page.items) {
      if (items.has(worker.workerId)) throw new ApiError('protocol');
      items.set(worker.workerId, worker);
    }
    if (page.nextCursor === null) return { snapshot: { observedAt: page.observedAt, items: [...items.values()] }, receivedMonotonic };
    if (cursors.has(page.nextCursor)) throw new ApiError('protocol');
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
};
const withdraw = (snapshot: WorkerListSnapshot): WorkerListSnapshot => ({ ...snapshot, items: snapshot.items.map(worker => ({
  ...worker, taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null,
})) });
const filterDenied = (scope: TaskCacheScope, snapshot: WorkerListSnapshot, fence: ReadonlyMap<string, string>): WorkerListSnapshot => scope.projectionSnapshotHasDenials(fence) ? withdraw(snapshot) : snapshot;
export const useWorkers = (options: WorkerReadOptions) => useWorkerObservation('workers', options, loadWorkers, false, withdraw, filterDenied);
