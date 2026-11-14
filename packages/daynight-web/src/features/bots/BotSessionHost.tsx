import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { authRequestsPaused, subscribeAuthPause } from '../../api/client';
import { browserNavigation } from '../../app/navigation';
import { parseAuthRoute } from '../../app/router';
import type { BotSessionBinding } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { SessionView } from '../task-agent-session/SessionView';
import type { SessionTimelineReadingHandle } from '../task-agent-session/SessionTimeline';
import { useSessionMessages } from '../task-agent-session/messages';
import { BotSessionCache, botSessionKey, type BotSessionPane } from './session-cache';
import type { SessionPresentationSlots } from '../task-agent-session/session-presentation-slots';
import { BotConversationEmpty } from './BotConversationEmpty';
import { getBotDisplaySnapshotCoordinator, type BotDisplaySnapshotCoordinator } from './display-snapshot-coordinator';
import type { BotDisplayPreview } from './display-snapshot';
import { botDisplayHistoryKey } from './display-snapshot-codec';
import { selectSessionHistoryRows, type SessionHistoryPreview } from '../task-agent-session/history-preview';
import type { SessionViewState } from '../task-agent-session/client';
import './bot-session.css';

/** Own this hook above the selected Bot and its details panel. Neither selection nor details recreate it. */
export function useBotSessionCache(): BotSessionCache {
  const scope = useTaskCacheScope();
  const cache = useMemo(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* The cache still retains lightweight state in memory. */ }
    return new BotSessionCache({ userId: scope.userId, identityScope: scope, isCurrent: () => !scope.isInvalidated, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage, displaySnapshots: getBotDisplaySnapshotCoordinator(scope) });
  }, [scope]);
  useEffect(() => {
    const abort = () => cache.invalidate();
    const stop = () => { for (const pane of cache.snapshot()) pane.client.suspendForAccountRefresh(); };
    const unsubscribePause = subscribeAuthPause(stop);
    // A pane created while the document is paused must stop before it can start work.
    const unsubscribePanes = cache.subscribe(() => { if (authRequestsPaused()) stop(); });
    if (authRequestsPaused()) stop();
    scope.signal.addEventListener('abort', abort, { once: true });
    const timer = setInterval(cache.syncAvailability, 250);
    if (scope.signal.aborted) abort(); else cache.syncAvailability();
    return () => { scope.signal.removeEventListener('abort', abort); clearInterval(timer); unsubscribePause(); unsubscribePanes(); cache.close(); };
  }, [cache, scope]);
  useLayoutEffect(() => {
    const navigation = browserNavigation();
    const target = () => { const route = parseAuthRoute(navigation.snapshot().pathname); return route.kind === 'bot' ? route.botId : null; };
    let observedBotId = target();
    // The existing owner notifies only admitted locations. Query/fragment changes
    // keep the same target; a new target or leaving Bots freezes before commit.
    const detach = navigation.subscribe(() => {
      const nextBotId = target();
      if (nextBotId === observedBotId) return;
      observedBotId = nextBotId; cache.suspendActions();
    });
    return () => { detach(); cache.suspendActions(); };
  }, [cache]);
  return cache;
}

/** A missing binding remains unresolved until the caller independently confirms no Session. */
export function BotSessionHost({ cache, displayBinding, actionBinding = null, confirmedNoSession = false, botId = displayBinding?.botId ?? null, active = true, fullscreenBoundary, presentation, botName = null, error = null, onRetry }: {
  readonly cache: BotSessionCache;
  readonly botName?: string | null;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly displayBinding: BotSessionBinding | null;
  readonly actionBinding?: BotSessionBinding | null;
  readonly confirmedNoSession?: boolean;
  readonly botId?: string | null;
  readonly active?: boolean;
  readonly presentation?: SessionPresentationSlots;
  readonly fullscreenBoundary?: RefObject<HTMLElement | null>;
}) {
  const panes = useSyncExternalStore(cache.subscribe, cache.snapshot), m = useSessionMessages();
  const navigation = browserNavigation();
  const location = useSyncExternalStore(navigation.subscribe, navigation.snapshot);
  const guardRevision = useSyncExternalStore(cache.subscribe, cache.guardSnapshot);
  const binding = displayBinding?.botId === botId ? displayBinding : null;
  const key = binding ? botSessionKey(binding) : null;
  const action = actionBinding?.botId === botId && active ? actionBinding : null;
  const actionKey = action ? botSessionKey(action) : null;
  const current = cache.isCurrent();
  const assistantPresentation: SessionPresentationSlots = {
    ...presentation,
    variant: 'assistant',
    renderEmpty: slot => <BotConversationEmpty {...slot} />,
    composer: { ...presentation?.composer, compactMenus: true, nativeSelectTouchMode: 'container' },
  };
  // Two admitted navigations can return to this same selection in one commit.
  // The navigation owner's snapshot still changes, so that commit must readmit it.
  useLayoutEffect(() => {
    if (current && botId && confirmedNoSession) cache.confirmNoSession(botId);
    else cache.select(binding, current ? action : null);
  }, [cache, key, actionKey, confirmedNoSession, botId, active, current, guardRevision, location]);
  useLayoutEffect(() => { if (botId) cache.setBotName(botId, botName); }, [cache, botId, botName]);
  const targets = panes.map(pane => ({ botId: pane.binding.botId, pane: pane as BotSessionPane | null }));
  if (current && botId && !cache.isBlocked(botId) && !cache.isRevoked(botId) && !targets.some(target => target.botId === botId)) targets.push({ botId, pane: null });
  return <section className="bot-session-host" aria-label={m.title}>
    {targets.map(target => {
      const visible = active && current && target.botId === botId && !cache.isBlocked(target.botId) && !cache.isRevoked(target.botId);
      const noSession = cache.isNoSession(target.botId) || target.botId === botId && confirmedNoSession;
      return <div key={target.botId} className="bot-session-pane" data-bot-id={target.botId} hidden={!visible} inert={!visible}>
        <BotPane cache={cache} botId={target.botId} presentation={assistantPresentation} pane={noSession ? null : target.pane} noSession={noSession} current={current} active={visible} error={target.botId === botId ? error : null} {...(onRetry ? { onRetry } : {})} {...(fullscreenBoundary ? { fullscreenBoundary } : {})} />
      </div>;
    })}
  </section>;
}
const noSubscribe = () => () => {};
const noSnapshot = () => null;
function useHistoryPreview(owner: BotDisplaySnapshotCoordinator | undefined, botId: string, active: boolean, view: SessionViewState | null): BotDisplayPreview | null {
  const version = useSyncExternalStore(owner?.subscribe ?? noSubscribe, owner?.version ?? (() => 0));
  const selected = useRef<{ owner: BotDisplaySnapshotCoordinator; botId: string; active: boolean } | null>(null);
  const [loaded, setLoaded] = useState<{ owner: BotDisplaySnapshotCoordinator; botId: string; generation: number; preview: BotDisplayPreview | null } | null>(null);
  const displayed = useRef<typeof loaded>(null);
  const readAllowed = owner?.allowed(botId) ?? false;
  useEffect(() => {
    if (!owner || !active) { if (selected.current) selected.current.active = false; return; }
    if (!readAllowed) return;
    let live = true;
    const generation = owner.generation(botId);
    const touch = selected.current?.owner !== owner || selected.current.botId !== botId || !selected.current.active;
    selected.current = { owner, botId, active };
    // Storage notifications must not write an LRU touch back to another tab.
    void owner.read(botId, { touch }).then(preview => {
      if (!live || !owner.allowed(botId)) return;
      // Persistence may save a shorter real tail. The admitted display seed owns
      // its uncovered rows until real coverage or actual revocation consumes them.
      setLoaded(previous => previous?.owner === owner && previous.botId === botId && previous.generation === generation && previous.preview && (!preview || botDisplayHistoryKey(previous.preview) === botDisplayHistoryKey(preview)) ? previous : { owner, botId, generation, preview });
    });
    return () => { live = false; };
  }, [owner, botId, active, version, readAllowed]);
  useLayoutEffect(() => {
    if (!view?.historyLoaded || !loaded?.preview || loaded.owner !== owner || loaded.botId !== botId) return;
    const entries = selectSessionHistoryRows(view.state, loaded.preview, true, view.historyCoverage).filter(row => row.preview).map(row => row.entry);
    // Consumed rows stay withdrawn when a later tail starts a disjoint cursor
    // chain. The retained seed only shrinks and never enters client/save inputs.
    if (entries.length !== loaded.preview.entries.length) setLoaded(current => current === loaded ? { ...loaded, preview: { ...loaded.preview!, entries } } : current);
  }, [view, loaded, owner, botId]);
  // Identity verification pauses new reads, while the same visible history can
  // remain readable. Hiding or changing its target ends that display allowance.
  const preview = owner && owner.displayAllowed(botId) && loaded?.owner === owner && loaded.botId === botId && loaded.generation === owner.generation(botId) && (readAllowed || active && displayed.current === loaded) ? loaded.preview : null;
  useLayoutEffect(() => { displayed.current = active && preview ? loaded : null; });
  return preview;
}

function BotPane({ cache, botId, pane, noSession, active, current, fullscreenBoundary, presentation, error, onRetry }: { readonly cache: BotSessionCache; readonly botId: string; readonly presentation?: SessionPresentationSlots; readonly pane: BotSessionPane | null; readonly noSession: boolean; readonly active: boolean; readonly current: boolean; readonly error: string | null; readonly onRetry?: () => void; readonly fullscreenBoundary?: RefObject<HTMLElement | null> }) {
  const view = useSyncExternalStore(pane?.client.subscribe ?? noSubscribe, pane?.client.snapshot ?? noSnapshot);
  const owner = cache.displaySnapshots();
  const loadedPreview = useHistoryPreview(owner, botId, active && current && !noSession, view);
  const preview = noSession ? null : loadedPreview;
  const previewInput: SessionHistoryPreview | undefined = preview ? { fence: preview.fence, historyEpoch: preview.historyEpoch, lastEventSeq: preview.lastEventSeq, entries: preview.entries, resources: preview.resources, ...(preview.readingAnchor ? { readingAnchor: preview.readingAnchor } : {}) } : undefined;
  const readingRef = useRef<SessionTimelineReadingHandle | null>(null);
  useLayoutEffect(() => { if (pane) pane.reading.current = readingRef.current; });
  useEffect(() => { if (!active) cache.flushDisplay(botId); }, [active, cache, botId]);
  const restored = useRef<SessionTimelineReadingHandle | null>(null), attemptedPage = useRef<string | null>(null);
  const userId = cache.accountUserId();
  const readingScope = pane?.key ?? (preview ? botSessionKey(preview.lastKnownBinding) : JSON.stringify([userId, botId]));
  const reading = useMemo(() => ({ scope: readingScope, ref: readingRef }), [readingScope]);
  useLayoutEffect(() => {
    if (!pane || !view || !view.state.snapshot && !preview) return;
    const handle = readingRef.current, bookmark = pane.retained.bookmark;
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
  return <SessionView {...(presentation ? { presentation } : {})} client={pane?.client ?? null} userId={userId} {...(previewInput ? { historyPreview: previewInput } : {})} error={error} {...(onRetry ? { onRetry } : {})} active={active} current={current} reading={reading} {...(fullscreenBoundary ? { fullscreenBoundary } : {})} />;
}
