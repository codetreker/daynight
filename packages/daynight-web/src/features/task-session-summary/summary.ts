import type { SessionSnapshot } from '../../api/types';

export type SessionIndicator = 'working' | 'notice' | 'warning';
export type TaskSessionSummary = {
  readonly sessionId: string;
  readonly claimId: string;
  readonly indicator: SessionIndicator | null;
};

export function sessionIndicator(snapshot: SessionSnapshot): SessionIndicator | null {
  if (snapshot.lifecycle !== 'active' || snapshot.connectionState === 'disconnected') return 'warning';
  if (!snapshot.synchronized || snapshot.connectionState !== 'connected') return null;
  // Providers normalize pending approvals, questions and forms to waiting_input.
  // canRespond describes permission and does not prove a pending interaction.
  switch (snapshot.activity) {
    case 'waiting_input': return 'notice';
    case 'idle': case 'stopped': return 'warning';
    case 'working': return 'working';
    default: return null;
  }
}

export function aggregateSessionIndicators(values: Iterable<SessionIndicator | null>): SessionIndicator | null {
  let highest: SessionIndicator | null = null;
  for (const value of values) {
    if (value === 'warning') return value;
    if (value === 'notice' || highest === null) highest = value;
  }
  return highest;
}
