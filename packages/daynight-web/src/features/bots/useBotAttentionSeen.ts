import { useEffect, useMemo, useRef, useState } from 'react';
import { authRequestsPaused } from '../../api/client';
import { markBotAttentionSeen } from '../../api/bots';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';

/** A conversation opening admits one seen write, independent of the persistent proposal count. */
export function useBotAttentionSeen(botId: string | null, enabled: boolean, needsAttention: boolean, refresh: () => void) {
  const scope = useTaskCacheScope();
  const opening = useMemo(() => ({ handled: false }), [scope, botId]);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const [failure, setFailure] = useState<{ opening: typeof opening; error: unknown } | null>(null);
  useEffect(() => {
    if (botId === null || !enabled || opening.handled) return;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, scope.signal]);
    const allowed = () => !signal.aborted && !scope.isInvalidated && !authRequestsPaused() && document.visibilityState !== 'hidden';
    const run = async () => {
      if (!allowed() || opening.handled) return;
      try {
        await scope.ready(signal);
        if (!allowed() || opening.handled) return;
        // The first confirmed empty count also consumes this opening. Later
        // background reads do not mean the user has opened the conversation again.
        if (!needsAttention) { opening.handled = true; return; }
        await markBotAttentionSeen(botId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch }, () => { opening.handled = true; });
        if (allowed()) { setFailure(null); latestRefresh.current(); }
      } catch (error) {
        if (allowed()) {
          setFailure({ opening, error });
          // Observe the actual count after a lost response; replay could clear newer events.
          latestRefresh.current();
        }
      }
    };
    const visibility = () => { void run(); };
    void run();
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [scope, botId, enabled, needsAttention, opening]);
  return failure?.opening === opening && !scope.isInvalidated ? failure.error : null;
}
