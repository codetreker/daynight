import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionV2Key } from '../../../../daynight/src/session/v2/types';
import { ApiError, authRequestsPaused } from '../../api/client';
import type { TerminalSessionApi } from '../../api/terminal-sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TerminalSessionClient } from './terminal-client';
import { TerminalText } from './TerminalText';
import { useTerminalHostMessages } from './terminal-host-messages';
import { useSessionMessages } from './messages';
import { useSessionFullscreen } from './useSessionFullscreen';

const keys: readonly [SessionV2Key, string][] = [['Enter', 'Enter'], ['Escape', 'Esc'], ['Ctrl+C', 'Ctrl+C'], ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowLeft', '←'], ['ArrowRight', '→'], ['Tab', 'Tab']];
export function TerminalSessionView({ projectId, api, claimId, active, current }: {
  readonly projectId: string; readonly api: TerminalSessionApi; readonly claimId: string; readonly active: boolean; readonly current: boolean;
}) {
  const scope = useTaskCacheScope(); const m = useTerminalHostMessages(); const sm = useSessionMessages();
  const currentRef = useRef(current); currentRef.current = current;
  const client = useMemo(() => new TerminalSessionClient({ api, claimId, userId: scope.userId, isCurrent: () => currentRef.current && !scope.isInvalidated && !authRequestsPaused() }), [api, claimId, scope]);
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => {
    const sync = () => client.setVisible(active && current && !scope.isInvalidated && !authRequestsPaused() && document.visibilityState !== 'hidden');
    const invalidate = () => client.invalidate();
    sync(); const timer = setInterval(sync, 250); document.addEventListener('visibilitychange', sync); scope.signal.addEventListener('abort', invalidate);
    const unsubscribe = scope.subscribe(event => { if (event.projectId === projectId && event.accessRevoked) client.invalidate(); else sync(); });
    return () => { clearInterval(timer); unsubscribe(); document.removeEventListener('visibilitychange', sync); scope.signal.removeEventListener('abort', invalidate); client.setVisible(false); };
  }, [client, scope, projectId, active, current]);
  useEffect(() => () => client.close(), [client]);
  const [draft, setDraft] = useState(''); const [confirmation, setConfirmation] = useState<'resume_automation' | 'resolve_initial_assignment' | 'acknowledge_unknown' | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const control = view.session?.control;
  const ownLease = view.ownsControl;
  const reasonId = useId();
  const usable = active && current && view.phase === 'ready' && view.session?.connected === true && view.session.capabilities.observe && view.session.capabilities.control && view.session.capabilities.archive && !view.pending && (view.result?.state !== 'unknown' || view.unknownAcknowledged) && !scope.isInvalidated && !authRequestsPaused();
  const allowed = (action: string) => usable && control?.availableActions.some(value => value === action) === true;
  const unknownInitial = control && ['unknown', 'unconfirmed'].includes(control.initialAssignment);
  const tooLarge = new TextEncoder().encode(draft).byteLength > 16 * 1024;
  const fullscreen = useSessionFullscreen({ client, userId: scope.userId, identity: view.session?.sessionId ?? null, active });
  const stateLabel = !view.session?.connected || view.phase === 'disconnected' ? m.disconnected : control?.state === 'manual' ? ownLease ? m.manual : m.other : control ? m[control.state] : m.readonly;
  useEffect(() => { if (!active || !current) setConfirmation(null); }, [active, current]);
  const requestConfirmation = (action: 'resume_automation' | 'resolve_initial_assignment' | 'acknowledge_unknown') => { setConfirmed(false); setConfirmation(action); };
  const submitConfirmation = () => {
    if (!confirmation || !confirmed) return;
    if (confirmation === 'acknowledge_unknown') { client.acknowledgeUnknown(); setConfirmation(null); return; }
    if (!allowed(confirmation)) return;
    void client.control(confirmation, { draftHandled: confirmation === 'resume_automation', initialUnknownDisposition: confirmation === 'resolve_initial_assignment' ? 'delivered_continue' : null });
    setConfirmation(null);
  };
  let reason = m.readonlyReason;
  const errorCode = control?.unavailableReason ?? (view.error instanceof ApiError ? view.error.code : null);
  if (errorCode === 'permission_denied' || view.error instanceof ApiError && [401, 403, 404, 410].includes(view.error.status ?? 0)) reason = m.permission;
  else if (errorCode === 'unsupported_protocol' || errorCode === 'unsupported_content_kind') reason = m.unsupported;
  else if (errorCode === 'lease_expired') reason = m.leaseExpired;
  else if (errorCode === 'input_busy') reason = m.busy;
  else if (errorCode === 'stale_fence' || errorCode === 'target_changed') reason = m.changed;
  else if (errorCode === 'input_unknown') reason = m.unknown;
  else if (errorCode === 'stop_unknown') reason = m.stopUnknown;
  else if (control?.state === 'manual' && !ownLease) reason = m.other;
  else if (control?.state === 'closing' || control?.state === 'closed') reason = m[control.state];
  else if (!view.session?.connected) reason = m.disconnected;
  return <section ref={fullscreen.sectionRef} className={`task-agent-session terminal-session${fullscreen.fullscreen ? ' session-fullscreen' : ''}`} onKeyDown={fullscreen.onKeyDown}>
    <div className="terminal-host-toolbar"><strong>{stateLabel}</strong><button className="button" disabled={view.pending} onClick={() => client.refresh()}>{m.refresh}</button><button ref={fullscreen.buttonRef} className="button" aria-pressed={fullscreen.fullscreen} onClick={fullscreen.toggle}>{fullscreen.fullscreen ? sm.exitFullscreen : sm.enterFullscreen}</button></div>
    {view.phase === 'loading' ? <p role="status">{m.loading}</p> : null}
    {view.error ? <p role="alert" className="session-error">{reason === m.readonlyReason ? m.error : reason}</p> : null}
    {unknownInitial ? <div className="terminal-notice"><p>{m.initialUnknown}</p><button className="button" disabled={!allowed('resolve_initial_assignment')} onClick={() => requestConfirmation('resolve_initial_assignment')}>{m.resolve}</button></div> : null}
    {control?.state === 'suspended' ? <div className="terminal-notice"><p>{m.suspended}</p><button className="button" disabled={!allowed('resume_automation')} onClick={() => requestConfirmation('resume_automation')}>{m.resume}</button></div> : null}
    {view.session?.snapshot ? <><div className="terminal-host-toolbar"><span>{view.session.owner.provider}</span><time dateTime={view.session.snapshot.frame.capturedAt}>{view.session.snapshot.frame.capturedAt.replace('T', ' ')}</time></div><TerminalText frame={view.session.snapshot.frame} /></> : <p className="session-empty">{m.noFrame}</p>}
    {view.phase === 'disconnected' ? <p role="status">{m.expired}</p> : null}
    <div className="terminal-composer"><label>{m.input}<textarea value={draft} placeholder={m.inputHint} aria-describedby={reasonId} onChange={event => setDraft(event.target.value)} /></label>
      <div className="terminal-host-toolbar"><div className="terminal-keys">{keys.map(([key, label]) => <button key={key} className="button" disabled={!ownLease || !allowed('keys')} onClick={() => { void client.key(key); }}>{label}</button>)}</div>
      <button className="button" disabled={!allowed(ownLease ? 'release_control' : 'acquire_control')} onClick={() => { void client.control(ownLease ? 'release_control' : 'acquire_control'); }}>{ownLease ? m.release : m.take}</button>
      <button className="button primary" disabled={!ownLease || !allowed('paste') || !draft || tooLarge} onClick={() => { void client.paste(draft); }}>{m.paste}</button></div>
      {tooLarge ? <p role="alert">{m.size}</p> : null}
      <details className="terminal-input-reason"><summary id={reasonId}>{m.reason}</summary><p>{reason}</p></details>
    </div>
    {view.pending ? <p role="status">{m.busy}</p> : null}
    {view.result?.state === 'unknown' ? <div role="status"><p>{m.unknown}</p><button className="button" disabled={view.pending} onClick={() => { void client.checkOperation(); }}>{m.check}</button>{!view.unknownAcknowledged ? <button className="button" disabled={view.pending} onClick={() => requestConfirmation('acknowledge_unknown')}>{m.acknowledge}</button> : null}</div> : view.result?.state === 'transport_completed' ? <p role="status">{m.transport}</p> : view.result?.state === 'rejected' ? <p role="status">{m.rejected}</p> : null}
    {confirmation ? <div className="terminal-confirmation" role="group" aria-label={confirmation === 'resume_automation' ? m.resume : confirmation === 'resolve_initial_assignment' ? m.resolve : m.acknowledge}><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{confirmation === 'resume_automation' ? m.resumeConfirm : confirmation === 'resolve_initial_assignment' ? m.resolveConfirm : m.acknowledgeConfirm}</label><div className="terminal-host-toolbar"><button className="button" onClick={() => setConfirmation(null)}>{m.cancel}</button><button className="button primary" disabled={!confirmed || confirmation !== 'acknowledge_unknown' && !allowed(confirmation)} onClick={submitConfirmation}>{m.confirm}</button></div></div> : null}
  </section>;
}
