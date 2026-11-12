import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, subscribeAuthPause } from '../../api/client';
import { getWorkerPrompt, isPromptText, PROMPT_REQUEST_BYTES, promptSubmissionBytes, saveWorkerPrompt, type PromptResource, type PromptTarget } from '../../api/worker-prompts';
import { useProjectAccessSession } from '../projects/ProjectAccess';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { isRetryableTaskCacheLifecycleChange } from '../task-cache/project-cache';
import { freezeSubmission, initialPromptState, promptDirty, promptReducer, type PromptAction, type PromptState } from './state';

type OwnedState = { readonly owner: object; readonly key: string; readonly state: PromptState; readonly unavailable: boolean };
type Actions = { edit: (text: string) => void; refresh: () => void; save: () => Promise<void>; discard: () => void; abandon: () => void; useLatest: () => void; keepDraft: () => void; setEnabled: (value: boolean) => void };
const emptyActions: Actions = { edit: () => {}, refresh: () => {}, save: async () => {}, discard: () => {}, abandon: () => {}, useLatest: () => {}, keepDraft: () => {}, setEnabled: () => {} };

const abortable = <T,>(work: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  if (signal.aborted) abort();
});

export const useWorkerPrompt = (input: PromptTarget, { readEnabled }: { readonly readEnabled: boolean }) => {
  const scope = useTaskCacheScope();
  const key = input.scope === 'user' ? 'user' : input.scope === 'project' ? `project:${input.projectId}` : `worker:${input.workerId}`;
  const target = useMemo((): PromptTarget => input.scope === 'user' ? { scope: 'user' } : input.scope === 'project' ? { scope: 'project', projectId: input.projectId } : { scope: 'worker', workerId: input.workerId }, [key]);
  const access = useProjectAccessSession(target.scope === 'project' ? target.projectId : '');
  const initial = (): OwnedState => ({ owner: scope, key, state: initialPromptState(), unavailable: false });
  const [owned, setOwned] = useState<OwnedState>(initial);
  const current = useRef(owned), actions = useRef<Actions>(emptyActions);
  const edit = useCallback((text: string) => actions.current.edit(text), []);
  const refresh = useCallback(() => actions.current.refresh(), []);
  const save = useCallback(() => actions.current.save(), []);
  const discard = useCallback(() => actions.current.discard(), []);
  const abandon = useCallback(() => actions.current.abandon(), []);
  const useLatest = useCallback(() => actions.current.useLatest(), []);
  const keepDraft = useCallback(() => actions.current.keepDraft(), []);

  useLayoutEffect(() => {
    let active = true, enabled = readEnabled, visible = document.visibilityState !== 'hidden', sequence = 0;
    let read: AbortController | null = null, write: AbortController | null = null, publication: AbortController | null = null, denial: AbortController | null = null, timer: ReturnType<typeof setInterval> | null = null, writeDispatched = false;
    let denialKind: 'access' | 'resource' | null = null;
    const waiters = new Set<() => void>();
    const alive = () => active && !scope.isInvalidated;
    const get = () => current.current.owner === scope && current.current.key === key ? current.current : initial();
    const store = (value: OwnedState) => { current.current = value; setOwned(value); };
    const dispatch = (action: PromptAction) => { if (alive()) { const old = get(); store({ ...old, state: promptReducer(old.state, action) }); } };
    const clear = () => { read?.abort(); write?.abort(); publication?.abort(); publication = null; denial?.abort(); denial = null; ++sequence; if (alive()) store({ ...initial(), unavailable: true }); };
    const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
    const waitForAdmission = async (signal: AbortSignal, requireActive: boolean, recover = false) => {
      while (alive()) {
        signal.throwIfAborted();
        if (requireActive && !enabled) await new Promise<void>((resolve, reject) => {
          const resume = () => { waiters.delete(resume); signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { waiters.delete(resume); reject(signal.reason); };
          waiters.add(resume); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
        try { await abortable(scope.ready(signal), signal); } catch (error) {
          if (isRetryableTaskCacheLifecycleChange(error) && alive() && !signal.aborted) continue;
          throw error;
        }
        if (access !== null) {
          let allowed;
          try { allowed = await abortable(access.waitForFreshAccess(signal, requireActive), signal); }
          catch (error) {
            if (isRetryableTaskCacheLifecycleChange(error) && alive() && !signal.aborted) continue;
            throw error;
          }
          if (allowed === null) {
            const snapshot = access.snapshot();
            if (snapshot.status === 'unavailable') throw new ApiError('server', 404, 'not_found');
            if (snapshot.status !== 'loading' && !snapshot.refreshing && !recover) throw new ApiError('network');
            await new Promise<void>((resolve, reject) => {
              const finish = () => { unsubscribe(); signal.removeEventListener('abort', abort); resolve(); };
              const abort = () => { unsubscribe(); reject(signal.reason); };
              const unsubscribe = access.subscribe(finish);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort(); else if (access.snapshot() !== snapshot) finish();
            });
            continue;
          }
        }
        signal.throwIfAborted();
        if (authRequestsPaused()) continue;
        if (!requireActive || enabled) return;
      }
      signal.throwIfAborted();
    };
    const denied = (error: unknown) => error instanceof ApiError && error.kind === 'server' && error.status === 404 && error.code === 'not_found';
    const clearWhenAdmitted = (stillDenied: () => boolean, kind: 'access' | 'resource' = 'resource') => {
      if (kind === 'access' && denial !== null && denialKind === 'resource') return;
      denial?.abort();
      const controller = new AbortController(); denial = controller; denialKind = kind;
      const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
      const work = async () => {
        try {
          while (alive() && !signal.aborted && denial === controller) {
            try { await abortable(scope.ready(signal), signal); }
            catch (error) { if (isRetryableTaskCacheLifecycleChange(error) && !signal.aborted) continue; throw error; }
            if (authRequestsPaused()) continue;
            if (alive() && !signal.aborted && !scope.hasIdentityMismatch && denial === controller && stillDenied()) clear();
            return;
          }
        } catch { /* The owning scope or denial was retired. */ }
        finally { if (denial === controller) { denial = null; denialKind = null; } }
      };
      void work();
    };
    const publish = (apply: () => void) => {
      publication?.abort();
      const controller = new AbortController(); publication = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
      const work = async () => {
        try {
          while (alive() && !signal.aborted && publication === controller) {
            try {
              await abortable(waitForAdmission(signal, false, true), signal);
              const snapshot = access?.snapshot();
              if (authRequestsPaused() || snapshot && (snapshot.status !== 'ready' || snapshot.refreshing)) continue;
              if (alive() && !signal.aborted && !scope.hasIdentityMismatch && publication === controller) apply();
              return;
            } catch (error) {
              if (!alive() || signal.aborted || publication !== controller) return;
              if (!denied(error)) return;
              if (authRequestsPaused() || access?.snapshot().status === 'ready') continue;
              clear(); return;
            }
          }
        } finally { if (publication === controller) publication = null; }
      };
      void work();
    };
    const readNow = async (replace = false) => {
      if (!alive() || scope.hasIdentityMismatch || !enabled || !visible || authRequestsPaused() || denial !== null || (read !== null && !replace)) return;
      if (replace) read?.abort();
      const controller = new AbortController(); read = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]), id = ++sequence;
      let stage: 'before' | 'request' | 'after' = 'before';
      dispatch({ type: 'read/start', id });
      try {
        await waitForAdmission(signal, true);
        stage = 'request';
        const resource = await abortable(getWorkerPrompt(target, signal, admission), signal);
        stage = 'after';
        do {
          await waitForAdmission(signal, true);
          const snapshot = access?.snapshot();
          if (!authRequestsPaused() && (!snapshot || snapshot.status === 'ready' && !snapshot.refreshing)) break;
        } while (alive() && !signal.aborted && read === controller);
        if (scope.hasIdentityMismatch && alive() && read === controller) { dispatch({ type: 'read/cancel', id }); return; }
        if (!alive() || signal.aborted || read !== controller) return;
        if (get().unavailable) store({ ...get(), unavailable: false });
        dispatch({ type: get().state.write === 'unknown' ? 'reconcile/success' : 'read/success', id, resource });
      } catch (error) {
        if (!alive() || read !== controller) return;
        if (scope.hasIdentityMismatch) { dispatch({ type: 'read/cancel', id }); return; }
        if (signal.aborted) return;
        try { await waitForAdmission(signal, true); } catch (failure) {
          if (scope.hasIdentityMismatch) { dispatch({ type: 'read/cancel', id }); return; }
          if (denied(failure) && alive()) {
            if (stage === 'request' && denied(error)) clearWhenAdmitted(() => true);
            else clearWhenAdmitted(() => access?.snapshot().status !== 'ready', 'access');
          }
          else if (alive() && !signal.aborted) dispatch({ type: get().state.write === 'unknown' ? 'reconcile/error' : 'read/error', id, error: 'read' });
          return;
        }
        if (denied(error)) {
          if (stage === 'request') clearWhenAdmitted(() => true);
          else clearWhenAdmitted(() => access?.snapshot().status !== 'ready', 'access');
          return;
        }
        dispatch({ type: get().state.write === 'unknown' ? 'reconcile/error' : 'read/error', id, error: 'read' });
      } finally { if (read === controller) read = null; }
    };
    const saveNow = async () => {
      if (!alive() || scope.hasIdentityMismatch || !enabled || !visible || authRequestsPaused() || denial !== null || get().unavailable) return;
      const state = get().state, submission = freezeSubmission(state, scope.userId, ++sequence);
      if (submission === null || !promptDirty(state) || !isPromptText(submission.text) || promptSubmissionBytes({ expectedUserId: submission.expectedUserId, revision: submission.revision, text: submission.text }) > PROMPT_REQUEST_BYTES) return;
      publication?.abort(); publication = null;
      const controller = new AbortController(); write = controller;
      writeDispatched = false;
      const signal = AbortSignal.any([controller.signal, scope.signal, scope.mismatchSignal]);
      let dispatched = false;
      let receipt: PromptResource | null = null;
      let rejection: ApiError | null = null;
      const confirmed = (resource: PromptResource) => {
        if (!alive() || get().state.write !== 'pending' || get().state.submission?.id !== submission.id) return;
        dispatch({ type: 'write/confirmed', id: submission.id });
        publish(() => dispatch({ type: 'write/success', id: submission.id, resource }));
      };
      dispatch({ type: 'write/start', submission });
      try {
        if (authRequestsPaused()) controller.abort();
        await abortable(waitForAdmission(signal, true), signal);
        signal.throwIfAborted();
        const resource = await abortable(saveWorkerPrompt(target, submission, signal, { ...admission, onDispatch: () => { signal.throwIfAborted(); dispatched = true; writeDispatched = true; }, onReceipt: value => { receipt = value; }, onRejection: error => { rejection = error; } }), signal);
        confirmed(resource);
      } catch (error) {
        if (!alive()) return;
        if (receipt !== null) { confirmed(receipt); return; }
        if (scope.hasIdentityMismatch) {
          const observed = rejection ?? error;
          const refusal = observed instanceof ApiError && observed.kind === 'server' && observed.status !== null && observed.status >= 400 && observed.status < 500;
          dispatch({ type: 'write/settle', id: submission.id, outcome: !dispatched || refusal ? observed instanceof ApiError && observed.code === 'version_conflict' ? 'conflict' : 'refused' : 'unknown' });
          return;
        }
        if (signal.aborted && rejection === null && !(error instanceof ApiError && error.kind === 'server' && error.status !== null && error.status >= 400 && error.status < 500)) {
          dispatch(dispatched ? { type: 'write/unknown', id: submission.id, error: 'write' } : { type: 'write/interrupted', id: submission.id });
          return;
        }
        error = rejection ?? error;
        if (denied(error)) {
          dispatch({ type: 'write/error', id: submission.id, error: 'write' });
          if (dispatched) clearWhenAdmitted(() => true);
          else clearWhenAdmitted(() => access?.snapshot().status !== 'ready', 'access');
          return;
        }
        const conflict = error instanceof ApiError && error.status === 409 && error.code === 'version_conflict';
        const uncertain = dispatched && (!(error instanceof ApiError) || error.kind !== 'server' || error.status === null || error.status >= 500);
        dispatch({ type: uncertain ? 'write/unknown' : conflict ? 'write/conflict' : 'write/error', id: submission.id, error: 'write' });
        if ((conflict || uncertain) && !authRequestsPaused()) void readNow(true);
      } finally { if (write === controller) write = null; }
    };
    const stopReads = () => { ++sequence; read?.abort(); read = null; if (timer !== null) clearInterval(timer); timer = null; };
    const startReads = () => { if (!alive() || !enabled || !visible) return; void readNow(); if (timer === null) timer = setInterval(() => { void readNow(); }, 30_000); };
    const visibility = () => { const next = document.visibilityState !== 'hidden'; if (next === visible) return; visible = next; stopReads(); if (visible) startReads(); };
    const focus = () => { if (visible && enabled) void readNow(true); };
    const invalidate = () => { stopReads(); write?.abort(); publication?.abort(); publication = null; denial?.abort(); denial = null; store(initial()); };
    const unsubscribe = access?.subscribe(() => {
      if (access.snapshot().status === 'unavailable') clearWhenAdmitted(() => access.snapshot().status !== 'ready', 'access');
      else if (access.snapshot().status === 'ready' && denialKind === 'access') { denial?.abort(); denial = null; denialKind = null; }
    });
    const unsubscribePause = subscribeAuthPause(() => { write?.abort(); });
    store(get());
    actions.current = { setEnabled: next => { if (enabled === next) return; enabled = next; if (enabled) { for (const resume of waiters) resume(); startReads(); } else stopReads(); }, edit: text => dispatch({ type: 'edit', text }), refresh: () => { void readNow(true); }, save: saveNow, discard: () => dispatch({ type: 'discard' }), abandon: () => {
      const state = get().state;
      if (state.write === 'pending' && state.submission !== null && !writeDispatched) {
        write?.abort();
        dispatch({ type: 'write/cancel', id: state.submission.id });
      } else dispatch({ type: 'abandon' });
    }, useLatest: () => dispatch({ type: 'useLatest' }), keepDraft: () => dispatch({ type: 'keepDraft' }) };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); scope.signal.addEventListener('abort', invalidate, { once: true }); startReads();
    return () => { active = false; stopReads(); write?.abort(); publication?.abort(); publication = null; denial?.abort(); denial = null; unsubscribe?.(); unsubscribePause(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); scope.signal.removeEventListener('abort', invalidate); actions.current = emptyActions; };
  }, [scope, key, target, access]);
  useLayoutEffect(() => { actions.current.setEnabled(readEnabled); }, [scope, key, readEnabled]);
  const state = owned.owner === scope && owned.key === key && !scope.isInvalidated ? owned.state : initialPromptState();
  const unavailable = owned.owner === scope && owned.key === key && owned.unavailable;
  const submission = state.baseline === null ? null : { expectedUserId: scope.userId, revision: state.baseline.revision, text: state.draft };
  const invalid = !isPromptText(state.draft), tooLarge = submission !== null && promptSubmissionBytes(submission) > PROMPT_REQUEST_BYTES;
  return { ...state, loading: state.resource === null && state.read !== 'error' && !unavailable, unavailable, dirty: promptDirty(state), pending: state.write === 'pending', confirmed: state.write === 'confirmed', uncertain: state.write === 'unknown', invalid, tooLarge, readEnabled, edit, refresh, save, discard, abandon, useLatest, keepDraft };
};
export type WorkerPromptController = ReturnType<typeof useWorkerPrompt>;
