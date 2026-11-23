import { credentialJson, credentialOperation, credentialRequest } from './credential-management';
import { array, malformed, record, string } from './parse';

export type ScopeCatalog = {
  readonly catalogRevision: string;
  readonly groups: readonly { readonly id: string; readonly scopeIds: readonly string[] }[];
  readonly defaultScopes: readonly string[];
};
export type ScopeSelection = { readonly catalogRevision: string; readonly scopes: readonly string[] };

const revision = (value: unknown): string => {
  const result = string(value);
  return /^[a-f0-9]{64}$/.test(result) ? result : malformed();
};
const groupId = (value: unknown): string => {
  const result = string(value);
  return /^[a-z][a-z0-9-]*$/.test(result) ? result : malformed();
};
const scopeId = (value: unknown): string => {
  const result = string(value);
  return /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(result) ? result : malformed();
};
const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

export const parseScopeCatalog = (value: unknown): ScopeCatalog => {
  const data = record(value);
  const groups = array(data.groups, item => {
    const group = record(item), scopeIds = array(group.scopeIds, scopeId);
    if (scopeIds.length === 0 || !unique(scopeIds)) return malformed();
    return { id: groupId(group.id), scopeIds };
  });
  const all = groups.flatMap(group => group.scopeIds);
  const defaultScopes = array(data.defaultScopes, scopeId);
  if (!unique(groups.map(group => group.id)) || !unique(all) || !unique(defaultScopes) || defaultScopes.some(id => !all.includes(id))) return malformed();
  return { catalogRevision: revision(data.catalogRevision), groups, defaultScopes };
};

export const parseCatalogRevision = revision;
export const scopedDecisionFields = (decision: 'approve' | 'deny', selection: ScopeSelection | undefined): { catalogRevision: string; scopes: readonly string[] } | Record<string, never> => {
  if (decision === 'deny') {
    if (selection !== undefined) return malformed();
    return {};
  }
  if (decision !== 'approve' || selection === undefined) return malformed();
  const catalogRevision = revision(selection.catalogRevision), scopes = array(selection.scopes, scopeId);
  if (scopes.length === 0 || !unique(scopes)) return malformed();
  return { catalogRevision, scopes };
};

export const readCredentialScopeCatalog = (userId: string, signal: AbortSignal, onIdentityMismatch: () => void): Promise<{ readonly pat: ScopeCatalog; readonly mcp: ScopeCatalog }> => credentialOperation(signal, async () => {
  const response = await credentialRequest('/api/v1/me/credential-scope-catalog', signal, userId, onIdentityMismatch, { headers: { Accept: 'application/json' } });
  return credentialJson(response, signal, value => {
    if (response.status !== 200) return malformed();
    const data = record(value);
    return { pat: parseScopeCatalog(data.pat), mcp: parseScopeCatalog(data.mcp) };
  });
});
