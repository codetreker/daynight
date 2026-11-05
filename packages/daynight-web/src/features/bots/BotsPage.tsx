import { useCallback, useEffect, useMemo, useRef, useId, useState, useLayoutEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { ApiError } from '../../api/client';
import { getBot, getBotDefaults, listBots, type BotDefinition, type CreateBotInput } from '../../api/bots';
import { navigate } from '../../app/router';
import type { TaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { BotSessionHost, useBotSessionCache } from './BotSessionHost';
import { BotCreateDialog } from './BotCreateDialog';
import { BotListItem } from './BotListItem';
import { BotDeleteDialog } from './BotDeleteDialog';
import { BotDeletionStatus } from './BotDeletionStatus';
import { getBotDeletionCoordinator } from './deletion-coordinator';
import { BotDetailsPanel } from './BotDetailsPanel';
import { BotStatus } from './BotStatus';
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
  const [deleteTarget, setDeleteTarget] = useState<{ bot: BotDefinition; opener: HTMLElement } | null>(null);
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
  const [search, setSearch] = useState(''), [creating, setCreating] = useState(false);
  const [unresolved, setUnresolved] = useState<{ scope: TaskCacheScope; request: CreateBotInput } | null>(() => { const request = pendingBotCreation(scope); return request === null ? null : { scope, request }; });
  const denied = detail.error instanceof ApiError && detail.error.kind === 'server' && (detail.error.status === 403 || detail.error.status === 404 || detail.error.status === 410);
  const deleted = detail.value !== null && detail.value.deletion !== null;
  const bot = !denied && !deleted && botId !== null && !blocked(botId) && detail.value?.deletion === null ? detail.value : null;
  useEffect(() => { if (botId !== null && denied) cache.invalidateBot(botId); }, [cache, botId, denied]);
  useEffect(() => { if (detail.value?.deletion) coordinator.observe(detail.value); }, [coordinator, detail.value]);
  useEffect(() => { if (!readEnabled || scope.isInvalidated) { setCreating(false); setDeleteTarget(null); } }, [readEnabled, scope]);
  const binding = useMemo(() => bot && !detail.stale && bot.sessionId && bot.testExecutionId ? { ownerUserId: bot.ownerUserId, botId: bot.id, sessionId: bot.sessionId, testExecutionId: bot.testExecutionId } : null, [bot, detail.stale]);
  const selectedDeletion = deletions.find(record => record.id === botId);
  const items = (list.value ?? []).filter(item => !blocked(item.id)).filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const worker = (id: string) => defaults.value?.workers.find(item => item.workerId === id);
  const showDetails = detailsOpen && botId !== null && !blocked(botId) && readEnabled && !scope.isInvalidated && !denied && !deleted;
  useEffect(() => { if (botId === null || !readEnabled || denied || deleted || scope.isInvalidated) setDetailsOpen(false); }, [botId, readEnabled, denied, deleted, scope]);
  const refreshed = () => { list.refresh(); defaults.refresh(); detail.refresh(); };
  return <section className={`bots-page${botId ? ' bot-selected' : ''}`} aria-label={m.title}>
    <aside className="bot-list-panel" aria-label={m.title}>
      <header className="bot-list-heading"><h1>{m.title}</h1><button className="button primary" type="button" disabled={!readEnabled} onClick={() => setCreating(true)}>{m.create}</button></header>
      <label className="bot-search"><span>{m.search}</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <button className="button quiet bot-refresh" type="button" onClick={refreshed} disabled={!readEnabled || list.busy || defaults.busy}>{m.refresh}</button>
      {list.value === null && list.error === null ? <p role="status">{m.loading}</p> : null}
      {list.error !== null ? <ReadError label={m.listError} error={list.error} retry={list.refresh} /> : null}
      {defaults.error !== null ? <ReadError label={m.defaultsError} error={defaults.error} retry={defaults.refresh} /> : null}
      {list.value !== null && items.length === 0 ? <p className="bot-empty" role="status">{search ? m.noMatches : m.empty}</p> : null}
      <ul className="bot-list">{items.map(item => <BotListItem key={item.id} bot={item} selected={botId === item.id} disabled={!readEnabled || scope.isInvalidated} worker={worker(item.workerId)} stale={defaults.stale} follow={follow} onDelete={(bot, opener) => setDeleteTarget({ bot, opener })} />)}</ul>
      <div className="bot-deletions">{deletions.filter(record => record.id !== botId).map(record => <BotDeletionStatus key={record.id} record={record} coordinator={coordinator} enabled={readEnabled && !scope.isInvalidated} />)}</div>
    </aside>
    <div className="bot-conversation" ref={conversation} tabIndex={-1}>
      <header className="bot-conversation-heading">{botId !== null ? <><a className="button quiet" href="/bots" onClick={follow}>{m.closeChat}</a><div><h2><button ref={detailsOpener} type="button" className="bot-details-toggle" disabled={!bot || !readEnabled} aria-controls={showDetails ? detailsId : undefined} aria-expanded={showDetails} onClick={() => setDetailsOpen(value => !value)}>{bot?.name ?? (selectedDeletion?.name || m.loading)}<span aria-hidden="true">⌄</span></button></h2>{bot ? <BotStatus bot={bot} worker={worker(bot.workerId)} stale={defaults.stale} /> : null}</div></> : <h2>{m.select}</h2>}</header>
      <div className="bot-conversation-body"><div className="bot-conversation-content">
      {botId !== null && detail.error !== null ? <ReadError label={m.detailError} error={detail.error} retry={detail.refresh} /> : null}
      {botId !== null && deletions.filter(record => record.id === botId).map(record => <div className="bot-selected-deletion" key={record.id}><BotDeletionStatus record={record} coordinator={coordinator} enabled={readEnabled && !scope.isInvalidated} /></div>)}
      {bot && bot.sessionId === null ? <p className="bot-empty" role="status">{bot.startupResult.code ? m.reason(bot.startupResult.code) : m[bot.startupResult.state]}</p> : null}
      <div className="bot-conversation-session" hidden={binding === null}><BotSessionHost cache={cache} binding={binding} active={readEnabled && binding !== null} fullscreenBoundary={conversation} /></div>
      </div>
      {showDetails ? <BotDetailsPanel id={detailsId} bot={bot} worker={bot ? worker(bot.workerId) : undefined} stale={defaults.stale || detail.stale} opener={detailsOpener} onClose={() => setDetailsOpen(false)} /> : null}
      </div>
    </div>
    {deleteTarget && readEnabled && !scope.isInvalidated ? <BotDeleteDialog bot={deleteTarget.bot} opener={deleteTarget.opener} onClose={() => setDeleteTarget(null)} onConfirm={() => { const target = deleteTarget.bot; setDeleteTarget(null); void coordinator.begin(target); }} /> : null}
    {creating && !scope.isInvalidated ? <BotCreateDialog unresolvedRequest={unresolved?.scope === scope ? unresolved.request : null} onUnresolvedRequestChange={request => { rememberBotCreation(scope, request); setUnresolved(request === null ? null : { scope, request }); }} onClose={() => setCreating(false)} onCreated={created => { setCreating(false); list.refresh(); defaults.refresh(); navigate(`/bots/${created.id}`); detail.refresh(); }} /> : null}
  </section>;
}
function ReadError({ label, error, retry }: { readonly label: string; readonly error: unknown; readonly retry: () => void }) {
  const m = useBotMessages();
  return <div className="notice error" role="alert"><p>{label}</p>{error instanceof ApiError && error.requestId ? <code>{error.requestId}</code> : null}<button className="button" type="button" onClick={retry}>{m.retry}</button></div>;
}
