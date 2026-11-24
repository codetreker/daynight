import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { BotDefinition, BotWorkerDefaults } from '../../api/bots';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import { dialogFocusables } from '../task-detail/focus';
import { useSessionControlMessages } from '../task-agent-session/controls-messages';
import { sessionNativeLabels, useSessionMessages } from '../task-agent-session/messages';
import { operationPresentation } from '../task-agent-session/operation-presentation';
import { selectSessionPresentation } from '../task-agent-session/presentation';
import type { SessionTimelineReadingHandle } from '../task-agent-session/SessionTimeline';
import type { TimelineReadingBookmark } from '../../ui/useTimelineScroll';
import { botSessionKey, type BotSessionCache, type BotSessionPane } from './session-cache';
import { useBotMessages } from './messages';
import { BotStatus } from './BotStatus';
import { useBotObservationMessages } from './observation-messages';
import type { BotObservationRead } from './useBotObservations';
import { useWorkerNames } from '../worker-names/useWorkerNames';
import './details-panel.css';

/** A responsive information panel; the Session stays in its original sibling. */
export function BotDetailsPanel({ assistantTasks, id, bot, observation, opener, onClose, cache, onDelete, deleteDisabled = false, modalBlocked = false }: {
  readonly assistantTasks?: ReactNode; readonly id: string;
  readonly bot: BotDefinition | null;
  readonly worker: BotWorkerDefaults | undefined;
  readonly stale: boolean;
  readonly observation?: BotObservationRead | undefined;
  readonly opener: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly cache?: BotSessionCache;
  readonly onDelete?: (bot: BotDefinition, opener: HTMLElement) => void;
  readonly deleteDisabled?: boolean;
  readonly modalBlocked?: boolean;
}) {
  const m = useBotMessages(), dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null);
  const [narrow, setNarrow] = useState(true);
  const shownMode = useRef<boolean | null>(null);
  const reading = useRef<{ pane: BotSessionPane; handle: SessionTimelineReadingHandle; bookmark: TimelineReadingBookmark } | null>(null);
  useLayoutEffect(() => {
    const panel = dialog.current!, container = panel.parentElement!;
    const measure = () => {
      if (modalBlocked) return;
      const style = getComputedStyle(container);
      const width = container.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      const next = window.innerWidth < 1280 || width < 760;
      if (shownMode.current !== null && shownMode.current !== next) {
        const pane = boundPane(cache, bot), handle = pane?.reading.current, bookmark = handle?.captureBookmark();
        reading.current = pane && handle && bookmark ? { pane, handle, bookmark } : null;
      }
      setNarrow(next);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [modalBlocked, cache, bot]);
  useBodyScrollLock(narrow);
  useLayoutEffect(() => {
    const panel = dialog.current!;
    if (modalBlocked || shownMode.current === narrow) return;
    const previousFocus = document.activeElement, firstOpen = shownMode.current === null;
    if (panel.open) panel.close();
    if (narrow) panel.showModal(); else panel.setAttribute('open', '');
    shownMode.current = narrow;
    // Changing modality must not discard a valid focus position in the panel
    // or an already focused conversation control when returning to a sidebar.
    if (!firstOpen && previousFocus instanceof HTMLElement && previousFocus.isConnected && !previousFocus.closest('[hidden], [inert]') && (!narrow || panel.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
    else close.current?.focus({ preventScroll: true });
    // Widening can clamp scrollTop before ResizeObserver runs. Restore through
    // the existing Timeline owner before that automatic scroll becomes intent.
    const saved = reading.current; reading.current = null;
    if (saved && boundPane(cache, bot) === saved.pane && saved.pane.reading.current === saved.handle) saved.handle.restoreBookmark(saved.bookmark);
  }, [narrow, modalBlocked, cache, bot]);
  useLayoutEffect(() => {
    const panel = dialog.current!;
    return () => {
      panel.close(); shownMode.current = null;
      const target = opener.current;
      if (target?.isConnected && !target.closest('[hidden], [inert]')) target.focus({ preventScroll: true });
    };
  }, [opener]);
  useLayoutEffect(() => {
    const panel = dialog.current!, viewport = window.visualViewport;
    const resize = () => {
      const values = { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight, top: viewport?.offsetTop ?? 0, left: viewport?.offsetLeft ?? 0 };
      for (const [key, value] of Object.entries(values)) panel.style.setProperty(`--bot-details-viewport-${key}`, `${value}px`);
    };
    resize(); window.addEventListener('resize', resize);
    viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize);
    return () => { window.removeEventListener('resize', resize); viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize); };
  }, []);
  const legacyRole = bot?.roleConfiguration?.revision === 'daynight-assistant/1' || bot?.roleConfiguration?.revision === 'daynight-assistant/2';
  return <dialog id={id} ref={dialog} className={`bot-details-panel${narrow ? ' bot-details-drawer' : ''}`} role={narrow ? 'dialog' : 'complementary'} aria-label={m.details} aria-modal={narrow ? true : undefined}
    onCancel={event => { event.preventDefault(); if (!modalBlocked) onClose(); }}
    onKeyDown={event => {
      if (modalBlocked || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      // Native modality isolates the background; stop Tab before fullscreen's
      // broader boundary handles the same keyboard event.
      else if (narrow && event.key === 'Tab') {
        const controls = dialogFocusables(event.currentTarget), first = controls[0], last = controls[controls.length - 1];
        if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
        event.stopPropagation();
      }
    }}>
    <header><h2>{m.details}</h2>{narrow && <AccountRefreshNotice />}<button ref={close} className="button quiet" type="button" aria-label={m.closeDetails} onClick={onClose}>×</button></header>
    <div className="bot-details-scroll">
      {bot === null ? <p role="status">{m.loading}</p> : <>
        {assistantTasks}
        <div className="bot-details-profile"><span>{m.name}</span><strong>{bot.name}</strong>{legacyRole ? <p>{m.legacyRoleNotice}</p> : null}</div>
        <section className="bot-details-section"><h3>{m.runInformation}</h3><dl>
          <BotObservationInformation bot={bot} observation={observation} />
          <div><dt>{m.cwd}</dt><dd><code>{bot.resolvedConfiguration.cwd}</code></dd></div>
        </dl></section>
        <section className="bot-details-section"><h3>{m.sessionInformation}</h3>{cache && bot.sessionId && bot.testExecutionId ? <BoundSessionInformation cache={cache} bot={bot} /> : <p>{m.sessionUnavailable}</p>}</section>
      </>}
    </div>
    {bot && onDelete ? <footer><button className="button danger" type="button" disabled={deleteDisabled} onClick={event => onDelete(bot, event.currentTarget)}>{m.delete}</button></footer> : null}
  </dialog>;
}

function BotObservationInformation({ bot, observation }: { readonly bot: BotDefinition; readonly observation?: BotObservationRead | undefined }) {
  const m = useBotObservationMessages(), b = useBotMessages();
  const value = observation?.value?.botId === bot.id ? observation.value : null;
  const names = useWorkerNames(value ? [{ userId: bot.ownerUserId, workerId: value.workerId }] : []);
  const machineName = value ? names.name(bot.ownerUserId, value.workerId, value.machine?.name ?? m.machineUnknown, true) : m.machineUnknown;
  const provider = value?.provider ?? bot.resolvedConfiguration.provider;
  const time = (value: string | null | undefined) => value ? <time dateTime={value}>{new Date(value).toLocaleString()}</time> : m.unknown;
  const reason = value?.reason ?? '';
  let action: string | null = null;
  if (value && !observation?.stale) {
    if (reason === 'recovery_version_unsupported') action = m.actions.version;
    else if (reason === 'outcome_unknown') action = m.actions.outcome;
    else if (reason.startsWith('provider_')) action = m.actions.provider;
    else if (['native_identity_missing', 'native_session_missing', 'native_record_missing', 'recovery_material_missing', 'recovery_material_invalid', 'recovery_material_incomplete'].includes(reason)) action = m.actions.native;
    else if (reason.includes('identity_mismatch') || reason.includes('conflict') || reason.includes('ownership')) action = m.actions.identity;
    else if (reason === 'directory_missing' || reason === 'invalid_cwd') action = m.actions.directory;
    else if (value.state === 'connecting') action = m.actions.connecting;
    else if (value.state === 'recovering') action = m.actions.recovering;
    else if (value.state === 'abnormal') action = m.actions.failure;
  }
  return <>
    <div><dt>{b.status}</dt><dd><BotStatus bot={bot} observation={observation} showWorkerName={false} />{observation?.error ? <p role="alert">{m.readFailed}</p> : null}{observation && <button className="button quiet bot-observation-refresh" type="button" aria-busy={observation.refreshing} disabled={observation.refreshing} onClick={observation.refreshExplicit}>{m.refresh}</button>}</dd></div>
    <div><dt>{m.machine}</dt><dd><bdi>{machineName}</bdi>{value?.machine && <p><code>{value.machine.id}</code></p>}</dd></div>
    <div><dt>{m.workerId}</dt><dd><code>{value?.workerId ?? m.unknown}</code></dd></div>
    <div><dt>{b.agent}</dt><dd>{provider === 'claude' ? 'Claude Code' : provider === 'copilot' ? 'GitHub Copilot' : 'Codex'}</dd></div>
    {value && observation?.stale ? <div><dt>{m.lastState}</dt><dd>{m.states[value.state]}<p>{m.staleHelp}</p></dd></div> : null}
    {value && <div><dt>{m.reason}</dt><dd>{m.describeReason(reason) !== reason && m.describeReason(reason)}<p><code>{reason}</code></p></dd></div>}
    {value && !observation?.stale && value.state === 'offline' ? <div><dt>{m.action}</dt><dd>{value.machine ? m.actions.offline : m.actions.machineUnknown} <code>daynight worker run</code></dd></div> : action ? <div><dt>{m.action}</dt><dd>{action}</dd></div> : null}
    <div><dt>{m.platformSession}</dt><dd><code>{value?.sessionId ?? m.unknown}</code></dd></div>
    <div><dt>{m.nativeSession}</dt><dd><code>{value?.nativeSessionId ?? m.unknown}</code></dd></div>
    <div><dt>{m.observed}</dt><dd>{time(value?.observedAt)}</dd></div>
    <div><dt>{m.workerLastSeen}</dt><dd>{time(value?.workerLastSeenAt)}</dd></div>
    <div><dt>{m.sessionLastSeen}</dt><dd>{time(value?.sessionLastSeenAt)}</dd></div>
  </>;
}

function boundPane(cache: BotSessionCache | undefined, bot: BotDefinition | null): BotSessionPane | undefined {
  if (!cache || !bot?.sessionId || !bot.testExecutionId || !cache.isCurrent()) return undefined;
  const key = botSessionKey({ ownerUserId: bot.ownerUserId, botId: bot.id, sessionId: bot.sessionId, testExecutionId: bot.testExecutionId });
  return cache.snapshot().find(pane => pane.key === key);
}

function BoundSessionInformation({ cache, bot }: { readonly cache: BotSessionCache; readonly bot: BotDefinition }) {
  const panes = useSyncExternalStore(cache.subscribe, cache.snapshot), m = useBotMessages();
  const key = botSessionKey({ ownerUserId: bot.ownerUserId, botId: bot.id, sessionId: bot.sessionId!, testExecutionId: bot.testExecutionId! });
  const pane = panes.find(item => item.key === key);
  return pane ? <SessionInformation key={pane.key} pane={pane} /> : <p>{m.sessionUnavailable}</p>;
}

function SessionInformation({ pane }: { readonly pane: BotSessionPane }) {
  const view = useSyncExternalStore(pane.client.subscribe, pane.client.snapshot), m = useSessionMessages(), b = useBotMessages();
  const snapshot = view.state.snapshot;
  const current = snapshot && view.status !== 'unavailable' && snapshot.identity.ownerUserId === pane.binding.ownerUserId && snapshot.sessionId === pane.binding.sessionId && snapshot.testExecutionId === pane.binding.testExecutionId ? snapshot : null;
  const controls = useSessionControlMessages(current?.identity.provider);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!current || view.startupReport?.startup.state !== 'starting') return;
    const remaining = Date.parse(view.startupReport.observedAt) + 90_001 - Date.now();
    if (remaining <= 0) { setNow(Date.now()); return; }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 90_001));
    return () => clearTimeout(timer);
  }, [current, view.startupReport]);
  if (!current) return <p>{b.sessionUnavailable}</p>;
  const presentation = selectSessionPresentation({ snapshot: current, report: view.startupReport, connected: view.connected, error: view.error, errorCode: view.errorCode, now: Math.max(now, Date.now()), previouslyConnected: view.environmentConnected });
  const label = presentation.native ? sessionNativeLabels[presentation.label as keyof typeof sessionNativeLabels] : m[presentation.label];
  const report = presentation.report;
  return <>
    <p lang={presentation.native ? 'en' : undefined}>{label}</p>
    {report && current.lifecycle === 'active' && (report.startup.state === 'failed' || report.startup.state === 'unknown' || report.recovery.state === 'blocked') ? <div className="bot-details-reason"><p>{m[`startup_${report.startup.reasonCode}`]}</p>{report.recovery.state === 'blocked' ? <p>{m[`recovery_${report.recovery.reasonCode}`]}</p> : null}<small>{m.startupObserved}: <time dateTime={report.observedAt}>{new Date(report.observedAt).toLocaleString()}</time></small></div> : null}
    {current.controls?.settings.length ? <dl>{current.controls.settings.map(setting => {
      const intent = view.settingIntents.get(setting.id), operation = intent && view.state.operations.get(intent.operationId);
      const pending = operation && !['confirmed', 'failed', 'rejected', 'expired'].includes(operation.state);
      const receipt = operation && operationPresentation(operation, view.operationProgress);
      const option = setting.options.find(item => item.value === setting.value);
      const actual = option ? controls.optionLabel(setting, option) : setting.value ?? m.unavailableValue;
      return <div key={setting.id}><dt>{controls.settingLabel(setting)}</dt><dd>{actual}{pending ? <p role="status" data-setting-state="pending">{receipt === 'unknown' ? m.settingUnknown : receipt === 'waiting' ? m.waiting : m.settingPending}</p> : null}{setting.scope === 'next_turn' ? <small>{m.nextTurnSetting}</small> : null}</dd></div>;
    })}</dl> : null}
    {current.controls?.settingsError ? <p className="bot-details-reason">{current.controls.settingsError}</p> : null}
  </>;
}
