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
  await page.context().route('**/api/**', async (route: Route) => {
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
    const profile = tabs.getByRole('link', { name: 'Profile', exact: true });
    const tokens = tabs.getByRole('link', { name: 'Access credentials', exact: true });
    const prompt = tabs.getByRole('link', { name: 'User prompt', exact: true });
    const selected = (button: typeof profile) => expect(button).toHaveAttribute('aria-current', 'page');
    await selected(profile);
    await expect(profile).toHaveAttribute('href', '/account');
    await expect(tokens).toHaveAttribute('href', '/account?tab=tokens');
    await expect(prompt).toHaveAttribute('href', '/account?tab=prompt');
    const initialLength = await page.evaluate(() => history.length);
    await profile.click(); expect(await page.evaluate(() => history.length)).toBe(initialLength);
    await tokens.click(); await selected(tokens); await expect(page).toHaveURL(/\/account\?tab=tokens$/);
    await prompt.focus(); await page.keyboard.press('Enter'); await selected(prompt); await expect(page).toHaveURL(/\/account\?tab=prompt$/);
    const input = page.locator('.worker-prompt-text');
    await expect(input).toHaveValue('Original prompt');
    await input.fill('Private draft must remain in the editor');
    await input.evaluate(element => { (window as unknown as { accountPromptNode: Element }).accountPromptNode = element; });
    const length = await page.evaluate(() => history.length);
    await prompt.click();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await tokens.click(); await selected(tokens);
    await page.goBack(); await selected(prompt); await expect(page).toHaveURL(/\/account\?tab=prompt$/);
    await expect(input).toHaveValue('Private draft must remain in the editor');
    expect(await input.evaluate(element => element === (window as unknown as { accountPromptNode: Element }).accountPromptNode)).toBe(true);
    expect(await page.evaluate(() => location.href + JSON.stringify(history.state))).not.toContain('Private draft');
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
    await expect(page).toHaveURL(/\/account\?tab=prompt$/);
    await expect(input).toHaveValue('Private draft must remain in the editor');
    await expect(input).toBeFocused();
    expect(writes).toEqual([]);
  });
}

test('traversing account tabs retains the one-time token owner without replaying creation', async ({ page }) => {
  const writes = await install(page);
  await page.goto('/account');
  const tabs = page.getByRole('navigation', { name: 'Account settings' });
  await tabs.getByRole('link', { name: 'Access credentials' }).click();
  const create = page.getByRole('region', { name: 'Personal access tokens' }).getByRole('button', { name: 'Create token' });
  await expect(create).toBeEnabled(); await create.click();
  await page.getByLabel('Token name').fill('Device');
  await page.getByRole('dialog', { name: 'Create personal access token' }).getByRole('button', { name: 'Create token' }).click();
  const secret = page.getByLabel('One-time access token');
  await expect(secret).toHaveValue('once-only-secret');
  await secret.evaluate(element => { (window as unknown as { tokenSecretNode: Element }).tokenSecretNode = element; });
  expect(await page.evaluate(() => location.href + JSON.stringify(history.state))).not.toContain('once-only-secret');
  await page.goBack();
  const profile = tabs.getByRole('link', { name: 'Profile' });
  await expect(profile).toHaveAttribute('aria-current', 'page');
  await expect(secret).toBeHidden();
  await profile.click();
  await page.goForward();
  await expect(tabs.getByRole('link', { name: 'Access credentials' })).toHaveAttribute('aria-current', 'page');
  await expect(secret).toHaveValue('once-only-secret');
  expect(await secret.evaluate(element => element === (window as unknown as { tokenSecretNode: Element }).tokenSecretNode)).toBe(true);
  expect(writes).toEqual(['POST /api/v1/me/tokens']);
  await page.reload();
  await expect(tabs.getByRole('link', { name: 'Access credentials' })).toHaveAttribute('aria-current', 'page');
  await expect(secret).toHaveCount(0);
  expect(writes).toEqual(['POST /api/v1/me/tokens']);
});

test('URL owns selection even with stale account history payloads', async ({ page }) => {
  await install(page);
  await page.goto('/account?tab=tokens');
  const tabs = page.getByRole('navigation', { name: 'Account settings' });
  await expect(tabs.getByRole('link', { name: 'Access credentials' })).toHaveAttribute('aria-current', 'page');
  await tabs.getByRole('link', { name: 'User prompt' }).click();
  await page.evaluate(() => {
    const state = history.state as { __daynightNavigation: { view: unknown } };
    history.replaceState({ ...state, __daynightNavigation: { ...state.__daynightNavigation, view: { version: 1, userId: '00000000-0000-4000-8000-000000000001', pageKey: 'account', selection: { tab: 'tokens' } } } }, '');
  });
  await page.goBack();
  await page.goForward();
  await expect(tabs.getByRole('link', { name: 'User prompt' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.settings-grid')).toBeVisible();
});

for (const width of [1280, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) {
  test(`direct account routes and invalid recovery at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await install(page);
    await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
    const names = locale === 'en' ? ['Profile', 'Access credentials', 'User prompt'] as const : ['个人资料', '访问凭据', '用户级 Prompt'] as const;
    const tabs = page.getByRole('navigation', { name: locale === 'en' ? 'Account settings' : '账户设置' });
    for (const [path, index] of [['/account', 0], ['/account?tab=profile', 0], ['/account?tab=tokens', 1], ['/account?tab=prompt', 2], ['/account?other=long-text&tab=prompt', 2]] as const) {
      await page.goto(path);
      const selected = tabs.getByRole('link', { name: names[index], exact: true });
      await expect(selected).toHaveAttribute('aria-current', 'page');
      await page.reload(); await expect(selected).toHaveAttribute('aria-current', 'page');
      if (path === '/account?tab=profile') {
        const length = await page.evaluate(() => history.length);
        await selected.click();
        expect(await page.evaluate(() => history.length)).toBe(length);
        await expect(page).toHaveURL(/\/account\?tab=profile$/);
      }
    }
    for (const query of ['?tab=', '?tab=unknown', '?tab=tokens&tab=tokens', '?tab=profile&tab=prompt']) {
      await page.goto(`/account${query}`);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.locator('.settings-main')).toBeHidden();
      const link = tabs.getByRole('link', { name: names[1], exact: true });
      await link.focus(); await expect(link).toBeFocused(); await page.keyboard.press('Enter');
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(page).toHaveURL(/\/account\?tab=tokens$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  });
}

test('account links open their selected page in a new tab', async ({ page, context }) => {
  await install(page);
  await page.goto('/account');
  const link = page.getByRole('link', { name: 'User prompt', exact: true });
  const [opened] = await Promise.all([context.waitForEvent('page'), link.click({ modifiers: ['ControlOrMeta'] })]);
  await opened.waitForLoadState();
  await expect(opened).toHaveURL(/\/account\?tab=prompt$/);
  await expect(opened.getByRole('link', { name: 'User prompt', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveURL(/\/account$/);
  await opened.close();
});

test('credential-specific setup and device links land on credentials', async ({ page }) => {
  await install(page);
  await page.route('**/api/v1/auth/device/inspect', route => route.fulfill({ json: { userCode: 'BCDFG-HJKLM', status: 'approved', expiresAt: '2099-10-20T09:00:00Z' }, headers: { 'Daynight-User-ID': userId } }));
  await page.goto('/account');
  const enter = async (path: string) => page.evaluate(destination => {
    history.pushState(null, '', destination); dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await enter('/setup');
  const setupLink = page.getByRole('link', { name: 'Manage tokens and app authorizations' });
  await expect(setupLink).toHaveAttribute('href', '/account?tab=tokens');
  await setupLink.click();
  await expect(page).toHaveURL(/\/account\?tab=tokens$/);
  await expect(page.getByRole('link', { name: 'Access credentials', exact: true })).toHaveAttribute('aria-current', 'page');
  await enter('/device?user_code=BCDFG-HJKLM');
  const deviceLink = page.getByRole('link', { name: 'Manage CLI access' });
  await expect(deviceLink).toHaveAttribute('href', '/account?tab=tokens');
  await deviceLink.click();
  await expect(page).toHaveURL(/\/account\?tab=tokens$/);
  await expect(page.getByRole('link', { name: 'Access credentials', exact: true })).toHaveAttribute('aria-current', 'page');
});
