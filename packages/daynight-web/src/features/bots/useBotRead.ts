import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

type ReadState<T> = { readonly scope: TaskCacheScope; readonly key: string; readonly value: T | null; readonly error: unknown; readonly busy: boolean; readonly stale: boolean };
/** Poll only visible, admitted resources; an old resource never supplies the new target's value. */
export function useBotRead<T>(key: string, enabled: boolean, load: (scope: TaskCacheScope, signal: AbortSignal) => Promise<T>) {
  const scope = useTaskCacheScope();
  const empty = (): ReadState<T> => ({ scope, key, value: null, error: null, busy: false, stale: true });
  const [state, setState] = useState<ReadState<T>>(empty);
  const action = useRef<() => void>(() => {});
  const refresh = useCallback(() => action.current(), []);
  useLayoutEffect(() => {
    let live = true, controller: AbortController | null = null, timer: ReturnType<typeof setInterval> | null = null;
    const eligible = () => live && enabled && !scope.isInvalidated && document.visibilityState !== 'hidden';
    const allowed = () => eligible() && !authRequestsPaused();
    const run = async () => {
      if (!allowed() || controller) return;
      const attempt = new AbortController(); controller = attempt;
      const signal = AbortSignal.any([attempt.signal, scope.signal]);
      setState(old => ({ ...(old.scope === scope && old.key === key ? old : empty()), busy: true }));
      try {
        await scope.ready(signal);
        if (!allowed() || signal.aborted) return;
        const value = await load(scope, signal);
        await scope.ready(signal);
        if (allowed() && !signal.aborted) setState({ scope, key, value, error: null, busy: false, stale: false });
      } catch (error) {
        if (allowed() && !signal.aborted) setState(old => ({ ...old, busy: false, stale: true, error }));
      } finally {
        if (controller === attempt) {
          controller = null;
          if (!allowed() || signal.aborted) setState(old => old.scope === scope && old.key === key && old.busy ? { ...old, busy: false } : old);
        }
      }
    };
    const cancel = () => {
      if (!controller) return;
      controller.abort(); controller = null;
      setState(old => old.scope === scope && old.key === key && old.busy ? { ...old, busy: false } : old);
    };
    const stop = () => { if (timer !== null) clearInterval(timer); timer = null; cancel(); };
    const sync = () => {
      if (!eligible()) { stop(); return; }
      if (timer !== null) return;
      void run();
      timer = setInterval(() => { if (!allowed()) cancel(); else void run(); }, 5_000);
    };
    const invalidate = () => { stop(); setState(empty()); };
    action.current = () => { void run(); };
    sync();
    document.addEventListener('visibilitychange', sync);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    return () => { live = false; stop(); document.removeEventListener('visibilitychange', sync); scope.signal.removeEventListener('abort', invalidate); action.current = () => {}; };
  }, [scope, key, enabled, load]);
  const current = state.scope === scope && state.key === key && !scope.isInvalidated ? state : empty();
  return { ...current, refresh };
}
