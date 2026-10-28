import { useState, useSyncExternalStore } from 'react';
import { sessionFenceKey } from '../../../../daynight/src/session/protocol';
import type { TaskSessionClient } from './client';
import { SessionComposer } from './SessionComposer';
import { SessionTimeline } from './SessionTimeline';
import { sessionRespondGate } from './state';
import { useSessionMessages } from './messages';
import '../../styles/task-session.css';

export function SessionView({ client, active, current }: { readonly client: TaskSessionClient; readonly active: boolean; readonly current: boolean }) {
  const view = useSyncExternalStore(client.subscribe, client.snapshot);
  const m = useSessionMessages();
  const [checkError, setCheckError] = useState<string | null>(null);
  const s = view.state.snapshot;
  const connected = current && view.connected;
  if (!s || view.status === 'unavailable') return <div className="session-empty" role="status"><p>{view.status === 'loading' ? m.loading : view.status === 'not_registered' ? m.notRegistered : view.status === 'unavailable' ? m.unavailable : view.error}</p><button className="button" disabled={view.authPaused} onClick={client.refresh}>{m.refresh}</button></div>;
  const operations = [...view.state.operations.values()].slice(-12);
  const runtimeReady = connected && s.synchronized && s.connectionState === 'connected';
  const activityLabel = !connected || s.connectionState === 'disconnected' ? m.disconnected : !s.synchronized || s.connectionState === 'synchronizing' ? m.synchronizing : m[s.activity];
  return <section className="task-agent-session" aria-label={m.title}>
    <header className="session-header"><div><strong>{s.identity.provider === 'claude' ? 'Claude Code' : s.identity.provider === 'copilot' ? 'GitHub Copilot' : 'Codex'}</strong><span className={`session-status ${runtimeReady ? 'online' : 'offline'}`} role="status">{activityLabel}</span></div><button className="button" disabled={view.authPaused} onClick={client.refresh}>{m.refresh}</button></header>
    {view.error ? <p className="session-error" role="alert">{view.error}</p> : null}
    <SessionTimeline state={view.state} active={active} canRespond={sessionRespondGate(view.state, connected && !view.authPaused)} onRespond={client.respond} hasOlder={view.hasOlder} loadingOlder={view.loadingOlder} onLoadOlder={() => client.loadOlder()} historyError={view.historyError} onLoadResource={client.resource} />
    {operations.length > 0 ? <div className="session-receipts" aria-live="polite">{operations.map((operation) => <div key={operation.operationId} className={`session-receipt ${operation.state}`}><span>{m[operation.state]}</span>{operation.error ? <span>{operation.error.message}</span> : null}{['unknown', 'accepted', 'offered', 'dispatching'].includes(operation.state) ? <button className="inline-link" disabled={view.authPaused || view.checking.has(operation.operationId)} onClick={() => { setCheckError(null); void client.checkOperation(operation.operationId).catch((error: unknown) => setCheckError(error instanceof Error ? error.message : m.failure)); }}>{view.checking.has(operation.operationId) ? m.checking : m.check}</button> : null}</div>)}</div> : null}
    {checkError ? <p className="session-error" role="alert">{checkError}</p> : null}
    <SessionComposer key={sessionFenceKey(s)} state={view.state} connected={connected} authPaused={view.authPaused} active={active} draft={view.draft} onDraftChange={client.setDraft} onSend={client.send} onCancel={client.cancel} settingIntents={view.settingIntents} onUpdateSetting={client.updateSetting} onExecuteCommand={client.executeCommand} onRefreshControls={client.refreshControls} />
  </section>;
}
