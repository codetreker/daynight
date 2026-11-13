import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, subscribeAuthPause } from '../../../api/client';
import { getWorkerConfiguration, saveWorkerConfiguration, type WorkerConfigurationResource, type WorkerConfigurationValue } from '../../../api/worker-configuration';
import type { ExecutionPlatform } from '../../../api/types';
import type { WorkerCloudToolPaths } from '../../../api/worker-tool-paths';
import { useTaskCacheScope, type TaskCacheScope } from '../../task-cache/TaskCacheProvider';
import { isRetryableTaskCacheLifecycleChange } from '../../task-cache/project-cache';
import { configurationDraftsEqual, configurationValuesEqual, draftFromValue, mergeConfigurationResources, parseConfigurationDraft, type ConfigurationDraft } from './model';

export type ConfigurationNotice = 'saved' | 'conflict' | 'reconciled' | 'notSaved' | null;
export type ConfigurationDraftUpdate = ConfigurationDraft | ((draft: ConfigurationDraft) => ConfigurationDraft);
type Submission = { readonly value: WorkerConfigurationValue; readonly revision: string; readonly draft: ConfigurationDraft; readonly controlModeSupported: boolean; readonly toolPathsSupported: boolean; readonly draftRevision: number; dispatched: boolean; receipt: WorkerConfigurationResource | null; rejection: ApiError | null };
type State = {
  readonly scope: TaskCacheScope; readonly workerId: string; readonly resource: WorkerConfigurationResource | null;
  readonly draft: ConfigurationDraft | null; readonly baselineDraft: ConfigurationDraft | null; readonly baselineRevision: string | null;
  readonly refreshing: boolean; readonly pending: boolean; readonly error: unknown; readonly errorSource: 'read' | 'write' | null; readonly notice: ConfigurationNotice;
  readonly uncertain: boolean; readonly unavailable: boolean; readonly submission: Submission | null; readonly abandoned: boolean; readonly protectedDraft: boolean;
};
const initialState = (scope: TaskCacheScope, workerId: string): State => ({ scope, workerId, resource: null, draft: null, baselineDraft: null, baselineRevision: null, refreshing: false, pending: false, error: null, errorSource: null, notice: null, uncertain: false, unavailable: false, submission: null, abandoned: false, protectedDraft: false });
const submittedBaseline = (state: State, submission: Submission): ConfigurationDraft => {
  const { toolPaths: _tools, ...draft } = submission.draft;
  const toolPaths = submission.toolPathsSupported ? submission.draft.toolPaths : state.baselineDraft?.toolPaths;
  return { ...draft, ...(toolPaths === undefined ? {} : { toolPaths }), ...(submission.controlModeSupported ? {} : { agentControlMode: state.baselineDraft?.agentControlMode }) };
};
const reconcileOmittedToolPaths = (state: State, submission: Submission, latest: WorkerCloudToolPaths | undefined) => {
  const baselineDraft = submittedBaseline(state, submission);
  if (submission.toolPathsSupported || latest === undefined || state.draft === null) return { draft: state.draft, baselineDraft, conflict: false };
  const toolPaths = { ...latest };
  let conflict = false;
  for (const tool of ['codex', 'copilot', 'herdr'] as const) {
    const baseline = state.baselineDraft?.toolPaths?.[tool], local = state.draft.toolPaths?.[tool];
    if (JSON.stringify(local) === JSON.stringify(baseline)) continue;
    // Omitted fields were not saved. Preserve their local edits and compare
    // each against the original baseline before adopting a newer revision.
    if (local !== undefined) toolPaths[tool] = local;
    if (JSON.stringify(latest[tool]) !== JSON.stringify(baseline) && JSON.stringify(latest[tool]) !== JSON.stringify(local)) conflict = true;
  }
  return { draft: { ...state.draft, toolPaths }, baselineDraft: { ...baselineDraft, toolPaths: structuredClone(latest) }, conflict };
};
const mergeConfigurationReceipt = (current: WorkerConfigurationResource | null, receipt: WorkerConfigurationResource): WorkerConfigurationResource => {
  const merged = mergeConfigurationResources(current, receipt);
  if (current === null) return merged;
  // Reads discover tool capability. A delayed or legacy PUT receipt cannot
  // replace a newer read's capability decision when its result is published.
  const { toolPathsSupported: _tools, ...resource } = merged;
  return { ...resource, ...(current.toolPathsSupported === true ? { toolPathsSupported: true } : {}) };
};
type Actions = { readonly setEnabled: (enabled: boolean) => void; readonly setDraft: (update: ConfigurationDraftUpdate) => void; readonly refresh: () => void; readonly loadLatest: () => void; readonly abandon: () => void; readonly save: () => Promise<void> };
const emptyActions: Actions = { setEnabled: () => {}, setDraft: () => {}, refresh: () => {}, loadLatest: () => {}, abandon: () => {}, save: async () => {} };

export const useWorkerConfiguration = (workerId: string, { readEnabled, toolPathsEditable = false, platform }: { readonly readEnabled: boolean; readonly toolPathsEditable?: boolean; readonly platform?: ExecutionPlatform }) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState<State>(() => initialState(scope, workerId));
  const stateRef = useRef(state), actions = useRef<Actions>(emptyActions);
  const toolAccess = useRef({ editable: toolPathsEditable, platform });
  useLayoutEffect(() => { toolAccess.current = { editable: toolPathsEditable, platform }; }, [toolPathsEditable, platform]);
  const setDraft = useCallback((update: ConfigurationDraftUpdate) => actions.current.setDraft(update), []);
  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadLatest = useCallback(() => actions.current.loadLatest(), []);
  const abandon = useCallback(() => actions.current.abandon(), []);
  const save = useCallback(() => actions.current.save(), []);

  useLayoutEffect(() => {
    let active = true, enabled = readEnabled, visible = document.visibilityState !== 'hidden', generation = 0;
    const admissionWaiters = new Set<() => void>();
    let read: AbortController | null = null, write: AbortController | null = null, publication: AbortController | null = null;
    let draftRevision = 0;
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
          if (isRetryableTaskCacheLifecycleChange(error) && alive() && !signal.aborted) continue;
          throw error;
        }
        if (enabled && alive()) return;
      }
      signal.throwIfAborted();
    };
    const acceptRead = (incoming: WorkerConfigurationResource) => update(old => {
      const resource = mergeConfigurationResources(old.resource, incoming);
      const mode = resource.desired?.value.agentControlMode;
      if (resource.controlModeSupported === true && mode !== undefined && old.draft !== null && old.draft.agentControlMode === undefined) {
        // A newly negotiated field had no editable draft in the legacy form.
        // Establish its baseline without replacing any existing field edits.
        old = { ...old, draft: { ...old.draft, agentControlMode: mode }, baselineDraft: old.baselineDraft === null ? null : { ...old.baselineDraft, agentControlMode: mode } };
      }
      const tools = resource.desired?.value.toolPaths;
      if (resource.toolPathsSupported === true && tools !== undefined && old.draft !== null && old.draft.toolPaths === undefined) {
        old = { ...old, draft: { ...old.draft, toolPaths: structuredClone(tools) }, baselineDraft: old.baselineDraft === null ? null : { ...old.baselineDraft, toolPaths: structuredClone(tools) } };
      }
      if (!old.pending && old.submission?.receipt !== null && old.submission?.receipt !== undefined) {
        const submitted = old.submission;
        const merged = mergeConfigurationReceipt(resource, submitted.receipt!);
        if (old.abandoned && merged.desired !== null) {
          const draft = draftFromValue(merged.desired.value);
          return { ...old, resource: merged, draft, baselineDraft: draft, baselineRevision: merged.desired.revision, refreshing: false, error: null, errorSource: null, notice: 'saved', uncertain: false, unavailable: false, submission: null, abandoned: false, protectedDraft: false };
        }
        return { ...old, resource: merged, refreshing: false, error: null, errorSource: null, notice: 'saved', uncertain: false, unavailable: false, submission: null, baselineDraft: submittedBaseline(old, submitted), baselineRevision: submitted.receipt!.desired!.revision, protectedDraft: draftRevision !== submitted.draftRevision };
      }
      if (old.uncertain && !old.pending && old.submission !== null) {
        const submitted = old.submission;
        const observedTools = incoming.toolPathsSupported === true && incoming.desired?.revision === resource.desired?.revision ? incoming.desired?.value.toolPaths : undefined;
        // A legacy or stale projection cannot authorize retained paths against
        // a newer revision, even when those paths were omitted from the PUT.
        if ((submitted.toolPathsSupported || old.baselineDraft?.toolPaths !== undefined || old.draft?.toolPaths !== undefined) && observedTools === undefined) {
          return { ...old, resource, refreshing: false, error: null, errorSource: null, unavailable: false };
        }
        if (old.abandoned && resource.desired !== null) {
          const draft = draftFromValue(resource.desired.value);
          return { ...old, resource, draft, baselineDraft: draft, baselineRevision: resource.desired.revision, refreshing: false, error: null, errorSource: null, notice: 'reconciled', uncertain: false, unavailable: false, submission: null, abandoned: false, protectedDraft: false };
        }
        if (resource.desired !== null && configurationValuesEqual(resource.desired.value, submitted.value, submitted.controlModeSupported, submitted.toolPathsSupported)) {
          const reconciled = reconcileOmittedToolPaths(old, submitted, observedTools);
          if (reconciled.conflict) {
            return { ...old, resource, draft: reconciled.draft, refreshing: false, error: null, errorSource: null, notice: 'conflict', uncertain: false, unavailable: false, submission: null, protectedDraft: true };
          }
          return { ...old, resource, draft: reconciled.draft, refreshing: false, error: null, errorSource: null, notice: 'reconciled', uncertain: false, unavailable: false, submission: null, baselineDraft: reconciled.baselineDraft, baselineRevision: resource.desired.revision, protectedDraft: false };
        }
        const conflict = resource.desired !== null && resource.desired.revision !== submitted.revision;
        const protectedDraft = conflict && old.draft !== null && !configurationDraftsEqual(old.draft, submitted.draft) &&
          resource.desired !== null && !configurationDraftsEqual(old.draft, draftFromValue(resource.desired.value));
        return { ...old, resource, refreshing: false, error: null, errorSource: null, notice: conflict ? 'conflict' : 'notSaved', uncertain: false, unavailable: false, submission: null, protectedDraft };
      }
      if (old.draft === null && resource.desired !== null) {
        const draft = draftFromValue(resource.desired.value);
        return { ...old, resource, draft, baselineDraft: draft, baselineRevision: resource.desired.revision, refreshing: false, error: old.errorSource === 'write' ? old.error : null, errorSource: old.errorSource === 'write' ? 'write' : null, unavailable: false };
      }
      const observedNewer = incoming.desired !== null && old.baselineRevision !== null && BigInt(incoming.desired.revision) > BigInt(old.baselineRevision);
      if (old.protectedDraft && observedNewer && old.draft !== null && resource.desired !== null && configurationDraftsEqual(old.draft, draftFromValue(resource.desired.value))) {
        return { ...old, resource, baselineDraft: old.draft, baselineRevision: resource.desired.revision, refreshing: false, error: old.errorSource === 'write' ? old.error : null, errorSource: old.errorSource === 'write' ? 'write' : null, notice: old.notice === 'conflict' ? null : old.notice, unavailable: false, protectedDraft: false };
      }
      const protectedDraft = old.protectedDraft;
      return { ...old, resource, refreshing: false, error: old.errorSource === 'write' ? old.error : null, errorSource: old.errorSource === 'write' ? 'write' : null, unavailable: false, protectedDraft };
    });
    const requestRead = async (replace = false, explicit = false, ownerSignal?: AbortSignal): Promise<void> => {
      if (!live() || !visible || read !== null && !replace) return;
      if (replace) read?.abort();
      const controller = new AbortController(); read = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal, ...(ownerSignal === undefined ? [] : [ownerSignal])]), attempt = ++generation;
      const current = () => live() && visible && attempt === generation && !signal.aborted;
      if (explicit) update(old => ({ ...old, refreshing: true }));
      try {
        await waitForAdmission(signal);
        const resource = await getWorkerConfiguration(workerId, signal, { ...admission, toolPathsSupported: true });
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
      } finally { if (attempt === generation) { read = null; if (scope.hasIdentityMismatch) update(old => ({ ...old, refreshing: false })); } }
    };
    const replaceDraft = () => update(old => {
      if (old.pending || old.uncertain || old.submission !== null || old.resource?.desired === null || old.resource === null || old.notice === 'conflict' && old.resource.desired.revision === old.baselineRevision) return old;
      const draft = draftFromValue(old.resource.desired.value);
      draftRevision++;
      return { ...old, draft, baselineDraft: draft, baselineRevision: old.resource.desired.revision, error: null, errorSource: null, notice: null, protectedDraft: false };
    });
    const abandonDraft = () => update(old => {
      draftRevision++;
      if (old.pending && old.submission !== null && !old.submission.dispatched) {
        write?.abort();
        const desired = old.resource?.desired;
        const draft = desired ? draftFromValue(desired.value) : old.baselineDraft;
        return { ...old, draft, baselineDraft: draft, baselineRevision: desired?.revision ?? old.baselineRevision, pending: false, submission: null, abandoned: false, protectedDraft: false, error: null, errorSource: null, notice: null };
      }
      if (!old.pending && old.submission?.receipt != null) return { ...old, abandoned: true, protectedDraft: false };
      if (!old.pending && !old.uncertain && old.submission === null) {
        if (!old.resource?.desired) return old;
        const draft = draftFromValue(old.resource.desired.value);
        return { ...old, draft, baselineDraft: draft, baselineRevision: old.resource.desired.revision, error: null, errorSource: null, notice: old.notice === 'conflict' && old.resource.desired.revision === old.baselineRevision ? 'conflict' : null, abandoned: false, protectedDraft: false };
      }
      if (old.resource?.desired) {
        const draft = draftFromValue(old.resource.desired.value);
        return { ...old, draft, baselineDraft: draft, baselineRevision: old.resource.desired.revision, abandoned: true, protectedDraft: false };
      }
      return { ...old, draft: old.baselineDraft, abandoned: true, protectedDraft: false };
    });
    // The operation can settle while its result waits for presentation admission.
    // The hook owns that publication until it completes, is superseded, or is disposed.
    const publish = (work: (signal: AbortSignal) => Promise<void>, onError?: (error: unknown) => void): Promise<void> => {
      publication?.abort();
      const controller = new AbortController(); publication = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal]);
      const result = (async () => {
        try { await waitForAdmission(signal); if (alive() && !signal.aborted) await work(signal); }
        catch (error) { if (!signal.aborted && alive()) onError?.(error); }
        finally { if (publication === controller) publication = null; }
      })();
      return result;
    };
    const abortable = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
    const saveDraft = async (): Promise<void> => {
      if (!live() || !visible || authRequestsPaused()) return;
      const old = currentState();
      if (old.pending || old.uncertain || old.notice === 'conflict' || old.submission !== null || old.draft === null || old.baselineRevision === null || old.resource?.desired === null || old.resource === null) return;
      if (old.resource.desired.revision !== old.baselineRevision) { update(value => ({ ...value, notice: 'conflict' })); return; }
      const controlModeSupported = old.resource.controlModeSupported === true;
      const toolPathsSupported = old.resource.toolPathsSupported === true && toolAccess.current.editable;
      const parsed = parseConfigurationDraft(old.draft, controlModeSupported, { toolPathsSupported, ...(toolAccess.current.platform === undefined ? {} : { platform: toolAccess.current.platform }) });
      if (parsed.value === null || old.baselineDraft !== null && configurationDraftsEqual(old.draft, old.baselineDraft, controlModeSupported, toolPathsSupported)) return;
      const submitted: Submission = { value: parsed.value, revision: old.baselineRevision, draft: structuredClone(old.draft), controlModeSupported, toolPathsSupported, draftRevision, dispatched: false, receipt: null, rejection: null };
      const toolsAdmitted = () => !submitted.toolPathsSupported || toolAccess.current.editable && currentState().resource?.toolPathsSupported === true;
      publication?.abort(); publication = null;
      const controller = new AbortController(); write = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal]);
      const owns = () => alive() && currentState().submission === submitted;
      update(value => ({ ...value, pending: true, error: null, errorSource: null, notice: null, submission: submitted }));
      const settleConfirmed = (incoming: WorkerConfigurationResource) => {
        if (!owns()) return;
        update(value => ({ ...value, pending: false, uncertain: false }));
        void publish(async () => {
          if (!owns()) return;
          update(value => {
            const resource = mergeConfigurationReceipt(value.resource, incoming);
            if (value.abandoned && resource.desired !== null) {
              const draft = draftFromValue(resource.desired.value);
              return { ...value, resource, draft, baselineDraft: draft, baselineRevision: resource.desired.revision, pending: false, uncertain: false, error: null, errorSource: null, notice: 'saved', unavailable: false, submission: null, abandoned: false, protectedDraft: false };
            }
            return { ...value, resource, pending: false, uncertain: false, error: null, errorSource: null, notice: 'saved', unavailable: false, submission: null, baselineDraft: submittedBaseline(value, submitted), baselineRevision: incoming.desired!.revision, protectedDraft: draftRevision !== submitted.draftRevision };
          });
        }, error => { if (owns()) update(value => ({ ...value, error, errorSource: 'write', notice: 'saved' })); });
      };
      try {
        await abortable(waitForAdmission(signal), signal);
        signal.throwIfAborted();
        if (!toolsAdmitted()) {
          update(value => ({ ...value, pending: false, submission: null }));
          return;
        }
        const incoming = await abortable(saveWorkerConfiguration(workerId, submitted.revision, submitted.value, signal, { ...admission, controlModeSupported: submitted.controlModeSupported, toolPathsSupported: submitted.toolPathsSupported, onDispatch: () => {
          // The API can wait for identity again after the scope admission above.
          if (!toolsAdmitted()) throw new Error('Worker tool path editing is unavailable.');
          submitted.dispatched = true;
        }, onConfirmed: receipt => { submitted.receipt = receipt; }, onRejected: error => { submitted.rejection = error; } }), signal);
        settleConfirmed(incoming);
      } catch (error) {
        if (!owns()) return;
        if (submitted.receipt !== null) { settleConfirmed(submitted.receipt); return; }
        error = submitted.rejection ?? error;
        const cancelled = signal.aborted && submitted.rejection === null;
        const conflict = error instanceof ApiError && error.status === 409 && error.code === 'version_conflict';
        const uncertain = submitted.dispatched && (!(error instanceof ApiError) || error.kind !== 'server' || error.status !== null && error.status >= 500);
        update(value => {
          if (!uncertain && value.abandoned && value.resource?.desired) {
            const draft = draftFromValue(value.resource.desired.value);
            return { ...value, draft, baselineDraft: draft, baselineRevision: value.resource.desired.revision, pending: false, error: cancelled ? null : error, errorSource: cancelled ? null : 'write', notice: conflict ? 'conflict' : null, uncertain: false, submission: null, abandoned: false, protectedDraft: false };
          }
          const edited = draftRevision !== submitted.draftRevision;
          const newer = value.resource?.desired != null && value.baselineRevision !== null && BigInt(value.resource.desired.revision) > BigInt(value.baselineRevision);
          const differsFromLatest = value.draft !== null && value.resource?.desired != null && !configurationDraftsEqual(value.draft, draftFromValue(value.resource.desired.value));
          return { ...value, pending: false, error: cancelled && !uncertain ? null : error, errorSource: cancelled && !uncertain ? null : 'write', notice: conflict ? 'conflict' : null, uncertain, submission: uncertain ? submitted : null, protectedDraft: value.protectedDraft || !uncertain && edited && (conflict || newer && differsFromLatest) };
        });
        if ((conflict || uncertain) && !signal.aborted) {
          void publish(async publicationSignal => { await requestRead(true, false, publicationSignal); });
        }
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
    const invalidate = () => { ++generation; read?.abort(); write?.abort(); publication?.abort(); if (polling !== null) clearInterval(polling); polling = null; store(initialState(scope, workerId)); };
    store({ ...currentState(), refreshing: false });
    actions.current = { setEnabled: next => {
      if (enabled === next) return;
      enabled = next;
      if (enabled) { for (const resume of admissionWaiters) resume(); startReads(); }
      else stopReads();
    }, setDraft: change => update(old => {
      if (old.draft === null) return old;
      const draft = typeof change === 'function' ? change(old.draft) : change;
      draftRevision++;
      const newer = old.resource?.desired != null && old.baselineRevision !== null && BigInt(old.resource.desired.revision) > BigInt(old.baselineRevision);
      if (old.protectedDraft && newer && configurationDraftsEqual(draft, draftFromValue(old.resource!.desired!.value))) {
        return { ...old, draft, baselineDraft: draft, baselineRevision: old.resource!.desired!.revision, error: old.errorSource === 'write' ? null : old.error, errorSource: old.errorSource === 'write' ? null : old.errorSource, notice: null, abandoned: false, protectedDraft: false };
      }
      const protectedDraft = old.protectedDraft;
      return { ...old, draft, error: old.errorSource === 'write' ? null : old.error, errorSource: old.errorSource === 'write' ? null : old.errorSource, notice: old.notice === 'conflict' ? 'conflict' : null, abandoned: false, protectedDraft };
    }), refresh: () => { void requestRead(true, true); }, loadLatest: replaceDraft, abandon: abandonDraft, save: saveDraft };
    const unsubscribePause = subscribeAuthPause(() => { write?.abort(); read?.abort(); });
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    startReads();
    return () => {
      active = false; ++generation; read?.abort(); write?.abort(); publication?.abort(); unsubscribePause();
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
  const matchesLatest = conflict && current.draft !== null && current.resource?.desired != null && configurationDraftsEqual(current.draft, draftFromValue(current.resource.desired.value));
  const dirty = !current.abandoned && (!matchesLatest || current.protectedDraft) && current.draft !== null && current.baselineDraft !== null &&
    (!configurationDraftsEqual(current.draft, current.baselineDraft) || current.submission !== null && !configurationDraftsEqual(current.draft, current.submission.draft) || current.protectedDraft);
  return {
    resource: current.resource, draft: current.draft, baselineRevision: current.baselineRevision,
    loading: current.resource === null && !current.unavailable && (current.error === null || current.refreshing),
    refreshing: current.refreshing, pending: current.pending, error: current.error, errorSource: current.errorSource, notice: current.notice, uncertain: current.uncertain, unavailable: current.unavailable,
    dirty, publicationPending: !current.pending && !current.uncertain && current.submission !== null,
    saveableDirty: dirty && current.draft !== null && current.baselineDraft !== null && !configurationDraftsEqual(current.draft, current.baselineDraft, current.resource?.controlModeSupported === true, current.resource?.toolPathsSupported === true && toolPathsEditable),
    conflict,
    setDraft, refresh, loadLatest, save, discard: loadLatest, abandon,
  };
};
