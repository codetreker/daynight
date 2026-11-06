import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';
import { authRequestsPaused } from '../../api/client';
import type { BotSessionBinding } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { SessionView } from '../task-agent-session/SessionView';
import type { SessionTimelineReadingHandle } from '../task-agent-session/SessionTimeline';
import { useSessionMessages } from '../task-agent-session/messages';
import { BotSessionCache, botSessionKey, type BotSessionPane } from './session-cache';
import type { SessionPresentationSlots } from '../task-agent-session/session-presentation-slots';
import './bot-session.css';

/** Own this hook above the selected Bot and its details panel. Neither selection nor details recreate it. */
export function useBotSessionCache(): BotSessionCache {
  const scope = useTaskCacheScope();
  const cache = useMemo(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* The cache still retains lightweight state in memory. */ }
    return new BotSessionCache({ userId: scope.userId, identityScope: scope, isCurrent: () => !scope.isInvalidated, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
  }, [scope]);
  useEffect(() => {
    const abort = () => cache.invalidate();
    scope.signal.addEventListener('abort', abort, { once: true });
    const timer = setInterval(cache.syncAvailability, 250);
    if (scope.signal.aborted) abort(); else cache.syncAvailability();
    return () => { scope.signal.removeEventListener('abort', abort); clearInterval(timer); cache.close(); };
  }, [cache, scope]);
  return cache;
}

/** The caller supplies only an authenticated Bot's real Session binding, or null while it is unknown. */
export function BotSessionHost({ cache, binding, active = true, fullscreenBoundary, presentation }: {
  readonly cache: BotSessionCache;
  readonly binding: BotSessionBinding | null;
  readonly active?: boolean;
  readonly presentation?: SessionPresentationSlots;
  readonly fullscreenBoundary?: RefObject<HTMLElement | null>;
}) {
  const panes = useSyncExternalStore(cache.subscribe, cache.snapshot), m = useSessionMessages();
  const guardRevision = useSyncExternalStore(cache.subscribe, cache.guardSnapshot);
  const key = binding ? botSessionKey(binding) : null;
  const current = cache.isCurrent();
  useLayoutEffect(() => { cache.select(binding); }, [cache, key, current, guardRevision]);
  const selected = current && panes.some(pane => pane.key === key);
  return <section className="bot-session-host" aria-label={m.title}>
    {!selected ? <p className="session-empty" role="status">{current ? m.loading : m.unavailable}</p> : null}
    {panes.map(pane => <div key={pane.key} className="bot-session-pane" data-bot-id={pane.binding.botId} hidden={!active || !current || pane.key !== key} inert={!active || !current || pane.key !== key}>
      <BotPane {...(presentation ? { presentation } : {})} pane={pane} current={current} active={active && current && pane.key === key} {...(fullscreenBoundary ? { fullscreenBoundary } : {})} />
    </div>)}
  </section>;
}

function BotPane({ pane, active, current, fullscreenBoundary, presentation }: { readonly presentation?: SessionPresentationSlots; readonly pane: BotSessionPane; readonly active: boolean; readonly current: boolean; readonly fullscreenBoundary?: RefObject<HTMLElement | null> }) {
  const view = useSyncExternalStore(pane.client.subscribe, pane.client.snapshot);
  const restored = useRef<SessionTimelineReadingHandle | null>(null), attemptedPage = useRef<string | null>(null);
  const reading = useMemo(() => ({ scope: pane.key, ref: pane.reading }), [pane]);
  useLayoutEffect(() => {
    const handle = pane.reading.current, bookmark = pane.retained.bookmark;
    // Archive loading can replace the Timeline while this pane stays mounted.
    // Only unfinished restoration may cross that boundary; the original handle
    // still distinguishes a real Latest cancellation from a fresh handle's idle.
    if (bookmark && restored.current && restored.current.getRestoreStatus() !== 'pending') { pane.retained.bookmark = null; return; }
    // Every replacement handle owns the pending bookmark before it can be captured
    // on eviction, including hidden panes and incomplete initial history.
    if (!current || !handle || !bookmark) return;
    if (restored.current !== handle) {
      restored.current = handle; attemptedPage.current = null;
      if (handle.restoreBookmark(bookmark) === 'rejected') { pane.retained.bookmark = null; return; }
    }
    const status = handle.getRestoreStatus();
    // Latest cancels restoration. A resolved/rejected bookmark must not be reapplied
    // by a later receipt, reconnect, display change or unrelated render.
    if (status !== 'pending') { pane.retained.bookmark = null; return; }
    const snapshot = view.state.snapshot;
    // Controller replacement can cancel a page without replacing the browser channel.
    // Wait for admission before remembering an attempt that loadOlder can start.
    if (!active || !snapshot?.synchronized || snapshot.connectionState !== 'connected' || snapshot.lifecycle !== 'active') return;
    const key = bookmark.anchor?.key;
    const page = `${view.connectionGeneration}/${snapshot.connectionEpoch}/${view.historyRevision}`;
    if (!key || view.state.entries.some(entry => entry.entryId === key) || !view.historyReady || !view.hasOlder || view.loadingOlder || view.historyError || view.authPaused || attemptedPage.current === page) return;
    attemptedPage.current = page;
    void pane.client.loadOlder();
    // Admission can change before authPaused reaches the view. A synchronous
    // refusal must leave the page eligible when availability next changes.
    if (!pane.client.snapshot().loadingOlder) attemptedPage.current = null;
  });
  return <SessionView {...(presentation ? { presentation } : {})} client={pane.client} userId={pane.binding.ownerUserId} active={active} current={current} reading={reading} {...(fullscreenBoundary ? { fullscreenBoundary } : {})} />;
}
