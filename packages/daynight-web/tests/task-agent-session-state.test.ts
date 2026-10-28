import type { TaskSessionSnapshot } from './helpers/session';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { emptySessionState, hydrateSession, applySessionEvent, mergeTimeline, sessionSendGate, sessionRespondGate } from '../src/features/task-agent-session/state';
import type { SessionSnapshot, SessionEvent, TimelineEntry } from '../src/api/types';
const snapshot = (): TaskSessionSnapshot => JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
const entry = (revision = '1', text = 'hello'): TimelineEntry => ({ entryId: 'message', entrySeq: '1', revision, kind: 'assistant_message', content: [{ type: 'text', text }] });
const event = (s: TaskSessionSnapshot, eventSeq: string, payload = entry()): Extract<SessionEvent, { readonly claimId: string }> => ({ protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, connectionEpoch: s.connectionEpoch, eventSeq, historyEpoch: s.historyEpoch, kind: 'timeline_upsert', payload });
describe('task agent session replica', () => {
  it('updates one stable timeline entry and ignores replayed events', () => {
    const s = { ...snapshot(), lastEventSeq: '0' };
    const state = hydrateSession(emptySessionState(), s, [entry()]);
    const changed = applySessionEvent(state, event(s, '1', entry('2', 'hello world')));
    expect(changed.entries).toEqual([entry('2', 'hello world')]);
    expect(applySessionEvent(changed, event(s, '1'))).toBe(changed);
  });
  it('fences old executions and marks gaps unsynchronized without admitting content', () => {
    const s = { ...snapshot(), lastEventSeq: '0' };
    const state = hydrateSession(emptySessionState(), s, []);
    expect(applySessionEvent(state, { ...event(s, '1'), claimId: '00000011-1111-4111-8111-111111111111' })).toBe(state);
    const gap = applySessionEvent(state, event(s, '2'));
    expect(gap.recoveryRequired).toBe(true);
    expect(gap.entries).toEqual([]);
    expect(sessionSendGate(gap, true)).toBe(false);
  });
  it('merges history by lossless sequence and revision without replacing newer streamed content', () => {
    const newer = entry('2', 'streamed');
    expect(mergeTimeline([newer], [entry(), { ...entry(), entryId: 'older', entrySeq: '0' }])).toEqual([{ ...entry(), entryId: 'older', entrySeq: '0' }, newer]);
  });
  it('requires initial input acceptance and verified steer while working', () => {
    const s = snapshot();
    for (const initialInputState of ['unknown', 'dispatching', 'failed', 'not_submitted'] as const) expect(sessionSendGate(hydrateSession(emptySessionState(), { ...s, initialInputState }, []), true)).toBe(false);
    const working = { ...s, activity: 'working' as const, capabilities: { ...s.capabilities, steer: false } };
    expect(sessionSendGate(hydrateSession(emptySessionState(), working, []), true)).toBe(false);
    expect(sessionSendGate(hydrateSession(emptySessionState(), s, []), false)).toBe(false);
  });
});

describe('recovery state ordering', () => {
  it('accepts a newer state receipt under the already materialized tail watermark', () => {
    const s = { ...snapshot(), lastEventSeq: '5' };
    const state = hydrateSession(emptySessionState(), s, []);
    const newer = { ...s, sessionRevision: '13', activity: 'working' as const, currentTurnId: 'turn' };
    const result = applySessionEvent(state, { ...event(s, '3'), kind: 'snapshot', payload: newer });
    expect(result.snapshot?.activity).toBe('working');
    expect(result.lastEventSeq).toBe('5');
  });
  it('blocks duplicate send intent while the original outcome is unknown', () => {
    const s = snapshot();
    const state = hydrateSession(emptySessionState(), s, []);
    const operation = { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, operationId: 'unknown', kind: 'send_message' as const, state: 'unknown' as const, providerResult: null, error: null };
    expect(sessionSendGate({ ...state, operations: new Map([['unknown', operation]]) }, true)).toBe(false);
  });
  it('replays a durable event from an earlier connection epoch of the same execution', () => {
    const s = { ...snapshot(), connectionEpoch: '3', lastEventSeq: '0' };
    const state = hydrateSession(emptySessionState(), s, []);
    expect(applySessionEvent(state, { ...event(s, '1'), connectionEpoch: '1' }).entries).toHaveLength(1);
  });
});

describe('same-session history retention', () => {
  it('keeps already read older entries across a same-epoch tail refresh and drops them for a new history epoch', () => {
    const s = snapshot();
    const previous = hydrateSession(emptySessionState(), s, [{ ...entry(), entryId: 'old', entrySeq: '1' }]);
    const incoming = [{ ...entry(), entryId: 'tail', entrySeq: '2' }];
    expect(hydrateSession(previous, s, incoming).entries.map((item) => item.entryId)).toEqual(['old', 'tail']);
    expect(hydrateSession(previous, { ...s, historyEpoch: 'new' }, incoming).entries.map((item) => item.entryId)).toEqual(['tail']);
  });
});


it('scopes pending response gates to the exact interaction and revision', () => {
  const original = snapshot(), s = { ...original, operations: { ...original.operations, canRespond: true } };
  const base = hydrateSession(emptySessionState(), s, []);
  const state = { ...base, operations: new Map([['pending', { protocol: s.protocol, sessionId: s.sessionId, claimId: s.claimId, executionGeneration: s.executionGeneration, operationId: 'pending', kind: 'interaction_response' as const, state: 'unknown' as const, providerResult: null, error: null }]]), responseTargets: new Map([['pending', { interactionId: 'approval', revision: '1' }]]) };
  expect(sessionRespondGate(state, true, { interactionId: 'approval', revision: '1' })).toBe(false);
  expect(sessionRespondGate(state, true, { interactionId: 'approval', revision: '2' })).toBe(true);
  expect(sessionRespondGate(state, true, { interactionId: 'form', revision: '1' })).toBe(true);
});

it('admits only trusted cleanup interactions while draining and never ordinary send', () => {
  const s = snapshot();
  const state = hydrateSession(emptySessionState(), { ...s, lifecycle: 'draining', cleanupInteractionIds: ['cleanup'], operations: { ...s.operations, canRespond: true } }, []);
  expect(sessionRespondGate(state, true, { interactionId: 'cleanup', revision: '1' })).toBe(true);
  expect(sessionRespondGate(state, true, { interactionId: 'old', revision: '1' })).toBe(false);
  expect(sessionSendGate(state, true)).toBe(false);
  expect(sessionRespondGate({ ...state, snapshot: { ...state.snapshot!, cleanupInteractionIds: [] } }, true, { interactionId: 'cleanup', revision: '1' })).toBe(false);
});
