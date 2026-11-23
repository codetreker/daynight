import { expect, test, type Page } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const userId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000101';
const teamId = '00000000-0000-4000-8000-000000000011';
const appId = '00000000-0000-4000-8000-000000000021';
const grantId = '00000000-0000-4000-8000-000000000031';
const time = '2026-10-20T09:00:00Z';
const app = { id: appId, githubAppId: '9007199254740993', name: `Platform App ${'engineering'.repeat(12)}`, githubSlug: 'platform', version: '9007199254740994' };
const candidate = { installation: { id: '9007199254740995', accountLogin: 'platform-installation' }, repository: { id: '42', fullName: 'example/project', private: true } };
const baseStatus = () => ({ projectId, version: '1', revision: '0', serviceAvailable: true, syncEnabled: false, connection: 'not_connected', repository: null as typeof candidate.repository | null, installation: null as typeof candidate.installation | null, canManageConnection: true, app: null as Omit<typeof app, 'version'> | null, grantId: null as string | null, pollIntervalMinutes: 5, initializing: false,
  poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null } });

const install = async (page: Page) => {
  const state = { status: baseStatus(), writes: [] as { path: string; body: Record<string, unknown> }[], discovery: [] as string[], role: 'admin' as 'admin' | 'member', teamAdmin: true, unknown: false };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    if (path === `/api/v1/projects/${projectId}/access`) return send({ projectId, ownerTeam: { id: teamId, kind: 'ordinary', name: 'Team' }, ownership: { teamId, version: 7n }, effectiveRole: state.role, teamRole: state.teamAdmin ? 'admin' : null, canTransfer: state.teamAdmin, directGrant: state.teamAdmin ? null : { projectId, userId, role: state.role, version: 1n, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/teams/${teamId}/github/apps`) return send({ items: [{ grantId, app, createdAt: time }], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/pull-requests`) return send({ projectId, revision: state.status.revision, items: [], total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' }, nextCursor: null, previousCursor: null });
    if (path === `/api/v1/projects/${projectId}/github`) return send(state.status);
    if (path.endsWith('/github/installation')) { state.discovery.push(url.search); return send(candidate); }
    if (path.endsWith('/github/connect')) {
      state.writes.push({ path, body: request.postDataJSON() });
      if (state.unknown) return send({ error: { code: 'github_write_outcome_unknown', message: 'unknown', requestId: 'test' } }, 503);
      state.status = { ...state.status, version: '2', revision: '1', connection: 'connected', installation: candidate.installation, repository: candidate.repository, app: { id: app.id, githubAppId: app.githubAppId, name: app.name, githubSlug: app.githubSlug }, grantId };
      return send(state.status);
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'test' } }, 404);
  });
  return state;
};

for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
  test(`connects the selected grant and keeps the layout usable at ${width}px (${locale})`, async ({ page }) => {
    const state = await install(page); await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tests/navigation/github-consumption.html?locale=${locale}`);
    const opener = page.getByRole('button', { name: locale === 'en' ? 'Connect GitHub App' : '连接 GitHub App' });
    await expect(opener).toBeVisible(); await opener.click();
    const dialog = page.getByRole('dialog');
    const select = dialog.getByLabel(locale === 'en' ? 'Authorized App' : '获授权 App');
    await select.selectOption(grantId);
    await expect(dialog.getByLabel(locale === 'en' ? 'Available App installation' : '可用的 App 安装')).toHaveValue(candidate.installation.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(new URLSearchParams(state.discovery[0]).get('appVersion')).toBe(app.version);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Connect GitHub App' : '连接 GitHub App' }).click();
    await expect(dialog).toHaveCount(0);
    expect(state.writes).toEqual([{ path: `/api/v1/projects/${projectId}/github/connect`, body: { version: '1', ownershipVersion: '7', appResourceId: appId, appVersion: app.version, grantId, installationId: candidate.installation.id } }]);
    await expect(page.getByText('Platform App', { exact: false }).first()).toBeVisible();
  });
}

test('preserves the poll draft and focus during background refresh', async ({ page }) => {
  const state = await install(page); await page.goto('/tests/navigation/github-consumption.html');
  const input = page.getByLabel('Poll interval'); await expect(input).toHaveValue('5');
  await input.fill('14'); await input.focus();
  state.status = { ...state.status, version: '2', revision: '1', pollIntervalMinutes: 9 };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(/Currently saved: 9 minutes/)).toBeVisible();
  await expect(input).toHaveValue('14'); await expect(input).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save interval' })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});

test('a Project administrator without Team authority cannot connect', async ({ page }) => {
  const state = await install(page); state.teamAdmin = false; state.status.canManageConnection = false;
  await page.goto('/tests/navigation/github-consumption.html');
  await expect(page.getByLabel('Poll interval')).toHaveValue('5');
  await expect(page.getByRole('button', { name: 'Connect GitHub App' })).toHaveCount(0);
  expect(state.discovery).toHaveLength(0); expect(state.writes).toHaveLength(0);
});

test('poll input follows browser text preferences at responsive widths', async ({ page }) => {
  await install(page); await page.goto('/tests/navigation/github-consumption.html');
  const input = page.getByLabel('Poll interval'); await expect(input).toHaveValue('5');
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const root of [12, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
      await expect(input).toHaveCSS('font-size', `${width === 320 ? Math.max(root, 16) : root * 0.875}px`);
    }
  }
});
