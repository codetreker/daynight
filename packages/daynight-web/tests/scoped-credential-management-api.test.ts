import { afterEach, describe, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { createScopedToken, listScopedOwnerGrants, listScopedTokens, updateOwnerGrantScopes, updateTokenScopes } from '../src/api/scoped-credential-management';

const user = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const revision = 'a'.repeat(64);
const scopePolicy = { scopes: ['task:read'], scopeVersion: '9007199254740993' };
const token = { id: target, name: 'CLI', description: null, createdAt: '2026-11-20T09:00:00Z', expiresAt: null, lastUsedAt: null, scopePolicy };
const grant = { id: target, description: null, clientName: 'Client', clientId: 'client', resource: 'https://daynight.example/mcp', scope: 'daynight:mcp', createdAt: '2026-11-20T09:00:00Z', expiresAt: '2027-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null, status: 'active', scopePolicy };
const signal = () => new AbortController().signal;
const response = (data: unknown, status = 200, principal = user) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
afterEach(() => { invalidateAuthRequests(); vi.restoreAllMocks(); });

describe('scoped credential management API', () => {
  it('reads complete tokens and fixed or scoped grants with exact versions', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ items: [token] })).mockResolvedValueOnce(response({ userId: user, grants: [grant, { ...grant, id: other, scopePolicy: null }] }));
    expect(await listScopedTokens(signal(), user, vi.fn())).toEqual([token]);
    expect(await listScopedOwnerGrants(signal(), user, vi.fn())).toEqual([grant, { ...grant, id: other, scopePolicy: null }]);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/v2/me/tokens', '/api/v3/oauth/grants']);
  });
  it.each([undefined, null, { scopes: [], scopeVersion: '1' }, { scopes: ['task:read', 'task:read'], scopeVersion: '1' }, { scopes: ['task:read'], scopeVersion: '01' }, { scopes: ['task:read'], scopeVersion: 1 }, { scopes: ['task:read'], scopeVersion: '9223372036854775808' }])('rejects invalid PAT policy %#', async policy => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ items: [{ ...token, scopePolicy: policy }] }));
    await expect(listScopedTokens(signal(), user, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('rejects duplicate rows and an absent grant policy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ items: [token, token] })).mockResolvedValueOnce(response({ userId: user, grants: [{ ...grant, scopePolicy: undefined }] }));
    await expect(listScopedTokens(signal(), user, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    await expect(listScopedOwnerGrants(signal(), user, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
  });
  it('creates a PAT with explicit catalog, selection, and one-time secret', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ ...token, token: 'secret' }, 201));
    const input = { name: 'CLI', expiresAt: null, description: '  backup  ', expectedUserId: user, catalogRevision: revision, scopes: ['task:read'] };
    const created = await createScopedToken(input, signal(), vi.fn());
    expect(created.token).toBe('secret');
    expect(fetch).toHaveBeenCalledWith('/api/v2/me/tokens', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ ...input, description: 'backup' });
    await expect(createScopedToken({ ...input, scopes: [] }, signal(), vi.fn())).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    ['PAT', updateTokenScopes, token, `/api/v2/me/tokens/${target}/scopes`],
    ['grant', updateOwnerGrantScopes, grant, `/api/v3/oauth/grants/${target}/scopes`],
  ] as const)('binds %s scope writes to the account, exact observed version and target', async (_name, update, row, url) => {
    const policy = { scopes: ['task:write', 'task:read'], scopeVersion: '9007199254740994' };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response({ ...row, scopePolicy: policy }));
    const input = { expectedUserId: user, expectedScopeVersion: '9007199254740993', catalogRevision: revision, scopes: ['task:read', 'task:write'] };
    const dispatched = vi.fn();
    expect((await update(target, input, signal(), vi.fn(), dispatched)).scopePolicy).toEqual(policy);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: 'PATCH', body: JSON.stringify(input) }));
    expect(dispatched).toHaveBeenCalledOnce();
  });
  it.each([
    ['PAT', updateTokenScopes, token], ['grant', updateOwnerGrantScopes, grant],
  ] as const)('rejects wrong %s receipts and preserves conflict or unknown without replay', async (_name, update, row) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const input = { expectedUserId: user, expectedScopeVersion: scopePolicy.scopeVersion, catalogRevision: revision, scopes: ['task:read'] };
    for (const bad of [{ ...row, id: other }, { ...row, scopePolicy: null }, { ...row, scopePolicy: { ...scopePolicy, scopeVersion: '9007199254740992' } }, { ...row, scopePolicy: { ...scopePolicy, scopes: ['task:write'] } }]) {
      fetch.mockResolvedValueOnce(response(bad));
      await expect(update(target, input, signal(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    }
    for (const [status, code] of [[409, 'version_conflict'], [503, 'write_outcome_unknown']] as const) {
      fetch.mockResolvedValueOnce(response({ error: { code, message: 'private', requestId: 'req-1' } }, status));
      await expect(update(target, input, signal(), vi.fn())).rejects.toMatchObject({ status, code });
    }
    expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('rejects late replies from the previous authenticated generation', async () => {
    const gate = Promise.withResolvers<Response>();
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(gate.promise);
    const pending = listScopedTokens(signal(), user, vi.fn());
    invalidateAuthRequests();
    gate.resolve(response({ items: [token] }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
