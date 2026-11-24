import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotHistoryWindowEntry, BotHistoryWindowPage } from '../../daynight/src/session/bot-history-window';
import type { BrowserMessage } from '../../daynight/src/session/controller-protocol';
import type { SessionSnapshot } from '../../daynight/src/session/protocol';
import { ApiError } from '../src/api/client';
import { BotHistoryWindowReset, type SessionApi } from '../src/api/sessions';
import { boundBotHistoryWindow } from '../src/features/task-agent-session/bot-history-window';
import { TaskSessionClient } from '../src/features/task-agent-session/client';

const userId = '00000009-1111-4111-8111-111111111111';
const sessionId = '00000001-1111-4111-8111-111111111111';
const testExecutionId = '00000002-1111-4111-8111-111111111111';
const historyEpoch = '00000003-1111-4111-8111-111111111111';
const botId = '00000004-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];

afterEach(() => {
  clients.splice(0).forEach(client => client.close());
  vi.useRealTimers();
});

function row(seq: number, revision = '1', preview = '🙂', kind: BotHistoryWindowEntry['kind'] = 'assistant_message'): BotHistoryWindowEntry {
  const bytes = String(new TextEncoder().encode(preview).length);
  return { kind, entryId: `row-${seq}`, entrySeq: String(seq), revision, preview, previewBytes: bytes,
    originalBytes: bytes, truncated: false, omissionReason: null, omittedEntryCount: 0, resourceIds: [], tool: null };
}

function page(items: readonly BotHistoryWindowEntry[], patch: Partial<BotHistoryWindowPage> = {}): BotHistoryWindowPage {
  return { kind: 'bot_history_window', botHistoryWindowVersion: 1, sessionId, historyEpoch, testExecutionId,
    executionGeneration: '1', connectionEpoch: '1', windowRevision: '1', retainedFromSeq: '1', throughSeq: '3',
    earlierHistoryUnavailable: false, hasEarlierHistory: false, beforeCursor: null, nextCursor: 'first', items, ...patch };
}

async function fixture(tail = page([row(1), row(2), row(3)])) {
  vi.useFakeTimers();
  const snapshot: SessionSnapshot = {
    protocol: 'daynight.session.v1', schemaVersion: 1, projectionVersion: 1,
    sessionId, testExecutionId, historyEpoch, executionGeneration: '1', connectionEpoch: '1',
    identity: { ownerUserId: userId, controllerId: 'controller', controllerInstanceId: 'instance', nativeSessionId: 'native', provider: 'codex', agentControlMode: 'web' },
    sessionRevision: '1', lastEventSeq: '20', lastTimelineSeq: '3', initialInputState: 'not_required',
    synchronized: true, lifecycle: 'active', connectionState: 'connected', activity: 'idle', currentTurnId: null,
    capabilities: { send: true, steer: true, respond: true, cancel: true },
    operations: { canSend: true, canCancel: false, canRespond: true },
  };
  const window = vi.fn<NonNullable<SessionApi['botHistoryWindow']>>().mockResolvedValue(tail);
  let receive = (_value: BrowserMessage) => {};
  const api: SessionApi = {
    current: vi.fn(async () => ({ status: 'registered' as const, session: snapshot })),
    channel: vi.fn((_id, _after, onMessage) => { receive = onMessage; return { close: vi.fn() }; }),
    botHistoryWindow: window, timeline: vi.fn(), archive: vi.fn(), archiveContent: vi.fn(),
    resources: vi.fn(), resource: vi.fn(), resourceUrl: vi.fn(), command: vi.fn(), operation: vi.fn(),
  };
  const client = new TaskSessionClient({ api, userId, testSessionId: sessionId, bot: { botId, ownerUserId: userId, sessionId, testExecutionId },
    isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: null });
  clients.push(client);
  await client.start();
  receive({ type: 'snapshot', protocol: snapshot.protocol, snapshot, userId, cursor: 'live' });
  await vi.advanceTimersByTimeAsync(0);
  return { api, client, window, snapshot, receive };
}

describe('Bot history window consumer', () => {
  it('updates stable IDs across a scan and advances the event watermark without inserting raw window content', async () => {
    const f = await fixture();
    f.client.setActionAdmission(false);
    expect(f.client.snapshot().state.lastEventSeq).toBe('20');
    f.receive({ type: 'event', protocol: f.snapshot.protocol, cursor: 'event-21', event: {
      kind: 'timeline_upsert', protocol: f.snapshot.protocol, sessionId, testExecutionId, executionGeneration: '1',
      connectionEpoch: '1', historyEpoch, eventSeq: '21',
      payload: { kind: 'assistant_message', entryId: 'row-2', entrySeq: '2', revision: '2', content: [{ type: 'text', text: 'Raw event body' }] },
    } });
    expect(f.client.snapshot().state.entries).toEqual([]);
    expect(f.client.snapshot().state.lastEventSeq).toBe('21');
    const next = { windowRevision: '2', retainedFromSeq: '2', throughSeq: '4', earlierHistoryUnavailable: true };
    f.window.mockResolvedValueOnce(page([row(2, '2', 'New 🙂')], { ...next, nextCursor: 'part' }))
      .mockResolvedValueOnce(page([row(3), row(4)], { ...next, nextCursor: 'complete' }))
      .mockResolvedValueOnce(page([], { ...next, nextCursor: 'complete' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.client.snapshot().botHistoryWindow).toMatchObject({
      ...next, entries: [row(2, '2', 'New 🙂'), row(3), row(4)],
    });
    expect(f.api.timeline).not.toHaveBeenCalled();
    expect(f.api.command).not.toHaveBeenCalled();
  });

  it('withdraws earlier rows on reset and rejects a late response from a previous connection', async () => {
    const f = await fixture();
    const next = page([], { windowRevision: '2', retainedFromSeq: '3', throughSeq: '4', earlierHistoryUnavailable: true });
    let finishTail!: (value: BotHistoryWindowPage) => void;
    f.window.mockRejectedValueOnce(new BotHistoryWindowReset(new ApiError('server', 409, 'reset_required'), next))
      .mockReturnValueOnce(new Promise(resolve => { finishTail = resolve; }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.client.snapshot()).toMatchObject({ historySettled: false, botHistoryWindow: { entries: [row(3)], earlierHistoryUnavailable: true } });
    f.window.mockResolvedValueOnce({ ...next, connectionEpoch: '2', items: [row(3), row(4)] });
    f.receive({ type: 'snapshot', protocol: f.snapshot.protocol, userId, cursor: 'new-live',
      snapshot: { ...f.snapshot, sessionRevision: '2', connectionEpoch: '2' } });
    finishTail({ ...next, items: [row(3, '42', 'Late response')] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.snapshot().botHistoryWindow?.entries).toEqual([row(3), row(4)]);
    expect(f.client.snapshot().historySettled).toBe(true);
  });

  it('switches from a recent window to a ready archive of the same execution', async () => {
    const f = await fixture();
    const archived = { ...f.snapshot, sessionRevision: '2', lifecycle: 'archived' as const, connectionState: 'disconnected' as const };
    const entry = { kind: 'assistant_message' as const, entryId: 'original', entrySeq: '1', revision: '1', content: [{ type: 'text' as const, text: 'Archived response' }] };
    vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: archived });
    vi.mocked(f.api.archive).mockResolvedValue({ state: 'ready', byteLength: '100', sha256: 'a'.repeat(64), errorCode: null });
    vi.mocked(f.api.archiveContent).mockResolvedValue({
      schemaVersion: 1, sessionId, testExecutionId, executionGeneration: '1', entries: [entry], resources: [],
      controllerId: 'controller', controllerInstanceId: 'instance', nativeSessionId: 'native', provider: 'codex',
    });
    f.receive({ type: 'snapshot', protocol: f.snapshot.protocol, userId, cursor: 'archived', snapshot: archived });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.snapshot()).toMatchObject({ archiveState: 'ready', botHistoryWindow: null, state: { entries: [entry] } });
  });

  it('lets older-page navigation supersede an in-flight changes poll', async () => {
    const f = await fixture(page([row(3)], { beforeCursor: 'older', hasEarlierHistory: true }));
    let finishPoll!: (value: BotHistoryWindowPage) => void;
    f.window.mockReturnValueOnce(new Promise(resolve => { finishPoll = resolve; }));
    await vi.advanceTimersByTimeAsync(3000);
    const pollSignal = f.window.mock.calls.at(-1)![3];
    f.window.mockResolvedValueOnce(page([row(1), row(2)]));
    await f.client.loadOlder();
    expect(pollSignal.aborted).toBe(true);
    expect(f.window).toHaveBeenLastCalledWith(sessionId, 'before', 'older', expect.any(AbortSignal));
    finishPoll(page([row(3, '42', 'Late poll')], { windowRevision: '2' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.snapshot().botHistoryWindow?.entries).toEqual([row(1), row(2), row(3)]);
  });

  it('retains the gap after UTF-8 and row-budget eviction at a complete turn', () => {
    const entries = [row(1, '1', 'a', 'user_message'), row(2, '1', '🙂'.repeat(60)),
      row(3, '1', 'b', 'user_message'), row(4, '1', '🙂')];
    const boundary = page(entries, { throughSeq: '4' });
    expect(boundBotHistoryWindow(boundary, entries, { entries: 3, bytes: 10_000 })).toMatchObject({
      entries: entries.slice(2), retainedFromSeq: '1', earlierHistoryUnavailable: true, localEviction: true,
    });
    const utf8Boundary = new TextEncoder().encode(JSON.stringify(boundBotHistoryWindow(boundary, entries.slice(1)))).length - 4;
    expect(boundBotHistoryWindow(boundary, entries, { entries: 4, bytes: utf8Boundary }).entries).toEqual(entries.slice(2));
  });
});
