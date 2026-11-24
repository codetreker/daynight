import { credentialScopeCatalogs, credentialScopePolicy } from "../helpers/credentialScopes";
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const tokenId = '00000000-0000-4000-8000-000000000021';
const emptyId = '00000000-0000-4000-8000-000000000022';
const grantId = '00000000-0000-4000-8000-000000000031';
const revokedId = '00000000-0000-4000-8000-000000000032';
const createdAt = '2026-10-20T09:00:00Z';
const expiredAt = '2026-10-21T09:00:00Z';
const future = '2099-10-20T09:00:00Z';
const longDescription = 'Long office description '.repeat(4).trim();
const personal = { id: teamId, kind: 'personal', name: null };
const user = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt, updatedAt: createdAt, membership: { teamId, userId, role: 'admin', version: 1, createdAt, updatedAt: createdAt } };

const install = async (page: Page, locale: 'en' | 'zh-CN', options: { unknownDescription?: boolean } = {}) => {
  let unknownDescription = options.unknownDescription === true;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const tokens = [
    { id: tokenId, name: 'NAS Backup', description: 'Home backup script', createdAt, expiresAt: future, scopePolicy: credentialScopePolicy, lastUsedAt: null },
    { id: emptyId, name: 'NAS Backup', description: null as string | null, createdAt, expiresAt: expiredAt, scopePolicy: credentialScopePolicy, lastUsedAt: null },
  ];
  const grants = [
    { id: grantId, clientName: 'Cursor', clientId: 'https://cursor.example', resource: 'https://service.example/mcp', scope: 'daynight:mcp', description: longDescription, createdAt, expiresAt: future, scopePolicy: credentialScopePolicy, lastUsedAt: null, revokedAt: null as string | null, status: 'active' },
    { id: revokedId, clientName: 'Cursor', clientId: 'https://cursor.example', resource: 'https://service.example/mcp', scope: 'daynight:mcp', description: null as string | null, createdAt, expiresAt: future, scopePolicy: credentialScopePolicy, lastUsedAt: null, revokedAt: expiredAt, status: 'revoked' },
  ];
  await page.addInitScript(language => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me/credential-scope-catalog') return send(credentialScopeCatalogs);
    if (path === '/api/v1/me') return send(user);
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/webhook-event-types') return send({ error: { code: 'not_found', message: 'Webhook capability unavailable', requestId: 'credential-fixture' } }, 404);
    if (path === '/api/v1/me/worker-prompt') return send({ scope: 'user', scopeId: userId, revision: '0', text: '', updatedAt: null });
    if (path === '/api/v2/me/tokens' && request.method() === 'GET') return send({ items: tokens });
    if (path === '/api/v3/oauth/grants') return send({ userId, grants });
    const match = /^\/api\/(v2\/me\/tokens|v3\/oauth\/grants)\/([^/]+)\/description$/.exec(path);
    if (match && request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      const row = (match[1] === 'v2/me/tokens' ? tokens : grants).find(item => item.id === match[2])!;
      expect(body.expectedUserId).toBe(userId);
      expect(body.expectedDescription).toBe(row.description);
      const value = body.description;
      if (value !== null && typeof value !== 'string') throw new Error('Description must be a string or null.');
      row.description = value === null ? null : value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '') || null;
      if (unknownDescription) {
        unknownDescription = false;
        return send({ error: { code: 'write_outcome_unknown', message: 'Write outcome unknown', requestId: 'description-unknown' } }, 503);
      }
      return send({ id: row.id, description: row.description });
    }
    throw new Error(`Unexpected credential browser request: ${request.method()} ${path}`);
  });
  return { writes };
};

const expectHittable = async (control: Locator, touch: boolean) => {
  await control.scrollIntoViewIfNeeded();
  const geometry = await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { width: box.width, height: box.height, hit: hit !== null && element.contains(hit) };
  });
  expect(geometry.hit).toBe(true);
  expect(geometry.width).toBeGreaterThanOrEqual(touch ? 44 : 28);
  expect(geometry.height).toBeGreaterThanOrEqual(touch ? 44 : 28);
};

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`description pencils, literal values and keyboard focus in ${locale} at ${width}px`, async ({ browser }, testInfo) => {
    const touch = width === 320;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch, locale, timezoneId: 'UTC' });
    const page = await context.newPage();
    try {
      const fixture = await install(page, locale);
      await page.goto('/account?tab=tokens');
      const editorTitle = locale === 'en' ? 'Edit description' : '编辑描述';
      const descriptionLabel = locale === 'en' ? 'Description' : '描述';
      const saveLabel = locale === 'en' ? 'Save' : '保存';
      const cancelLabel = locale === 'en' ? 'Cancel' : '取消';
      const pencil = (id: string) => page.locator(`[data-credential-description="${id}"]`);
      const row = (id: string) => pencil(id).locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," token-row ") or contains(concat(" ",normalize-space(@class)," ")," grant-row ")][1]');
      const open = async (id: string) => {
        await pencil(id).focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: editorTitle, exact: true });
        await expect(dialog.getByLabel(descriptionLabel, { exact: true })).toBeFocused();
        return dialog;
      };
      await expect(pencil(tokenId)).toBeVisible();
      await expect(pencil(emptyId)).toBeVisible();
      const names = await Promise.all([pencil(tokenId).getAttribute('aria-label'), pencil(emptyId).getAttribute('aria-label')]);
      expect(names[0]).not.toBe(names[1]);
      await expect(row(tokenId).locator('.credential-description')).toHaveText('Home backup script');
      await expect(row(emptyId).locator('.credential-description')).toHaveCount(0);
      const description = row(tokenId).locator('.credential-description');
      const nameBox = (await row(tokenId).locator('.person-name').boundingBox())!;
      const descriptionBox = (await description.boundingBox())!;
      const editBox = (await pencil(tokenId).boundingBox())!;
      expect(descriptionBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
      expect(editBox.x).toBeGreaterThanOrEqual(descriptionBox.x + descriptionBox.width - 1);
      expect(editBox.y).toBeLessThan(descriptionBox.y + descriptionBox.height);
      expect(editBox.y + editBox.height).toBeGreaterThan(descriptionBox.y);
      const emptyNameBox = (await row(emptyId).locator('.person-name').boundingBox())!;
      const emptyEditBox = (await pencil(emptyId).boundingBox())!;
      expect(emptyEditBox.x).toBeGreaterThanOrEqual(emptyNameBox.x + emptyNameBox.width - 1);
      expect(emptyEditBox.y).toBeLessThan(emptyNameBox.y + emptyNameBox.height);
      expect(emptyEditBox.y + emptyEditBox.height).toBeGreaterThan(emptyNameBox.y);
      await expect(row(grantId).locator('.credential-description')).toHaveAttribute('title', longDescription);
      if (touch) expect(await row(grantId).locator('.credential-description').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      for (const id of [tokenId, emptyId, grantId, revokedId]) await expectHittable(pencil(id), touch);
      await page.screenshot({ path: testInfo.outputPath(`credential-descriptions-${locale}-${width}.png`), fullPage: true });

      let dialog = await open(tokenId);
      await dialog.getByLabel(descriptionLabel, { exact: true }).fill('Cancelled draft');
      await dialog.getByRole('button', { name: cancelLabel, exact: true }).click();
      await expect(pencil(tokenId)).toBeFocused();
      await expect(row(tokenId).locator('.credential-description')).toHaveText('Home backup script');
      expect(fixture.writes).toEqual([]);

      dialog = await open(emptyId);
      await dialog.getByLabel(descriptionLabel, { exact: true }).fill('  <b>备份</b> 😀  ');
      await dialog.getByRole('button', { name: saveLabel, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pencil(emptyId)).toBeFocused();
      await expect(row(emptyId).locator('.credential-description')).toHaveText('<b>备份</b> 😀');
      await expect(row(emptyId).locator('b')).toHaveCount(0);
      expect(fixture.writes).toHaveLength(1);

      dialog = await open(emptyId);
      await dialog.getByLabel(descriptionLabel, { exact: true }).fill('   ');
      await dialog.getByRole('button', { name: saveLabel, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pencil(emptyId)).toBeFocused();
      await expect(row(emptyId).locator('.credential-description')).toHaveCount(0);

      dialog = await open(revokedId);
      await dialog.getByLabel(descriptionLabel, { exact: true }).fill('Old office laptop');
      await dialog.getByRole('button', { name: saveLabel, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(pencil(revokedId)).toBeFocused();
      await expect(row(revokedId)).toHaveClass(/revoked/);
      await expect(row(revokedId).locator('.credential-description')).toHaveText('Old office laptop');
      expect(fixture.writes).toHaveLength(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    } finally { await context.close(); }
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`raw multiline paste is refused and drafts survive account tabs in ${locale}`, async ({ page }) => {
    const fixture = await install(page, locale);
    await page.goto('/account?tab=tokens');
    const pencil = page.locator(`[data-credential-description="${tokenId}"]`);
    await pencil.click();
    const dialog = page.getByRole('dialog', { name: locale === 'en' ? 'Edit description' : '编辑描述', exact: true });
    const input = dialog.getByLabel(locale === 'en' ? 'Description' : '描述', { exact: true });
    await input.fill('Retained draft');
    const prevented = await input.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'first\nsecond');
      return !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    expect(prevented).toBe(true);
    await expect(input).toHaveValue('Retained draft');
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(fixture.writes).toEqual([]);
    await input.fill('Retained revised draft');
    await page.evaluate(() => { history.pushState(null, '', '/account'); dispatchEvent(new PopStateEvent('popstate')); });
    await expect(dialog).toBeHidden();
    await page.getByRole('link', { name: locale === 'en' ? 'Access credentials' : '访问凭据', exact: true }).click();
    await expect(input).toHaveValue('Retained revised draft');
    await dialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
    await expect(pencil).toBeFocused();
    expect(fixture.writes).toEqual([]);
    await page.getByRole('region', { name: locale === 'en' ? 'Personal access tokens' : '个人访问令牌' }).getByRole('button', { name: locale === 'en' ? 'Create token' : '创建令牌', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: locale === 'en' ? 'Create personal access token' : '创建个人访问令牌' });
    const optionalDescription = createDialog.getByLabel(locale === 'en' ? /Description/ : /描述/);
    await optionalDescription.fill('Creation draft');
    expect(await optionalDescription.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'first\nsecond');
      return !element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    })).toBe(true);
    await expect(optionalDescription).toHaveValue('Creation draft');
    await expect(createDialog.getByRole('alert')).toBeVisible();
    expect(fixture.writes).toEqual([]);
  });
}


test('an unknown description result survives leaving the account and only an explicit save writes again', async ({ page }) => {
  const fixture = await install(page, 'en', { unknownDescription: true });
  await page.goto('/account?tab=tokens');
  const pencil = page.locator(`[data-credential-description="${tokenId}"]`);
  await pencil.click();
  const dialog = page.getByRole('dialog', { name: 'Edit description', exact: true });
  const input = dialog.getByLabel('Description', { exact: true });
  await input.fill('Unknown result draft');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Read current state', exact: true })).toBeVisible();
  await expect(input).toHaveValue('Unknown result draft');
  expect(fixture.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { history.pushState(null, '', '/projects'); dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page).toHaveURL(/\/projects$/);
  await expect(pencil).toBeHidden();
  await page.goBack();
  await expect(page).toHaveURL(/\/account\?tab=tokens$/);
  await expect(pencil).toBeVisible();
  await pencil.click();
  await expect(input).toHaveValue('Unknown result draft');
  expect(fixture.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Read current state', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('Unknown result draft');
  await expect(dialog.getByText('Unknown result draft', { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  await input.fill('Explicitly saved after review');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(pencil).toBeFocused();
  await expect(pencil.locator('..').locator('.credential-description')).toHaveText('Explicitly saved after review');
  expect(fixture.writes).toHaveLength(2);
});
