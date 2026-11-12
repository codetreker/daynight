import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionV2Key } from '../../../../daynight/src/session/v2/types';
import { ApiError, authRequestsPaused, subscribeAuthPause } from '../../api/client';
import type { TerminalSessionApi } from '../../api/terminal-sessions';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { TerminalSessionClient, sameTerminalFence, type TerminalClientSnapshot } from './terminal-client';
import { TerminalText } from './TerminalText';
import { useTerminalHostMessages } from './terminal-host-messages';
import { useSessionMessages } from './messages';
import { useSessionFullscreen } from './useSessionFullscreen';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';

type ConfirmationAction = 'resume_automation' | 'resolve_initial_assignment' | 'acknowledge_unknown';
function sameConfirmationIdentity(before: TerminalClientSnapshot, current: TerminalClientSnapshot, action: ConfirmationAction): boolean {
  const a = before.session, b = current.session;
  const sameSession = a === null || b === null ? a === b : sameTerminalFence(a, b) && a.owner.ownerUserId === b.owner.ownerUserId && a.control?.controlEpoch === b.control?.controlEpoch;
  return sameSession && (action !== 'acknowledge_unknown' || before.result?.operationId === current.result?.operationId);
}

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
    const unsubscribePause = subscribeAuthPause(client.suspendForAccountRefresh);
    if (authRequestsPaused()) client.suspendForAccountRefresh();
    sync(); const timer = setInterval(sync, 250); document.addEventListener('visibilitychange', sync); scope.signal.addEventListener('abort', invalidate);
    const unsubscribe = scope.subscribe(event => { if (event.projectId === projectId && event.accessRevoked) client.invalidate(); else sync(); });
    return () => { clearInterval(timer); unsubscribe(); unsubscribePause(); document.removeEventListener('visibilitychange', sync); scope.signal.removeEventListener('abort', invalidate); client.setVisible(false); };
  }, [client, scope, projectId, active, current]);
  useEffect(() => () => client.close(), [client]);
  const [draft, setDraft] = useState(''); const [confirmation, setConfirmation] = useState<{ action: ConfirmationAction; snapshot: TerminalClientSnapshot; client: TerminalSessionClient } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const control = view.session?.control;
  const isOwner = view.session?.owner.ownerUserId === scope.userId;
  const ownLease = view.ownsControl;
  const displayedOwnLease = isOwner && control?.lease?.holderUserId === scope.userId && control.lease.browserClientId === client.browserClientId;
  const releaseShown = displayedOwnLease && (!view.inputReady || ownLease);
  const reasonId = useId();
  const usable = isOwner && active && current && view.inputReady && view.phase === 'ready' && view.session?.connected === true && view.session.capabilities.observe && view.session.capabilities.control && view.session.capabilities.archive && !view.pending && (view.result?.state !== 'unknown' || view.unknownAcknowledged) && !scope.isInvalidated && !authRequestsPaused();
  const allowed = (action: string) => usable && control?.availableActions.some(value => value === action) === true;
  const unknownInitial = control && ['unknown', 'unconfirmed'].includes(control.initialAssignment);
  const tooLarge = new TextEncoder().encode(draft).byteLength > 16 * 1024;
  const fullscreen = useSessionFullscreen({ client, userId: scope.userId, identity: view.session?.sessionId ?? null, active });
  const stateLabel = view.session === null ? view.error ? m.sessionError : view.availability === 'not_registered' ? m.waiting : view.availability === 'not_applicable' ? m.noSession : m.connecting : !view.session.connected || view.phase === 'disconnected' ? view.session.snapshot ? m.disconnected : m.disconnectedPlain : control?.state === 'manual' ? displayedOwnLease ? m.manual : m.other : control ? m[control.state] : m.readonly;
  const confirmationCurrent = confirmation !== null && confirmation.client === client && sameConfirmationIdentity(confirmation.snapshot, view, confirmation.action);
  useEffect(() => { if (!confirmationCurrent) { setConfirmation(null); setConfirmed(false); } }, [confirmationCurrent]);
  const requestConfirmation = (action: ConfirmationAction) => { setConfirmed(false); setConfirmation({ action, snapshot: client.getSnapshot(), client }); };
  const submitConfirmation = () => {
    if (!confirmation || !confirmed) return;
    // Check the live identity again: the store can advance before React clears an old dialog.
    if (confirmation.client !== client || !sameConfirmationIdentity(confirmation.snapshot, client.getSnapshot(), confirmation.action)) { setConfirmation(null); setConfirmed(false); return; }
    if (!active || !current || !view.inputReady || scope.isInvalidated || authRequestsPaused()) return;
    if (confirmation.action === 'acknowledge_unknown') { client.acknowledgeUnknown(); setConfirmation(null); return; }
    if (!allowed(confirmation.action)) return;
    void client.control(confirmation.action, { draftHandled: confirmation.action === 'resume_automation', initialUnknownDisposition: confirmation.action === 'resolve_initial_assignment' ? 'delivered_continue' : null });
    setConfirmation(null);
  };
  let reason = m.readonlyReason;
  const errorCode = view.error instanceof ApiError ? view.error.code : view.error ? null : control?.unavailableReason;
  if (errorCode === 'permission_denied' || view.error instanceof ApiError && [401, 403, 404, 410].includes(view.error.status ?? 0)) reason = m.permission;
  else if (errorCode === 'unsupported_protocol' || errorCode === 'unsupported_content_kind') reason = m.unsupported;
  else if (errorCode === 'lease_expired') reason = m.leaseExpired;
  else if (errorCode === 'input_busy') reason = m.busy;
  else if (errorCode === 'stale_fence' || errorCode === 'target_changed') reason = m.changed;
  else if (errorCode === 'input_unknown') reason = m.unknown;
  else if (errorCode === 'stop_unknown') reason = m.stopUnknown;
  else if (view.error instanceof ApiError && view.error.kind === 'network') reason = m.networkError;
  else if (view.error instanceof ApiError && view.error.kind === 'protocol') reason = m.protocolError;
  else if (view.error) reason = m.error;
  else if (control?.state === 'manual' && !displayedOwnLease) reason = m.other;
  else if (control?.state === 'closing' || control?.state === 'closed') reason = m[control.state];
  else if (!view.session?.connected) reason = view.session?.snapshot ? m.disconnected : m.disconnectedPlain;
  return <section ref={fullscreen.sectionRef} className={`task-agent-session terminal-session${fullscreen.fullscreen ? ' session-fullscreen' : ''}`} onKeyDown={fullscreen.onKeyDown}>
    <div className="terminal-host-toolbar"><strong>{stateLabel}</strong><button className="button" disabled={view.pending || authRequestsPaused()} onClick={() => client.refresh()}>{m.refresh}</button><button ref={fullscreen.buttonRef} className="button" aria-pressed={fullscreen.fullscreen} onClick={fullscreen.toggle}>{fullscreen.fullscreen ? sm.exitFullscreen : sm.enterFullscreen}</button>{fullscreen.fullscreen && <AccountRefreshNotice />}</div>
    {view.phase === 'loading' ? <p role="status">{m.loading}</p> : null}
    {view.phase === 'unavailable' && view.availability ? <p role="status">{view.availability === 'not_registered' ? m.notRegistered : m.notApplicable}</p> : null}
    {view.error ? <p role="alert" className="session-error">{reason === m.readonlyReason ? m.error : reason}</p> : null}
    {unknownInitial ? <div className="terminal-notice"><p>{m.initialUnknown}</p><button className="button" disabled={!allowed('resolve_initial_assignment')} onClick={() => requestConfirmation('resolve_initial_assignment')}>{m.resolve}</button></div> : null}
    {control?.state === 'suspended' ? <div className="terminal-notice"><p>{m.suspended}</p><button className="button" disabled={!allowed('resume_automation')} onClick={() => requestConfirmation('resume_automation')}>{m.resume}</button></div> : null}
    {view.session?.snapshot ? <><div className="terminal-host-toolbar"><span>{view.session.owner.provider}</span><time dateTime={view.session.snapshot.frame.capturedAt}>{view.session.snapshot.frame.capturedAt.replace('T', ' ')}</time></div><TerminalText frame={view.session.snapshot.frame} /></> : <p className="session-empty">{m.noFrame}</p>}
    {view.phase === 'disconnected' ? <p role="status">{m.expired}</p> : null}
    <div className="terminal-composer"><label>{m.input}<textarea readOnly={!isOwner} value={draft} placeholder={m.inputHint} aria-describedby={reasonId} onChange={event => setDraft(event.target.value)} /></label>
      <div className="terminal-host-toolbar"><div className="terminal-keys">{keys.map(([key, label]) => <button key={key} className="button" disabled={!ownLease || !allowed('keys')} onClick={() => { void client.key(key); }}>{label}</button>)}</div>
      <button className="button" disabled={!allowed(releaseShown ? 'release_control' : 'acquire_control')} onClick={() => { void client.control(releaseShown ? 'release_control' : 'acquire_control'); }}>{releaseShown ? m.release : m.take}</button>
      <button className="button primary" disabled={!ownLease || !allowed('paste') || !draft || tooLarge} onClick={() => { void client.paste(draft); }}>{m.paste}</button></div>
      {tooLarge ? <p role="alert">{m.size}</p> : null}
      <details className="terminal-input-reason"><summary id={reasonId}>{m.reason}</summary><p>{reason}</p></details>
    </div>
    {view.pending ? <p role="status">{m.busy}</p> : null}
    {view.result?.state === 'unknown' ? <div role="status"><p>{m.unknown}</p><button className="button" disabled={view.pending || authRequestsPaused()} onClick={() => { void client.checkOperation(); }}>{m.check}</button>{!view.unknownAcknowledged ? <button className="button" disabled={!isOwner || view.pending} onClick={() => requestConfirmation('acknowledge_unknown')}>{m.acknowledge}</button> : null}</div> : view.result?.state === 'transport_completed' ? <p role="status">{m.transport}</p> : view.result?.state === 'rejected' ? <p role="status">{m.rejected}</p> : null}
    {confirmation && confirmationCurrent ? <div className="terminal-confirmation" role="group" aria-label={confirmation.action === 'resume_automation' ? m.resume : confirmation.action === 'resolve_initial_assignment' ? m.resolve : m.acknowledge}><label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{confirmation.action === 'resume_automation' ? m.resumeConfirm : confirmation.action === 'resolve_initial_assignment' ? m.resolveConfirm : m.acknowledgeConfirm}</label><div className="terminal-host-toolbar"><button className="button" onClick={() => setConfirmation(null)}>{m.cancel}</button><button className="button primary" disabled={!confirmed || !active || !current || !view.inputReady || confirmation.action !== 'acknowledge_unknown' && !allowed(confirmation.action)} onClick={submitConfirmation}>{m.confirm}</button></div></div> : null}
  </section>;
}
