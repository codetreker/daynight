import { createRoot } from 'react-dom/client';
import type { BrowserSession } from '../../src/api/browser-sessions';
import { BrowserSessionsPanel } from '../../src/features/management/BrowserSessionsPanel';
import { CredentialClockProvider } from '../../src/features/management/CredentialLastUse';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import type { Locale } from '../../src/i18n/locale';
import '../../src/styles/app.css';

const userId = '00000000-0000-4000-8000-000000000201';
const user = { id: userId, personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal' as const, name: null }, name: 'Alice', email: 'alice@example.test', emailVerified: true, avatarUrl: null };
const current: BrowserSession = { id: '00000000-0000-4000-8000-000000000202', browser: 'Chrome', os: 'macOS', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, expiresAt: '2099-01-01T00:00:00Z' };
let items: BrowserSession[] = [{ id: '00000000-0000-4000-8000-000000000203', browser: 'Safari', os: 'iOS', createdAt: '2026-01-02T00:00:00Z', lastUsedAt: '2026-01-03T00:00:00Z', expiresAt: '2099-01-02T00:00:00Z' }];
const transport: NonNullable<Parameters<typeof BrowserSessionsPanel>[0]['transport']> = {
  list: async () => ({ userId, current, items, nextCursor: null }),
  get: async id => { const found = items.find(item => item.id === id); if (!found) throw new Error('Missing fixture target'); return found; },
  revoke: async (id, input, _signal, _mismatch, onDispatch) => { onDispatch?.(); sessionStorage.setItem('fixture.write', JSON.stringify({ id, ...input })); items = items.filter(item => item.id !== id); },
};
const locale: Locale = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en';
createRoot(document.getElementById('root')!).render(<LocaleProvider initial={{ locale, issue: null }}><main className="content"><CredentialClockProvider visible><BrowserSessionsPanel user={user} onIdentityMismatch={() => {}} onSignOut={() => {}} visible transport={transport} /></CredentialClockProvider></main></LocaleProvider>);
