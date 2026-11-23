import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCredentialScopeCatalog, parseScopeCatalog } from '../src/api/credential-scope';
import { pauseAuthRequests, subscribeUnauthorized } from '../src/api/client';
import { decideScopedConsent, decideScopedDeviceAuthorization, inspectScopedConsent, inspectScopedDeviceAuthorization } from '../src/api/scoped-authorization';

const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const revision = 'a'.repeat(64);
const catalog = { catalogRevision: revision, groups: [{ id: 'task', scopeIds: ['task:read', 'task:write'] }, { id: 'team', scopeIds: ['team:read'] }], defaultScopes: ['task:read', 'team:read'] };
const view = { requestId: user, userId: user, status: 'pending', clientName: 'Client', clientId: 'client', clientProvenance: 'dcr', redirectUri: 'http://127.0.0.1:1234/callback', resource: 'https://daynight.example/mcp', scope: 'daynight:mcp', codeExpired: false, catalogRevision: revision } as const;
const device = { userCode: 'BCDFG-HJKLM', status: 'pending', expiresAt: '2027-01-01T00:00:00Z', catalogRevision: revision };
const selection = { catalogRevision: revision, scopes: ['task:read'] };
const ok = (body: unknown, principal = user) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
const noContent = () => new Response(null, { status: 204, headers: { 'Daynight-User-ID': user } });
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

describe('scoped authorization API', () => {
  it('reads independently ordered catalogs and verifies the account', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ pat: catalog, mcp: { ...catalog, defaultScopes: [] } }));
    const result = await readCredentialScopeCatalog(user, signal(), vi.fn());
    expect(result.pat).toEqual(catalog);
    expect(result.mcp.defaultScopes).toEqual([]);
    expect(fetch).toHaveBeenCalledWith('/api/v1/me/credential-scope-catalog', expect.objectContaining({ credentials: 'same-origin' }));
    const mismatch = vi.fn(); fetch.mockResolvedValueOnce(ok({ pat: catalog, mcp: catalog }, other));
    await expect(readCredentialScopeCatalog(user, signal(), mismatch)).rejects.toMatchObject({ kind: 'protocol' });
    expect(mismatch).toHaveBeenCalledOnce();
  });
  it('rejects duplicate groups, duplicate IDs, invalid revisions and defaults outside the catalog', () => {
    for (const bad of [
      { ...catalog, catalogRevision: '' },
      { ...catalog, groups: [catalog.groups[0], catalog.groups[0]] },
      { ...catalog, groups: [{ id: 'task', scopeIds: ['task:read', 'task:read'] }] },
      { ...catalog, defaultScopes: ['task:delete'] },
      { ...catalog, defaultScopes: ['task:read', 'task:read'] },
      { ...catalog, groups: [{ id: 'task', scopeIds: [] }] },
    ]) expect(() => parseScopeCatalog(bad)).toThrow();
    expect(parseScopeCatalog({ catalogRevision: revision, groups: [], defaultScopes: [] }).groups).toEqual([]);
  });
  it('validates pending and terminal device inspections and the original code', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(device)).mockResolvedValueOnce(ok({ ...device, status: 'approved', catalogRevision: undefined })).mockResolvedValueOnce(ok({ ...device, catalogRevision: undefined })).mockResolvedValueOnce(ok({ ...device, userCode: 'BCDFG-NPQRS' }));
    expect(await inspectScopedDeviceAuthorization(device.userCode, user, signal(), vi.fn())).toEqual(device);
    expect(fetch).toHaveBeenCalledWith('/api/v2/auth/device/inspect', expect.objectContaining({ method: 'POST', body: JSON.stringify({ userCode: device.userCode }) }));
    expect((await inspectScopedDeviceAuthorization(device.userCode, user, signal(), vi.fn())).status).toBe('approved');
    await expect(inspectScopedDeviceAuthorization(device.userCode, user, signal(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(inspectScopedDeviceAuthorization(device.userCode, user, signal(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('sends actual scopes for approval and no scope fields for denial, rejecting empty sets before dispatch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(noContent());
    const dispatched = vi.fn();
    await decideScopedDeviceAuthorization(device.userCode, 'approve', user, selection, signal(), vi.fn(), dispatched);
    expect(dispatched).toHaveBeenCalledOnce();
    await decideScopedDeviceAuthorization(device.userCode, 'deny', user, undefined, signal(), vi.fn());
    expect(fetch.mock.calls.map(call => JSON.parse(String(call[1]?.body)))).toEqual([
      { userCode: device.userCode, decision: 'approve', expectedUserId: user, ...selection },
      { userCode: device.userCode, decision: 'deny', expectedUserId: user },
    ]);
    await expect(decideScopedDeviceAuthorization(device.userCode, 'approve', user, { ...selection, scopes: [] }, signal(), vi.fn())).rejects.toThrow();
    await expect(decideScopedDeviceAuthorization(device.userCode, 'deny', user, selection, signal(), vi.fn())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reports a definite device 401 and withholds its callback when an identity pause begins', async () => {
    const refusal = () => new Response(JSON.stringify({ error: { code: 'unauthenticated', message: 'Session expired', requestId: 'req-1' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    const gate = Promise.withResolvers<Response>();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(refusal()).mockReturnValueOnce(gate.promise);
    const unauthorized = vi.fn(), mismatch = vi.fn(), notified = vi.fn();
    const unsubscribe = subscribeUnauthorized(notified);
    try {
      await expect(decideScopedDeviceAuthorization(device.userCode, 'deny', user, undefined, signal(), mismatch, undefined, unauthorized)).rejects.toMatchObject({ kind: 'server', status: 401, code: 'unauthenticated' });
      expect(unauthorized).toHaveBeenCalledOnce();
      expect(notified).toHaveBeenCalledOnce();
      expect(mismatch).not.toHaveBeenCalled();
      const pending = decideScopedDeviceAuthorization(device.userCode, 'deny', user, undefined, signal(), mismatch, undefined, unauthorized);
      expect(fetch).toHaveBeenCalledTimes(2);
      const resume = pauseAuthRequests();
      try {
        gate.resolve(refusal());
        await expect(pending).rejects.toMatchObject({ kind: 'server', status: 401, code: 'unauthenticated' });
        expect(notified).toHaveBeenCalledTimes(2);
        expect(unauthorized).toHaveBeenCalledOnce();
        expect(mismatch).not.toHaveBeenCalled();
      } finally { resume(); }
    } finally { unsubscribe(); }
  });
  it('binds OAuth inspection and decision to the original request, account and callback', async () => {
    const callback = 'http://127.0.0.1:1234/callback?code=secret&iss=https%3A%2F%2Fdaynight.example';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok(view)).mockResolvedValueOnce(ok({ redirectUri: callback })).mockResolvedValueOnce(ok({ redirectUri: 'https://wrong.example/?code=secret' }));
    const inspected = await inspectScopedConsent(user, user, signal(), vi.fn());
    expect(inspected).toEqual(view);
    expect(await decideScopedConsent(inspected, 'approve', selection, signal())).toBe(callback);
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v2/oauth/requests/${user}/decision`);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ expectedUserId: user, decision: 'approve', ...selection });
    await expect(decideScopedConsent(inspected, 'approve', selection, signal())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('keeps denial free of scopes and distinguishes identity mismatch from unauthorized handling', async () => {
    const callback = 'http://127.0.0.1:1234/callback?error=access_denied&iss=https%3A%2F%2Fdaynight.example';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ redirectUri: callback })).mockResolvedValueOnce(ok({ redirectUri: callback }, other));
    expect(await decideScopedConsent(view, 'deny', undefined, signal())).toBe(callback);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ expectedUserId: user, decision: 'deny' });
    const unauthorized = vi.fn(), mismatch = vi.fn();
    await expect(decideScopedConsent(view, 'deny', undefined, signal(), unauthorized, undefined, mismatch)).rejects.toMatchObject({ kind: 'protocol' });
    expect(mismatch).toHaveBeenCalledOnce();
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('preserves conflict details without replay and prevents account mismatch', async () => {
    const conflict = new Response(JSON.stringify({ error: { code: 'version_conflict', message: 'Changed', requestId: 'req-1', details: { writeOutcome: 'not_committed' } } }), { status: 409, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': user } });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(conflict).mockResolvedValueOnce(ok(view, other));
    await expect(decideScopedConsent(view, 'approve', selection, signal())).rejects.toMatchObject({ kind: 'server', status: 409, code: 'version_conflict', writeOutcome: 'not_committed' });
    const mismatch = vi.fn();
    await expect(inspectScopedConsent(user, user, signal(), mismatch)).rejects.toMatchObject({ kind: 'protocol' });
    expect(mismatch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
