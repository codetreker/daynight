import { AssistantTaskSection, AssistantTaskOwned } from './AssistantTaskSection';
import { AssistantTaskDetail } from './AssistantTaskDetail';
import { AssistantTaskCreate } from './AssistantTaskCreate';
import { AssistantTaskPendingStrip } from './AssistantTaskPendingStrip';
import { loadAssistantTasks, assistantTaskUrl } from './assistant-task-data';
import './assistant-tasks.css';
import { useCallback, useEffect, useMemo, useRef, useId, useState, useLayoutEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { botSessionKey } from './session-cache';
import type { SessionTimelineReadingHandle } from '../task-agent-session/SessionTimeline';
import type { TimelineReadingBookmark } from '../../ui/useTimelineScroll';
import { ApiError, authRequestsPaused } from '../../api/client';
import { getBotDefaults, listBots, type BotDefinition, type CreateBotInput } from '../../api/bots';
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
import { BotConversationHeader, type BotConversationTarget } from './BotConversationHeader';
import { useBotMessages, useAssistantTaskMessages } from './messages';
import { useBotRead } from './useBotRead';
import { useBotDetail } from './useBotDetail';
import { useBotAttentionSeen } from './useBotAttentionSeen';
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
  event.preventDefault(); navigate(event.currentTarget.pathname + event.currentTarget.search);
};
export function BotsPage({ botId, readEnabled, taskId = null, taskTab = "manual", recordId, eventId }: { readonly botId: string | null; readonly readEnabled: boolean; readonly taskId?: string | null; readonly taskTab?: "manual" | "records" | "proposals"; readonly recordId?: string; readonly eventId?: string }) {
  const tm = useAssistantTaskMessages();
  const assistantTasks = useBotRead("assistant-tasks", readEnabled, loadAssistantTasks);
  const [taskCreating, setTaskCreating] = useState<"ordinary" | "watchdog" | null>(null);
  const m = useBotMessages(), scope = useTaskCacheScope(), cache = useBotSessionCache();
  const coordinator = useMemo(() => getBotDeletionCoordinator(scope), [scope]);
  const deletions = useSyncExternalStore(coordinator.subscribe, coordinator.snapshot);
  useSyncExternalStore(cache.subscribe, cache.guardSnapshot);
  const panes = useSyncExternalStore(cache.subscribe, cache.snapshot);
  const retainedBotIds = useMemo(() => new Set(panes.map(pane => pane.binding.botId)), [panes]);
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
  const detail = useBotDetail(botId, readEnabled, retainedBotIds);
  const detailStale = !detail.confirmed;
  const conversation = useRef<HTMLDivElement>(null), detailsOpener = useRef<HTMLButtonElement>(null), detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [search, setSearch] = useState(''), [creating, setCreating] = useState<{ scope: TaskCacheScope; botId: string | null } | null>(null);
  const selection = useRef({ scope, botId });
  useLayoutEffect(() => { selection.current = { scope, botId }; }, [scope, botId]);
  const [unresolved, setUnresolved] = useState<{ scope: TaskCacheScope; request: CreateBotInput } | null>(() => { const request = pendingBotCreation(scope); return request === null ? null : { scope, request }; });
  const denied = detail.error instanceof ApiError && detail.error.kind === 'server' && (detail.error.status === 403 || detail.error.status === 404 || detail.error.status === 410);
  const deleted = detail.deletion !== null;
  const bot = !denied && !deleted && botId !== null && !blocked(botId) && detail.value?.deletion === null ? detail.value : null;
  useEffect(() => { if (botId !== null && denied) cache.invalidateBot(botId); }, [cache, botId, denied]);
  useEffect(() => { if (scope.isInvalidated) { setCreating(null); setDeleteTarget(null); } }, [scope, scope.isInvalidated]);
  useLayoutEffect(() => { setCreating(current => current && (current.scope !== scope || current.botId !== botId) ? null : current); }, [scope, botId]);
  const targetUnavailable = deleteTarget !== null && (deleteTarget.scope !== scope || blocked(deleteTarget.bot.id) || deleteTarget.bot.id === botId && (denied || deleted));
  useEffect(() => { if (targetUnavailable) setDeleteTarget(null); }, [targetUnavailable]);
  const attentionSeenError = useBotAttentionSeen(taskId === null ? botId : null, readEnabled && detail.confirmed && bot !== null, (bot?.attentionCount ?? 0) > 0, () => { list.refresh(); detail.refresh(); });
  const binding = bot && detail.displayBinding?.botId === botId ? detail.displayBinding : null;
  const actionBinding = binding && readEnabled ? detail.actionBinding : null;
  const confirmedNoSession = detail.confirmed && bot !== null && bot.id === botId && bot.sessionId === null && bot.testExecutionId === null;
  const pendingReading = useRef<{ handle: SessionTimelineReadingHandle; bookmark: TimelineReadingBookmark } | null>(null);
  const captureReading = useCallback(() => {
    const handle = binding ? cache.snapshot().find(pane => pane.key === botSessionKey(binding))?.reading.current : null;
    const bookmark = handle?.captureBookmark();
    return handle && bookmark ? { handle, bookmark } : null;
  }, [binding, cache]);
  const restoreDetailsFocus = useRef(false);
  const changeDetails = (open: boolean) => { pendingReading.current = captureReading(); restoreDetailsFocus.current = !open; setDetailsOpen(open); };
  useLayoutEffect(() => {
    const saved = pendingReading.current; pendingReading.current = null;
    if (saved && captureReading()?.handle === saved.handle) saved.handle.restoreBookmark(saved.bookmark);
    if (!detailsOpen && restoreDetailsFocus.current) {
      restoreDetailsFocus.current = false;
      const opener = detailsOpener.current;
      if (opener?.isConnected && !opener.disabled && !opener.closest('[hidden], [inert]')) opener.focus({ preventScroll: true });
    }
  }, [detailsOpen, captureReading]);
  useLayoutEffect(() => {
    // Fullscreen updates this boundary in place. Restore its retained text
    // anchor before a viewport reflow can emit a clamped scroll position.
    const observer = new MutationObserver(() => {
      const saved = captureReading();
      if (saved) saved.handle.restoreBookmark(saved.bookmark);
    });
    observer.observe(conversation.current!, { attributes: true, attributeFilter: ['data-session-fullscreen', 'style'] });
    return () => observer.disconnect();
  }, [captureReading]);
  const selectedDeletion = deletions.find(record => record.id === botId);
  const visibleBots = (list.value ?? []).filter(item => !blocked(item.id));
  const items = visibleBots.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const worker = (id: string) => defaults.value?.workers.find(item => item.workerId === id);
  const showDetails = detailsOpen && botId !== null && !blocked(botId) && !scope.isInvalidated && !denied && !deleted;
  const detailsUnavailable = botId === null || blocked(botId) || denied || deleted || scope.isInvalidated;
  useEffect(() => { if (detailsUnavailable) setDetailsOpen(false); }, [detailsUnavailable]);
  const selectedName = !denied && !deleted && botId !== null && !blocked(botId) ? visibleBots.find(item => item.id === botId)?.name : null;
  const headerTarget: BotConversationTarget = { bot, worker: bot ? worker(bot.workerId) : undefined, stale: defaults.stale || detailStale, name: bot?.name ?? selectedName ?? (selectedDeletion?.name || m.loading), detailsId, detailsOpen: showDetails, detailsOpener, onDetails: () => changeDetails(!detailsOpen), follow };
  const refreshed = () => { list.refresh(); defaults.refresh(); detail.refresh(); };
  const deleteDialog = deleteTarget && !scope.isInvalidated && !targetUnavailable ? <div className="bot-details-confirmation" onKeyDown={event => {
    // Native dialog cancel and Tab own this layer before fullscreen handles keys.
    if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
  }}><BotDeleteDialog bot={deleteTarget.bot} opener={deleteTarget.opener} onClose={() => setDeleteTarget(null)} onConfirm={() => { if (!readEnabled || authRequestsPaused() || scope.isInvalidated) return; const target = deleteTarget.bot; setDeleteTarget(null); void coordinator.begin(target); }} /></div> : null;
  return <section className={`bots-page${botId || taskId ? ' bot-selected' : ''}`} aria-label={m.title}>
    <aside className="bot-list-panel" aria-label={m.title}>
      <header className="bot-list-heading"><h1>{m.title}</h1><button className="button quiet bot-create" type="button" aria-label={m.create} title={m.create} disabled={!readEnabled} onClick={() => setCreating({ scope, botId })}><span aria-hidden="true">+</span></button></header>
      {creating && creating.scope === scope && creating.botId === botId && !scope.isInvalidated ? <BotCreateDialog enabled={readEnabled} unresolvedRequest={unresolved?.scope === scope ? unresolved.request : null} onUnresolvedRequestChange={request => { rememberBotCreation(scope, request); setUnresolved(request === null ? null : { scope, request }); }} onClose={() => setCreating(null)} onCreated={created => { if (selection.current.scope !== scope || selection.current.botId !== botId || scope.isInvalidated) return; setCreating(null); list.refresh(); defaults.refresh(); navigate(`/bots/${created.id}`); detail.refresh(); }} /> : null}
      <label className="bot-search"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input type="search" aria-label={tm.search} placeholder={tm.search} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="bot-list-section"><h2>{m.yourAssistants}{list.value !== null ? <span className="bot-list-count">{visibleBots.length}</span> : null}</h2><button className="button quiet bot-refresh" type="button" aria-label={m.refresh} title={m.refresh} aria-busy={list.busy || defaults.busy} onClick={refreshed} disabled={!readEnabled || list.busy || defaults.busy}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5" /></svg></button></div>
      {list.value === null && list.error === null ? <p role="status">{m.loading}</p> : null}
      {list.error !== null ? <ReadError label={m.listError} error={list.error} retry={list.refresh} /> : null}
      {defaults.error !== null ? <ReadError label={m.defaultsError} error={defaults.error} retry={defaults.refresh} /> : null}
      {list.value !== null && items.length === 0 ? <p className="bot-empty" role="status">{visibleBots.length === 0 ? m.empty : m.noMatches}</p> : null}
      <ul className="bot-list" aria-label={m.yourAssistants}>{items.map(item => <BotListItem key={item.id} bot={item} selected={botId === item.id} disabled={scope.isInvalidated} worker={worker(item.workerId)} stale={defaults.stale} follow={follow} onDelete={(bot, opener) => setDeleteTarget({ scope, bot, opener })} />)}</ul>
      <AssistantTaskSection tasks={assistantTasks.value} bots={visibleBots} selectedId={taskId} search={search} error={assistantTasks.error} busy={assistantTasks.busy} onRefresh={assistantTasks.refresh} onCreate={() => setTaskCreating('ordinary')} onWatchdog={() => { const task = assistantTasks.value?.find(t => t.application === 'watchdog'); if(task) navigate(assistantTaskUrl(task.id)); else setTaskCreating('watchdog'); }} follow={follow} />
      <div className="bot-deletions">{deletions.filter(record => record.id !== botId).map(record => <BotDeletionStatus key={record.id} record={record} coordinator={coordinator} enabled={readEnabled && !scope.isInvalidated} />)}</div>
    </aside>
    <div className="bot-conversation" ref={conversation} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented && showDetails && !deleteDialog) {
        event.preventDefault(); event.stopPropagation(); changeDetails(false);
      }
    }}>
      {taskId === null && (botId === null || blocked(botId) || denied || deleted) ? <header className="bot-conversation-heading">{botId === null ? <h2>{m.select}</h2> : <BotConversationHeader target={headerTarget} />}</header> : null}
      {taskId ? <AssistantTaskDetail key={`${scope.userId}:${taskId}`} taskId={taskId} tab={taskTab} {...(eventId ? {eventId} : {})} {...(recordId ? {recordId} : {})} enabled={readEnabled} bots={visibleBots} onChanged={assistantTasks.refresh} /> : null}
      <div className="bot-conversation-body" hidden={taskId !== null}><div className="bot-conversation-content">
      {attentionSeenError !== null ? <ReadError label={m.attentionSeenError} error={attentionSeenError} retry={() => { list.refresh(); detail.refresh(); }} /> : null}
      {botId !== null && denied && detail.error !== null ? <ReadError label={m.detailError} error={detail.error} retry={detail.refresh} /> : null}
      {botId !== null && deletions.filter(record => record.id === botId).map(record => <div className="bot-selected-deletion" key={record.id}><BotDeletionStatus record={record} coordinator={coordinator} enabled={readEnabled && !scope.isInvalidated} /></div>)}
      {bot && bot.sessionId === null ? <p className="bot-empty" role="status">{bot.startupResult.code ? m.reason(bot.startupResult.code) : m[bot.startupResult.state]}</p> : null}
      <div className="bot-conversation-session" hidden={botId === null}><BotSessionHost cache={cache} botId={botId} botName={bot?.name ?? selectedName ?? null} displayBinding={binding} actionBinding={actionBinding} confirmedNoSession={confirmedNoSession} active={botId !== null && !blocked(botId) && !denied && !deleted} error={detail.error !== null ? m.detailError : null} onRetry={detail.refresh} fullscreenBoundary={conversation} presentation={{ variant: 'assistant', composer: { renderAttachments: slot => botId ? <AssistantTaskPendingStrip botId={botId} tasks={assistantTasks.value ?? []} enabled={readEnabled && slot.active && !slot.authPaused} /> : null }, renderHeader: session => <BotConversationHeader target={headerTarget} session={session} />, renderUnavailable: () => detail.error !== null ? <ReadError label={m.detailError} error={detail.error} retry={detail.refresh} /> : null }} /></div>
      </div>
      {showDetails ? <BotDetailsPanel assistantTasks={bot ? <AssistantTaskOwned tasks={assistantTasks.value ?? []} botId={bot.id} follow={follow} /> : null} id={headerTarget.detailsId} bot={headerTarget.bot} worker={headerTarget.worker} stale={headerTarget.stale} opener={headerTarget.detailsOpener} cache={cache} deleteDisabled={!readEnabled || detailStale} modalBlocked={deleteDialog !== null} onDelete={(bot, opener) => setDeleteTarget({ scope, bot, opener })} onClose={() => changeDetails(false)} /> : null}
      </div>
    </div>
    {taskCreating && !scope.isInvalidated ? <AssistantTaskCreate key={`${scope.userId}:${taskCreating}`} watchdog={taskCreating === "watchdog"} bots={visibleBots} enabled={readEnabled} onClose={() => setTaskCreating(null)} onCreated={id => { setTaskCreating(null); assistantTasks.refresh(); navigate(assistantTaskUrl(id)); }} /> : null}
    {deleteDialog && (botId !== null && conversation.current ? createPortal(deleteDialog, conversation.current) : deleteDialog)}
  </section>;
}
function ReadError({ label, error, retry }: { readonly label: string; readonly error: unknown; readonly retry: () => void }) {
  const m = useBotMessages();
  return <div className="notice error" role="alert"><p>{label}</p>{error instanceof ApiError && error.requestId ? <code>{error.requestId}</code> : null}<button className="button" type="button" onClick={retry}>{m.retry}</button></div>;
}
