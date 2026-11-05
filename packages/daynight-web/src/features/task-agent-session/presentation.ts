import type { SessionSnapshot } from '../../../../daynight/src/session/protocol';
import type { SessionStartupReport } from '../../../../daynight/src/session/startup';

export function currentStartupReport(snapshot: SessionSnapshot, report: SessionStartupReport | null | undefined): SessionStartupReport | null {
  return report && report.sessionId === snapshot.sessionId && report.claimId === snapshot.claimId
    && report.executionGeneration === snapshot.executionGeneration && report.controllerInstanceId === snapshot.identity.controllerInstanceId ? report : null;
}

// Native initialization can require an approval from the live timeline. A missing
// Worker report also cannot disable healthy standalone or older sessions.
export function liveHistoryAllowed(snapshot: SessionSnapshot, report: SessionStartupReport | null | undefined): boolean {
  const current = currentStartupReport(snapshot, report);
  return snapshot.lifecycle === 'active' && snapshot.connectionState === 'connected' && snapshot.synchronized
    && current?.startup.state !== 'failed' && current?.recovery.state !== 'blocked';
}

export type SessionPresentation = {
  readonly label: 'archived' | 'sessionStatusUnavailable' | 'startupUnconfirmedBlocked' | 'startupFailedBlocked' | 'recoveryBlocked'
    | 'startupFailed' | 'startupUnconfirmed' | 'waitingEnvironment' | 'sessionStarting' | 'environmentDisconnected' | 'sessionSynchronizing'
    | SessionSnapshot['activity'];
  readonly native: boolean;
  readonly operational: boolean;
  readonly report: SessionStartupReport | null;
};

export function selectSessionPresentation({ snapshot: s, report, connected, error, errorCode, now, previouslyConnected = false }: {
  readonly snapshot: SessionSnapshot; readonly report: SessionStartupReport | null | undefined;
  readonly previouslyConnected?: boolean; readonly connected: boolean; readonly error: string | null; readonly errorCode: string | null | undefined; readonly now: number;
}): SessionPresentation {
  const r = currentStartupReport(s, report);
  const result = (label: SessionPresentation['label'], operational = false, native = false): SessionPresentation => ({ label, native, operational, report: r });
  if (s.lifecycle !== 'active') return result('archived', false, true);
  if (error && errorCode !== 'controller_offline') return result('sessionStatusUnavailable');
  if (r?.recovery.state === 'blocked') return result(r.startup.state === 'failed' ? 'startupFailedBlocked' : r.startup.state === 'ready' ? 'recoveryBlocked' : 'startupUnconfirmedBlocked');
  if (r?.startup.state === 'failed') return result('startupFailed');
  const online = s.connectionState === 'connected' && s.synchronized && errorCode !== 'controller_offline';
  // Approval cards can be used during initialization. Sending still requires the
  // independent native input gate, including initial assignment acceptance.
  const operational = connected && online && liveHistoryAllowed(s, r);
  if (r?.startup.state === 'unknown') return result('startupUnconfirmed', operational);
  if (r?.startup.state === 'starting') {
    const age = now - Date.parse(r.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 90_000) return result('startupUnconfirmed', operational);
    if (s.connectionState === 'disconnected' || errorCode === 'controller_offline') return result('waitingEnvironment');
    return result('sessionStarting', operational);
  }
  if (s.connectionState === 'disconnected' || errorCode === 'controller_offline') {
    return result(r?.startup.state === 'ready' || previouslyConnected || errorCode === 'controller_offline' ? 'environmentDisconnected' : 'startupUnconfirmed');
  }
  if (s.activity === 'initializing' && !r) return result('startupUnconfirmed', operational);
  if (!connected || !online) return result('sessionSynchronizing');
  return result(s.activity, operational, true);
}
