import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { getWorkerConfiguration, saveWorkerConfiguration, type WorkerConfigurationResource, type WorkerConfigurationValue } from '../../../api/worker-configuration';
import { useTaskCacheScope, type TaskCacheScope } from '../../task-cache/TaskCacheProvider';
import { TaskCacheLifecycleChanged } from '../../task-cache/project-cache';
import { configurationDraftsEqual, configurationValuesEqual, draftFromValue, mergeConfigurationResources, parseConfigurationDraft, type ConfigurationDraft } from './model';

export type ConfigurationNotice = 'saved' | 'conflict' | 'reconciled' | 'notSaved' | null;
export type ConfigurationDraftUpdate = ConfigurationDraft | ((draft: ConfigurationDraft) => ConfigurationDraft);
type Submission = { readonly value: WorkerConfigurationValue; readonly revision: string; readonly draft: ConfigurationDraft; dispatched: boolean };
type State = {
  readonly scope: TaskCacheScope; readonly workerId: string; readonly resource: WorkerConfigurationResource | null;
  readonly draft: ConfigurationDraft | null; readonly baselineDraft: ConfigurationDraft | null; readonly baselineRevision: string | null;
  readonly refreshing: boolean; readonly pending: boolean; readonly error: unknown; readonly errorSource: 'read' | 'write' | null; readonly notice: ConfigurationNotice;
  readonly uncertain: boolean; readonly unavailable: boolean; readonly submission: Submission | null;
};
const initialState = (scope: TaskCacheScope, workerId: string): State => ({ scope, workerId, resource: null, draft: null, baselineDraft: null, baselineRevision: null, refreshing: false, pending: false, error: null, errorSource: null, notice: null, uncertain: false, unavailable: false, submission: null });
type Actions = { readonly setEnabled: (enabled: boolean) => void; readonly setDraft: (update: ConfigurationDraftUpdate) => void; readonly refresh: () => void; readonly loadLatest: () => void; readonly save: () => Promise<void> };
const emptyActions: Actions = { setEnabled: () => {}, setDraft: () => {}, refresh: () => {}, loadLatest: () => {}, save: async () => {} };

export const useWorkerConfiguration = (workerId: string, { readEnabled }: { readonly readEnabled: boolean }) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<State>(() => initialState(scope, workerId));
  const stateRef = useRef(state), actions = useRef<Actions>(emptyActions);
  const setDraft = useCallback((update: ConfigurationDraftUpdate) => actions.current.setDraft(update), []);
  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadLatest = useCallback(() => actions.current.loadLatest(), []);
  const save = useCallback(() => actions.current.save(), []);

  useLayoutEffect(() => {
    let active = true, enabled = readEnabled, visible = document.visibilityState !== 'hidden', generation = 0;
    const admissionWaiters = new Set<() => void>();
    let read: AbortController | null = null, write: AbortController | null = null;
    let polling: ReturnType<typeof setInterval> | null = null;
    const alive = () => active && !scope.isInvalidated;
    const live = () => alive() && enabled;
    const currentState = () => stateRef.current.scope === scope && stateRef.current.workerId === workerId ? stateRef.current : initialState(scope, workerId);
    const store = (next: State) => { stateRef.current = next; setState(next); };
    const update = (change: (old: State) => State) => { if (alive()) store(change(currentState())); };
    const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
    // A dispatched PUT belongs to this resource even if request admission pauses.
    // Wait again after readiness, since admission may close while readiness resolves.
    const waitForAdmission = async (signal: AbortSignal) => {
      while (alive()) {
        signal.throwIfAborted();
        if (!enabled) await new Promise<void>((resolve, reject) => {
          const finish = () => { admissionWaiters.delete(finish); signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { admissionWaiters.delete(finish); reject(signal.reason); };
          admissionWaiters.add(finish); signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        try { await scope.ready(signal); } catch (error) {
          if (error instanceof TaskCacheLifecycleChanged && alive() && !signal.aborted) continue;
          throw error;
        }
        if (enabled && alive()) return;
      }
      signal.throwIfAborted();
    };
    const acceptRead = (incoming: WorkerConfigurationResource) => update(old => {
      const resource = mergeConfigurationResources(old.resource, incoming);
      if (old.uncertain && !old.pending && old.submission !== null) {
        const submitted = old.submission;
        if (resource.desired !== null && configurationValuesEqual(resource.desired.value, submitted.value)) {
          return { ...old, resource, refreshing: false, error: null, errorSource: null, notice: 'reconciled', uncertain: false, unavailable: false, submission: null, baselineDraft: submitted.draft, baselineRevision: resource.desired.revision };
        }
        const conflict = resource.desired !== null && resource.desired.revision !== submitted.revision;
        return { ...old, resource, refreshing: false, error: null, errorSource: null, notice: conflict ? 'conflict' : 'notSaved', uncertain: false, unavailable: false, submission: null };
      }
      if (old.draft === null && resource.desired !== null) {
        const draft = draftFromValue(resource.desired.value);
        return { ...old, resource, draft, baselineDraft: draft, baselineRevision: resource.desired.revision, refreshing: false, error: old.errorSource === 'write' ? old.error : null, errorSource: old.errorSource === 'write' ? 'write' : null, unavailable: false };
      }
      return { ...old, resource, refreshing: false, error: old.errorSource === 'write' ? old.error : null, errorSource: old.errorSource === 'write' ? 'write' : null, unavailable: false };
    });
    const requestRead = async (replace = false, explicit = false): Promise<void> => {
      if (!live() || !visible || read !== null && !replace) return;
      if (replace) read?.abort();
      const controller = new AbortController(); read = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal]), attempt = ++generation;
      const current = () => live() && visible && attempt === generation && !signal.aborted;
      if (explicit) update(old => ({ ...old, refreshing: true }));
      try {
        await waitForAdmission(signal);
        const resource = await getWorkerConfiguration(workerId, signal, admission);
        await waitForAdmission(signal);
        if (current()) acceptRead(resource);
      } catch (error) {
        try { await waitForAdmission(signal); } catch { return; }
        if (current()) {
          if (error instanceof ApiError && error.kind === 'server' && error.status === 404 && error.code === 'not_found') {
            write?.abort();
            store({ ...initialState(scope, workerId), error, errorSource: 'read', unavailable: true });
          } else update(old => ({ ...old, refreshing: false, error: old.errorSource === 'write' ? old.error : error, errorSource: old.errorSource === 'write' ? 'write' : 'read', unavailable: false }));
        }
      } finally { if (attempt === generation) read = null; }
    };
    const replaceDraft = () => update(old => {
      if (old.pending || old.uncertain || old.resource?.desired === null || old.resource === null) return old;
      const draft = draftFromValue(old.resource.desired.value);
      return { ...old, draft, baselineDraft: draft, baselineRevision: old.resource.desired.revision, error: null, errorSource: null, notice: null };
    });
    const saveDraft = async (): Promise<void> => {
      if (!live() || !visible) return;
      const old = currentState();
      if (old.pending || old.uncertain || old.draft === null || old.baselineRevision === null || old.resource?.desired === null || old.resource === null) return;
      if (old.resource.desired.revision !== old.baselineRevision) { update(value => ({ ...value, notice: 'conflict' })); return; }
      const parsed = parseConfigurationDraft(old.draft);
      if (parsed.value === null || old.baselineDraft !== null && configurationDraftsEqual(old.draft, old.baselineDraft)) return;
      const submitted: Submission = { value: parsed.value, revision: old.baselineRevision, draft: structuredClone(old.draft), dispatched: false };
      const controller = new AbortController(); write = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal]);
      update(value => ({ ...value, pending: true, error: null, errorSource: null, notice: null, submission: submitted }));
      try {
        await waitForAdmission(signal);
        if (!alive() || signal.aborted) return;
        const incoming = await saveWorkerConfiguration(workerId, submitted.revision, submitted.value, signal, { ...admission, onDispatch: () => { submitted.dispatched = true; } });
        await waitForAdmission(signal);
        if (!alive() || signal.aborted) return;
        update(value => ({ ...value, resource: mergeConfigurationResources(value.resource, incoming), pending: false, uncertain: false, error: null, errorSource: null, notice: 'saved', unavailable: false, submission: null, baselineDraft: submitted.draft, baselineRevision: incoming.desired!.revision }));
      } catch (error) {
        if (!alive() || signal.aborted) return;
        try { await waitForAdmission(signal); } catch { return; }
        if (!alive() || signal.aborted) return;
        const conflict = error instanceof ApiError && error.status === 409 && error.code === 'version_conflict';
        const uncertain = submitted.dispatched && (!(error instanceof ApiError) || error.kind !== 'server' || error.status !== null && error.status >= 500);
        update(value => ({ ...value, pending: false, error, errorSource: 'write', notice: conflict ? 'conflict' : null, uncertain, submission: uncertain ? submitted : null }));
        if (conflict || uncertain) await requestRead(true);
      } finally { if (write === controller) write = null; }
    };
    const stopReads = () => {
      ++generation; read?.abort(); read = null;
      if (polling !== null) clearInterval(polling);
      polling = null;
      update(old => ({ ...old, refreshing: false }));
    };
    const startReads = () => {
      if (!live() || !visible) return;
      void requestRead(); polling = setInterval(() => { void requestRead(); }, 5_000);
    };
    const visibility = () => {
      const next = document.visibilityState !== 'hidden';
      if (next === visible) return;
      visible = next; stopReads(); if (visible) startReads();
    };
    const invalidate = () => { ++generation; read?.abort(); write?.abort(); if (polling !== null) clearInterval(polling); polling = null; store(initialState(scope, workerId)); };
    store({ ...currentState(), refreshing: false });
    actions.current = { setEnabled: next => {
      if (enabled === next) return;
      enabled = next;
      if (enabled) { for (const resume of admissionWaiters) resume(); startReads(); }
      else stopReads();
    }, setDraft: change => update(old => old.draft === null ? old : { ...old, draft: typeof change === 'function' ? change(old.draft) : change, error: old.errorSource === 'write' ? null : old.error, errorSource: old.errorSource === 'write' ? null : old.errorSource, notice: null }), refresh: () => { void requestRead(true, true); }, loadLatest: replaceDraft, save: saveDraft };
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    startReads();
    return () => {
      active = false; ++generation; read?.abort(); write?.abort();
      if (polling !== null) clearInterval(polling);
      document.removeEventListener('visibilitychange', visibility); scope.signal.removeEventListener('abort', invalidate);
      const last = currentState();
      if (last.pending) store({ ...last, refreshing: false, pending: false, uncertain: last.submission?.dispatched === true, submission: last.submission?.dispatched === true ? last.submission : null });
      actions.current = emptyActions;
    };
  }, [scope, workerId]);

  useLayoutEffect(() => { actions.current.setEnabled(readEnabled); }, [scope, workerId, readEnabled]);

  const current = state.scope === scope && state.workerId === workerId && !scope.isInvalidated ? state : initialState(scope, workerId);
  // A poll can observe our PUT before its response. Settle or reconcile that write
  // before classifying a newer target as an external edit.
  const conflict = !current.pending && !current.uncertain && current.baselineRevision !== null && current.resource?.desired !== null && current.resource !== null && current.resource.desired.revision !== current.baselineRevision;
  return {
    resource: current.resource, draft: current.draft, baselineRevision: current.baselineRevision,
    loading: current.resource === null && !current.unavailable && (current.error === null || current.refreshing),
    refreshing: current.refreshing, pending: current.pending, error: current.error, errorSource: current.errorSource, notice: current.notice, uncertain: current.uncertain, unavailable: current.unavailable,
    dirty: current.draft !== null && current.baselineDraft !== null && !configurationDraftsEqual(current.draft, current.baselineDraft),
    conflict,
    setDraft, refresh, loadLatest, save, discard: loadLatest,
  };
};
