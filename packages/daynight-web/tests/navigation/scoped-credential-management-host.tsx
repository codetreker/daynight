import { createRoot } from 'react-dom/client';
import { revokeToken, updateTokenDescription, updateTokenExpiry } from '../../src/api/auth';
import { revokeOwnerGrant, updateOwnerGrantDescription } from '../../src/api/oauth-grants';
import type { ScopeCatalog } from '../../src/api/credential-scope';
import type { ScopedOwnerGrant, ScopedToken } from '../../src/api/scoped-credential-management';
import { ScopedTokensPanel } from '../../src/features/management/ScopedTokensPanel';
import { ScopedOwnerGrantsPanel } from '../../src/features/management/ScopedOwnerGrantsPanel';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import type { Locale } from '../../src/i18n/locale';
import '../../src/styles/app.css';

const params = new URLSearchParams(location.search);
const userId = '00000000-0000-4000-8000-000000000201';
const user = { id: userId, personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null };
const catalog: ScopeCatalog = { catalogRevision: 'a'.repeat(64), groups: [{ id: 'task', scopeIds: ['task:read', 'task:write'] }, { id: 'team', scopeIds: ['team:read', 'team:write'] }], defaultScopes: ['task:read', 'task:write', 'team:read'] };
let token: ScopedToken = { id: '00000000-0000-4000-8000-000000000202', name: 'Laptop token', description: null, createdAt: '2026-01-01T00:00:00Z', expiresAt: null, lastUsedAt: null, scopePolicy: { scopes: ['task:read'], scopeVersion: '1' } };
let grant: ScopedOwnerGrant = { id: '00000000-0000-4000-8000-000000000203', description: null, clientName: 'Example MCP', clientId: 'example-client', resource: 'https://daynight.example/mcp', scope: 'daynight:mcp', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', lastUsedAt: null, revokedAt: null, status: 'active', scopePolicy: { scopes: ['task:read'], scopeVersion: '1' } };
const catalogs = async () => ({ pat: catalog, mcp: catalog });
const log = (value: unknown) => { const entries = JSON.parse(sessionStorage.getItem('fixture.writes') ?? '[]') as unknown[]; entries.push(value); sessionStorage.setItem('fixture.writes', JSON.stringify(entries)); };
const tokenTransport: NonNullable<Parameters<typeof ScopedTokensPanel>[0]['transport']> = {
  list: async () => [token], catalog: catalogs, create: async (input, _signal, _mismatch, onDispatch) => { onDispatch?.(); log(input); return { ...token, name: input.name, scopePolicy: { scopes: input.scopes, scopeVersion: '1' }, token: 'fixture-secret' }; }, revoke: revokeToken, update: updateTokenExpiry, describe: updateTokenDescription,
  scopes: async (_id, input, _signal, _mismatch, onDispatch) => { onDispatch?.(); log(input); token = { ...token, scopePolicy: { scopes: input.scopes, scopeVersion: '2' } }; return token; },
};
const grantTransport: NonNullable<Parameters<typeof ScopedOwnerGrantsPanel>[0]['transport']> = {
  list: async () => [grant], catalog: catalogs, revoke: revokeOwnerGrant, describe: updateOwnerGrantDescription,
  updateScopes: async (_id, input, _signal, _mismatch, onDispatch) => { onDispatch?.(); log(input); grant = { ...grant, scopePolicy: { scopes: input.scopes, scopeVersion: '2' } }; return grant; },
};
const locale: Locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
const page = params.get('kind') === 'grant'
  ? <ScopedOwnerGrantsPanel user={user} onIdentityMismatch={() => {}} transport={grantTransport} />
  : <ScopedTokensPanel user={user} onIdentityMismatch={() => {}} transport={tokenTransport} />;
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale, issue: null }}><main className="content">{page}</main></LocaleProvider>);
