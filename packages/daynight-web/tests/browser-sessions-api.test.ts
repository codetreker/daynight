import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBrowserSession, listBrowserSessions, revokeBrowserSession } from '../src/api/browser-sessions';
import { invalidateAuthRequests } from '../src/api/client';

const user = '00000000-0000-4000-8000-000000000001';
const currentId = '00000000-0000-4000-8000-000000000002';
const targetId = '00000000-0000-4000-8000-000000000003';
const otherId = '00000000-0000-4000-8000-000000000004';
const current = { id: currentId, browser: 'Chrome', os: 'Linux', createdAt: '2026-11-20T09:00:00Z', lastUsedAt: '2026-11-21T09:00:00Z', expiresAt: '2026-11-28T09:00:00Z' };
const target = { ...current, id: targetId, browser: null, os: null, lastUsedAt: null };
const page = { userId: user, current, items: [target], nextCursor: 'opaque+cursor' };
const signal = () => new AbortController().signal;
const response = (data: unknown, status = 200, principal = user) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const empty = (status = 204, principal = user) => new Response(null, { status, headers: { 'Daynight-User-ID': principal } });
const error = (status: number, code: string) => response({ error: { code, message: 'private', requestId: 'req-1' } }, status);
afterEach(() => { invalidateAuthRequests(); vi.restoreAllMocks(); });

describe('browser session API', () => {
  it('reads the current session, nullable device data and an opaque next page', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(page)).mockResolvedValueOnce(response({ ...page, items: [], nextCursor: null }));
    expect(await listBrowserSessions(signal(), user, vi.fn())).toEqual(page);
    expect(await listBrowserSessions(signal(), user, vi.fn(), page.nextCursor)).toEqual({ ...page, items: [], nextCursor: null });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/v1/me/browser-sessions', '/api/v1/me/browser-sessions?cursor=opaque%2Bcursor']);
    await expect(listBrowserSessions(signal(), user, vi.fn(), '')).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...page, userId: otherId },
    { ...page, items: [current] },
    { ...page, items: [target, target] },
    { ...page, current: { ...current, browser: 'unknown' } },
    { ...page, current: { ...current, os: 'Desktop' } },
    { ...page, current: { ...current, lastUsedAt: undefined } },
    { ...page, current: { ...current, expiresAt: '2026-02-31T00:00:00Z' } },
    { ...page, current: { ...current, rawUserAgent: 'secret' } },
    { ...page, nextCursor: '' },
  ])('rejects malformed or inconsistent page %#', async bad => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(bad));
    await expect(listBrowserSessions(signal(), user, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('reads only the requested target and reports a 404 without inventing a write result', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(target)).mockResolvedValueOnce(response({ ...target, id: otherId })).mockResolvedValueOnce(error(404, 'not_found'));
    expect(await getBrowserSession(targetId, signal(), user, vi.fn())).toEqual(target);
    await expect(getBrowserSession(targetId, signal(), user, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(getBrowserSession(targetId, signal(), user, vi.fn())).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(Array(3).fill(`/api/v1/me/browser-sessions/${targetId}`));
  });
  it('binds a single revoke to the observed user and current session', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(empty());
    const dispatch = vi.fn(), input = { expectedUserId: user, expectedSessionId: currentId };
    await revokeBrowserSession(targetId, input, signal(), vi.fn(), dispatch);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/v1/me/browser-sessions/${targetId}/revoke`, expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(revokeBrowserSession(currentId, input, signal(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('preserves conflicts and unknown outcomes without replaying the revoke', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(error(409, 'identity_mismatch')).mockResolvedValueOnce(error(503, 'write_outcome_unknown')).mockRejectedValueOnce(new Error('connection lost'));
    const input = { expectedUserId: user, expectedSessionId: currentId };
    await expect(revokeBrowserSession(targetId, input, signal(), vi.fn())).rejects.toMatchObject({ status: 409, code: 'identity_mismatch' });
    await expect(revokeBrowserSession(targetId, input, signal(), vi.fn())).rejects.toMatchObject({ status: 503, code: 'write_outcome_unknown' });
    await expect(revokeBrowserSession(targetId, input, signal(), vi.fn())).rejects.toMatchObject({ kind: 'network' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects another principal and late responses after identity invalidation', async () => {
    const gate = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(page, 200, otherId)).mockReturnValueOnce(gate.promise);
    const mismatch = vi.fn();
    await expect(listBrowserSessions(signal(), user, mismatch)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce();
    const pending = listBrowserSessions(signal(), user, vi.fn());
    invalidateAuthRequests(); gate.resolve(response(page));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
