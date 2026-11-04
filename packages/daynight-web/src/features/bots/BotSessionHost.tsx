import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { authRequestsPaused } from '../../api/client';
import type { BotSessionBinding } from '../../api/sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { SessionView } from '../task-agent-session/SessionView';
import { useSessionMessages } from '../task-agent-session/messages';
import { BotSessionCache, botSessionKey, type BotSessionPane } from './session-cache';
import './bot-session.css';

/** Own this hook above the selected Bot and its details panel. Neither selection nor details recreate it. */
export function useBotSessionCache(): BotSessionCache {
  const scope = useTaskCacheScope();
  const cache = useMemo(() => {
    let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* The cache still retains lightweight state in memory. */ }
    return new BotSessionCache({ userId: scope.userId, isCurrent: () => !scope.isInvalidated, isPaused: authRequestsPaused, onPrincipalMismatch: scope.principalMismatch, storage });
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
export function BotSessionHost({ cache, binding, active = true }: {
  readonly cache: BotSessionCache;
  readonly binding: BotSessionBinding | null;
  readonly active?: boolean;
}) {
  const panes = useSyncExternalStore(cache.subscribe, cache.snapshot), m = useSessionMessages();
  const key = binding ? botSessionKey(binding) : null;
  const current = cache.isCurrent();
  useLayoutEffect(() => { cache.select(binding); }, [cache, key, current]);
  const selected = current && panes.some(pane => pane.key === key);
  return <section className="bot-session-host" aria-label={m.title}>
    {!selected ? <p className="session-empty" role="status">{current ? m.loading : m.unavailable}</p> : null}
    {panes.map(pane => <div key={pane.key} className="bot-session-pane" data-bot-id={pane.binding.botId} hidden={!active || !current || pane.key !== key} inert={!active || !current || pane.key !== key}>
      <BotPane pane={pane} current={current} active={active && current && pane.key === key} />
    </div>)}
  </section>;
}

function BotPane({ pane, active, current }: { readonly pane: BotSessionPane; readonly active: boolean; readonly current: boolean }) {
  const view = useSyncExternalStore(pane.client.subscribe, pane.client.snapshot);
  const restored = useRef(false), attemptedPage = useRef<string | null>(null);
  const reading = useMemo(() => ({ scope: pane.key, ref: pane.reading }), [pane]);
  useLayoutEffect(() => {
    const handle = pane.reading.current, bookmark = pane.retained.bookmark;
    if (!active || !current || !handle || !bookmark || (!view.historyReady && view.archiveState !== 'ready')) return;
    if (!restored.current) {
      restored.current = true;
      if (handle.restoreBookmark(bookmark) === 'rejected') { pane.retained.bookmark = null; return; }
    }
    const status = handle.getRestoreStatus();
    // Latest cancels restoration. A resolved/rejected bookmark must not be reapplied
    // by a later receipt, reconnect, display change or unrelated render.
    if (status !== 'pending') { pane.retained.bookmark = null; return; }
    const key = bookmark.anchor?.key;
    const page = `${view.connectionGeneration}/${view.historyRevision}`;
    if (!key || view.state.entries.some(entry => entry.entryId === key) || !view.historyReady || !view.hasOlder || view.loadingOlder || view.historyError || view.authPaused || attemptedPage.current === page) return;
    attemptedPage.current = page;
    void pane.client.loadOlder();
  });
  return <SessionView client={pane.client} userId={pane.binding.ownerUserId} active={active} current={current} reading={reading} />;
}
