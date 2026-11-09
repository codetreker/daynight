import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { getWorkerPrompt, isPromptText, PROMPT_REQUEST_BYTES, promptSubmissionBytes, saveWorkerPrompt, type PromptTarget } from '../../api/worker-prompts';
import { useProjectAccessSession } from '../projects/ProjectAccess';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TaskCacheLifecycleChanged } from '../task-cache/project-cache';
import { freezeSubmission, initialPromptState, promptDirty, promptReducer, type PromptAction, type PromptState } from './state';

type OwnedState = { readonly owner: object; readonly key: string; readonly state: PromptState; readonly unavailable: boolean };
type Actions = { edit: (text: string) => void; refresh: () => void; save: () => Promise<void>; discard: () => void; abandon: () => void; useLatest: () => void; keepDraft: () => void; setEnabled: (value: boolean) => void };
const emptyActions: Actions = { edit: () => {}, refresh: () => {}, save: async () => {}, discard: () => {}, abandon: () => {}, useLatest: () => {}, keepDraft: () => {}, setEnabled: () => {} };

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
    let read: AbortController | null = null, write: AbortController | null = null, timer: ReturnType<typeof setInterval> | null = null, writeDispatched = false;
    const waiters = new Set<() => void>();
    const alive = () => active && !scope.isInvalidated;
    const get = () => current.current.owner === scope && current.current.key === key ? current.current : initial();
    const store = (value: OwnedState) => { current.current = value; setOwned(value); };
    const dispatch = (action: PromptAction) => { if (alive()) { const old = get(); store({ ...old, state: promptReducer(old.state, action) }); } };
    const clear = () => { read?.abort(); write?.abort(); ++sequence; if (alive()) store({ ...initial(), unavailable: true }); };
    const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
    const waitForAdmission = async (signal: AbortSignal, requireActive: boolean, recover = false) => {
      while (alive()) {
        signal.throwIfAborted();
        if (requireActive && !enabled) await new Promise<void>((resolve, reject) => {
          const resume = () => { waiters.delete(resume); signal.removeEventListener('abort', abort); resolve(); };
          const abort = () => { waiters.delete(resume); reject(signal.reason); };
          waiters.add(resume); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
        try { await scope.ready(signal); } catch (error) {
          if (error instanceof TaskCacheLifecycleChanged && alive() && !signal.aborted) continue;
          throw error;
        }
        if (access !== null) {
          const allowed = await access.waitForFreshAccess(signal, requireActive);
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
        if (!requireActive || enabled) return;
      }
      signal.throwIfAborted();
    };
    const denied = (error: unknown) => error instanceof ApiError && error.status === 404 && error.code === 'not_found';
    const readNow = async (replace = false) => {
      if (!alive() || !enabled || !visible || (read !== null && !replace)) return;
      if (replace) read?.abort();
      const controller = new AbortController(); read = controller;
      const signal = AbortSignal.any([controller.signal, scope.signal]), id = ++sequence;
      dispatch({ type: 'read/start', id });
      try {
        await waitForAdmission(signal, true);
        const resource = await getWorkerPrompt(target, signal, admission);
        await waitForAdmission(signal, true);
        if (!alive() || signal.aborted || read !== controller) return;
        if (get().unavailable) store({ ...get(), unavailable: false });
        dispatch({ type: get().state.write === 'unknown' ? 'reconcile/success' : 'read/success', id, resource });
      } catch (error) {
        if (!alive() || signal.aborted || read !== controller) return;
        try { await waitForAdmission(signal, true); } catch (failure) {
          if (denied(failure) && alive()) clear();
          else if (alive() && !signal.aborted) dispatch({ type: get().state.write === 'unknown' ? 'reconcile/error' : 'read/error', id, error: 'read' });
          return;
        }
        if (denied(error)) { clear(); return; }
        dispatch({ type: get().state.write === 'unknown' ? 'reconcile/error' : 'read/error', id, error: 'read' });
      } finally { if (read === controller) read = null; }
    };
    const saveNow = async () => {
      if (!alive() || !enabled || !visible || get().unavailable) return;
      const state = get().state, submission = freezeSubmission(state, scope.userId, ++sequence);
      if (submission === null || !promptDirty(state) || !isPromptText(submission.text) || promptSubmissionBytes({ expectedUserId: submission.expectedUserId, revision: submission.revision, text: submission.text }) > PROMPT_REQUEST_BYTES) return;
      const controller = new AbortController(); write = controller;
      writeDispatched = false;
      const signal = AbortSignal.any([controller.signal, scope.signal]);
      let dispatched = false;
      dispatch({ type: 'write/start', submission });
      try {
        await waitForAdmission(signal, true);
        const resource = await saveWorkerPrompt(target, submission, signal, { ...admission, onDispatch: () => { dispatched = true; writeDispatched = true; } });
        await waitForAdmission(signal, false, true);
        if (alive() && !signal.aborted) dispatch({ type: 'write/success', id: submission.id, resource });
      } catch (error) {
        if (!alive() || signal.aborted) return;
        try { await waitForAdmission(signal, false, dispatched); } catch (failure) {
          if (denied(failure) && alive()) clear();
          else if (!dispatched && alive() && !signal.aborted) dispatch({ type: 'write/error', id: submission.id, error: 'write' });
          return;
        }
        if (denied(error)) { clear(); return; }
        const conflict = error instanceof ApiError && error.status === 409 && error.code === 'version_conflict';
        const uncertain = dispatched && (!(error instanceof ApiError) || error.kind !== 'server' || error.status === null || error.status >= 500);
        dispatch({ type: uncertain ? 'write/unknown' : conflict ? 'write/conflict' : 'write/error', id: submission.id, error: 'write' });
        if (conflict || uncertain) void readNow(true);
      } finally { if (write === controller) write = null; }
    };
    const stopReads = () => { ++sequence; read?.abort(); read = null; if (timer !== null) clearInterval(timer); timer = null; };
    const startReads = () => { if (!alive() || !enabled || !visible) return; void readNow(); if (timer === null) timer = setInterval(() => { void readNow(); }, 30_000); };
    const visibility = () => { const next = document.visibilityState !== 'hidden'; if (next === visible) return; visible = next; stopReads(); if (visible) startReads(); };
    const focus = () => { if (visible && enabled) void readNow(true); };
    const invalidate = () => { stopReads(); write?.abort(); store(initial()); };
    const unsubscribe = access?.subscribe(() => { if (access.snapshot().status === 'unavailable') clear(); });
    store(get());
    actions.current = { setEnabled: next => { if (enabled === next) return; enabled = next; if (enabled) { for (const resume of waiters) resume(); startReads(); } else stopReads(); }, edit: text => dispatch({ type: 'edit', text }), refresh: () => { void readNow(true); }, save: saveNow, discard: () => dispatch({ type: 'discard' }), abandon: () => {
      const state = get().state;
      if (state.write === 'pending' && state.submission !== null && !writeDispatched) {
        write?.abort();
        dispatch({ type: 'write/cancel', id: state.submission.id });
      } else dispatch({ type: 'abandon' });
    }, useLatest: () => dispatch({ type: 'useLatest' }), keepDraft: () => dispatch({ type: 'keepDraft' }) };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); scope.signal.addEventListener('abort', invalidate, { once: true }); startReads();
    return () => { active = false; stopReads(); write?.abort(); unsubscribe?.(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); scope.signal.removeEventListener('abort', invalidate); actions.current = emptyActions; };
  }, [scope, key, target, access]);
  useLayoutEffect(() => { actions.current.setEnabled(readEnabled); }, [scope, key, readEnabled]);
  const state = owned.owner === scope && owned.key === key && !scope.isInvalidated ? owned.state : initialPromptState();
  const unavailable = owned.owner === scope && owned.key === key && owned.unavailable;
  const submission = state.baseline === null ? null : { expectedUserId: scope.userId, revision: state.baseline.revision, text: state.draft };
  const invalid = !isPromptText(state.draft), tooLarge = submission !== null && promptSubmissionBytes(submission) > PROMPT_REQUEST_BYTES;
  return { ...state, loading: state.resource === null && state.read !== 'error' && !unavailable, unavailable, dirty: promptDirty(state), pending: state.write === 'pending', uncertain: state.write === 'unknown', invalid, tooLarge, readEnabled, edit, refresh, save, discard, abandon, useLatest, keepDraft };
};
export type WorkerPromptController = ReturnType<typeof useWorkerPrompt>;
