import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import type { SessionSnapshot } from '../src/api/types';

const binding = { ownerUserId: '00000009-1111-4111-8111-111111111111', botId: '00000015-1111-4111-8111-111111111111', sessionId: '00000016-1111-4111-8111-111111111111', testExecutionId: '00000017-1111-4111-8111-111111111111' };
function snapshot(): Extract<SessionSnapshot, { readonly testExecutionId: string }> {
  const task = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const { claimId: _claim, ...base } = task;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = task.identity;
  return { ...base, sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, identity: { ...identity, ownerUserId: binding.ownerUserId }, initialInputState: 'not_required' };
}
const response = (session: SessionSnapshot, principal = binding.ownerUserId) => new Response(JSON.stringify({ session }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
afterEach(() => vi.unstubAllGlobals());

it('binds a Bot to its real independent Session URL and execution identity', async () => {
  expect(sessions).toHaveProperty('createBotSessionApi');
  const s = snapshot();
  const fetch = vi.fn(async (_url: string) => response(s)); vi.stubGlobal('fetch', fetch);
  const api = sessions.createBotSessionApi(binding, vi.fn());
  await expect(api.current(new AbortController().signal)).resolves.toEqual({ status: 'registered', session: s });
  expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/test-sessions/${binding.sessionId}`);
  expect(api.resourceUrl(binding.sessionId, binding.botId)).toBe(`/api/v1/test-sessions/${binding.sessionId}/resources/${binding.botId}/content`);
  expect(() => api.resourceUrl(binding.botId, binding.botId)).toThrow();
});

it.each(['execution', 'session', 'owner', 'task'] as const)('rejects a Bot current response with a different %s binding', async kind => {
  const s = snapshot();
  const changed = kind === 'execution' ? { ...s, testExecutionId: binding.botId }
    : kind === 'session' ? { ...s, sessionId: binding.botId }
    : kind === 'owner' ? { ...s, identity: { ...s.identity, ownerUserId: binding.botId } }
    : JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  vi.stubGlobal('fetch', vi.fn(async () => response(changed)));
  await expect(sessions.createBotSessionApi(binding, vi.fn()).current(new AbortController().signal)).rejects.toThrow();
});

it('invalidates the authenticated scope when a Bot response comes from another account', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(snapshot(), binding.botId)));
  const mismatch = vi.fn();
  await expect(sessions.createBotSessionApi(binding, mismatch).current(new AbortController().signal)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(mismatch).toHaveBeenCalledOnce();
});

const windowBoundary = {
  sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, executionGeneration: '2', connectionEpoch: '3',
  botHistoryWindowVersion: 1, historyEpoch: '00000018-1111-4111-8111-111111111111', windowRevision: '7',
  retainedFromSeq: '1', throughSeq: '1', earlierHistoryUnavailable: false,
};
const windowPage = {
  ...windowBoundary, kind: 'bot_history_window', hasEarlierHistory: false, beforeCursor: null, nextCursor: 'changes',
  items: [{ entryId: '00000019-1111-4111-8111-111111111111', entrySeq: '1', revision: '2', kind: 'assistant_message', preview: '😀…', truncated: true, originalBytes: '30000', previewBytes: '7', omissionReason: 'preview_limit', omittedEntryCount: 0, resourceIds: [], tool: null }],
};
function windowResponse(value: unknown, status = 200, principal: string | null = binding.ownerUserId, version: string | null = '1'): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (principal !== null) headers.set('Daynight-User-ID', principal);
  if (version !== null) headers.set('Daynight-Bot-History-Window-Version', version);
  return new Response(JSON.stringify(value), { status, headers });
}
const windowError = (code: string, message = code) => ({ error: { code, message, requestId: 'request-1' } });

it('offers the versioned window only through a Bot binding and reads all three modes', async () => {
  const fetch = vi.fn(async (_url: string) => windowResponse(windowPage)); vi.stubGlobal('fetch', fetch);
  const api = sessions.createBotSessionApi(binding, vi.fn()), signal = new AbortController().signal;
  expect(sessions.createTestSessionApi(binding.sessionId, binding.ownerUserId, vi.fn()).botHistoryWindow).toBeUndefined();
  for (const [mode, cursor] of [['tail', null], ['before', 'older'], ['changes', 'changes']] as const) {
    await expect(api.botHistoryWindow!(binding.sessionId, mode, cursor, signal)).resolves.toEqual(windowPage);
  }
  const root = `/api/v1/test-sessions/${binding.sessionId}/bot-history-window`;
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `${root}?mode=tail&limit=50`, `${root}?mode=before&limit=50&cursor=older`, `${root}?mode=changes&limit=50&cursor=changes`,
  ]);
  await expect(api.botHistoryWindow!(binding.botId, 'tail', null, signal)).rejects.toMatchObject({ kind: 'protocol' });
  await expect(api.botHistoryWindow!(binding.sessionId, 'before', 'a&mode=tail', signal)).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each([
  ['execution', () => windowResponse({ ...windowPage, testExecutionId: binding.botId })],
  ['version', () => windowResponse(windowPage, 200, binding.ownerUserId, null)],
  ['preview bytes', () => windowResponse({ ...windowPage, items: [{ ...windowPage.items[0], previewBytes: '4' }] })],
  ['wire budget', () => new Response(' '.repeat(262145) + JSON.stringify(windowPage), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': binding.ownerUserId, 'Daynight-Bot-History-Window-Version': '1' } })],
] as const)('rejects a window with invalid %s', async (_label, result) => {
  vi.stubGlobal('fetch', vi.fn(result));
  const api = sessions.createBotSessionApi(binding, vi.fn());
  await expect(api.botHistoryWindow!(binding.sessionId, 'tail', null, new AbortController().signal)).rejects.toMatchObject({ kind: 'protocol' });
});

it('rejects history from a different principal before consuming its contents', async () => {
  const response = windowResponse(windowPage, 200, binding.botId);
  vi.stubGlobal('fetch', vi.fn(() => response));
  const mismatch = vi.fn(), api = sessions.createBotSessionApi(binding, mismatch);
  await expect(api.botHistoryWindow!(binding.sessionId, 'tail', null, new AbortController().signal)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(mismatch).toHaveBeenCalledOnce();
  expect(response.bodyUsed).toBe(false);
});

it.each([
  [501, 'upgrade_required', binding.ownerUserId, '1', 'upgrade_required', 'upgrade_required'],
  [404, 'not_found', null, null, 'resource not found', 'upgrade_required'],
  [404, 'not_found', binding.ownerUserId, '1', 'Session not found.', 'not_found'],
  [404, 'not_found', binding.ownerUserId, null, 'resource not found', 'not_found'],
  [403, 'forbidden', binding.ownerUserId, null, 'Access denied.', 'forbidden'],
  [503, 'controller_offline', binding.ownerUserId, '1', 'Controller offline.', 'controller_offline'],
] as const)('retains the meaning of HTTP %s %s', async (status, code, principal, version, message, expected) => {
  vi.stubGlobal('fetch', vi.fn(() => windowResponse(windowError(code, message), status, principal, version)));
  const api = sessions.createBotSessionApi(binding, vi.fn());
  await expect(api.botHistoryWindow!(binding.sessionId, 'tail', null, new AbortController().signal)).rejects.toMatchObject({ kind: 'server', code: expected });
});

it('exposes an authorized reset boundary and rejects a reset for a different execution', async () => {
  const fetch = vi.fn()
    .mockReturnValueOnce(windowResponse({ ...windowError('reset_required'), boundary: windowBoundary }, 409))
    .mockReturnValueOnce(windowResponse({ ...windowError('reset_required'), boundary: { ...windowBoundary, testExecutionId: binding.botId } }, 409));
  vi.stubGlobal('fetch', fetch);
  const api = sessions.createBotSessionApi(binding, vi.fn()), signal = new AbortController().signal;
  await expect(api.botHistoryWindow!(binding.sessionId, 'changes', 'previous', signal)).rejects.toMatchObject({ name: 'BotHistoryWindowReset', code: 'reset_required', boundary: windowBoundary });
  await expect(api.botHistoryWindow!(binding.sessionId, 'changes', 'previous', signal)).rejects.toMatchObject({ kind: 'protocol' });
});

it('treats a history read rejected by the Bot deletion barrier as a lost admission', async () => {
  vi.stubGlobal('fetch', vi.fn(() => windowResponse(windowError('resource_conflict'), 409)));
  const api = sessions.createBotSessionApi(binding, vi.fn());
  await expect(api.botHistoryWindow!(binding.sessionId, 'tail', null, new AbortController().signal)).rejects.toBeInstanceOf(sessions.IndependentSessionReadDenied);
});
