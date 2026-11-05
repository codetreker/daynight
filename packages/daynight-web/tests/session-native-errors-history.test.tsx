import { readFileSync } from 'node:fs';
import { fireEvent, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CodexErrors } from '../../daynight/src/commands/controller/providers/codex-errors';
import { providerDisplayEntry } from '../../daynight/src/commands/controller/provider-display';
import { parseSessionArchive } from '../../daynight/src/session/archive';
import { parseSessionEvent, parseSessionSnapshot, parseTimelineEntry, sessionFence, type TimelineEntry } from '../../daynight/src/session/protocol';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { applySessionEvent, emptySessionState, hydrateSession } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };

it.each(['live events', 'reconnect snapshot', 'file archive'] as const)('preserves native diagnostic semantics and record bytes through %s', path => {
  const snapshot = parseSessionSnapshot({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lastEventSeq: '0', lastTimelineSeq: '0' });
  const threadId = snapshot.identity.nativeSessionId!, turnId = 'turn-with-retry';
  const updates: TimelineEntry[] = [], sequences = new Map<string, string>();
  const producer = new CodexErrors(entry => {
    if (!sequences.has(entry.entryId)) sequences.set(entry.entryId, String(sequences.size + 1));
    updates.push(parseTimelineEntry({ ...providerDisplayEntry(entry), entrySeq: sequences.get(entry.entryId) }));
  });
  const nativeError = { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'stream disconnected before completion / error decoding response body' };
  producer.notification({ threadId, turnId, willRetry: true, error: nativeError }, threadId, turnId);
  producer.notification({ threadId, turnId, willRetry: false, error: { ...nativeError, message: 'Native retry attempts exhausted.' } }, threadId, turnId);
  producer.completed({ threadId, turn: { id: turnId, status: 'failed', error: { message: 'Native turn failed.', codexErrorInfo: 'responseTooManyFailedAttempts' } } }, threadId);
  const legacy = parseTimelineEntry({ entryId: '00000010-1111-4111-8111-111111111111', entrySeq: '3', revision: '1', kind: 'error', code: 'native_error', message: JSON.stringify(nativeError, null, 2) });
  updates.push(legacy);
  expect(updates).toHaveLength(4);
  expect(updates[1]).toMatchObject({ entryId: updates[2]!.entryId, entrySeq: '2', revision: '1' });
  expect(updates[2]).toMatchObject({ revision: '2' });
  const records = [updates[0]!, updates[2]!, legacy], original = JSON.stringify(records);
  let state = hydrateSession(emptySessionState(), snapshot, []);
  if (path === 'live events') {
    for (const [index, payload] of updates.entries()) {
      const event = parseSessionEvent(JSON.parse(JSON.stringify({ protocol: snapshot.protocol, ...sessionFence(snapshot), connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq: String(index + 1), kind: 'timeline_upsert', payload })));
      state = applySessionEvent(state, event);
    }
    expect(state.lastEventSeq).toBe('4');
    expect(state.recoveryRequired).toBe(false);
  } else if (path === 'reconnect snapshot') {
    const resumed = parseSessionSnapshot({ ...snapshot, connectionEpoch: '4', sessionRevision: '13', lastEventSeq: '4', lastTimelineSeq: '3' });
    state = hydrateSession(state, resumed, JSON.parse(original).map(parseTimelineEntry));
    expect(state.snapshot?.connectionEpoch).toBe('4');
  } else {
    const archive = parseSessionArchive(JSON.parse(JSON.stringify({ schemaVersion: 1, ...sessionFence(snapshot), controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, provider: snapshot.identity.provider, nativeSessionId: threadId, entries: records, resources: [] })));
    const archived = parseSessionSnapshot({ ...snapshot, lifecycle: 'archived', connectionState: 'disconnected', lastEventSeq: '4', lastTimelineSeq: '3', operations: { canSend: false, canCancel: false, canRespond: false } });
    state = hydrateSession(state, archived, archive.entries);
    expect(state.snapshot?.lifecycle).toBe('archived');
  }
  expect(JSON.stringify(state.entries)).toBe(original);
  const view = render(<SessionTimeline state={state} {...props} />);
  for (const record of records) {
    const article = view.container.querySelector(`[data-entry-key="${record.entryId}"]`)!;
    const retry = record.kind === 'error' && record.code === 'native_retry';
    expect(within(article as HTMLElement).getByRole(retry ? 'status' : 'alert')).toBeVisible();
    expect(within(article as HTMLElement).queryByRole(retry ? 'alert' : 'status')).toBeNull();
    const details = article.querySelector('details')!;
    expect(details.open).toBe(false);
    details.open = true; fireEvent(details, new Event('toggle'));
    expect(details.querySelector('pre')?.textContent).toBe(record.kind === 'error' ? record.message : null);
  }
  expect(JSON.stringify(records)).toBe(original);
  expect(JSON.stringify(state.entries)).toBe(original);
  expect(state.entries.map(({ entryId, entrySeq, revision }) => [entryId, entrySeq, revision])).toEqual(records.map(({ entryId, entrySeq, revision }) => [entryId, entrySeq, revision]));
});
