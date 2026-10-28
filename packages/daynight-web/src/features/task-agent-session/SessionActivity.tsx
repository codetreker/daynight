import { useEffect, useState } from 'react';
import type { SessionSnapshot } from '../../../../daynight/src/session/protocol';
import { useSessionMessages } from './messages';

export function SessionActivity({ snapshot, connected, active, commandPending, interruptPending, interruptRequested, interruptAllowed, onInterrupt }: {
  readonly snapshot: SessionSnapshot | null; readonly connected: boolean; readonly active: boolean;
  readonly commandPending: boolean; readonly interruptRequested: boolean; readonly interruptPending: boolean; readonly interruptAllowed: boolean; readonly onInterrupt: () => void;
}) {
  const m = useSessionMessages();
  const [now, setNow] = useState(Date.now);
  const working = snapshot?.activity === 'working' || snapshot?.activity === 'waiting_input';
  const startedAt = snapshot?.turnStartedAt ? Date.parse(snapshot.turnStartedAt) : NaN;
  const timed = connected && active && working && Boolean(snapshot?.currentTurnId) && Number.isFinite(startedAt);
  useEffect(() => {
    if (!timed) return;
    const tick = () => { if (!document.hidden) setNow(Date.now()); };
    tick(); const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [timed, startedAt]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`;
  const label = !connected || snapshot?.connectionState === 'disconnected' ? m.disconnected : !snapshot?.synchronized || snapshot.connectionState === 'synchronizing' ? m.synchronizing : commandPending && !working ? m.executingCommand : m[snapshot.activity];
  if (!working && !commandPending && !interruptPending) return null;
  return <div className="session-composer-activity" aria-label={m.agentActivity}>
    <span className={`session-activity-dot ${working && connected ? 'working' : ''}`} aria-hidden="true" /><span aria-live="polite">{label}</span>
    {timed ? <time aria-label={m.elapsedTime} dateTime={`PT${seconds}S`}>{elapsed}</time> : null}
    {working && !Number.isFinite(startedAt) && connected ? <span className="session-control-note">{m.startTimeUnknown}</span> : null}
    {working || commandPending || interruptPending ? <button type="button" className="session-interrupt" disabled={!interruptAllowed || interruptPending} onClick={onInterrupt}>{interruptPending ? m.interrupting : interruptRequested ? m.interruptRequested : m.interrupt}</button> : null}
  </div>;
}
