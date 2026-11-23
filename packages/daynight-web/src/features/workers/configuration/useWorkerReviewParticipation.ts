import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, authRequestsPaused, subscribeAuthPause } from '../../../api/client';
import { getWorkerReviewParticipation, saveWorkerReviewParticipation, type WorkerReviewParticipation } from '../../../api/worker-review-participation';
import { useTaskCacheScope, type TaskCacheScope } from '../../task-cache/TaskCacheProvider';

type Notice = 'saved' | 'conflict' | 'unknown' | 'rejected' | null;
type State = { readonly scope: TaskCacheScope; readonly workerId: string; readonly value: WorkerReviewParticipation | null; readonly reading: boolean; readonly pending: boolean; readonly needsRead: boolean; readonly unavailable: boolean; readonly error: unknown; readonly notice: Notice };
const initial = (scope: TaskCacheScope, workerId: string): State => ({ scope, workerId, value: null, reading: false, pending: false, needsRead: false, unavailable: false, error: null, notice: null });
type Actions = { enable: (value: boolean) => void; refresh: () => void; toggle: () => void };
const noActions: Actions = { enable: () => {}, refresh: () => {}, toggle: () => {} };

export const useWorkerReviewParticipation = (workerId: string, readEnabled: boolean) => {
  const scope = useTaskCacheScope();
  const [state, setState] = useState(() => initial(scope, workerId));
  const stateRef = useRef(state), actions = useRef<Actions>(noActions);
  const refresh = useCallback(() => actions.current.refresh(), []);
  const toggle = useCallback(() => actions.current.toggle(), []);
  useLayoutEffect(() => {
    let active = true, enabled = readEnabled, generation = 0;
    let read: AbortController | null = null, write: AbortController | null = null;
    const alive = () => active && !scope.isInvalidated;
    const current = () => stateRef.current.scope === scope && stateRef.current.workerId === workerId ? stateRef.current : initial(scope, workerId);
    const update = (fn: (value: State) => State) => { if (alive()) { const next = fn(current()); stateRef.current = next; setState(next); } };
    const admission = { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch };
    const stopRead = () => { generation++; read?.abort(); read = null; update(old => ({ ...old, reading: false })); };
    const load = () => {
      if (!alive() || !enabled || authRequestsPaused() || current().pending || read !== null) return;
      const controller = new AbortController(); read = controller; const ticket = ++generation;
      update(old => ({ ...old, reading: true, error: null }));
      void (async () => {
        try {
          await scope.ready(controller.signal);
          if (!enabled) return;
          const value = await getWorkerReviewParticipation(workerId, controller.signal, admission);
          if (alive() && ticket === generation) update(old => ({ ...old, value, reading: false, needsRead: false, unavailable: false, error: null }));
        } catch (error) {
          if (!alive() || ticket !== generation || controller.signal.aborted) return;
          const unavailable = !current().needsRead && error instanceof ApiError && error.status === 404;
          update(old => ({ ...old, reading: false, unavailable, error: unavailable ? null : error }));
        } finally { if (read === controller) read = null; }
      })();
    };
    const submit = () => {
      const old = current();
      if (!enabled || !alive() || authRequestsPaused() || old.pending || old.needsRead || old.value === null || old.unavailable) return;
      stopRead();
      const controller = new AbortController(); write = controller;
      const baseline = old.value; let dispatched = false;
      update(value => ({ ...value, pending: true, error: null, notice: null }));
      void (async () => {
        try {
          await scope.ready(controller.signal);
          if (!enabled || !alive()) throw new DOMException('Inactive page', 'AbortError');
          const value = await saveWorkerReviewParticipation(workerId, !baseline.enabled, baseline.version, controller.signal, admission, () => {
            if (!enabled || !alive() || authRequestsPaused()) throw new DOMException('Inactive page', 'AbortError');
            dispatched = true;
          });
          if (alive()) update(state => ({ ...state, value, pending: false, needsRead: false, notice: 'saved', error: null }));
        } catch (error) {
          if (!alive()) return;
          const conflict = error instanceof ApiError && error.kind === 'server' && error.status === 409;
          const uncertain = dispatched && (!(error instanceof ApiError) || error.writeOutcome !== 'not_committed' && (error.kind !== 'server' || error.status === null || error.status >= 500 || error.status === 408 || error.status === 429 || error.code === 'write_outcome_unknown'));
          update(state => ({ ...state, pending: false, needsRead: conflict || uncertain, notice: conflict ? 'conflict' : uncertain ? 'unknown' : controller.signal.aborted ? null : 'rejected', error: controller.signal.aborted && !uncertain ? null : error }));
          if ((conflict || uncertain) && enabled) load();
        } finally { if (write === controller) write = null; }
      })();
    };
    actions.current = { enable: next => { if (enabled === next) return; enabled = next; if (!enabled) stopRead(); else if (!current().pending) load(); }, refresh: load, toggle: submit };
    const pause = subscribeAuthPause(() => { stopRead(); write?.abort(); });
    const invalidate = () => { stopRead(); write?.abort(); };
    scope.signal.addEventListener('abort', invalidate, { once: true });
    if (enabled) load();
    return () => { active = false; generation++; read?.abort(); write?.abort(); pause(); scope.signal.removeEventListener('abort', invalidate); actions.current = noActions; };
  }, [scope, workerId]);
  useLayoutEffect(() => { actions.current.enable(readEnabled); }, [scope, workerId, readEnabled]);
  const current = state.scope === scope && state.workerId === workerId && !scope.isInvalidated ? state : initial(scope, workerId);
  return { ...current, refresh, toggle };
};
