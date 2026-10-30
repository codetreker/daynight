import type { WorkerSummary } from '../../api/workers';

export const isWorkerOnline = (worker: { readonly lastReportedAt: string }, serverMilliseconds: number): boolean =>
  serverMilliseconds - Date.parse(worker.lastReportedAt) < 120_000;
export const isWorkerRecent = (worker: { readonly lastReportedAt: string }, serverMilliseconds: number): boolean =>
  serverMilliseconds - Date.parse(worker.lastReportedAt) <= 72 * 60 * 60 * 1_000;
export const sortWorkers = (items: readonly WorkerSummary[], serverMilliseconds: number): WorkerSummary[] => [...items].sort((a, b) =>
  Number(isWorkerOnline(b, serverMilliseconds)) - Number(isWorkerOnline(a, serverMilliseconds))
  || Date.parse(b.lastReportedAt) - Date.parse(a.lastReportedAt)
  || (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0));

export type WorkerTimeAnchor = { readonly observedAt: string; readonly receivedMonotonic: number };
export const workerServerMilliseconds = (anchor: WorkerTimeAnchor, monotonicNow: number): number =>
  Date.parse(anchor.observedAt) + monotonicNow - anchor.receivedMonotonic;
