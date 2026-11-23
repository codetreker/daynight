import { useEffect, useMemo, useReducer } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { getWorkerAlias, type WorkerAlias } from '../../api/worker-alias';
import { useOptionalTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

export type WorkerNameTarget = { readonly userId?: string | null | undefined; readonly workerId?: string | null | undefined };
type Entry = { alias: WorkerAlias | null; readonly listeners: Set<() => void>; controller: AbortController | null; checkedAt: number; stop: (() => void) | null };
const stores = new WeakMap<TaskCacheScope, Map<string, Entry>>();
const storeFor = (scope: TaskCacheScope) => {
  let store = stores.get(scope);
  if (!store) { store = new Map(); stores.set(scope, store); }
  return store;
};

const read = async (scope: TaskCacheScope, workerId: string, entry: Entry) => {
  if (entry.controller || scope.isInvalidated || scope.hasIdentityMismatch || authRequestsPaused() || document.visibilityState === 'hidden') return;
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
  entry.controller = controller;
  entry.checkedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const alias = await getWorkerAlias(workerId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
    if (signal.aborted || scope.isInvalidated || scope.hasIdentityMismatch || entry.controller !== controller) return;
    if (entry.alias === null || BigInt(alias.version) >= BigInt(entry.alias.version)) entry.alias = alias;
    for (const listener of entry.listeners) listener();
  } catch (error) {
    if (!signal.aborted && !scope.isInvalidated && !scope.hasIdentityMismatch && error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      entry.alias = null;
      for (const listener of entry.listeners) listener();
    }
  } finally {
    clearTimeout(timeout);
    if (entry.controller === controller) entry.controller = null;
  }
};

const start = (scope: TaskCacheScope, workerId: string, entry: Entry) => {
  if (entry.stop) return;
  const refresh = () => { void read(scope, workerId, entry); };
  const timer = setInterval(refresh, 30_000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  const stop = () => {
    clearInterval(timer);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
    scope.signal.removeEventListener('abort', stop);
    scope.mismatchSignal.removeEventListener('abort', stop);
    if (entry.controller) { entry.controller.abort(); entry.controller = null; entry.checkedAt = 0; }
    entry.stop = null;
  };
  entry.stop = stop;
  scope.signal.addEventListener('abort', stop, { once: true });
  scope.mismatchSignal.addEventListener('abort', stop, { once: true });
  if (Date.now() - entry.checkedAt >= 30_000) refresh();
};

// Metadata is shared only inside one authenticated scope; claim hostnames remain immutable.
export const useWorkerNames = (targets: readonly WorkerNameTarget[]) => {
  const scope = useOptionalTaskCacheScope();
  const [, update] = useReducer(value => value + 1, 0);
  const key = JSON.stringify([...new Set(targets.filter(target => target.userId === scope?.userId && target.workerId).map(target => target.workerId!))].sort());
  useEffect(() => {
    if (!scope || scope.isInvalidated || scope.hasIdentityMismatch) return;
    const ids = JSON.parse(key) as string[];
    const store = storeFor(scope);
    const entries = ids.map(workerId => {
      let entry = store.get(workerId);
      if (!entry) { entry = { alias: null, listeners: new Set(), controller: null, checkedAt: 0, stop: null }; store.set(workerId, entry); }
      entry.listeners.add(update);
      start(scope, workerId, entry);
      return { workerId, entry };
    });
    return () => {
      for (const { entry } of entries) {
        entry.listeners.delete(update);
        if (entry.listeners.size === 0) entry.stop?.();
      }
    };
  }, [scope, key]);
  return useMemo(() => ({ name: (userId: string | null | undefined, workerId: string | null | undefined, machineName: string, detailed = false): string => {
    const alias = scope && !scope.isInvalidated && !scope.hasIdentityMismatch && userId === scope.userId && workerId ? stores.get(scope)?.get(workerId)?.alias?.value : null;
    return alias ? detailed ? `${alias} · ${machineName}` : alias : machineName;
  } }), [scope]);
};
