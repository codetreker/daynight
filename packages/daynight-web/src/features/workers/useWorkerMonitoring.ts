import { useCallback, useRef } from 'react';
import { getWorkerMonitoring, queryWorkerMonitoring, type MonitoringScope, type MonitoringSummary, type WorkerMonitoringDetail, type WorkerMonitoringItem } from '../../api/worker-monitoring';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useWorkerObservation, type WorkerReadOptions } from './useWorkerObservation';

// A projection may have changed after an earlier read. Retain the Worker's own
// resource facts, but remove every affected scoped item and its association.
const projectDetail = (snapshot: WorkerMonitoringDetail, denied: (scope: MonitoringScope) => boolean, restricted: boolean): WorkerMonitoringDetail => {
  if (snapshot.state === 'absent') return snapshot;
  const data = snapshot.data;
  const keep = <T extends { scope: MonitoringScope }>(item: T) => !denied(item.scope);
  return { ...snapshot, permissionProjection: restricted ? 'restricted' : snapshot.permissionProjection,
    data: { ...data, admission: { ...data.admission, reasons: data.admission.reasons.filter(keep) },
      reservations: data.reservations.filter(keep), activities: data.activities.filter(keep),
      currentFailures: data.currentFailures.filter(keep), lastRecovery: data.lastRecovery !== null && keep(data.lastRecovery) ? data.lastRecovery : null } };
};
const withdraw = (snapshot: WorkerMonitoringDetail, projectId: string): WorkerMonitoringDetail =>
  projectDetail(snapshot, scope => scope.kind !== 'worker' && scope.projectId === projectId, true);
const filterDenied = (scope: TaskCacheScope, snapshot: WorkerMonitoringDetail, fence: ReadonlyMap<string, string>): WorkerMonitoringDetail => {
  const failed = scope.projectionSnapshotFailed(fence) || scope.hasGlobalProjectionFailure;
  return projectDetail(snapshot, item => item.kind !== 'worker' && (failed || scope.projectionSnapshotDenied(fence, item.projectId)), scope.projectionSnapshotHasDenials(fence) || failed);
};

export const useWorkerMonitoring = (workerId: string, options: WorkerReadOptions) => {
  const scope = useTaskCacheScope();
  const history = useRef<{ scope: TaskCacheScope; workerId: string; snapshot: WorkerMonitoringDetail | null; expiresAt: string | null; expired: boolean }>({ scope, workerId, snapshot: null, expiresAt: null, expired: false });
  if (history.current.scope !== scope || history.current.workerId !== workerId) history.current = { scope, workerId, snapshot: null, expiresAt: null, expired: false };
  const load = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const snapshot = await getWorkerMonitoring(workerId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
    return { snapshot, receivedMonotonic: performance.now() };
  }, [workerId]);
  const state = useWorkerObservation(`monitoring:${workerId}`, options, load, true, withdraw, filterDenied, true);
  const current = state.snapshot, known = history.current;
  if (current !== known.snapshot) {
    known.snapshot = current;
    if (current === null) { known.expiresAt = null; known.expired = false; }
    else if (current.state === 'available') { known.expiresAt = current.expiresAt; known.expired = false; }
    else {
      if (known.expiresAt !== null) known.expired = Date.parse(current.observedAt) >= Date.parse(known.expiresAt);
      known.expiresAt = null;
    }
  }
  return { ...state, expired: known.expired };
};

// null is a local withdrawal state, never a valid public API admission.
export type WorkerMonitoringProjectedItem = Extract<WorkerMonitoringItem, { state: 'absent' }> | (Omit<Extract<WorkerMonitoringItem, { state: 'available' }>, 'summary'> & { readonly summary: Omit<MonitoringSummary, 'admission'> & { readonly admission: MonitoringSummary['admission'] | null } });
export type WorkerMonitoringSummaryEntry = { readonly item: WorkerMonitoringProjectedItem; readonly observedAt: string; readonly receivedMonotonic: number; readonly expired: boolean };
export type WorkerMonitoringSummaries = { readonly observedAt: string; readonly items: readonly WorkerMonitoringSummaryEntry[] };
export const monitoringSummaryAge = (entry: WorkerMonitoringSummaryEntry, monotonicNow: number): number | null =>
  entry.item.receivedAt === null ? null : Date.parse(entry.observedAt) + monotonicNow - entry.receivedMonotonic - Date.parse(entry.item.receivedAt);

// Public reason codes have no scope IDs, so withdrawal cannot identify an
// individual project's codes. Drop them all until a newly qualified read.
const withdrawSummaries = (snapshot: WorkerMonitoringSummaries): WorkerMonitoringSummaries => ({
  ...snapshot, items: snapshot.items.map(entry => entry.item.state === 'absent' || entry.item.summary.admission === null ? entry :
    { ...entry, item: { ...entry.item, summary: { ...entry.item.summary, admission: null } } }),
});
const filterSummaries = (scope: TaskCacheScope, snapshot: WorkerMonitoringSummaries, fence: ReadonlyMap<string, string>): WorkerMonitoringSummaries =>
  scope.projectionSnapshotHasDenials(fence) ? withdrawSummaries(snapshot) : snapshot;
export const useWorkerMonitoringSummaries = (workerIds: readonly string[], options: WorkerReadOptions) => {
  const scope = useTaskCacheScope();
  const key = workerIds.join(',');
  const history = useRef<{ scope: TaskCacheScope; snapshot: WorkerMonitoringSummaries | null; expiry: Map<string, string>; expired: Set<string> }>({ scope, snapshot: null, expiry: new Map(), expired: new Set() });
  if (history.current.scope !== scope) history.current = { scope, snapshot: null, expiry: new Map(), expired: new Set() };
  const retain = useCallback((snapshot: WorkerMonitoringSummaries): WorkerMonitoringSummaries | null => {
    const ids = new Set(key === '' ? [] : key.split(','));
    const items = snapshot.items.filter(entry => ids.has(entry.item.workerId));
    if (items.length === 0) return null;
    return items.length === snapshot.items.length ? snapshot : { ...snapshot, items };
  }, [key]);
  const load = useCallback(async (scope: TaskCacheScope, signal: AbortSignal) => {
    const ids = key.split(','), items: WorkerMonitoringSummaryEntry[] = [];
    let observedAt = '', receivedMonotonic = 0;
    for (let offset = 0; offset < ids.length; offset += 100) {
      await scope.ready(signal);
      const page = await queryWorkerMonitoring(ids.slice(offset, offset + 100), signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
      receivedMonotonic = performance.now(); observedAt = page.observedAt;
      items.push(...page.items.map(item => ({ item, observedAt: page.observedAt, receivedMonotonic, expired: false })));
    }
    return { snapshot: { observedAt, items }, receivedMonotonic };
  }, [key]);
  const state = useWorkerObservation(key === '' ? 'monitoring-list:empty' : 'monitoring-list', { readEnabled: options.readEnabled && key !== '' }, load, false, withdrawSummaries, filterSummaries, true, retain);
  const known = history.current;
  const currentIds = new Set(workerIds);
  for (const id of known.expiry.keys()) if (!currentIds.has(id)) known.expiry.delete(id);
  for (const id of known.expired) if (!currentIds.has(id)) known.expired.delete(id);
  if (state.snapshot !== known.snapshot) {
    known.snapshot = state.snapshot;
    if (state.snapshot === null) { known.expiry.clear(); known.expired.clear(); }
    else for (const entry of state.snapshot.items) {
      const { item } = entry;
      if (item.state === 'available') { known.expiry.set(item.workerId, item.expiresAt); known.expired.delete(item.workerId); }
      else {
        const expiry = known.expiry.get(item.workerId);
        if (expiry !== undefined) {
          if (Date.parse(entry.observedAt) >= Date.parse(expiry)) known.expired.add(item.workerId);
          else known.expired.delete(item.workerId);
          known.expiry.delete(item.workerId);
        }
      }
    }
  }
  return { ...state, snapshot: state.snapshot === null ? null : { ...state.snapshot, items: state.snapshot.items.map(entry => ({ ...entry, expired: known.expired.has(entry.item.workerId) })) } };
};
