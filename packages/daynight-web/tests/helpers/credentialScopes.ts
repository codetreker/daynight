export const credentialScopePolicy = { scopes: ['task:read'], scopeVersion: '1' };

export const credentialScopeCatalog = {
  catalogRevision: 'a'.repeat(64),
  groups: [{ id: 'task', scopeIds: ['task:read'] }],
  defaultScopes: ['task:read'],
};

export const credentialScopeCatalogs = { pat: credentialScopeCatalog, mcp: credentialScopeCatalog };
