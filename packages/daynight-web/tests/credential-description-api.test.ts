import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToken, listTokens, updateTokenDescription } from '../src/api/auth';
import { cancelAuthNetworkRequests, invalidateAuthRequests, pauseAuthRequests, subscribeUnauthorized } from '../src/api/client';
import { credentialDescriptionProblem, normalizeCredentialDescription, parseCredentialDescription } from '../src/api/credential-description';
import { credentialJson, credentialRequest } from '../src/api/credential-management';
import { listOwnerGrants, updateOwnerGrantDescription } from '../src/api/oauth-grants';

const userId = '00000000-0000-4000-8000-000000000001';
const target = '00000000-0000-4000-8000-000000000002';
const otherId = '00000000-0000-4000-8000-000000000003';
const createdAt = '2026-11-20T09:00:00Z';
const token = { id: target, name: 'CLI', description: null, createdAt, expiresAt: null, lastUsedAt: null };
const user = { id: userId, personalTeam: { id: target, kind: 'personal', name: null }, email: null, emailVerified: null, name: null, avatarUrl: null };
const signal = () => new AbortController().signal;
const response = (data: unknown, status = 200, principal: string | null = userId) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...(principal === null ? {} : { 'Daynight-User-ID': principal }) } });
const install = (...responses: Response[]) => {
  const fetcher = vi.fn();
  for (const result of responses) fetcher.mockResolvedValueOnce(result);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });

describe('shared credential description rules', () => {
  it('uses Unicode White_Space and code points without normalization or internal-space changes', () => {
    const text = '😀'.repeat(98) + 'e\u0301';
    expect(normalizeCredentialDescription(`\u2000${text}\u3000`)).toBe(text);
    expect(normalizeCredentialDescription('  a  b  ')).toBe('a  b');
    expect(normalizeCredentialDescription('\u2000\t\u3000')).toBeNull();
    expect(normalizeCredentialDescription('\ufeff')).toBe('\ufeff');
    expect(normalizeCredentialDescription(null)).toBeNull();
  });
  it.each(['\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029'])('rejects line separator %j before trimming', separator => {
    expect(credentialDescriptionProblem(`${separator}value`)).toBe('multiline');
    expect(() => normalizeCredentialDescription(separator)).toThrow();
  });
  it.each(['\0', '\ud800', '\udfff'])('rejects invalid Unicode/NUL %j', value => {
    expect(credentialDescriptionProblem(value)).toBe('unicode');
    expect(() => normalizeCredentialDescription(value)).toThrow();
  });
  it('rejects overlong drafts and noncanonical or absent observations', () => {
    expect(credentialDescriptionProblem('😀'.repeat(101))).toBe('tooLong');
    for (const value of [undefined, false, '', ' value ', ' '.repeat(2), 'a\n']) expect(() => parseCredentialDescription(value)).toThrow();
    expect(parseCredentialDescription('a\tb')).toBe('a\tb');
  });
});

describe.each([
  ['PAT', updateTokenDescription, `/api/v2/me/tokens/${target}/description`],
  ['OAuth', updateOwnerGrantDescription, `/api/v3/oauth/grants/${target}/description`],
] as const)('%s description API', (_kind, update, url) => {
  it('binds owner and nullable observation, normalizes new input and returns only the target field', async () => {
    const fetcher = install(response({ id: target, description: '<b>备份</b>' }));
    const onDispatch = vi.fn();
    await expect(update(target, { expectedUserId: userId, expectedDescription: null, description: '  <b>备份</b>  ' }, signal(), vi.fn(), onDispatch)).resolves.toEqual({ id: target, description: '<b>备份</b>' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ expectedUserId: userId, expectedDescription: null, description: '<b>备份</b>' }), credentials: 'same-origin', redirect: 'error' }));
    expect(onDispatch).toHaveBeenCalledOnce();
  });
  it.each([
    { id: otherId, description: null }, { id: target }, { id: target, description: '' },
    { id: target, description: 'different' }, { id: target, description: null, token: 'private' },
  ])('rejects an untrusted target/description receipt %# without replay', async receipt => {
    const fetcher = install(response(receipt));
    await expect(update(target, { expectedUserId: userId, expectedDescription: 'old', description: null }, signal(), vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([null, otherId])('rejects a receipt principal %j', async principal => {
    install(response({ id: target, description: null }, 200, principal));
    const changed = vi.fn();
    await expect(update(target, { expectedUserId: userId, expectedDescription: null, description: null }, signal(), changed)).rejects.toMatchObject({ kind: 'protocol' });
    expect(changed).toHaveBeenCalledTimes(principal === null ? 0 : 1);
  });
  it.each([[409, 'version_conflict'], [404, 'not_found'], [503, 'write_outcome_unknown']])('retains sanitized %i/%s without automatic retry', async (status, code) => {
    const fetcher = install(response({ error: { code, message: 'private description', requestId: 'request-id' } }, status as number));
    const error = await update(target, { expectedUserId: userId, expectedDescription: null, description: null }, signal(), vi.fn()).catch(value => value);
    expect(error).toMatchObject({ status, code, requestId: 'request-id' });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('private description');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('waits for identity admission and never dispatches when the account changes first', async () => {
    const fetcher = install(response({ id: target, description: null }));
    pauseAuthRequests();
    const dispatched = vi.fn();
    const pending = update(target, { expectedUserId: userId, expectedDescription: null, description: null }, signal(), vi.fn(), dispatched);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    invalidateAuthRequests();
    await rejected;
    expect(fetcher).not.toHaveBeenCalled(); expect(dispatched).not.toHaveBeenCalled();
  });
});

describe('new credential interface identity verification', () => {
  it('does not expire a valid account for an old route 401', async () => {
    const fetcher = install(new Response('legacy callback', { status: 401 }), response(user));
    const unauthorized = vi.fn(), unsubscribe = subscribeUnauthorized(unauthorized);
    try {
      await expect(listTokens(signal(), userId, vi.fn())).rejects.toMatchObject({ code: 'credential_interface_unavailable' });
      expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/v2/me/tokens', '/api/v1/me']);
      expect(unauthorized).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });
  it('broadcasts session expiry only after independent me returns 401', async () => {
    const fetcher = install(new Response(null, { status: 401 }), new Response(null, { status: 401 }));
    const unauthorized = vi.fn(), unsubscribe = subscribeUnauthorized(unauthorized);
    try {
      await expect(listOwnerGrants(signal(), userId, vi.fn())).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
      expect(fetcher).toHaveBeenCalledTimes(2); expect(unauthorized).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });
  it('pauses on another account and propagates verification failures without replay', async () => {
    const fetcher = install(response({}, 401), response({ ...user, id: otherId }));
    const mismatch = vi.fn();
    await expect(listTokens(signal(), userId, mismatch)).rejects.toMatchObject({ code: 'principal_mismatch' });
    expect(mismatch).toHaveBeenCalledOnce();
    fetcher.mockResolvedValueOnce(response({}, 401)).mockRejectedValueOnce(new Error('private network details'));
    const failure = await listTokens(signal(), userId, vi.fn()).catch(value => value);
    expect(failure).toMatchObject({ kind: 'network' }); expect(failure).not.toHaveProperty('cause');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('discards late list and one-time-secret responses from an older identity generation', async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const pending = listTokens(signal(), userId, vi.fn());
    invalidateAuthRequests(); finish(response({ items: [token] }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const creating = createToken({ name: 'CLI', expiresAt: null, expectedUserId: userId }, signal(), vi.fn());
    invalidateAuthRequests(); finish(response({ ...token, token: 'one-time-secret' }, 201));
    await expect(creating).rejects.toMatchObject({ name: 'AbortError' });
    cancelAuthNetworkRequests();
  });
  it('retains the response generation across the boundary between headers and decoding', async () => {
    install(response({ items: [token] }));
    const lifetime = signal();
    const received = await credentialRequest('/api/v2/me/tokens', lifetime, userId, vi.fn());
    invalidateAuthRequests();
    const parse = vi.fn();
    await expect(credentialJson(received, lifetime, parse)).rejects.toMatchObject({ name: 'AbortError' });
    expect(parse).not.toHaveBeenCalled();
  });
  it('requires a canonical description on v2 list/create metadata and delivers confirmed secret once', async () => {
    const fetcher = install(response({ items: [token] }), response({ ...token, description: 'backup', token: 'secret' }, 201));
    await expect(listTokens(signal(), userId, vi.fn())).resolves.toEqual([token]);
    await expect(createToken({ name: 'CLI', expiresAt: null, description: 'backup', expectedUserId: userId }, signal(), vi.fn())).resolves.toEqual({ ...token, description: 'backup', token: 'secret' });
    for (const description of [undefined, '', ' padded ', 'a\n', '😀'.repeat(101)]) {
      fetcher.mockResolvedValueOnce(response({ items: [{ ...token, description }] }));
      await expect(listTokens(signal(), userId, vi.fn())).rejects.toMatchObject({ kind: 'protocol' });
    }
  });
});
