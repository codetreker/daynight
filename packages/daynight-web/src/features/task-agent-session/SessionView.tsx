import { operationErrorText } from './operation-error';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import { selectSessionPresentation } from './presentation';
import type { TaskSessionClient, SessionViewState } from './client';
import type { SessionPresentationSlots } from './session-presentation-slots';
import { useSessionDisplayPreference } from './useSessionDisplayPreference';
import { useSessionFullscreen } from './useSessionFullscreen';
import { useSessionColumnLayout } from './useSessionColumnLayout';
import { SessionDisplayMenu } from './SessionDisplayMenu';
import { SessionComposer } from './SessionComposer';
import type { ComposerAttachmentsBinding } from './ComposerAttachments';
import { SessionTimeline, type SessionTimelineReading } from './SessionTimeline';
import { matchingSessionHistoryPreview, selectSessionHistoryRows, type SessionHistoryPreview } from './history-preview';
import { emptySessionState, sessionRespondGate } from './state';
import { operationNeedsAttention, operationPresentation } from './operation-presentation';
import { sessionNativeLabels, useSessionMessages } from './messages';
import { SessionImageScope } from './images/SessionImageScope';
import { useInvalidImageBindings } from './useInvalidImageBindings';
import '../../styles/task-session.css';

const emptyView: SessionViewState = { actionAdmitted: false, operationProgress: new Map(), environmentConnected: false, startupReport: null, errorCode: null, archiveState: null, settingIntents: new Map(), draft: { text: '', revision: '0', submission: null }, state: emptySessionState(), status: 'loading', connected: false, authPaused: false, error: null, hasOlder: false, loadingOlder: false, historyError: null, checking: new Set(), historyReady: false, historyLoaded: false, historySettled: false, historyCoverage: null, historyRevision: 0, connectionGeneration: 0 };
const emptySubscribe = () => () => {};
const emptySnapshot = () => emptyView;
const emptyImageDraft = () => null;
const noAction = async () => {};
const noResource = async (): Promise<Blob> => { throw new Error('Historical resources are unavailable.'); };

export function SessionView({ client, userId, active, current, reading, fullscreenBoundary, presentation: slots, historyPreview, pendingPhase, onRetry, error }: { readonly client: TaskSessionClient | null; readonly historyPreview?: SessionHistoryPreview; readonly pendingPhase?: 'binding' | 'snapshot' | 'history'; readonly onRetry?: () => void; readonly error?: string | null; readonly userId: string; readonly active: boolean; readonly current: boolean; readonly reading?: SessionTimelineReading; readonly fullscreenBoundary?: RefObject<HTMLElement | null>; readonly presentation?: SessionPresentationSlots }) {
  const view = useSyncExternalStore(client?.subscribe ?? emptySubscribe, client?.snapshot ?? emptySnapshot);
  const imageDraft = useSyncExternalStore(client?.imageDrafts?.subscribe ?? emptySubscribe, client?.imageDrafts?.getSnapshot ?? emptyImageDraft);
  useEffect(() => {
    client?.setImageDraftAdmission?.(active, current);
    return () => client?.setImageDraftAdmission?.(false, false);
  }, [client, active, current]);
  const attachments: ComposerAttachmentsBinding | undefined = imageDraft && client?.imageDrafts ? {
    view: imageDraft,
    addFiles: (files, text) => client.imageDrafts.addFiles(files, text), remove: id => client.imageDrafts.remove(id),
    discardRejected: () => client.imageDrafts.discardRejected(), retrySave: () => client.imageDrafts.retrySave(),
    retryUpload: id => client.imageDrafts.retryUpload(id), checkStatus: ref => client.imageDrafts.checkStatus(ref),
    continueEditing: () => client.imageDrafts.continueEditing(), resolveConflict: choice => client.imageDrafts.resolveConflict(choice),
    resolveFailure: (ref, choice) => client.imageDrafts.resolveFailure(ref, choice),
    resumePrepared: () => client.imageDrafts.resumePrepared(),
    cancelPrepared: ref => client.imageDrafts.cancelPrepared(ref),
    restoreDetached: ref => client.imageDrafts.restoreDetached(ref),
    retryDetachedSave: ref => client.imageDrafts.retryDetachedSave(ref),
    resolveDetachedConflict: (ref, choice) => client.imageDrafts.resolveDetachedConflict(ref, choice),
  } : undefined;
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
  const preview = matchingSessionHistoryPreview(view.state, historyPreview);
  const previewEnabled = slots?.variant === 'assistant' || historyPreview !== undefined || client === null;
  const timelineState = previewEnabled && !view.historyLoaded ? { ...view.state, entries: [], resources: new Map() } : view.state;
  const hasContent = selectSessionHistoryRows(timelineState, preview, view.historyLoaded, view.historyCoverage).length > 0;
  const previewMode = client === null || !view.historyLoaded;
  const phase = pendingPhase ?? (client === null ? 'binding' : s === null ? 'snapshot' : 'history');
  const issue = error ?? view.error;
  const refresh = client?.refresh ?? onRetry ?? (() => {});
  const retry = error ? onRetry ?? refresh : refresh;
  const invalidImageBindings = useInvalidImageBindings(client, s ? JSON.stringify([userId, sessionFenceKey(s), s.historyEpoch, s.identity.nativeSessionId]) : null, view.state.entries, active && current && !view.authPaused && view.historyLoaded && view.status !== 'unavailable', refresh);
  const fallbackOwner = useRef({});
  const display = useSessionDisplayPreference(s && view.status !== 'unavailable' ? { userId, sessionId: s.sessionId } : null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  useEffect(() => { setDisplayOpen(false); }, [active, userId, s?.sessionId]);
  const fullscreen = useSessionFullscreen({ client: previewEnabled ? fallbackOwner.current : client ?? fallbackOwner.current, userId, active, identity: previewEnabled ? s ? sessionFenceKey(s) : preview ? sessionFenceKey(preview.fence) : null : s?.sessionId ?? null, ...(fullscreenBoundary ? { fullscreenBoundary } : {}) });
  const connected = current && view.connected;
  const available = s !== null && view.status !== 'unavailable';
  const operations = [...view.state.operations.values()].filter(operation => operationNeedsAttention(operation, view.operationProgress));
  const readOnly = s !== null && s.lifecycle !== 'active';
  const canInteract = client?.canInteract() ?? false;
  useSessionColumnLayout(fullscreen.sectionRef, available && !readOnly ? `${userId}/${sessionFenceKey(s)}` : null);
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
  const refreshControl = defaultHeader ? <button className="button session-refresh-toggle" type="button" aria-label={m.refresh} disabled={view.authPaused} onClick={refresh}>
    <span className="session-refresh-label">{m.refresh}</span>
    <svg className="session-refresh-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" /></svg>
    <span className="session-refresh-tooltip" aria-hidden="true">{m.refresh}</span>
  </button> : <button className="button" disabled={view.authPaused} onClick={refresh}>{m.refresh}</button>;
  const emptyReady = !hasContent && canInteract && available && view.status === 'ready' && active && current && runtimeReady && !readOnly && !imageDraft?.loading && !(imageDraft?.active && imageDraft.readOnly) && view.historyReady && !view.hasOlder && !view.loadingOlder && !view.historyError && !view.error && !view.state.recoveryRequired && view.state.entries.length === 0 && s.activity === 'idle';
  const empty = emptyReady && slots?.renderEmpty ? slots.renderEmpty({ draft: view.draft, setDraftAndFocus: text => {
    const latest = client?.snapshot(), latestDraft = client?.imageDrafts?.getSnapshot();
    if (!mounted.current || !admission.current.active || !admission.current.current || admission.current.userId !== userId || !inputRef.current || latestDraft?.loading || latestDraft?.active && latestDraft.readOnly || !latest || latest.status !== 'ready' || !latest.state.snapshot || !s || sessionFenceKey(latest.state.snapshot) !== sessionFenceKey(s) || latest.state.snapshot.lifecycle !== 'active') return;
    client?.setDraft(text); inputRef.current?.focus({ preventScroll: true });
  } }) : null;
  const timelineAllowed = available && (!readOnly || view.archiveState === 'ready') || preview !== undefined || !readOnly && (slots?.renderPending !== undefined || slots?.variant === 'assistant' || client === null);
  const timelineKey = `${userId}/${s || preview ? sessionFenceKey(s ?? preview!.fence) : 'pending'}`;
  const timeline = timelineAllowed ? <SessionTimeline key={timelineKey} {...(preview ? { historyPreview: preview } : {})} historyLoaded={view.historyLoaded} historyCoverage={view.historyCoverage} {...(reading ? { reading } : {})} displayMode={display.mode} suppressEmpty={previewEnabled && previewMode || !readOnly && !runtimeReady || empty != null && empty !== false} state={timelineState} active={active} actionAdmitted={view.actionAdmitted} canRespond={sessionRespondGate(view.state, canInteract && active && runtimeReady && !view.authPaused)} onRespond={client?.respond ?? noAction} hasOlder={view.hasOlder} historyReady={!!runtimeReady && !readOnly && !view.authPaused && view.historyReady} historyComplete={readOnly && view.archiveState === 'ready'} historyRevision={view.historyRevision} connectionGeneration={view.connectionGeneration} loadingOlder={view.loadingOlder} onLoadOlder={() => client?.loadOlder() ?? noAction()} historyError={view.historyError} onLoadResource={client?.resource ?? noResource} onInvalidImageBindings={invalidImageBindings} /> : null;
  const loadingSlot = { phase, hasContent, retry };
  const pending = !hasContent && !issue && previewMode ? slots?.renderPending?.(loadingSlot) : null;
  const unavailable = issue ? slots?.renderUnavailable?.({ ...loadingSlot, error: issue }) : null;
  const assistantShell = slots?.variant === 'assistant' || historyPreview !== undefined || client === null;

  return <section className={`task-agent-session${defaultHeader ? ' session-default-header-layout' : ''}${slots?.variant === 'assistant' ? ' session-presentation-assistant' : ''}${fullscreen.fullscreen && !fullscreenBoundary ? ' session-fullscreen' : ''}`} aria-label={m.title} ref={fullscreen.sectionRef} tabIndex={-1} onKeyDown={fullscreen.onKeyDown}>
    <SessionImageScope scope={client?.imageScope?.() ?? null} rootRef={fullscreen.sectionRef} active={active} readAdmitted={current && !view.authPaused} onPreviewChange={setImagePreviewOpen}>
    <header className={`session-header${defaultHeader ? ' session-header-default' : ''}`}>{slots?.renderHeader ? slots.renderHeader({ snapshot: available ? s : null, startupReport: available ? presentation?.report ?? null : null, active, current, available, readOnly, runtimeReady: available && runtimeReady, authPaused: view.authPaused, status: view.status, fullscreen: fullscreen.fullscreen, displayMode: display.mode, statusDescriptionId: statusId, provider, activity, display: displayControl, focus: focusControl, refresh: refreshControl }) : <><div className="session-header-identity">{provider}{activity}</div><div className="session-header-actions">{displayControl}{focusControl}{refreshControl}</div></>}</header>
    {!available && !assistantShell ? <div className="session-empty" role="status"><p>{view.status === 'loading' ? m.loading : view.status === 'not_registered' ? m.notRegistered : view.status === 'unavailable' ? view.error ?? m.unavailable : view.error}</p></div> : <>
    {showReason ? <details className="session-startup-details"><summary>{m.startupDetails}</summary>
      <p>{m[`startup_${report.startup.reasonCode}`]}</p>
      {report.recovery.state === 'blocked' ? <p>{m[`recovery_${report.recovery.reasonCode}`]}</p> : null}
      <small>{m.startupObserved}: <time dateTime={report.observedAt}>{new Date(report.observedAt).toLocaleString()}</time></small>
    </details> : null}
    {issue && (error || view.errorCode !== 'controller_offline') ? unavailable ?? <p className="session-error" role="alert">{issue}{assistantShell && (error || !hasContent) ? <button className="inline-link" onClick={retry}>{m.retryHistory}</button> : null}</p> : null}
    {readOnly && view.archiveState !== 'ready' ? <p className="session-empty" role="status">{archiveLabel}</p> : null}
    {timeline ? assistantShell || slots?.renderEmpty ? <div className="session-timeline-shell session-presentation-timeline">{timeline}{empty != null && empty !== false ? <div className="session-presentation-empty">{empty}</div> : null}{assistantShell && !hasContent && !issue && previewMode ? <div className="session-presentation-pending" role="status">{pending ?? <SessionPendingContent />}</div> : null}</div> : timeline : null}
    {client && !readOnly && operations.length > 0 ? <div className="session-receipts" aria-live="polite">{operations.map(operation => {
      const receipt = operationPresentation(operation, view.operationProgress);
      return <div key={operation.operationId} className={`session-receipt ${receipt}`}>
        {operation.error ? <span>{operationErrorText(operation.error.message, m.operationFailed)}</span> : <span>{receipt === 'failed' ? m.operationFailed : receipt === 'rejected' ? m.operationRejected : receipt === 'expired' ? m.operationExpired : m.operationUnconfirmed}</span>}
        {checkErrors.has(operation.operationId) ? <span className="session-error" role="alert">{operationErrorText(checkErrors.get(operation.operationId)!, m.operationFailed)}</span> : null}
        {receipt === 'unknown' ? <button className="inline-link" disabled={view.authPaused || view.checking.has(operation.operationId)} onClick={() => { void client.checkOperation(operation.operationId).then(() => setCheckErrors(previous => { const next = new Map(previous); next.delete(operation.operationId); return next; }), (error: unknown) => setCheckErrors(previous => new Map(previous).set(operation.operationId, error instanceof Error ? error.message : m.failure))); }}>{view.checking.has(operation.operationId) ? m.checking : m.check}</button> : null}
      </div>;
    })}</div> : null}
    {client && s && !readOnly ? <SessionComposer {...(attachments ? { attachments } : {})} inputRef={inputRef} {...(slots?.composer ? { presentation: slots.composer } : {})} canInteract={canInteract} actionAdmitted={view.actionAdmitted} sessionNoticeOwned={!presentation?.native} statusDescriptionId={statusId} suppressKeyboardHint={displayOpen || imagePreviewOpen} key={s ? sessionFenceKey(s) : undefined} state={view.state} connected={active && runtimeReady} authPaused={view.authPaused} active={active} draft={view.draft} onDraftChange={client.setDraft} onSend={client.send} onCancel={client.cancel} operationProgress={view.operationProgress} settingIntents={view.settingIntents} onUpdateSetting={client.updateSetting} onExecuteCommand={client.executeCommand} onRefreshControls={client.refreshControls} /> : assistantShell ? <SessionComposerPlaceholder /> : null}
    </>}
    </SessionImageScope>
  </section>;
}

/** The binding-free shell has no draft or command owner. */
export function SessionComposerPlaceholder() {
  const m = useSessionMessages();
  return <div className="session-composer-placeholder" aria-label={m.message}><span>{m.placeholder}</span><span aria-hidden="true">↑</span></div>;
}

export function SessionPendingContent() {
  const m = useSessionMessages();
  return <div className="session-pending-content" aria-label={m.loading}><span /><span /><span /></div>;
}
