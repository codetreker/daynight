import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';

const inactive = () => new DOMException('The read is not active.', 'AbortError');
type Waiter = { readonly resolve: () => void; readonly reject: (error: unknown) => void };
type ReadState<T> = { readonly scope: TaskCacheScope; readonly key: string; readonly value: T | null; readonly error: unknown; readonly busy: boolean; readonly stale: boolean };
/**
 * Poll only visible, admitted resources; an old resource never supplies the new target's value.
 * reread resolves once a read that started after the call has stored its value, and rejects when that read fails or cannot run.
 */
export function useBotRead<T>(key: string, enabled: boolean, load: (scope: TaskCacheScope, signal: AbortSignal) => Promise<T>) {
  const scope = useTaskCacheScope();
  const empty = (): ReadState<T> => ({ scope, key, value: null, error: null, busy: false, stale: true });
  const [state, setState] = useState<ReadState<T>>(empty);
  const action = useRef<() => void>(() => {});
  const fresh = useRef<(waiter: Waiter) => void>(waiter => waiter.reject(inactive()));
  const refresh = useCallback(() => action.current(), []);
  const reread = useCallback(() => new Promise<void>((resolve, reject) => fresh.current({ resolve, reject })), []);
  useLayoutEffect(() => {
    let live = true, controller: AbortController | null = null, timer: ReturnType<typeof setInterval> | null = null, again = false;
    // Waiters registered while a read is in flight are served by the next read, which starts after them.
    let waiting: Waiter[] = [];
    const settle = (served: readonly Waiter[], error?: unknown) => { for (const waiter of served) { if (error === undefined) waiter.resolve(); else waiter.reject(error); } };
    const eligible = () => live && enabled && !scope.isInvalidated && document.visibilityState !== 'hidden';
    const allowed = () => eligible() && !authRequestsPaused();
    const run = async () => {
      if (controller) return;
      if (!allowed()) { settle(waiting.splice(0), inactive()); return; }
      const attempt = new AbortController(); controller = attempt; again = false;
      const served = waiting.splice(0);
      let outcome: unknown = inactive();
      const signal = AbortSignal.any([attempt.signal, scope.signal]);
      setState(old => ({ ...(old.scope === scope && old.key === key ? old : empty()), busy: true }));
      try {
        await scope.ready(signal);
        if (!allowed() || signal.aborted) return;
        const value = await load(scope, signal);
        await scope.ready(signal);
        if (allowed() && !signal.aborted) { setState({ scope, key, value, error: null, busy: false, stale: false }); outcome = undefined; }
      } catch (error) {
        if (allowed() && !signal.aborted) { setState(old => ({ ...old, busy: false, stale: true, error })); outcome = error; }
      } finally {
        settle(served, outcome);
        if (controller === attempt) {
          controller = null;
          if (!allowed() || signal.aborted) setState(old => old.scope === scope && old.key === key && old.busy ? { ...old, busy: false } : old);
          if (again) void run();
        }
      }
    };
    const cancel = () => {
      settle(waiting.splice(0), inactive());
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
    const visibility = () => {
      if (eligible() && timer !== null) void run();
      else sync();
    };
    action.current = () => { void run(); };
    fresh.current = waiter => { waiting.push(waiter); if (controller) again = true; else void run(); };
    sync();
    document.addEventListener('visibilitychange', visibility);
    scope.signal.addEventListener('abort', invalidate, { once: true });
    return () => { live = false; stop(); settle(waiting.splice(0), inactive()); fresh.current = waiter => waiter.reject(inactive()); document.removeEventListener('visibilitychange', visibility); scope.signal.removeEventListener('abort', invalidate); action.current = () => {}; };
  }, [scope, key, enabled, load]);
  const current = state.scope === scope && state.key === key && !scope.isInvalidated ? state : empty();
  return { ...current, refresh, reread };
}
