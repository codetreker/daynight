import { useLayoutEffect } from 'react';
import { authRequestsPaused, hasActiveAuthenticatedRead, recentAuthenticatedRead, subscribeAuthPause } from '../../api/client';
import { reportBrowserSessionActivity } from '../../api/session-activity';
import { useOptionalTaskCacheScope } from '../task-cache/TaskCacheProvider';

// Much shorter than the seven-day expiry but infrequent while a view is idle.
const interval = 5 * 60_000;

export function useBrowserSessionActivity(userId: string, enabled: boolean): void {
  const scope = useOptionalTaskCacheScope();
  useLayoutEffect(() => {
    if (!enabled || scope === null || scope.userId !== userId || scope.isInvalidated) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: AbortController | null = null;
    let stopped = false;
    let lastReport = Date.now();
    const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; pending?.abort(); pending = null; };
    const schedule = () => {
      clear();
      if (stopped || scope.isInvalidated || scope.signal.aborted || scope.mismatchSignal.aborted || authRequestsPaused() || document.visibilityState === 'hidden') return;
      const last = Math.max(lastReport, recentAuthenticatedRead(userId) ?? 0);
      timer = setTimeout(() => {
        timer = null;
        if (stopped || scope.isInvalidated || scope.signal.aborted || scope.mismatchSignal.aborted || authRequestsPaused() || document.visibilityState === 'hidden') return;
        if (hasActiveAuthenticatedRead()) { lastReport = Date.now(); schedule(); return; }
        if (Date.now() - Math.max(lastReport, recentAuthenticatedRead(userId) ?? 0) < interval) { schedule(); return; }
        const owner = new AbortController(); pending = owner;
        lastReport = Date.now();
        void reportBrowserSessionActivity(userId, AbortSignal.any([owner.signal, scope.signal, scope.mismatchSignal]), scope.principalMismatch).catch(() => {}).finally(() => {
          if (pending === owner) { pending = null; schedule(); }
        });
      }, Math.max(0, last + interval - Date.now()));
    };
    const visibility = () => { if (document.visibilityState === 'hidden') clear(); else schedule(); };
    const unsubscribe = subscribeAuthPause(clear);
    scope.signal.addEventListener('abort', clear, { once: true });
    scope.mismatchSignal.addEventListener('abort', clear, { once: true });
    document.addEventListener('visibilitychange', visibility);
    schedule();
    return () => { stopped = true; clear(); unsubscribe(); scope.signal.removeEventListener('abort', clear); scope.mismatchSignal.removeEventListener('abort', clear); document.removeEventListener('visibilitychange', visibility); };
  }, [scope, userId, enabled]);
}
