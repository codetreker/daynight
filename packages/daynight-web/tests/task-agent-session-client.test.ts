import { ApiError } from '../src/api/client';
import { sessionBinding } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { SessionApi, SessionChannel } from '../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionOperation, SessionSnapshot } from '../src/api/types';
const snapshot = (): TaskSessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' });
const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.forEach((c) => c.close()); clients.length = 0; });
function fixture(storage: Storage | null = null, principal = userId) {
  const s = snapshot(); let receive!: (message: BrowserMessage) => void; let close!: () => void;
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const channel: SessionChannel = { close: vi.fn() };
  const api: SessionApi = { current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/resource', channel: vi.fn((_id, _after, onMessage, onClose) => { receive = onMessage; close = onClose; return channel; }) };
  const client = new TaskSessionClient({ api, userId: principal, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage }); clients.push(client);
  return { s, api, client, receive: (message: BrowserMessage) => receive(message), disconnect: () => close() };
}
async function ready(f: ReturnType<typeof fixture>) { await f.client.start(); f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: f.s, cursor: 'zero' }); await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true)); }
describe('task session transport lifecycle', () => {
  it('keeps registered sessions and durable history readable when the channel cannot open', async () => {
    const f = fixture(); await f.client.start(); f.disconnect();
    await vi.waitFor(() => expect(f.api.timeline).toHaveBeenCalledOnce());
    expect(f.client.snapshot().status).toBe('ready');
    expect(f.client.snapshot().state.snapshot?.sessionId).toBe(f.s.sessionId);
    expect(f.client.snapshot().connected).toBe(false);
  });
  it('hydrates history then applies live revisions without launching or sending an agent input', async () => {
    const f = fixture(); await ready(f);
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'live' }] } } });
    expect(f.client.snapshot().state.entries).toHaveLength(1);
    expect(f.api.command).not.toHaveBeenCalled();
  });
  it('queries the same operation after an unknown HTTP result and never posts again', async () => {
    const f = fixture(); await ready(f);
    let id = '';
    vi.mocked(f.api.command).mockImplementation(async (_session, command) => { id = command.operationId; throw new Error('lost acknowledgement'); });
    await expect(f.client.send('hello')).rejects.toThrow();
    expect(f.client.snapshot().state.operations.get(id)?.state).toBe('unknown');
    const receipt: SessionOperation = { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', operationId: id, kind: 'send_message', state: 'provider_accepted', providerResult: 'started', error: null };
    vi.mocked(f.api.operation).mockResolvedValue(receipt);
    await f.client.checkOperation(id);
    expect(f.client.snapshot().state.operations.get(id)?.state).toBe('provider_accepted');
    expect(f.api.command).toHaveBeenCalledTimes(1);
  });
  it('keeps sending disabled until replay reaches the authenticated snapshot watermark', async () => {
    const f = fixture(); await ready(f);
    f.disconnect(); await f.client.start();
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: { ...f.s, lastEventSeq: '1' }, cursor: 'zero' });
    expect(f.client.snapshot().connected).toBe(false);
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'live' }] } } });
    expect(f.client.snapshot().connected).toBe(true);
  });
  it('does not admit a different browser principal or claim', async () => {
    const f = fixture(); await f.client.start();
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId: '00000010-1111-4111-8111-111111111111', snapshot: f.s, cursor: 'zero' });
    expect(f.client.snapshot().connected).toBe(false);
    expect(f.client.snapshot().state.snapshot).toBeNull();
  });
});


describe('task session operation and recovery contracts', () => {
  it('distinguishes a server acknowledgement from provider acceptance', async () => {
    const f = fixture(); await ready(f);
    let pending!: SessionOperation;
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => pending = { protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'accepted', providerResult: null, error: null });
    vi.mocked(f.api.operation).mockImplementation(async () => ({ ...pending, state: 'provider_accepted', providerResult: 'started' }));
    let finished = false;
    const send = f.client.send('hello').then(() => { finished = true; });
    await vi.waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(f.client.snapshot().state.operations.get(pending.operationId)?.state).toBe('accepted');
    await send;
    expect(finished).toBe(true);
    expect(f.api.command).toHaveBeenCalledOnce();
  });
  it('uses the exact active turn for cancellation and rejects stale interactions', async () => {
    const f = fixture();
    Object.assign(f.s, { currentTurnId: 'native-turn', activity: 'working', operations: { canSend: true, canCancel: true, canRespond: true } });
    await ready(f);
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => ({ protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null }));
    await f.client.cancel();
    expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'cancel', payload: { expectedTurnId: 'native-turn' } });
    await expect(f.client.respond({ interactionId: 'old', revision: '1', state: 'pending', title: 'old', kind: 'approval', detail: 'old', actions: ['reject'] }, { kind: 'approval', action: 'reject' })).rejects.toThrow('changed');
  });
  it('responds to initialization approval without treating it as initial input acceptance', async () => {
    const f = fixture(); Object.assign(f.s, { initialInputState: 'dispatching', activity: 'waiting_input', operations: { canSend: false, canCancel: false, canRespond: true } });
    const interaction = { interactionId: 'approval', revision: '2', state: 'pending' as const, title: 'Run', kind: 'approval' as const, detail: 'Run tool', actions: ['allow_once' as const] };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [{ entryId: 'approval', entrySeq: '1', revision: '2', kind: 'interaction', interaction }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => ({ protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null }));
    await f.client.respond(interaction, { kind: 'approval', action: 'allow_once' });
    expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'interaction_response', payload: { interactionId: 'approval', interactionRevision: '2' } });
    expect(f.client.snapshot().state.snapshot?.initialInputState).toBe('dispatching');
    await expect(f.client.send('too early')).rejects.toThrow('not currently allowed');
  });
  it('loads earlier entries while preserving a newer streamed revision', async () => {
    const f = fixture();
    const recent = { entryId: 'recent', entrySeq: '2', revision: '2', kind: 'assistant_message' as const, content: [{ type: 'text' as const, text: 'recent' }] };
    const first = { sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [recent], resources: [], beforeCursor: 'before', afterCursor: null, hasMoreBefore: true, hasMoreAfter: false, lastEventSeq: '0' };
    vi.mocked(f.api.timeline).mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first, beforeCursor: null, hasMoreBefore: false, items: [{ ...recent, entryId: 'earlier', entrySeq: '1' }, { ...recent, revision: '1' }] });
    await ready(f); await f.client.loadOlder();
    expect(f.client.snapshot().state.entries.map((entry) => [entry.entryId, entry.revision])).toEqual([['earlier', '2'], ['recent', '2']]);
    expect(f.client.snapshot().hasOlder).toBe(false);
    expect(f.api.timeline).toHaveBeenLastCalledWith(f.s.sessionId, 'before', 'before', expect.any(AbortSignal));
  });
  it('shows a real not-registered state and rejects a replaced claim', async () => {
    const f = fixture(); vi.mocked(f.api.current).mockResolvedValue({ status: 'not_registered', claimId: f.s.claimId, agentControlMode: 'web' });
    await f.client.start(); expect(f.client.snapshot().status).toBe('not_registered'); expect(f.api.channel).not.toHaveBeenCalled();
    vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: { ...f.s, claimId: 'other' } });
    await f.client.start(); expect(f.client.snapshot().status).toBe('unavailable');
  });
  it('clears permissions and content when the owning scope closes', async () => {
    const f = fixture(); await ready(f); f.client.close();
    expect(f.client.snapshot().connected).toBe(false); expect(f.client.snapshot().state.snapshot).toBeNull();
    await expect(f.client.send('late')).rejects.toThrow();
  });
});

describe('independent native interaction responses', () => {
  it.each(['unknown', 'dispatching'] as const)('allows a new form while an earlier approval is %s without replaying that approval', async state => {
    const f = fixture(); Object.assign(f.s, { activity: 'waiting_input', operations: { ...f.s.operations, canRespond: true } });
    const approval = { interactionId: 'tool-approval', revision: '1', state: 'pending' as const, title: 'Run MCP tool', kind: 'approval' as const, detail: 'Start tool', actions: ['allow_once' as const] };
    const form = { interactionId: 'tool-form', revision: '1', state: 'pending' as const, title: 'MCP form', kind: 'form' as const, canDismiss: false, fields: [{ fieldId: 'name', label: 'Name', type: 'text' as const, required: true, sensitive: false }] };
    vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.s.sessionId, historyEpoch: f.s.historyEpoch, items: [approval, form].map((interaction, index) => ({ entryId: interaction.interactionId, entrySeq: String(index + 1), revision: '1', kind: 'interaction', interaction })), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(f);
    let pending!: SessionOperation;
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => {
      const receipt: SessionOperation = { protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: command.kind === 'interaction_response' && command.payload.interactionId === approval.interactionId ? state : 'confirmed', providerResult: null, error: null };
      if (receipt.state !== 'confirmed') pending = receipt;
      return receipt;
    });
    const first = f.client.respond(approval, { kind: 'approval', action: 'allow_once' }).catch(error => error);
    await vi.waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    await expect(f.client.respond(approval, { kind: 'approval', action: 'allow_once' })).rejects.toThrow();
    await f.client.respond(form, { kind: 'form', values: [{ fieldId: 'name', value: 'answer' }] });
    expect(f.api.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.command).mock.calls[1]?.[1]).toMatchObject({ kind: 'interaction_response', payload: { interactionId: form.interactionId, interactionRevision: '1' } });
    vi.mocked(f.api.operation).mockResolvedValue({ ...pending, state: 'confirmed', providerResult: 'handled' });
    await first;
  });
});


it('restores response targets without storing answers and does not lock a different interaction', async () => {
  const storage = window.localStorage, f = fixture(storage);
  const approval = { interactionId: 'original-approval', revision: '1', state: 'pending' as const, title: 'Run', kind: 'approval' as const, detail: 'Start', actions: ['allow_once' as const] };
  const form = { interactionId: 'followup-form', revision: '1', state: 'pending' as const, title: 'Answer', kind: 'form' as const, canDismiss: false, fields: [{ fieldId: 'label', label: 'Label', type: 'text' as const, required: true, sensitive: true }] };
  const prepare = async (target: ReturnType<typeof fixture>) => {
    Object.assign(target.s, { activity: 'waiting_input', operations: { ...target.s.operations, canRespond: true } });
    vi.mocked(target.api.timeline).mockResolvedValue({ sessionId: target.s.sessionId, historyEpoch: target.s.historyEpoch, items: [approval, form].map((interaction, index) => ({ entryId: interaction.interactionId, entrySeq: String(index + 1), revision: '1', kind: 'interaction', interaction })), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    await ready(target);
  };
  await prepare(f); vi.mocked(f.api.command).mockRejectedValue(new Error('Lost acknowledgement'));
  await expect(f.client.respond(approval, { kind: 'approval', action: 'allow_once' })).rejects.toThrow('Lost acknowledgement');
  f.client.close();
  const restored = fixture(storage); await prepare(restored);
  await expect(restored.client.respond(approval, { kind: 'approval', action: 'allow_once' })).rejects.toThrow();
  vi.mocked(restored.api.command).mockRejectedValue(new Error('Lost form acknowledgement'));
  await expect(restored.client.respond(form, { kind: 'form', values: [{ fieldId: 'label', value: 'sensitive-form-answer' }] })).rejects.toThrow('Lost form acknowledgement');
  expect(restored.api.command).toHaveBeenCalledOnce();
  const stored = storage.getItem(storage.key(0)!); expect(stored).toContain('followup-form'); expect(stored).not.toContain('sensitive-form-answer');
});

describe('session text draft ownership', () => {
  it('restores a same-tab draft after reopening without dispatching input', async () => {
    const storage = window.sessionStorage; storage.clear();
    const first = fixture(storage); await ready(first);
    first.client.setDraft('not sent\n中文'); first.client.close();
    const reopened = fixture(storage); await ready(reopened);
    expect(reopened.client.snapshot().draft.text).toBe('not sent\n中文');
    expect(reopened.api.command).not.toHaveBeenCalled();
    reopened.client.pause(); reopened.client.setDraft('offline edit');
    expect(reopened.client.snapshot().draft.text).toBe('offline edit');
    reopened.client.invalidate();
    const revoked = fixture(storage); await ready(revoked);
    expect(revoked.client.snapshot().draft.text).toBe('');
  });
  it('isolates a replaced execution and does not restore its predecessor draft', async () => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage); await ready(f); f.client.setDraft('old execution');
    const replacement = { ...f.s, executionGeneration: '2' };
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: replacement, cursor: 'zero' });
    await vi.waitFor(() => expect(f.client.snapshot().state.snapshot?.executionGeneration).toBe('2'));
    expect(f.client.snapshot().draft.text).toBe('');
    expect([...Array(storage.length)].map((_, i) => storage.getItem(storage.key(i)!)).join('')).not.toContain('old execution');
  });
  it.each([false, true])('reconciles an exact restored send without clearing a later edit (edited=%s)', async (edited) => {
    const storage = window.sessionStorage; storage.clear();
    const first = fixture(storage); await ready(first); first.client.setDraft('sent once');
    vi.mocked(first.api.command).mockRejectedValue(new Error('lost acknowledgement'));
    await expect(first.client.send('sent once')).rejects.toThrow();
    const operation = [...first.client.snapshot().state.operations.values()][0]!;
    if (edited) { first.client.setDraft('different'); first.client.setDraft('sent once'); }
    first.client.close();
    const restored = fixture(storage);
    vi.mocked(restored.api.operation).mockResolvedValue({ ...operation, state: 'provider_accepted', providerResult: 'started' });
    await ready(restored);
    await vi.waitFor(() => expect(restored.client.snapshot().state.operations.get(operation.operationId)?.state).toBe('provider_accepted'));
    expect(restored.client.snapshot().draft.text).toBe(edited ? 'sent once' : '');
    expect(restored.api.command).not.toHaveBeenCalled();
  });
  it('does not clear its pending draft for another browser send receipt', async () => {
    const f = fixture(); await ready(f); f.client.setDraft('my input');
    vi.mocked(f.api.command).mockRejectedValue(new Error('lost acknowledgement'));
    await expect(f.client.send('my input')).rejects.toThrow();
    f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'operation', payload: { protocol: f.s.protocol, sessionId: f.s.sessionId, claimId: f.s.claimId, executionGeneration: '1', operationId: '00000012-1111-4111-8111-111111111111', kind: 'send_message', state: 'confirmed', providerResult: 'started', error: null } } });
    expect(f.client.snapshot().draft.text).toBe('my input');
  });
  it('clears saved text on principal mismatch and cannot recreate it through a stale client', async () => {
    const storage = window.sessionStorage; storage.clear();
    const f = fixture(storage); await ready(f); f.client.setDraft('private text');
    f.receive({ protocol: f.s.protocol, type: 'snapshot', userId: '00000010-1111-4111-8111-111111111111', snapshot: f.s, cursor: 'zero' });
    f.client.setDraft('stale write');
    expect([...Array(storage.length)].map((_, i) => storage.getItem(storage.key(i)!)).join('')).not.toMatch(/private text|stale write/);
  });
});

it('removes a closed task draft when reopening is denied before receiving a snapshot', async () => {
  const storage = window.sessionStorage; storage.clear();
  const old = fixture(storage); await ready(old); old.client.setDraft('revoked private text'); old.client.close();
  const denied = fixture(storage); vi.mocked(denied.api.current).mockRejectedValue(new ApiError('server', 403, 'forbidden'));
  await denied.client.start();
  expect(denied.client.snapshot().draft.text).toBe('');
  expect([...Array(storage.length)].map((_, i) => storage.getItem(storage.key(i)!)).join('')).not.toContain('revoked private text');
});

it('never loads another principal draft and preserves editing when browser storage fails', async () => {
  const storage = window.sessionStorage; storage.clear();
  const owner = fixture(storage); await ready(owner); owner.client.setDraft('owner only'); owner.client.close();
  const other = fixture(storage, '00000010-1111-4111-8111-111111111111'); await other.client.start();
  expect(other.client.snapshot().draft.text).toBe('');
  const unavailable = fixture({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); }, length: 0, key: () => null, clear: () => {} });
  await ready(unavailable); unavailable.client.setDraft('in memory'); unavailable.client.pause();
  expect(unavailable.client.snapshot().draft.text).toBe('in memory');
});

it('reconciles a saved draft submission even if its separate receipt storage was lost', async () => {
  const storage = window.sessionStorage; storage.clear();
  const first = fixture(storage); await ready(first); first.client.setDraft('only once');
  vi.mocked(first.api.command).mockRejectedValue(new Error('lost acknowledgement'));
  await expect(first.client.send('only once')).rejects.toThrow();
  const operation = [...first.client.snapshot().state.operations.values()][0]!; first.client.close();
  for (const key of Object.keys(storage)) if (key.startsWith('daynight:session-operations:')) storage.removeItem(key);
  const restored = fixture(storage); vi.mocked(restored.api.operation).mockResolvedValue({ ...operation, state: 'provider_accepted', providerResult: 'started' });
  await ready(restored);
  await vi.waitFor(() => expect(restored.client.snapshot().draft.text).toBe(''));
  expect(restored.api.command).not.toHaveBeenCalled();
});

it('retains the loaded offline view until the same execution can load its new local history', async () => {
  const f = fixture(); await ready(f);
  const entry = { kind: 'reasoning' as const, entryId: 'local-entry', entrySeq: '1', revision: '1', text: 'Visible before relay restart' };
  f.receive({ protocol: f.s.protocol, type: 'event', cursor: 'one', event: { protocol: f.s.protocol, ...sessionBinding(f.s), sessionId: f.s.sessionId, executionGeneration: '1', connectionEpoch: '1', historyEpoch: f.s.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: entry } });
  const reconnected = { ...f.s, historyEpoch: 'new-local-view', connectionEpoch: '2', connectionState: 'disconnected' as const, synchronized: false };
  vi.mocked(f.api.current).mockResolvedValue({ status: 'registered', session: reconnected });
  vi.mocked(f.api.timeline).mockRejectedValue(new ApiError('server', 503, 'controller_offline'));
  await f.client.start();
  f.receive({ protocol: f.s.protocol, type: 'snapshot', userId, snapshot: reconnected, cursor: 'new-zero' });
  await vi.waitFor(() => expect(f.client.snapshot().status).toBe('error'));
  expect(f.client.snapshot().connected).toBe(false);
  expect(f.client.snapshot().state.entries).toEqual([entry]);
  await expect(f.client.send('cannot send offline')).rejects.toThrow();
  expect(f.api.command).not.toHaveBeenCalled();
});
