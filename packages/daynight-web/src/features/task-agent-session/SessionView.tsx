import { useEffect, useState, useSyncExternalStore } from 'react';
import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import type { TaskSessionClient } from './client';
import { useSessionDisplayPreference } from './useSessionDisplayPreference';
import { useSessionFullscreen } from './useSessionFullscreen';
import { SessionDisplayMenu } from './SessionDisplayMenu';
import { SessionComposer } from './SessionComposer';
import { SessionTimeline } from './SessionTimeline';
import { sessionRespondGate } from './state';
import { sessionNativeLabels, useSessionMessages } from './messages';
import '../../styles/task-session.css';

export function SessionView({ client, userId, active, current }: { readonly client: TaskSessionClient; readonly userId: string; readonly active: boolean; readonly current: boolean }) {
  const view = useSyncExternalStore(client.subscribe, client.snapshot);
  const m = useSessionMessages();
  const [checkError, setCheckError] = useState<string | null>(null);
  const s = view.state.snapshot;
  const display = useSessionDisplayPreference(s && view.status !== 'unavailable' ? { userId, sessionId: s.sessionId } : null);
  const [displayOpen, setDisplayOpen] = useState(false);
  useEffect(() => { setDisplayOpen(false); }, [active, userId, s?.sessionId]);
  const fullscreen = useSessionFullscreen({ client, userId, active, identity: s?.sessionId ?? null });
  const connected = current && view.connected;
  const available = s !== null && view.status !== 'unavailable';
  // Provider acceptance completes input delivery, but controls still need confirmation.
  const operations = [...view.state.operations.values()].filter(operation => operation.error !== null || !(operation.state === 'confirmed' || operation.state === 'provider_accepted' && ['send_message', 'execute_command'].includes(operation.kind))).slice(-12);
  const readOnly = s?.lifecycle !== 'active';
  const archiveLabel = view.archiveState === 'ready' ? m.archived : view.archiveState === 'failed' ? m.archiveFailed : view.archiveState === 'unavailable' ? (s?.lifecycle === 'draining' ? m.archivePreparing : m.archiveUnavailable) : view.archiveState === 'pending' ? m.archivePending : m.archiveLoading;
  const runtimeReady = connected && s?.synchronized && s.connectionState === 'connected';
  const activityLabel = readOnly ? sessionNativeLabels.archived : !connected || s?.connectionState === 'disconnected' ? sessionNativeLabels.disconnected : !s?.synchronized || s.connectionState === 'synchronizing' ? sessionNativeLabels.synchronizing : sessionNativeLabels[s.activity];
  const fullscreenLabel = fullscreen.fullscreen ? m.exitFullscreen : m.enterFullscreen;
  return <section className={`task-agent-session${fullscreen.fullscreen ? ' session-fullscreen' : ''}`} aria-label={m.title} ref={fullscreen.sectionRef} tabIndex={-1} onKeyDown={fullscreen.onKeyDown}>
    <header className="session-header"><div><strong>{available ? s.identity.provider === 'claude' ? 'Claude Code' : s.identity.provider === 'copilot' ? 'GitHub Copilot' : 'Codex' : m.title}</strong>{available && <span className={`session-status ${runtimeReady ? 'online' : 'offline'}`} role="status" lang="en">{activityLabel}</span>}</div><div className="session-header-actions">
      {available && <SessionDisplayMenu mode={display.mode} issue={display.issue} onModeChange={display.setMode} onRetrySave={display.retrySave} open={active && displayOpen} onOpenChange={setDisplayOpen} />}
      <button className="button session-fullscreen-toggle" type="button" ref={fullscreen.buttonRef} aria-label={fullscreenLabel} title={fullscreenLabel} aria-pressed={fullscreen.fullscreen} onClick={fullscreen.toggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.fullscreen ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg>
        <span className="session-fullscreen-tooltip" aria-hidden="true">{fullscreenLabel}</span>
      </button>
      <button className="button" disabled={view.authPaused} onClick={client.refresh}>{m.refresh}</button>
    </div></header>
    {!available ? <div className="session-empty" role="status"><p>{view.status === 'loading' ? m.loading : view.status === 'not_registered' ? m.notRegistered : view.status === 'unavailable' ? m.unavailable : view.error}</p></div> : <>
    {!readOnly && s.connectionState === 'disconnected' ? <p className="session-empty" role="status">{m.offlineHistory}</p> : null}
    {view.error ? <p className="session-error" role="alert">{view.error}</p> : null}
    {readOnly ? <p className="session-empty" role="status">{archiveLabel}</p> : null}
    {!readOnly || view.archiveState === 'ready' ? <SessionTimeline displayMode={display.mode} state={view.state} active={active} canRespond={sessionRespondGate(view.state, connected && !view.authPaused)} onRespond={client.respond} hasOlder={view.hasOlder} loadingOlder={view.loadingOlder} onLoadOlder={() => client.loadOlder()} historyError={view.historyError} onLoadResource={client.resource} /> : null}
    {!readOnly && operations.length > 0 ? <div className="session-receipts" aria-live="polite">{operations.map((operation) => <div key={operation.operationId} className={`session-receipt ${operation.state}`}><span>{m[operation.state]}</span>{operation.error ? <span>{operation.error.message}</span> : null}{['unknown', 'accepted', 'offered', 'dispatching'].includes(operation.state) ? <button className="inline-link" disabled={view.authPaused || view.checking.has(operation.operationId)} onClick={() => { setCheckError(null); void client.checkOperation(operation.operationId).catch((error: unknown) => setCheckError(error instanceof Error ? error.message : m.failure)); }}>{view.checking.has(operation.operationId) ? m.checking : m.check}</button> : null}</div>)}</div> : null}
    {checkError ? <p className="session-error" role="alert">{checkError}</p> : null}
    {!readOnly ? <SessionComposer suppressKeyboardHint={displayOpen} key={sessionFenceKey(s)} state={view.state} connected={connected} authPaused={view.authPaused} active={active} draft={view.draft} onDraftChange={client.setDraft} onSend={client.send} onCancel={client.cancel} settingIntents={view.settingIntents} onUpdateSetting={client.updateSetting} onExecuteCommand={client.executeCommand} onRefreshControls={client.refreshControls} /> : null}
    </>}
  </section>;
}
