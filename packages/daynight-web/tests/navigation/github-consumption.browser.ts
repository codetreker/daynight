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
  poll: { running: false, lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, error: null }, webhook: { running: false, lastReceivedAt: null, lastAttemptAt: null, lastSuccessAt: null, error: null }, projectWebhook: undefined as Hook | undefined });

type Hook = { version: string | null; enabled: boolean; repositoryId: string | null; lastReceivedAt: string | null; webhookUrl: string; state: 'unconfigured' | 'waiting' | 'received' | 'disabled' | 'repository_mismatch' };
const hook = (): Hook => ({ version: null, enabled: false, repositoryId: null, lastReceivedAt: null, webhookUrl: `http://127.0.0.1:4199/api/v1/github/projects/${projectId}/webhook`, state: 'unconfigured' });

const install = async (page: Page) => {
  const state = { status: baseStatus(), writes: [] as { path: string; body: Record<string, unknown> }[], discovery: [] as string[], role: 'admin' as 'admin' | 'member', teamAdmin: true, unknown: false, hookResponse: '' as '' | 'conflict' | 'unknown', hookGate: null as Promise<void> | null };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
    if (path === `/api/v1/projects/${projectId}/access`) return send({ projectId, ownerTeam: { id: teamId, kind: 'ordinary', name: 'Team' }, ownership: { teamId, version: 7n }, effectiveRole: state.role, teamRole: state.teamAdmin ? 'admin' : null, canTransfer: state.teamAdmin, directGrant: state.teamAdmin ? null : { projectId, userId, role: state.role, version: 1n, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/teams/${teamId}/github/apps`) return send({ items: [{ grantId, app, createdAt: time }], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/pull-requests`) return send({ projectId, revision: state.status.revision, items: [], total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' }, nextCursor: null, previousCursor: null });
    if (path === `/api/v1/projects/${projectId}/github`) return send(state.status);
    if (path.endsWith('/github/installation')) { state.discovery.push(url.search); return send(candidate); }
    if (path.endsWith('/github/webhook')) {
      const body = request.postDataJSON(); state.writes.push({ path, body });
      if (state.hookGate !== null) await state.hookGate;
      if (state.hookResponse === 'conflict') { state.hookResponse = ''; state.status.projectWebhook = { ...hook(), version: '2', enabled: true, repositoryId: '42', state: 'waiting' }; return send({ error: { code: 'version_conflict', message: 'conflict', requestId: 'test' } }, 409); }
      if (state.hookResponse === 'unknown') { state.hookResponse = ''; state.status.projectWebhook = { ...hook(), version: '3', enabled: true, repositoryId: '42', state: 'waiting' }; return send({ error: { code: 'github_write_outcome_unknown', message: 'unknown', requestId: 'test' } }, 503); }
      state.status.projectWebhook = { ...hook(), version: String(Number(body.version ?? 0) + 1), enabled: body.enabled, repositoryId: '42', state: body.enabled ? 'waiting' : 'disabled' };
      return send(state.status.projectWebhook);
    }
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


test('project webhook supports random secret and clipboard on a narrow screen', async ({ page, context }) => {
  const state = await install(page); await page.setViewportSize({ width: 320, height: 900 });
  state.status = { ...state.status, connection: 'connected', repository: candidate.repository, installation: candidate.installation, app: { id: app.id, githubAppId: app.githubAppId, name: app.name, githubSlug: app.githubSlug }, grantId, projectWebhook: hook() };
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/tests/navigation/github-consumption.html');
  await page.getByRole('button', { name: 'Configure webhook' }).click();
  const dialog = page.getByRole('dialog'), input = dialog.getByLabel('Webhook secret');
  await dialog.getByRole('button', { name: 'Generate random secret' }).click();
  const first = await input.inputValue(); expect(first).toMatch(/^[a-f0-9]{64}$/);
  await dialog.getByRole('button', { name: 'Generate random secret' }).click();
  const second = await input.inputValue(); expect(second).toMatch(/^[a-f0-9]{64}$/); expect(second).not.toBe(first);
  await dialog.getByRole('button', { name: 'Copy secret' }).click();
  await expect(dialog.getByText('Secret copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(second);
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new Error('denied')), configurable: true }); });
  await dialog.getByRole('button', { name: 'Copy secret' }).click();
  await expect(dialog.getByText(/Could not copy/)).toBeVisible(); await expect(input).toHaveValue(second);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Save webhook' }).click(); await expect(dialog).toHaveCount(0);
  expect(state.writes.at(-1)?.body.secret).toBe(second);
  await page.getByRole('button', { name: 'Change secret' }).click(); await expect(page.getByRole('dialog').getByLabel('Webhook secret')).toHaveValue('');
});

test('webhook conflict retains draft, unknown result requires readback', async ({ page }) => {
  const state = await install(page);
  state.status = { ...state.status, connection: 'connected', repository: candidate.repository, installation: candidate.installation, app: { id: app.id, githubAppId: app.githubAppId, name: app.name, githubSlug: app.githubSlug }, grantId, projectWebhook: hook() };
  await page.goto('/tests/navigation/github-consumption.html');
  await page.getByRole('button', { name: 'Configure webhook' }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByLabel('Webhook secret').fill('retained draft');
  state.hookResponse = 'conflict'; await dialog.getByRole('button', { name: 'Save webhook' }).click();
  await expect(dialog.getByText(/Someone changed/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Check current settings' }).click();
  await expect(dialog.getByLabel('Webhook secret')).toHaveValue('retained draft');
  await expect(dialog.getByRole('button', { name: 'Save webhook' })).toBeEnabled();
  state.hookResponse = 'unknown'; await dialog.getByRole('button', { name: 'Save webhook' }).click();
  await expect(dialog.getByText(/save result is unknown/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Check current settings' }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText(/secret save result cannot be confirmed/)).toBeVisible();
  await page.getByRole('button', { name: 'Change secret' }).click(); dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Webhook secret')).toHaveValue('');
});

test('received delivery is distinct from PR success and members cannot change the webhook', async ({ page }) => {
  const state = await install(page); state.role = 'member'; state.teamAdmin = false;
  state.status = { ...state.status, canManageConnection: false, connection: 'connected', repository: candidate.repository, installation: candidate.installation, app: { id: app.id, githubAppId: app.githubAppId, name: app.name, githubSlug: app.githubSlug }, grantId: null,
    projectWebhook: { ...hook(), version: '1', enabled: true, repositoryId: '42', state: 'received', lastReceivedAt: time } };
  await page.goto('/tests/navigation/github-consumption.html');
  await expect(page.getByText('Delivery received', { exact: true })).toBeVisible();
  await expect(page.getByText('GitHub reached this endpoint. PR sync results are shown separately.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change secret' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disable webhook' })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});


test('saving a webhook prevents editing the submitted secret until the response', async ({ page }) => {
  const state = await install(page);
  state.status = { ...state.status, connection: 'connected', repository: candidate.repository, installation: candidate.installation, app: { id: app.id, githubAppId: app.githubAppId, name: app.name, githubSlug: app.githubSlug }, grantId, projectWebhook: hook() };
  let release!: () => void;
  state.hookGate = new Promise<void>(resolve => { release = resolve; });
  await page.goto('/tests/navigation/github-consumption.html');
  await page.getByRole('button', { name: 'Configure webhook' }).click();
  const dialog = page.getByRole('dialog'), input = dialog.getByLabel('Webhook secret');
  await input.fill('submitted secret');
  await dialog.getByRole('button', { name: 'Save webhook' }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(input).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Generate random secret' })).toBeDisabled();
  expect(state.writes[0]?.body.secret).toBe('submitted secret');
  release(); await expect(dialog).toHaveCount(0);
});

test('webhook dialog remains operable by keyboard at 320 by 480', async ({ page }) => {
  const state = await install(page); await page.setViewportSize({ width: 320, height: 480 });
  state.status = { ...state.status, connection: 'connected', repository: candidate.repository, installation: candidate.installation, app: { id: app.id, githubAppId: app.githubAppId, name: app.name, githubSlug: app.githubSlug }, grantId, projectWebhook: hook() };
  await page.goto('/tests/navigation/github-consumption.html');
  const opener = page.getByRole('button', { name: 'Configure webhook' });
  await opener.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'), input = dialog.getByLabel('Webhook secret');
  await expect(input).toBeFocused(); await page.keyboard.type('keyboard secret');
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Generate random secret' })).toBeFocused();
  await page.keyboard.press('Tab'); const copySecret = dialog.getByRole('button', { name: 'Copy secret' }); await expect(copySecret).toBeFocused(); await expect(copySecret).toBeInViewport();
  const body = dialog.locator('.dialog-body');
  expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(dialog.getByText(/Generate a secret or enter your own/)).toBeInViewport();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab'); const save = dialog.getByRole('button', { name: 'Save webhook' }); await expect(save).toBeFocused();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Enter'); await expect(dialog).toHaveCount(0);
  expect(state.writes.at(-1)?.body.secret).toBe('keyboard secret');
  await expect(opener.or(page.getByRole('button', { name: 'Change secret' })).last()).toBeVisible();
});
