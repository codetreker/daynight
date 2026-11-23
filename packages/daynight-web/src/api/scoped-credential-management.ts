import { parseCreatedManagedToken, parseManagedToken } from './auth-parse';
import type { CreatedPersonalAccessToken, PersonalAccessToken } from './auth-types';
import { ApiError, requestId } from './client';
import { normalizeCredentialDescription } from './credential-description';
import { credentialJson, credentialOperation, credentialRequest } from './credential-management';
import { scopedDecisionFields, type ScopeSelection } from './credential-scope';
import { parseGrant, type OwnerGrant } from './oauth-grants';
import { array, id, malformed, record, string, timestamp } from './parse';

export type ScopePolicy = { readonly scopes: readonly string[]; readonly scopeVersion: string };
export type ScopedToken = PersonalAccessToken & { readonly scopePolicy: ScopePolicy };
export type ScopedOwnerGrant = OwnerGrant & { readonly scopePolicy: ScopePolicy | null };
export type ScopeUpdate = ScopeSelection & { readonly expectedUserId: string; readonly expectedScopeVersion: string };
export type ScopedTokenCreate = ScopeSelection & { readonly expectedUserId: string; readonly name: string; readonly expiresAt: string | null; readonly description?: string | null };

const exactFields = (data: Record<string, unknown>, fields: readonly string[]) => {
  if (Object.keys(data).some(key => !fields.includes(key))) return malformed();
};
const scopeVersion = (value: unknown): string => {
  const version = string(value);
  if (!/^[1-9][0-9]*$/.test(version) || BigInt(version) > 9223372036854775807n) return malformed();
  return version;
};
const parsePolicy = (value: unknown): ScopePolicy => {
  const data = record(value);
  exactFields(data, ['scopes', 'scopeVersion']);
  const scopes = array(data.scopes, value => {
    const scope = string(value);
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(scope)) return malformed();
    return scope;
  });
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) return malformed();
  return { scopes, scopeVersion: scopeVersion(data.scopeVersion) };
};
const tokenFields = ['id', 'name', 'description', 'createdAt', 'expiresAt', 'lastUsedAt', 'scopePolicy'];
const parseToken = (value: unknown): ScopedToken => {
  const data = record(value);
  exactFields(data, tokenFields);
  return { ...parseManagedToken(data), scopePolicy: parsePolicy(data.scopePolicy) };
};
const parseCreatedToken = (value: unknown): CreatedPersonalAccessToken & { readonly scopePolicy: ScopePolicy } => {
  const data = record(value);
  exactFields(data, [...tokenFields, 'token']);
  return { ...parseCreatedManagedToken(data), scopePolicy: parsePolicy(data.scopePolicy) };
};
const parseScopedGrant = (value: unknown): ScopedOwnerGrant => {
  const data = record(value);
  const { scopePolicy, ...grant } = data;
  return { ...parseGrant(grant), scopePolicy: scopePolicy === null ? null : parsePolicy(scopePolicy) };
};
const selectionFields = (selection: ScopeSelection) => scopedDecisionFields('approve', selection);
const matchesScopes = (policy: ScopePolicy, selected: readonly string[]) => policy.scopes.length === selected.length && selected.every(scope => policy.scopes.includes(scope));
const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };

export const listScopedTokens = (signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void): Promise<readonly ScopedToken[]> => credentialOperation(signal, async () => {
  const response = await credentialRequest('/api/v2/me/tokens', signal, expectedUserId, onIdentityMismatch, { headers: { Accept: 'application/json' } });
  return credentialJson(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    exactFields(data, ['items']);
    const items = array(data.items, parseToken);
    if (new Set(items.map(item => item.id)).size !== items.length) return malformed();
    return items;
  });
});

export const createScopedToken = (input: ScopedTokenCreate, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<CreatedPersonalAccessToken & { readonly scopePolicy: ScopePolicy }> => credentialOperation(signal, async () => {
  if (input.name.trim() === '' || [...input.name].length > 100 || /[\u0000\p{Cs}]/u.test(input.name)) throw new ApiError('protocol');
  const expectedUserId = requestId(input.expectedUserId);
  const fields = selectionFields(input);
  const body = JSON.stringify({ expectedUserId, name: input.name, expiresAt: input.expiresAt === null ? null : timestamp(input.expiresAt), ...(input.description === undefined ? {} : { description: normalizeCredentialDescription(input.description) }), ...fields });
  const response = await credentialRequest('/api/v2/me/tokens', signal, expectedUserId, onIdentityMismatch, { method: 'POST', headers, body }, onDispatch);
  return credentialJson(response, signal, value => {
    if (response.status !== 201) return malformed();
    const token = parseCreatedToken(value);
    if (!matchesScopes(token.scopePolicy, input.scopes)) return malformed();
    return token;
  });
});

export const listScopedOwnerGrants = (signal: AbortSignal, expectedUserId: string, onIdentityMismatch: () => void): Promise<readonly ScopedOwnerGrant[]> => credentialOperation(signal, async () => {
  const expected = requestId(expectedUserId);
  const response = await credentialRequest('/api/v3/oauth/grants', signal, expected, onIdentityMismatch, { headers: { Accept: 'application/json' } });
  return credentialJson(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    exactFields(data, ['userId', 'grants']);
    if (id(data.userId) !== expected) return malformed();
    const grants = array(data.grants, parseScopedGrant);
    if (new Set(grants.map(grant => grant.id)).size !== grants.length) return malformed();
    return grants;
  });
});

const updateScopes = <T extends { readonly id: string; readonly scopePolicy: ScopePolicy | null }>(url: string, targetId: string, input: ScopeUpdate, signal: AbortSignal, onIdentityMismatch: () => void, parse: (value: unknown) => T, onDispatch?: () => void): Promise<T> => credentialOperation(signal, async () => {
  const expectedUserId = requestId(input.expectedUserId), expectedScopeVersion = scopeVersion(input.expectedScopeVersion);
  const body = JSON.stringify({ expectedUserId, expectedScopeVersion, ...selectionFields(input) });
  const response = await credentialRequest(url, signal, expectedUserId, onIdentityMismatch, { method: 'PATCH', headers, body }, onDispatch);
  return credentialJson(response, signal, value => {
    if (response.status !== 200) return malformed();
    const result = parse(value), policy = result.scopePolicy;
    if (result.id !== targetId || policy === null || BigInt(policy.scopeVersion) < BigInt(expectedScopeVersion) || BigInt(policy.scopeVersion) > BigInt(expectedScopeVersion) + 1n || !matchesScopes(policy, input.scopes)) return malformed();
    return result;
  });
});

export const updateTokenScopes = (tokenId: string, input: ScopeUpdate, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<ScopedToken> => {
  const target = requestId(tokenId);
  return updateScopes(`/api/v2/me/tokens/${target}/scopes`, target, input, signal, onIdentityMismatch, parseToken, onDispatch);
};
export const updateOwnerGrantScopes = (grantId: string, input: ScopeUpdate, signal: AbortSignal, onIdentityMismatch: () => void, onDispatch?: () => void): Promise<ScopedOwnerGrant> => {
  const target = requestId(grantId);
  return updateScopes(`/api/v3/oauth/grants/${target}/scopes`, target, input, signal, onIdentityMismatch, parseScopedGrant, onDispatch);
};
