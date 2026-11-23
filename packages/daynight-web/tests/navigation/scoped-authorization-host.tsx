import { createRoot } from 'react-dom/client';
import { ApiError } from '../../src/api/client';
import type { ScopeCatalog } from '../../src/api/credential-scope';
import type { ScopedConsentView, ScopedDeviceInspection } from '../../src/api/scoped-authorization';
import { ScopedDeviceAuthorizationPage, type ScopedDeviceAuthorizationApi } from '../../src/features/auth/ScopedDeviceAuthorizationPage';
import { ScopedOAuthConsentPage } from '../../src/features/auth/ScopedOAuthConsentPage';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import type { Locale } from '../../src/i18n/locale';
import '../../src/styles/app.css';

const params = new URLSearchParams(location.search);
const userId = '00000000-0000-4000-8000-000000000201', requestId = '00000000-0000-4000-8000-000000000202', code = 'BCDFG-HJKLM', revision = 'a'.repeat(64);
const user = { id: userId, personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null };
const groups = [{ id: 'team', scopeIds: ['team:read', 'team:write'] }, { id: 'worker-execution', scopeIds: ['worker:complete'] }];
const pat: ScopeCatalog = { catalogRevision: revision, groups, defaultScopes: ['team:read', 'worker:complete'] };
const mcp: ScopeCatalog = { catalogRevision: revision, groups, defaultScopes: ['team:read'] };
const catalog = async () => ({ pat, mcp });
const status = (): 'pending' | 'approved' | 'denied' => (sessionStorage.getItem('fixture.status') as 'pending' | 'approved' | 'denied' | null) ?? 'pending';
const log = (value: unknown) => { const previous = JSON.parse(sessionStorage.getItem('fixture.decisions') ?? '[]') as unknown[]; previous.push(value); sessionStorage.setItem('fixture.decisions', JSON.stringify(previous)); };
const inspectDevice: ScopedDeviceAuthorizationApi['inspect'] = async () => ({ userCode: code, expiresAt: new Date(Date.now() + 600_000).toISOString(), status: status(), catalogRevision: revision } as ScopedDeviceInspection);
const decideDevice: ScopedDeviceAuthorizationApi['decide'] = async (actualCode, decision, actualUser, selection, _signal, _mismatch, onDispatch) => {
  onDispatch?.(); log({ actualCode, decision, actualUser, selection });
  if (params.get('unknown') === '1') throw new ApiError('network');
  sessionStorage.setItem('fixture.status', decision === 'approve' ? 'approved' : 'denied');
};
const deviceTransport: ScopedDeviceAuthorizationApi = { inspect: inspectDevice, decide: decideDevice, catalog };
const inspectConsent = async (): Promise<ScopedConsentView> => ({ requestId, userId, status: status(), clientName: 'Example MCP', clientId: 'example-client', clientProvenance: 'dcr', redirectUri: 'http://127.0.0.1:41235/callback', resource: 'https://daynight.example/mcp', scope: 'daynight:mcp', codeExpired: false, catalogRevision: revision });
const consentTransport: NonNullable<Parameters<typeof ScopedOAuthConsentPage>[0]['transport']> = {
  inspect: inspectConsent, catalog,
  decide: async (view, decision, selection, _signal, _unauthorized, onDispatch) => {
    onDispatch?.(); log({ requestId: view.requestId, decision, selection });
    if (params.get('unknown') === '1') throw new ApiError('network');
    sessionStorage.setItem('fixture.status', decision === 'approve' ? 'approved' : 'denied');
    return 'http://127.0.0.1:41235/callback?error=access_denied&iss=https%3A%2F%2Fdaynight.example';
  },
};
const locale: Locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
const page = params.get('kind') === 'device'
  ? <ScopedDeviceAuthorizationPage user={user} initialCode={code} transport={deviceTransport} onSwitchAccount={() => {}} onIdentityMismatch={() => {}} />
  : <ScopedOAuthConsentPage user={user} requestId={requestId} transport={consentTransport} onSwitchAccount={() => {}} onIdentityMismatch={() => {}} navigate={() => {}} />;
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale, issue: null }}>{page}</LocaleProvider>);
