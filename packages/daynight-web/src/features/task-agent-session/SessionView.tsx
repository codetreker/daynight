import { operationErrorText } from './operation-error';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import { selectSessionPresentation } from './presentation';
import type { TaskSessionClient } from './client';
import type { SessionPresentationSlots } from './session-presentation-slots';
import { useSessionDisplayPreference } from './useSessionDisplayPreference';
import { useSessionFullscreen } from './useSessionFullscreen';
import { SessionDisplayMenu } from './SessionDisplayMenu';
import { SessionComposer } from './SessionComposer';
import { SessionTimeline, type SessionTimelineReading } from './SessionTimeline';
import { sessionRespondGate } from './state';
import { operationNeedsAttention, operationPresentation } from './operation-presentation';
import { sessionNativeLabels, useSessionMessages } from './messages';
import '../../styles/task-session.css';

export function SessionView({ client, userId, active, current, reading, fullscreenBoundary, presentation: slots }: { readonly client: TaskSessionClient; readonly userId: string; readonly active: boolean; readonly current: boolean; readonly reading?: SessionTimelineReading; readonly fullscreenBoundary?: RefObject<HTMLElement | null>; readonly presentation?: SessionPresentationSlots }) {
  const view = useSyncExternalStore(client.subscribe, client.snapshot);
  const m = useSessionMessages();
  const statusId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const admission = useRef({ active, current, userId }); admission.current = { active, current, userId };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const report = view.startupReport;
    if (report?.startup.state !== 'starting') return;
    const remaining = Date.parse(report.observedAt) + 90_001 - Date.now();
    if (remaining <= 0) { setNow(Date.now()); return; }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 90_001));
    return () => clearTimeout(timer);
  }, [view.startupReport]);
  const [checkErrors, setCheckErrors] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    setCheckErrors(previous => {
      const next = new Map([...previous].filter(([id]) => {
        const operation = view.state.operations.get(id);
        return operation && operationNeedsAttention(operation, view.operationProgress);
      }));
      return next.size === previous.size ? previous : next;
    });
  }, [view.state.operations, view.operationProgress]);
  const s = view.state.snapshot;
  const display = useSessionDisplayPreference(s && view.status !== 'unavailable' ? { userId, sessionId: s.sessionId } : null);
  const [displayOpen, setDisplayOpen] = useState(false);
  useEffect(() => { setDisplayOpen(false); }, [active, userId, s?.sessionId]);
  const fullscreen = useSessionFullscreen({ client, userId, active, identity: s?.sessionId ?? null, ...(fullscreenBoundary ? { fullscreenBoundary } : {}) });
  const connected = current && view.connected;
  const available = s !== null && view.status !== 'unavailable';
  const operations = [...view.state.operations.values()].filter(operation => operationNeedsAttention(operation, view.operationProgress));
  const readOnly = s?.lifecycle !== 'active';
  const archiveLabel = view.archiveState === 'ready' ? m.archived : view.archiveState === 'failed' ? m.archiveFailed : view.archiveState === 'unavailable' ? (s?.lifecycle === 'draining' ? m.archivePreparing : m.archiveUnavailable) : view.archiveState === 'pending' ? m.archivePending : m.archiveLoading;
  const presentation = s ? selectSessionPresentation({ snapshot: s, report: view.startupReport, connected, error: view.error, errorCode: view.errorCode, now: Math.max(now, Date.now()), previouslyConnected: view.environmentConnected }) : null;
  const runtimeReady = presentation?.operational === true;
  const activityLabel = presentation ? presentation.native ? sessionNativeLabels[presentation.label as keyof typeof sessionNativeLabels] : m[presentation.label] : null;
  const report = presentation?.report;
  const showReason = report && !readOnly && (report.startup.state === 'failed' || report.startup.state === 'unknown' || report.recovery.state === 'blocked');
  const fullscreenLabel = fullscreen.fullscreen ? m.exitFullscreen : m.enterFullscreen;
  const defaultHeader = !slots?.renderHeader;
  const provider = <strong className={defaultHeader ? 'session-provider' : undefined}>{available ? s.identity.provider === 'claude' ? 'Claude Code' : s.identity.provider === 'copilot' ? 'GitHub Copilot' : 'Codex' : m.title}</strong>;
  const activity = available && <span className={`session-status ${runtimeReady ? 'online' : 'offline'}`} role="status" id={statusId} lang={presentation?.native ? "en" : undefined}>{activityLabel}</span>;
  const displayControl = available && <SessionDisplayMenu mode={display.mode} issue={display.issue} onModeChange={display.setMode} onRetrySave={display.retrySave} open={active && displayOpen} onOpenChange={setDisplayOpen} />;
  const focusControl = <button className="button session-fullscreen-toggle" type="button" ref={fullscreen.buttonRef} aria-label={fullscreenLabel} title={fullscreenLabel} aria-pressed={fullscreen.fullscreen} onClick={fullscreen.toggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.fullscreen ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'} /></svg>
        <span className="session-fullscreen-tooltip" aria-hidden="true">{fullscreenLabel}</span>
      </button>;
  const refreshControl = defaultHeader ? <button className="button session-refresh-toggle" type="button" aria-label={m.refresh} disabled={view.authPaused} onClick={client.refresh}>
    <span className="session-refresh-label">{m.refresh}</span>
    <svg className="session-refresh-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
    <span className="session-refresh-tooltip" aria-hidden="true">{m.refresh}</span>
  </button> : <button className="button" disabled={view.authPaused} onClick={client.refresh}>{m.refresh}</button>;
  const emptyReady = available && view.status === 'ready' && active && current && runtimeReady && !readOnly && view.historyReady && !view.hasOlder && !view.loadingOlder && !view.historyError && !view.error && !view.state.recoveryRequired && view.state.entries.length === 0 && s.activity === 'idle';
  const empty = emptyReady && slots?.renderEmpty ? slots.renderEmpty({ draft: view.draft, setDraftAndFocus: text => {
    const latest = client.snapshot();
    if (!mounted.current || !admission.current.active || !admission.current.current || admission.current.userId !== userId || !inputRef.current || latest.status !== 'ready' || !latest.state.snapshot || !s || sessionFenceKey(latest.state.snapshot) !== sessionFenceKey(s) || latest.state.snapshot.lifecycle !== 'active') return;
    client.setDraft(text); inputRef.current?.focus({ preventScroll: true });
  } }) : null;
  const timeline = available && (!readOnly || view.archiveState === 'ready') ? <SessionTimeline key={`${userId}/${s.sessionId}`} {...(reading ? { reading } : {})} displayMode={display.mode} suppressEmpty={!readOnly && !runtimeReady || empty != null && empty !== false} state={view.state} active={active} canRespond={sessionRespondGate(view.state, active && runtimeReady && !view.authPaused)} onRespond={client.respond} hasOlder={view.hasOlder} historyReady={!!runtimeReady && !readOnly && !view.authPaused && view.historyReady} historyComplete={readOnly && view.archiveState === 'ready'} historyRevision={view.historyRevision} connectionGeneration={view.connectionGeneration} loadingOlder={view.loadingOlder} onLoadOlder={() => client.loadOlder()} historyError={view.historyError} onLoadResource={client.resource} /> : null;
  return <section className={`task-agent-session${defaultHeader ? ' session-default-header-layout' : ''}${slots?.variant === 'assistant' ? ' session-presentation-assistant' : ''}${fullscreen.fullscreen && !fullscreenBoundary ? ' session-fullscreen' : ''}`} aria-label={m.title} ref={fullscreen.sectionRef} tabIndex={-1} onKeyDown={fullscreen.onKeyDown}>
    <header className={`session-header${defaultHeader ? ' session-header-default' : ''}`}>{slots?.renderHeader ? slots.renderHeader({ snapshot: available ? s : null, startupReport: available ? presentation?.report ?? null : null, active, current, available, readOnly, runtimeReady: available && runtimeReady, authPaused: view.authPaused, status: view.status, fullscreen: fullscreen.fullscreen, displayMode: display.mode, statusDescriptionId: statusId, provider, activity, display: displayControl, focus: focusControl, refresh: refreshControl }) : <><div className="session-header-identity">{provider}{activity}</div><div className="session-header-actions">{displayControl}{focusControl}{refreshControl}</div></>}</header>
    {!available ? <div className="session-empty" role="status"><p>{view.status === 'loading' ? m.loading : view.status === 'not_registered' ? m.notRegistered : view.status === 'unavailable' ? view.error ?? m.unavailable : view.error}</p></div> : <>
    {showReason ? <details className="session-startup-details"><summary>{m.startupDetails}</summary>
      <p>{m[`startup_${report.startup.reasonCode}`]}</p>
      {report.recovery.state === 'blocked' ? <p>{m[`recovery_${report.recovery.reasonCode}`]}</p> : null}
      <small>{m.startupObserved}: <time dateTime={report.observedAt}>{new Date(report.observedAt).toLocaleString()}</time></small>
    </details> : null}
    {view.error && view.errorCode !== 'controller_offline' ? <p className="session-error" role="alert">{view.error}</p> : null}
    {readOnly && view.archiveState !== 'ready' ? <p className="session-empty" role="status">{archiveLabel}</p> : null}
    {!readOnly || view.archiveState === 'ready' ? (slots?.renderEmpty ? <div className="session-timeline-shell session-presentation-timeline">{timeline}{empty != null && empty !== false ? <div className="session-presentation-empty">{empty}</div> : null}</div> : timeline) : null}
    {!readOnly && operations.length > 0 ? <div className="session-receipts" aria-live="polite">{operations.map(operation => {
      const receipt = operationPresentation(operation, view.operationProgress);
      return <div key={operation.operationId} className={`session-receipt ${receipt}`}>
        {operation.error ? <span>{operationErrorText(operation.error.message, m.operationFailed)}</span> : <span>{receipt === 'failed' ? m.operationFailed : receipt === 'rejected' ? m.operationRejected : receipt === 'expired' ? m.operationExpired : m.operationUnconfirmed}</span>}
        {checkErrors.has(operation.operationId) ? <span className="session-error" role="alert">{operationErrorText(checkErrors.get(operation.operationId)!, m.operationFailed)}</span> : null}
        {receipt === 'unknown' ? <button className="inline-link" disabled={view.authPaused || view.checking.has(operation.operationId)} onClick={() => { void client.checkOperation(operation.operationId).then(() => setCheckErrors(previous => { const next = new Map(previous); next.delete(operation.operationId); return next; }), (error: unknown) => setCheckErrors(previous => new Map(previous).set(operation.operationId, error instanceof Error ? error.message : m.failure))); }}>{view.checking.has(operation.operationId) ? m.checking : m.check}</button> : null}
      </div>;
    })}</div> : null}
    {!readOnly ? <SessionComposer inputRef={inputRef} {...(slots?.composer ? { presentation: slots.composer } : {})} sessionNoticeOwned={!presentation?.native} statusDescriptionId={statusId} suppressKeyboardHint={displayOpen} key={sessionFenceKey(s)} state={view.state} connected={active && runtimeReady} authPaused={view.authPaused} active={active} draft={view.draft} onDraftChange={client.setDraft} onSend={client.send} onCancel={client.cancel} operationProgress={view.operationProgress} settingIntents={view.settingIntents} onUpdateSetting={client.updateSetting} onExecuteCommand={client.executeCommand} onRefreshControls={client.refreshControls} /> : null}
    </>}
  </section>;
}
