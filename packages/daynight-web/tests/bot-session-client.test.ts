import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { ApiError } from '../src/api/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionOperation, SessionSnapshot, SessionResource } from '../src/api/types';

const binding = { ownerUserId: '00000009-1111-4111-8111-111111111111', botId: '00000015-1111-4111-8111-111111111111', sessionId: '00000016-1111-4111-8111-111111111111', testExecutionId: '00000017-1111-4111-8111-111111111111' };
function snapshot(): Extract<SessionSnapshot, { readonly testExecutionId: string }> {
  const task = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const { claimId: _claim, ...base } = task;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = task.identity;
  return { ...base, sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, identity: { ...identity, ownerUserId: binding.ownerUserId }, initialInputState: 'not_required', lastEventSeq: '0' };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); sessionStorage.clear(); });
function fixture(bot = binding) {
  const s = snapshot(); let receive!: (message: BrowserMessage) => void;
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const channel = { close: vi.fn() }, onInvalidate = vi.fn();
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused', channel: vi.fn((_id, _after, handler) => { receive = handler; return channel; }) };
  const client = new TaskSessionClient({ api, userId: binding.ownerUserId, testSessionId: binding.sessionId, bot, isCurrent: () => true, onPrincipalMismatch: vi.fn(), onInvalidate, storage: sessionStorage }); clients.push(client);
  return { s, page, api, client, channel, onInvalidate, receive: (next = s) => receive({ protocol: next.protocol, type: 'snapshot', userId: binding.ownerUserId, snapshot: next, cursor: 'zero' }) };
}
async function ready(f: ReturnType<typeof fixture>) { await f.client.start(); f.receive(); await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true)); }

it.each(['testExecutionId', 'ownerUserId', 'sessionId'] as const)('rejects a Bot client whose expected %s does not match the authenticated Session', async field => {
  const f = fixture({ ...binding, [field]: binding.botId }); await f.client.start();
  expect(f.client.snapshot().status).toBe('unavailable');
  expect(f.client.snapshot().state.snapshot).toBeNull();
  expect(f.onInvalidate).toHaveBeenCalledOnce();
});

it('isolates Bot drafts and calls invalidation once without treating eviction as revocation', async () => {
  const a = fixture(); await ready(a); a.client.setDraft('only A'); a.client.close();
  expect(a.onInvalidate).not.toHaveBeenCalled();
  const b = fixture({ ...binding, botId: '00000018-1111-4111-8111-111111111111' }); await ready(b);
  expect(b.client.snapshot().draft.text).toBe(''); b.client.close();
  const reopened = fixture(); await ready(reopened); expect(reopened.client.snapshot().draft.text).toBe('only A');
  reopened.client.invalidate(); reopened.client.invalidate();
  expect(reopened.onInvalidate).toHaveBeenCalledOnce();
  expect(reopened.client.snapshot().draft.text).toBe('');
});

it('discards late history, receipts and resource bytes from a closed Bot client', async () => {
  const f = fixture();
  const resource: SessionResource = { resourceId: '00000019-1111-4111-8111-111111111111', name: 'result.txt', mediaType: 'text/plain', byteLength: '4', sha256: 'a'.repeat(64), status: 'available', error: null };
  vi.mocked(f.api.timeline).mockResolvedValueOnce({ ...f.page, hasMoreBefore: true, beforeCursor: 'before', resources: [resource] });
  await ready(f);
  const older = deferred<TimelinePage>(), command = deferred<SessionOperation>(), content = deferred<Blob>();
  vi.mocked(f.api.timeline).mockReturnValueOnce(older.promise); vi.mocked(f.api.command).mockReturnValueOnce(command.promise); vi.mocked(f.api.resource).mockReturnValueOnce(content.promise);
  const loading = f.client.loadOlder(), sending = f.client.send('once').catch(error => error), downloading = f.client.resource(resource.resourceId, new AbortController().signal).catch(error => error);
  const sent = vi.mocked(f.api.command).mock.calls[0]![1];
  f.client.close();
  older.resolve({ ...f.page, items: [{ kind: 'assistant_message', entryId: 'late', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'old Bot' }] }] });
  command.resolve({ protocol: sent.protocol, sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: sent.executionGeneration, operationId: sent.operationId, kind: 'send_message', state: 'provider_accepted', providerResult: 'started', error: null });
  content.resolve(new Blob(['late']));
  await loading; expect(await sending).toBeInstanceOf(Error); expect(await downloading).toBeInstanceOf(Error);
  expect(f.client.snapshot().state.entries).toEqual([]); expect(f.client.snapshot().state.operations.size).toBe(0); expect(f.channel.close).toHaveBeenCalledOnce();
});

it('rejects a new Bot execution announced on the live channel and clears its saved draft', async () => {
  const f = fixture(); await ready(f); f.client.setDraft('old execution');
  f.receive({ ...f.s, testExecutionId: binding.botId });
  expect(f.client.snapshot().status).toBe('unavailable'); expect(f.client.snapshot().draft.text).toBe(''); expect(f.onInvalidate).toHaveBeenCalledOnce();
});

it('drops obsolete generation receipts only after authenticating the current Bot fence', async () => {
  const f = fixture(); await ready(f); f.client.setDraft('old generation');
  vi.mocked(f.api.command).mockRejectedValue(new Error('unknown delivery'));
  await expect(f.client.send('old generation')).rejects.toThrow();
  const oldKeys = Object.keys(sessionStorage).filter(key => key.startsWith('daynight:session-operations:'));
  expect(oldKeys).toHaveLength(1);
  f.receive({ ...f.s, executionGeneration: String(BigInt(f.s.executionGeneration) + 1n) });
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  expect(f.client.snapshot().draft.text).toBe(''); expect(f.client.snapshot().state.operations.size).toBe(0);
  expect(oldKeys.map(key => sessionStorage.getItem(key))).toEqual([null]);
});

it.each(['command', 'operation', 'resource'] as const)('does not revoke the current Bot generation for a late rejected %s request', async kind => {
  const f = fixture();
  const resource: SessionResource = { resourceId: '00000019-1111-4111-8111-111111111111', name: 'result.txt', mediaType: 'text/plain', byteLength: '4', sha256: 'a'.repeat(64), status: 'available', error: null };
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, resources: [resource] }); await ready(f);
  const pending = deferred<never>();
  vi.mocked(f.api[kind]).mockReturnValueOnce(pending.promise);
  const result = (kind === 'command' ? f.client.send('once') : kind === 'operation' ? f.client.checkOperation('00000020-1111-4111-8111-111111111111') : f.client.resource(resource.resourceId, new AbortController().signal)).catch(error => error);
  f.receive({ ...f.s, executionGeneration: String(BigInt(f.s.executionGeneration) + 1n) });
  await vi.waitFor(() => expect(f.client.snapshot().connected).toBe(true));
  pending.reject(new ApiError('server', 403, 'forbidden')); await result;
  expect(f.client.snapshot().status).toBe('ready'); expect(f.client.snapshot().connected).toBe(true); expect(f.onInvalidate).not.toHaveBeenCalled();
});
