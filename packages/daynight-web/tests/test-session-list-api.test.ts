import { afterEach, expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import { isLoginReturnPath, parseAuthRoute } from '../src/app/router';
const owner = '00000009-1111-4111-8111-111111111111';
const item = { sessionId: '00000001-1111-4111-8111-111111111111', provider: 'codex', lifecycle: 'active', connectionState: 'connected', createdAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T02:00:00Z' };
afterEach(() => vi.unstubAllGlobals());
it('recognizes the protected session directory as a login return target', () => {
  expect(parseAuthRoute('/test-sessions')).toEqual({ kind: 'testSessions' });
  expect(isLoginReturnPath('/test-sessions')).toBe(true);
});
it('loads an owner-bound page with an opaque cursor', async () => {
  expect(sessions).toHaveProperty('listTestSessions');
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [item], nextCursor: 'next' }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner } }));
  vi.stubGlobal('fetch', fetch);
  const page = await sessions.listTestSessions(owner, 'opaque + /', new AbortController().signal, vi.fn());
  expect(page).toEqual({ items: [item], nextCursor: 'next' });
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/test-sessions?limit=50&online=true&cursor=opaque+%2B+%2F');
});
it('rejects malformed or duplicate entries rather than showing partial rows', () => {
  expect(sessions).toHaveProperty('parseTestSessionList');
  for (const value of [{ items: [item, item], nextCursor: null }, { items: [{ ...item, provider: 'unknown' }], nextCursor: null }, { items: [{ ...item, updatedAt: 'yesterday' }], nextCursor: null }, { items: [item], nextCursor: '' }, { items: [item], nextCursor: null, secret: 'extra' }]) {
    expect(() => sessions.parseTestSessionList(value)).toThrow();
  }
});
it('rejects an account mismatch before exposing listed sessions', async () => {
  expect(sessions).toHaveProperty('listTestSessions');
  const mismatch = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [item], nextCursor: null }), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': item.sessionId } })));
  await expect(sessions.listTestSessions(owner, null, new AbortController().signal, mismatch)).rejects.toThrow();
  expect(mismatch).toHaveBeenCalledOnce();
});
