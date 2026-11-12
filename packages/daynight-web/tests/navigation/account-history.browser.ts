import { expect, test, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const personal = { id: teamId, kind: 'personal', name: null };
const user = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: time, updatedAt: time, membership: { teamId, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } };

const install = async (page: Page) => {
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    if (path === '/api/v1/me') return send(user);
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/tokens') return request.method() === 'POST'
      ? send({ id: '00000000-0000-4000-8000-000000000022', name: 'Device', lastUsedAt: null, createdAt: time, expiresAt: null, token: 'once-only-secret' }, 201)
      : send({ items: [] });
    if (path === '/api/v2/oauth/grants') return send({ userId, grants: [] });
    if (path === '/api/v1/me/worker-prompt') return send({ scope: 'user', scopeId: userId, revision: '1', text: 'Original prompt', updatedAt: time });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  return writes;
};

for (const width of [1280, 320]) {
  test(`account tabs traverse without remounting a prompt draft at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const writes = await install(page);
    await page.goto('/account');
    const tabs = page.getByRole('navigation', { name: 'Account settings' });
    const profile = tabs.getByRole('button', { name: 'Profile', exact: true });
    const tokens = tabs.getByRole('button', { name: 'Access credentials', exact: true });
    const prompt = tabs.getByRole('button', { name: 'User prompt', exact: true });
    const selected = (button: typeof profile) => expect(button).toHaveAttribute('aria-current', 'page');
    await selected(profile);
    await tokens.click(); await selected(tokens);
    await prompt.focus(); await page.keyboard.press('Enter'); await selected(prompt);
    const input = page.locator('.worker-prompt-text');
    await expect(input).toHaveValue('Original prompt');
    await input.fill('Private draft must remain in the editor');
    await input.evaluate(element => { (window as unknown as { accountPromptNode: Element }).accountPromptNode = element; });
    const length = await page.evaluate(() => history.length);
    await prompt.click();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await tokens.click(); await selected(tokens);
    await page.goBack(); await selected(prompt);
    await expect(input).toHaveValue('Private draft must remain in the editor');
    expect(await input.evaluate(element => element === (window as unknown as { accountPromptNode: Element }).accountPromptNode)).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain('Private draft');
    await page.goBack(); await selected(tokens);
    await page.goBack(); await selected(profile);
    await page.goForward(); await selected(tokens);
    await page.goForward(); await selected(prompt);
    await expect(input).toHaveValue('Private draft must remain in the editor');
    await page.goForward(); await selected(tokens);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    if (width === 320) await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.locator('.sidebar nav').getByRole('link', { name: 'Projects', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /keep editing/i }).click();
    await selected(prompt);
    await expect(input).toHaveValue('Private draft must remain in the editor');
    expect(writes).toEqual([]);
  });
}

test('traversing account tabs retains the one-time token owner without replaying creation', async ({ page }) => {
  const writes = await install(page);
  await page.goto('/account');
  const tabs = page.getByRole('navigation', { name: 'Account settings' });
  await tabs.getByRole('button', { name: 'Access credentials' }).click();
  const create = page.getByRole('region', { name: 'Personal access tokens' }).getByRole('button', { name: 'Create token' });
  await expect(create).toBeEnabled(); await create.click();
  await page.getByLabel('Token name').fill('Device');
  await page.getByRole('dialog', { name: 'Create personal access token' }).getByRole('button', { name: 'Create token' }).click();
  const secret = page.getByLabel('One-time access token');
  await expect(secret).toHaveValue('once-only-secret');
  await secret.evaluate(element => { (window as unknown as { tokenSecretNode: Element }).tokenSecretNode = element; });
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain('once-only-secret');
  await page.goBack();
  const profile = tabs.getByRole('button', { name: 'Profile' });
  await expect(profile).toHaveAttribute('aria-current', 'page');
  await expect(secret).toBeHidden();
  await profile.click();
  await page.goForward();
  await expect(tabs.getByRole('button', { name: 'Access credentials' })).toHaveAttribute('aria-current', 'page');
  await expect(secret).toHaveValue('once-only-secret');
  expect(await secret.evaluate(element => element === (window as unknown as { tokenSecretNode: Element }).tokenSecretNode)).toBe(true);
  expect(writes).toEqual(['POST /api/v1/me/tokens']);
});

test('a malformed admitted account selection exposes an error and hides page content', async ({ page }) => {
  await install(page);
  await page.goto('/account');
  const tabs = page.getByRole('navigation', { name: 'Account settings' });
  await tabs.getByRole('button', { name: 'Access credentials' }).click();
  await page.evaluate(() => {
    const state = history.state as { __daynightNavigation: { view: unknown } };
    history.replaceState({ ...state, __daynightNavigation: { ...state.__daynightNavigation, view: { version: 1, userId: '00000000-0000-4000-8000-000000000001', pageKey: 'account', selection: { tab: 'invalid' } } } }, '');
  });
  await page.goBack();
  await expect(tabs.getByRole('button', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  await page.goForward();
  await expect(page.getByRole('alert')).toHaveText('Invalid page navigation state.');
  await expect(page.locator('.settings-grid')).toBeHidden();
  await expect(page.getByText('Through UniAuth')).toBeHidden();
  await page.goBack();
  await expect(tabs.getByRole('button', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.settings-grid')).toBeVisible();
});
