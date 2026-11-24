import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { getWorkerLifecycle, getWorkerLifecycleOperation, lifecycleIntentHash, parseLifecycleIntentRequest, resolveWorkerLifecycleOperation, submitWorkerLifecycle, type LifecycleIntentReceipt, type LifecycleIntentRequest, type LifecycleResource } from '../../api/worker-lifecycle';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useWorkerObservation, type WorkerReadOptions } from './useWorkerObservation';
import { workerLifecycleStorageKey } from './lifecycle-storage';
import { lifecycleFacts } from './lifecycle-facts';

type Journal = { readonly request: LifecycleIntentRequest; readonly hash: string };
type OperationState = { readonly journal: Journal | null; readonly busy: boolean; readonly error: string | null };
type Store = { state: OperationState; readonly listeners: Set<() => void>; readonly key: string; receipt: LifecycleIntentReceipt | null; blockedStorage: boolean };
const stores = new WeakMap<TaskCacheScope, Map<string, Store>>();
const notify = (store: Store, update: Partial<OperationState>) => {
  store.state = { ...store.state, ...update };
  for (const listener of store.listeners) listener();
};
const readJournal = (key: string, scope: TaskCacheScope, workerId: string): Journal | null => {
  const saved = sessionStorage.getItem(key);
  if (saved === null) return null;
  const data = JSON.parse(saved) as Record<string, unknown>;
  if (Object.keys(data).length !== 5 || data.origin !== location.origin || data.userId !== scope.userId || data.workerId !== workerId || typeof data.hash !== 'string' || !/^[a-f0-9]{64}$/.test(data.hash)) throw new Error('Invalid lifecycle journal');
  return { request: parseLifecycleIntentRequest(data.request), hash: data.hash };
};
const storeFor = (scope: TaskCacheScope, workerId: string): Store => {
  let owned = stores.get(scope);
  if (owned === undefined) { owned = new Map(); stores.set(scope, owned); }
  const found = owned.get(workerId);
  if (found !== undefined) return found;
  const key = workerLifecycleStorageKey(location.origin, scope.userId, workerId);
  let journal: Journal | null = null, error: string | null = null, blockedStorage = false;
  try {
    journal = readJournal(key, scope, workerId);
    if (journal !== null) error = 'unknown';
  } catch { error = 'storage'; blockedStorage = true; }
  const store: Store = { key, state: { journal, busy: false, error }, listeners: new Set(), receipt: null, blockedStorage };
  owned.set(workerId, store);
  scope.signal.addEventListener('abort', () => {
    try { sessionStorage.removeItem(key); } catch { /* The invalidated principal cannot reuse the in-memory journal. */ }
    store.receipt = null;
    notify(store, { journal: null, busy: false, error: null });
  }, { once: true });
  return store;
};
const persist = (store: Store, scope: TaskCacheScope, workerId: string, journal: Journal) => {
  try {
    sessionStorage.setItem(store.key, JSON.stringify({ origin: location.origin, userId: scope.userId, workerId, ...journal }));
    return true;
  } catch { return false; }
};
const clear = (store: Store) => {
  try { sessionStorage.removeItem(store.key); } catch { store.blockedStorage = true; }
  store.receipt = null;
  notify(store, { journal: null, error: store.blockedStorage ? 'storage' : null });
};

/** Server observation time orders snapshots across instance changes. Report sequences are scoped to an instance and intent. */
export const lifecycleAdvances = (old: LifecycleResource, next: LifecycleResource): boolean => {
  if (BigInt(next.intentVersion) < BigInt(old.intentVersion)) return false;
  if (old.instance !== null && next.instance === null) return false;
  const before = old.observation, after = next.observation;
  if (before !== null && after === null && old.intentVersion === next.intentVersion && old.instance?.instanceId === next.instance?.instanceId) return false;
  if (before !== null && after !== null && before.instanceId === after.instanceId && before.intentVersion === after.intentVersion
    && BigInt(after.reportSequence) < BigInt(before.reportSequence)) return false;
  return Date.parse(next.observedAt) >= Date.parse(old.observedAt);
};
const unchanged = (snapshot: LifecycleResource) => snapshot;
const filter = (_scope: TaskCacheScope, snapshot: LifecycleResource) => snapshot;

export const useWorkerLifecycle = (workerId: string, options: WorkerReadOptions) => {
  const scope = useTaskCacheScope();
  const store = useMemo(() => storeFor(scope, workerId), [scope, workerId]);
  const subscribe = useCallback((listener: () => void) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, [store]);
  const operation = useSyncExternalStore(subscribe, () => store.state);
  const latest = useRef<{ scope: TaskCacheScope; workerId: string; snapshot: LifecycleResource } | null>(null);
  const context = useRef({ scope, workerId, enabled: options.readEnabled });
  context.current = { scope, workerId, enabled: options.readEnabled };
  const load = useCallback(async (owner: TaskCacheScope, signal: AbortSignal) => {
    // Include the whole request duration so response transit cannot extend stop evidence.
    const receivedMonotonic = performance.now();
    const snapshot = await getWorkerLifecycle(workerId, AbortSignal.any([signal, AbortSignal.timeout(12_000)]), { userId: owner.userId, onPrincipalMismatch: owner.principalMismatch });
    const previous = latest.current;
    if (previous?.scope === owner && previous.workerId === workerId && !lifecycleAdvances(previous.snapshot, snapshot)) throw new ApiError('protocol');
    if (store.receipt !== null && BigInt(snapshot.intentVersion) < BigInt(store.receipt.intentVersion)) throw new ApiError('protocol');
    latest.current = { scope: owner, workerId, snapshot };
    return { snapshot, receivedMonotonic };
  }, [workerId, store]);
  const read = useWorkerObservation(`worker-lifecycle:${workerId}`, options, load, true, unchanged, filter, true);
  const permitted = () => context.current.scope === scope && context.current.workerId === workerId && context.current.enabled && !scope.isInvalidated && !scope.mismatchSignal.aborted && !authRequestsPaused();
  const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
  const run = async (action?: 'disable' | 'resume') => {
    if (!permitted() || store.state.busy) return;
    if (action !== undefined && (store.state.journal !== null || store.blockedStorage)) return;
    notify(store, { busy: true });
    const deadline = AbortSignal.timeout(15_000), signal = AbortSignal.any([deadline, scope.signal, scope.mismatchSignal]);
    let dispatched = false, journal = store.state.journal;
    try {
      await scope.ready(signal);
      if (!permitted()) return;
      if (action === undefined && store.blockedStorage) {
        try {
          journal = readJournal(store.key, scope, workerId);
          store.blockedStorage = false;
          notify(store, { journal, error: journal === null ? null : 'unknown' });
        } catch { notify(store, { error: 'storage' }); return; }
      }
      if (action !== undefined) {
        const resource = read.snapshot, envelope = resource?.observation;
        if (resource === null || resource.capability !== 'supported' || read.stale) return;
        if (action === 'disable' && resource.desired !== 'enabled') return;
        if (action === 'resume' && !lifecycleFacts(resource, read.serverMilliseconds, read.stale).resumeEligible) return;
        const common = { protocolVersion: 1 as const, operationId: crypto.randomUUID(), expectedVersion: resource.intentVersion, source: 'web' as const };
        const request: LifecycleIntentRequest = action === 'disable' ? { ...common, action, localEpoch: null, originOperationId: null }
          : { ...common, action, localEpoch: envelope!.localEpoch, instanceId: envelope!.instanceId };
        journal = { request, hash: await lifecycleIntentHash(request) };
        if (!permitted()) return;
        const saved = persist(store, scope, workerId, journal);
        notify(store, { journal, error: saved ? null : 'storage' });
        if (!saved) return;
        const receipt = await submitWorkerLifecycle(workerId, request, signal, admission, () => {
          if (!permitted()) throw new DOMException('Lifecycle admission changed', 'AbortError');
          dispatched = true;
        });
        if (!permitted()) return;
        store.receipt = receipt;
        notify(store, { error: 'accepted' });
      } else if (journal !== null) {
        if (await lifecycleIntentHash(journal.request) !== journal.hash) { store.blockedStorage = true; notify(store, { error: 'storage' }); return; }
        let result;
        try { result = await getWorkerLifecycleOperation(workerId, journal.request.operationId, signal, admission); }
        catch (error) {
          if (!(error instanceof ApiError && error.kind === 'server' && error.status === 404)) throw error;
          if (!permitted()) return;
          result = await resolveWorkerLifecycleOperation(workerId, journal.request, signal, admission, () => {
            if (!permitted()) throw new DOMException('Lifecycle admission changed', 'AbortError');
          });
        }
        if (!permitted()) return;
        if (result.kind === 'not_committed' && result.receipt.requestKind === 'intent' && result.receipt.requestHash === journal.hash) {
          clear(store); notify(store, { error: 'not_committed' });
        } else if (result.kind === 'intent' && result.receipt.action === journal.request.action
          && BigInt(result.receipt.intentVersion) === BigInt(journal.request.expectedVersion) + 1n) {
          store.receipt = result.receipt;
          notify(store, { error: 'accepted' });
        } else throw new ApiError('protocol');
      }
      read.refresh();
    } catch (error) {
      if (!permitted()) return;
      const rejected = action !== undefined && error instanceof ApiError && error.kind === 'server'
        && (error.writeOutcome === 'not_committed' || ['operation_conflict', 'version_conflict', 'lifecycle_unsupported', 'disable_incomplete', 'safety_blocked', 'stale_instance', 'stale_intent', 'unauthenticated', 'forbidden', 'not_found'].includes(error.code));
      if (rejected || action !== undefined && !dispatched) clear(store);
      const code = error instanceof ApiError && error.kind === 'server' ? error.code : 'unknown';
      notify(store, { error: code });
      read.refresh();
    } finally { notify(store, { busy: false }); }
  };
  const busyPhase = read.snapshot?.observation?.observation.phase;
  const resource = read.snapshot, envelope = resource?.observation;
  useEffect(() => {
    if (resource !== null && store.receipt !== null && BigInt(resource.intentVersion) >= BigInt(store.receipt.intentVersion)) clear(store);
  }, [resource, store, operation]);
  const awaitingMachine = resource !== null && resource.admission === 'closed' && (envelope == null || envelope.intentVersion !== resource.intentVersion
    || envelope.operationId !== resource.operationId || envelope.instanceId !== resource.instance?.instanceId);
  const checkAction = useRef(() => run());
  checkAction.current = () => run();
  useEffect(() => {
    if (options.readEnabled && store.state.journal !== null) void checkAction.current();
  }, [scope, workerId, store, options.readEnabled]);
  useEffect(() => {
    if (!options.readEnabled || operation.journal === null && !awaitingMachine && busyPhase !== 'disabling' && busyPhase !== 'resuming') return;
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') read.refresh(); }, 2_000);
    return () => clearInterval(timer);
  }, [options.readEnabled, operation.journal, awaitingMachine, busyPhase, read.refresh]);
  return { ...read, pending: operation.journal?.request ?? null, busy: operation.busy, operationError: operation.error,
    submit: (action: 'disable' | 'resume') => run(action), check: () => run() };
};
