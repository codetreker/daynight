import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { authRequestsPaused } from '../../api/client';
import { getBot, type Bot } from '../../api/bots';
import { useTaskCacheScope, type TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { BotDetailCache, type BotDetailRequest } from './detail-cache';
import { getBotDeletionCoordinator } from './deletion-coordinator';

export type BotDetailLoader = (botId: string, scope: TaskCacheScope, signal: AbortSignal) => Promise<Bot>;
const loadDetail: BotDetailLoader = (botId, scope, signal) => getBot(botId, signal, { userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });

/** Keep this owner mounted above Bot selection; pass the three resident pane IDs, excluding any cold target. */
export function useBotDetail(botId: string | null, enabled: boolean, retainedBotIds: ReadonlySet<string>, load: BotDetailLoader = loadDetail) {
  const scope = useTaskCacheScope();
  const cache = useMemo(() => new BotDetailCache(scope), [scope]);
  const coordinator = useMemo(() => getBotDeletionCoordinator(scope), [scope]);
  const selection = useMemo(() => ({ botId }), [scope, botId]);
  useSyncExternalStore(cache.subscribe, cache.snapshot);
  const action = useRef<() => void>(() => {});
  const refresh = useCallback(() => action.current(), []);
  // Depend on membership, not a caller-created Set's identity, to avoid a subscription/render loop.
  const retainedKey = JSON.stringify([...retainedBotIds].sort());
  useLayoutEffect(() => {
    const abort = () => cache.invalidate();
    scope.signal.addEventListener('abort', abort, { once: true });
    const detach = coordinator.attachCache(cache);
    if (scope.isInvalidated) abort();
    return () => { detach(); scope.signal.removeEventListener('abort', abort); cache.close(); };
  }, [cache, coordinator, scope]);
  useLayoutEffect(() => {
    cache.select(selection, new Set(JSON.parse(retainedKey) as string[]), enabled);
  }, [cache, selection, retainedKey, enabled]);
  useLayoutEffect(() => {
    let live = true, pending: BotDetailRequest | null = null, timer: ReturnType<typeof setInterval> | null = null;
    const eligible = () => live && enabled && botId !== null && !scope.isInvalidated && document.visibilityState !== 'hidden';
    const allowed = () => eligible() && !authRequestsPaused();
    const cancel = () => { if (pending) cache.cancel(pending); pending = null; };
    const run = async () => {
      if (!allowed() || pending) return;
      const ticket = cache.begin(); if (!ticket) return;
      pending = ticket;
      try {
        await scope.ready(ticket.signal);
        if (!allowed() || ticket.signal.aborted) return;
        const value = await load(ticket.botId, scope, ticket.signal);
        if (!allowed() || ticket.signal.aborted) return;
        if (value.deletion !== null) {
          cache.accept(ticket, value);
          const deletion = cache.read(selection).deletion;
          if (deletion) coordinator.observe(deletion);
          return;
        }
        await scope.ready(ticket.signal);
        if (allowed() && !ticket.signal.aborted) cache.accept(ticket, value);
      } catch (error) {
        if (allowed() && !ticket.signal.aborted) cache.fail(ticket, error);
      } finally {
        cache.cancel(ticket);
        if (pending === ticket) pending = null;
      }
    };
    const stop = () => { if (timer !== null) clearInterval(timer); timer = null; cancel(); };
    const sync = () => {
      if (!eligible()) { stop(); return; }
      if (timer !== null) return;
      void run();
      timer = setInterval(() => { if (!allowed()) cancel(); else void run(); }, 5_000);
    };
    action.current = () => { void run(); };
    sync();
    document.addEventListener('visibilitychange', sync);
    scope.signal.addEventListener('abort', stop, { once: true });
    return () => { live = false; stop(); document.removeEventListener('visibilitychange', sync); scope.signal.removeEventListener('abort', stop); action.current = () => {}; };
  }, [cache, coordinator, scope, selection, botId, enabled, load]);
  return { ...cache.read(selection, enabled, enabled), refresh, cache };
}
