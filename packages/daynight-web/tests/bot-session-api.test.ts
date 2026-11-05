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
