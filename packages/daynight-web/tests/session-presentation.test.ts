import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '../../daynight/src/session/protocol';
import type { SessionStartupReport } from '../../daynight/src/session/startup';
import { liveHistoryAllowed, selectSessionPresentation } from '../src/features/task-agent-session/presentation';
const snapshot = (): SessionSnapshot => JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const now = Date.parse('2026-11-05T00:01:00Z');
function report(s: SessionSnapshot, startup: SessionStartupReport['startup'], blocked = false): SessionStartupReport {
  return { schemaVersion: 1, source: 'worker', sessionId: s.sessionId, claimId: s.claimId!, executionGeneration: s.executionGeneration, controllerInstanceId: s.identity.controllerInstanceId, revision: '1', observedAt: '2026-11-05T00:00:30Z', startup, recovery: blocked ? { state: 'blocked', reasonCode: 'native_identity_missing' } : { state: 'none', reasonCode: null } };
}
const select = (s: SessionSnapshot, r: SessionStartupReport | null, extra = {}) => selectSessionPresentation({ snapshot: s, report: r, connected: true, error: null, errorCode: null, now, ...extra });
describe('authoritative session presentation', () => {
  it('distinguishes timeout, explicit failure and recovery blockage before generic connection loss', () => {
    const s = { ...snapshot(), connectionState: 'disconnected' as const, synchronized: false };
    expect(select(s, report(s, { state: 'unknown', reasonCode: 'native_timeout' }, true)).label).toBe('startupUnconfirmedBlocked');
    expect(select(s, report(s, { state: 'failed', reasonCode: 'native_rejected' }, true)).label).toBe('startupFailedBlocked');
    expect(select(s, report(s, { state: 'failed', reasonCode: 'controller_launch_failed' })).label).toBe('startupFailed');
    expect(select(s, report(s, { state: 'ready', reasonCode: 'ready' })).label).toBe('environmentDisconnected');
    expect(select(s, null).label).toBe('startupUnconfirmed');
  });
  it('uses only fresh current-generation starting evidence and never epoch or null native identity', () => {
    const s = { ...snapshot(), activity: 'initializing' as const, connectionEpoch: '99', identity: { ...snapshot().identity, nativeSessionId: null } };
    const r = report(s, { state: 'starting', reasonCode: 'initializing' });
    expect(select(s, r).label).toBe('sessionStarting');
    expect(select(s, { ...r, observedAt: '2026-11-04T23:59:29Z' }).label).toBe('startupUnconfirmed');
    expect(select(s, { ...r, observedAt: '2026-11-05T00:01:01Z' }).label).toBe('startupUnconfirmed');
    expect(select(s, { ...r, executionGeneration: '999' }).label).toBe('startupUnconfirmed');
    expect(select(s, null).label).toBe('startupUnconfirmed');
    expect(select({ ...s, connectionState: 'disconnected' }, r).label).toBe('waitingEnvironment');
  });
  it('keeps archive and request errors distinct and does not infer a startup failure', () => {
    const s = snapshot();
    expect(select(s, report(s, { state: 'ready', reasonCode: 'ready' }), { error: 'Invalid protocol', errorCode: 'protocol' }).label).toBe('sessionStatusUnavailable');
    expect(select({ ...s, lifecycle: 'archived' }, report(s, { state: 'failed', reasonCode: 'native_rejected' }, true)).label).toBe('archived');
    expect(select(s, null, { error: 'offline', errorCode: 'controller_offline' }).label).toBe('environmentDisconnected');
  });
  it('retains legacy healthy sessions and initialization approvals while stopping impossible history reads', () => {
    const s = snapshot();
    expect(liveHistoryAllowed(s, null)).toBe(true);
    expect(liveHistoryAllowed({ ...s, activity: 'waiting_input' }, report(s, { state: 'starting', reasonCode: 'initializing' }))).toBe(true);
    expect(liveHistoryAllowed(s, report(s, { state: 'ready', reasonCode: 'ready' }, true))).toBe(false);
    expect(liveHistoryAllowed(s, report(s, { state: 'failed', reasonCode: 'native_rejected' }))).toBe(false);
    expect(liveHistoryAllowed({ ...s, connectionState: 'disconnected' }, null)).toBe(false);
    expect(liveHistoryAllowed({ ...s, lifecycle: 'archived' }, null)).toBe(false);
  });
});
