import { useCallback, useEffect, useMemo, useRef, useId, useState, useLayoutEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { getBot, getBotDefaults, listBots, type BotDefinition, type CreateBotInput } from '../../api/bots';
import { navigate } from '../../app/router';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { BotSessionHost, useBotSessionCache } from './BotSessionHost';
import { BotCreateForm } from './BotCreateForm';
import { BotListItem } from './BotListItem';
import { BotDeleteDialog } from './BotDeleteDialog';
import { BotDeletionStatus } from './BotDeletionStatus';
import { getBotDeletionCoordinator } from './deletion-coordinator';
import { BotDetailsPanel } from './BotDetailsPanel';
import { BotConversationHeader, type BotConversationTarget } from './BotConversationHeader';
import { useBotMessages } from './messages';
import { useBotRead } from './useBotRead';
import { pendingBotCreation, rememberBotCreation } from './pending-creation';
import './bots.css';

const admission = (scope: TaskCacheScope) => ({ userId: scope.userId, onPrincipalMismatch: scope.principalMismatch });
const loadList = async (scope: TaskCacheScope, signal: AbortSignal) => {
  const items = new Map<string, BotDefinition>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await listBots({ limit: 100, ...(cursor === null ? {} : { cursor }) }, signal, admission(scope));
    for (const bot of page.items) { if (items.has(bot.id)) throw new ApiError('protocol'); items.set(bot.id, bot); }
    cursor = page.nextCursor;
    if (cursor !== null) { if (cursors.has(cursor)) throw new ApiError('protocol'); cursors.add(cursor); }
  } while (cursor !== null);
  return [...items.values()];
};
const loadDefaults = (scope: TaskCacheScope, signal: AbortSignal) => getBotDefaults(null, signal, admission(scope));
const follow = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.pathname);
};
export function BotsPage({ botId, readEnabled }: { readonly botId: string | null; readonly readEnabled: boolean }) {
  const m = useBotMessages(), scope = useTaskCacheScope(), cache = useBotSessionCache();
  const coordinator = useMemo(() => getBotDeletionCoordinator(scope), [scope]);
  const deletions = useSyncExternalStore(coordinator.subscribe, coordinator.snapshot);
  useSyncExternalStore(cache.subscribe, cache.guardSnapshot);
  useLayoutEffect(() => coordinator.attachCache(cache), [coordinator, cache]);
  const [deleteTarget, setDeleteTarget] = useState<{ scope: TaskCacheScope; bot: BotDefinition; opener: HTMLElement } | null>(null);
  const blocked = (id: string) => cache.isBlocked(id) || cache.isRevoked(id) || deletions.some(record => record.id === id && record.phase !== 'rejected');
  useEffect(() => {
    const poll = () => { if (readEnabled && !scope.isInvalidated && document.visibilityState !== 'hidden') for (const record of coordinator.snapshot()) if (!record.busy && !['completed', 'rejected', 'unavailable'].includes(record.phase)) void coordinator.check(record.id); };
    poll(); const timer = setInterval(poll, 5_000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, [coordinator, scope, readEnabled]);
  const list = useBotRead('bots', readEnabled, loadList), defaults = useBotRead('bot-defaults', readEnabled, loadDefaults);
  const loadDetail = useCallback((scope: TaskCacheScope, signal: AbortSignal) => getBot(botId!, signal, admission(scope)), [botId]);
  const detail = useBotRead(`bot:${botId}`, readEnabled && botId !== null, loadDetail);
  const conversation = useRef<HTMLDivElement>(null), detailsOpener = useRef<HTMLButtonElement>(null), detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [search, setSearch] = useState(''), [creating, setCreating] = useState<{ scope: TaskCacheScope; botId: string | null } | null>(null);
  const selection = useRef({ scope, botId });
  useLayoutEffect(() => { selection.current = { scope, botId }; }, [scope, botId]);
  const [unresolved, setUnresolved] = useState<{ scope: TaskCacheScope; request: CreateBotInput } | null>(() => { const request = pendingBotCreation(scope); return request === null ? null : { scope, request }; });
  const denied = detail.error instanceof ApiError && detail.error.kind === 'server' && (detail.error.status === 403 || detail.error.status === 404 || detail.error.status === 410);
  const deleted = detail.value !== null && detail.value.deletion !== null;
  const bot = !denied && !deleted && botId !== null && !blocked(botId) && detail.value?.deletion === null ? detail.value : null;
  useEffect(() => { if (botId !== null && denied) cache.invalidateBot(botId); }, [cache, botId, denied]);
  useEffect(() => { if (detail.value?.deletion) coordinator.observe(detail.value); }, [coordinator, detail.value]);
  useEffect(() => { if (scope.isInvalidated) { setCreating(null); setDeleteTarget(null); } }, [scope, scope.isInvalidated]);
  useLayoutEffect(() => { setCreating(current => current && (current.scope !== scope || current.botId !== botId) ? null : current); }, [scope, botId]);
  const targetUnavailable = deleteTarget !== null && (deleteTarget.scope !== scope || blocked(deleteTarget.bot.id) || deleteTarget.bot.id === botId && (denied || deleted));
  useEffect(() => { if (targetUnavailable) setDeleteTarget(null); }, [targetUnavailable]);
  const binding = useMemo(() => bot && !detail.stale && bot.sessionId && bot.testExecutionId ? { ownerUserId: bot.ownerUserId, botId: bot.id, sessionId: bot.sessionId, testExecutionId: bot.testExecutionId } : null, [bot, detail.stale]);
  const selectedDeletion = deletions.find(record => record.id === botId);
  const visibleBots = (list.value ?? []).filter(item => !blocked(item.id));
  const items = visibleBots.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const worker = (id: string) => defaults.value?.workers.find(item => item.workerId === id);
  const showDetails = detailsOpen && botId !== null && !blocked(botId) && !scope.isInvalidated && !denied && !deleted;
  useEffect(() => { if (botId === null || denied || deleted || scope.isInvalidated) setDetailsOpen(false); }, [botId, denied, deleted, scope]);
  const headerTarget: BotConversationTarget = { bot, worker: bot ? worker(bot.workerId) : undefined, stale: defaults.stale || detail.stale, name: bot?.name ?? (selectedDeletion?.name || m.loading), detailsId, detailsOpen: showDetails, detailsOpener, onDetails: () => setDetailsOpen(value => !value), follow };
  const refreshed = () => { list.refresh(); defaults.refresh(); detail.refresh(); };
  return <section className={`bots-page${botId ? ' bot-selected' : ''}`} aria-label={m.title}>
    <aside className="bot-list-panel" aria-label={m.title}>
      <header className="bot-list-heading"><h1>{m.title}</h1><button className="button quiet bot-create" type="button" aria-label={m.create} title={m.create} disabled={!readEnabled} onClick={() => setCreating({ scope, botId })}><span aria-hidden="true">+</span></button></header>
      {creating && creating.scope === scope && creating.botId === botId && !scope.isInvalidated ? <BotCreateForm enabled={readEnabled} unresolvedRequest={unresolved?.scope === scope ? unresolved.request : null} onUnresolvedRequestChange={request => { rememberBotCreation(scope, request); setUnresolved(request === null ? null : { scope, request }); }} onClose={() => setCreating(null)} onCreated={created => { if (selection.current.scope !== scope || selection.current.botId !== botId || scope.isInvalidated) return; setCreating(null); list.refresh(); defaults.refresh(); navigate(`/bots/${created.id}`); detail.refresh(); }} /> : null}
      <label className="bot-search"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label={m.search} placeholder={m.search} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="bot-list-section"><h2>{m.yourAssistants}{list.value !== null ? <span className="bot-list-count">{visibleBots.length}</span> : null}</h2><button className="button quiet bot-refresh" type="button" aria-label={m.refresh} title={m.refresh} aria-busy={list.busy || defaults.busy} onClick={refreshed} disabled={!readEnabled || list.busy || defaults.busy}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5" /></svg></button></div>
      {list.value === null && list.error === null ? <p role="status">{m.loading}</p> : null}
      {list.error !== null ? <ReadError label={m.listError} error={list.error} retry={list.refresh} /> : null}
      {defaults.error !== null ? <ReadError label={m.defaultsError} error={defaults.error} retry={defaults.refresh} /> : null}
      {list.value !== null && items.length === 0 ? <p className="bot-empty" role="status">{visibleBots.length === 0 ? m.empty : m.noMatches}</p> : null}
      <ul className="bot-list">{items.map(item => <BotListItem key={item.id} bot={item} selected={botId === item.id} disabled={scope.isInvalidated} worker={worker(item.workerId)} stale={defaults.stale} follow={follow} onDelete={(bot, opener) => setDeleteTarget({ scope, bot, opener })} />)}</ul>
      <div className="bot-deletions">{deletions.filter(record => record.id !== botId).map(record => <BotDeletionStatus key={record.id} record={record} coordinator={coordinator} enabled={readEnabled && !scope.isInvalidated} />)}</div>
    </aside>
    <div className="bot-conversation" ref={conversation} tabIndex={-1}>
      {binding === null ? <header className="bot-conversation-heading">{botId !== null ? <BotConversationHeader target={headerTarget} /> : <h2>{m.select}</h2>}</header> : null}
      <div className="bot-conversation-body"><div className="bot-conversation-content">
      {botId !== null && detail.error !== null ? <ReadError label={m.detailError} error={detail.error} retry={detail.refresh} /> : null}
      {botId !== null && deletions.filter(record => record.id === botId).map(record => <div className="bot-selected-deletion" key={record.id}><BotDeletionStatus record={record} coordinator={coordinator} enabled={readEnabled && !scope.isInvalidated} /></div>)}
      {bot && bot.sessionId === null ? <p className="bot-empty" role="status">{bot.startupResult.code ? m.reason(bot.startupResult.code) : m[bot.startupResult.state]}</p> : null}
      <div className="bot-conversation-session" hidden={binding === null}><BotSessionHost cache={cache} binding={binding} active={binding !== null} fullscreenBoundary={conversation} presentation={{ variant: 'assistant', renderHeader: session => <BotConversationHeader target={headerTarget} session={session} /> }} /></div>
      </div>
      {showDetails ? <BotDetailsPanel id={headerTarget.detailsId} bot={headerTarget.bot} worker={headerTarget.worker} stale={headerTarget.stale} opener={headerTarget.detailsOpener} onClose={() => setDetailsOpen(false)} /> : null}
      </div>
    </div>
    {deleteTarget && !scope.isInvalidated && !targetUnavailable ? <BotDeleteDialog bot={deleteTarget.bot} opener={deleteTarget.opener} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (!readEnabled || authRequestsPaused() || scope.isInvalidated) return; const target = deleteTarget.bot; setDeleteTarget(null); void coordinator.begin(target); }} /> : null}
  </section>;
}
function ReadError({ label, error, retry }: { readonly label: string; readonly error: unknown; readonly retry: () => void }) {
  const m = useBotMessages();
  return <div className="notice error" role="alert"><p>{label}</p>{error instanceof ApiError && error.requestId ? <code>{error.requestId}</code> : null}<button className="button" type="button" onClick={retry}>{m.retry}</button></div>;
}
