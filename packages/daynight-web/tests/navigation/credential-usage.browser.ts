import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const tokenId = '00000000-0000-4000-8000-000000000021';
const grantId = '00000000-0000-4000-8000-000000000031';
const createdAt = '2026-10-20T09:00:00Z';
const usedAt = '2026-11-12T11:57:00Z';
const laterUse = '2026-11-12T11:58:00Z';
const expiresAt = '2099-10-20T09:00:00Z';
const tokenName = 'Device-' + 'longname'.repeat(11);
const clientId = 'https://client.example/' + 'long-client-id'.repeat(10);
const resource = 'https://service.example/' + 'long-resource'.repeat(10);
const personal = { id: teamId, kind: 'personal', name: null };
const user = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt, updatedAt: createdAt, membership: { teamId, userId, role: 'admin', version: 1, createdAt, updatedAt: createdAt } };

test.use({ hasTouch: true, timezoneId: 'America/New_York' });

const expectHittableInsideClips = async (control: Locator) => {
  await control.scrollIntoViewIfNeeded();
  const result = await control.evaluate(element => {
    const box = element.getBoundingClientRect();
    let left = 0, right = innerWidth;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible') {
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left + parent.clientLeft);
        right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
      }
    }
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    return { fits: box.left >= left - 1 && box.right <= right + 1, hit: hit !== null && element.contains(hit) };
  });
  expect(result).toEqual({ fits: true, hit: true });
};

const install = async (page: Page, locale: 'en' | 'zh-CN') => {
  let grantUse = usedAt;
  const reads: string[] = [];
  await page.clock.install({ time: new Date('2026-11-12T12:00:00Z') });
  await page.addInitScript(language => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    reads.push(`${request.method()} ${path}`);
    if (path === '/api/v1/me') return send(user);
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/tokens') return send({ items: [
      { id: tokenId, name: tokenName, createdAt, expiresAt, lastUsedAt: usedAt },
      { id: '00000000-0000-4000-8000-000000000022', name: 'Unused token', createdAt, expiresAt: null, lastUsedAt: null },
    ] });
    if (path === '/api/v2/oauth/grants') return send({ userId, grants: [
      { id: grantId, clientName: 'Long client', clientId, resource, scope: 'daynight:mcp', createdAt, expiresAt, lastUsedAt: grantUse, revokedAt: null, status: 'active' },
      { id: '00000000-0000-4000-8000-000000000032', clientName: 'Unused client', clientId: 'https://unused.example', resource: 'https://service.example/mcp', scope: 'daynight:mcp', createdAt, expiresAt, lastUsedAt: null, revokedAt: null, status: 'active' },
    ] });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  return { reads, updateGrantUse: () => { grantUse = laterUse; } };
};

for (const locale of ['en', 'zh-CN'] as const) {
  for (const width of [1440, 390, 320]) {
    test(`credential metadata remains readable and operable in ${locale} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await install(page, locale);
      await page.goto('/account');
      await page.getByRole('button', { name: locale === 'en' ? 'Access credentials' : '访问凭据', exact: true }).click();
      const token = page.locator('.token-row').filter({ hasText: tokenName });
      const grant = page.locator('.grant-row').filter({ hasText: clientId });
      const tokenSummary = token.locator('details > summary');
      const grantSummary = grant.locator('details > summary');
      await expect(tokenSummary).toBeVisible();
      await expect(grantSummary).toBeVisible();
      const noUsage = locale === 'en' ? 'Last used: No usage recorded' : '最后使用: 暂无使用记录';
      await expect(page.getByText(noUsage, { exact: true })).toHaveCount(2);
      await expect(tokenSummary).toContainText(locale === 'en' ? 'About 3 min ago' : '约 3 分钟前');
      const localTime = await page.evaluate(({ language, value }) => new Intl.DateTimeFormat(language, {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(value)), { language: locale, value: usedAt });
      const title = `${locale === 'en' ? 'Recorded time (approximate)' : '记录时间（近似）'}: ${localTime}`;
      await tokenSummary.hover();
      await expect(tokenSummary).toHaveAttribute('title', title);
      await tokenSummary.focus();
      await page.keyboard.press('Enter');
      await expect(token.locator('details')).toHaveAttribute('open', '');
      await expect(token.locator('.full-time')).toHaveText(title);
      await page.keyboard.press('Space');
      await expect(token.locator('details')).not.toHaveAttribute('open', '');
      await grantSummary.scrollIntoViewIfNeeded();
      const box = await grantSummary.boundingBox();
      expect(box).not.toBeNull();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(grant.locator('details')).toHaveAttribute('open', '');
      await expect(grant.locator('.full-time')).toHaveText(title);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await token.locator('.row-detail').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(100);
      await expect(grant.locator('.grant-origin')).toContainText(clientId);
      await expect(grant.locator('.grant-facts')).toContainText(resource);
      for (const row of [token, grant]) {
        expect(await row.evaluate(element => {
          const box = element.getBoundingClientRect(), panel = element.closest('section')!.getBoundingClientRect();
          return box.left >= panel.left - 1 && box.right <= panel.right + 1 && element.scrollWidth <= element.clientWidth + 1;
        })).toBe(true);
        const controls = row.locator('summary, .actions button');
        for (let index = 0; index < await controls.count(); index++) await expectHittableInsideClips(controls.nth(index));
      }
      for (const content of [grant.locator('.grant-origin'), grant.locator('.grant-facts p').first()]) {
        expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      }
    });
  }
}

test('a clock tick and metadata refresh preserve the focused open details and scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const fixture = await install(page, 'en');
  await page.goto('/account');
  await page.getByRole('button', { name: 'Access credentials', exact: true }).click();
  const grant = page.locator('.grant-row').filter({ hasText: clientId });
  const details = grant.locator('details');
  const summary = details.locator('summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(details).toHaveAttribute('open', '');
  await summary.evaluate(element => {
    const target = element as HTMLElement;
    let parent: HTMLElement | null = target.parentElement;
    while (parent && (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight)) parent = parent.parentElement;
    const state = window as unknown as { credentialSummary: Element; credentialScroll: Element; credentialScrollTop: number };
    state.credentialSummary = element;
    state.credentialScroll = parent ?? document.scrollingElement!;
    state.credentialScrollTop = state.credentialScroll.scrollTop;
  });
  expect(await page.evaluate(() => (window as unknown as { credentialScrollTop: number }).credentialScrollTop)).toBeGreaterThan(0);
  const credentialReads = () => fixture.reads.filter(value => value === 'GET /api/v1/me/tokens' || value === 'GET /api/v2/oauth/grants').length;
  const initialReads = credentialReads();
  await page.clock.fastForward(60_000);
  await expect(summary).toContainText('About 4 min ago');
  expect(credentialReads()).toBe(initialReads);
  fixture.updateGrantUse();
  await page.getByRole('button', { name: 'Refresh', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(summary).toContainText('About 3 min ago');
  await expect(details).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
  expect(await summary.evaluate(element => {
    const state = window as unknown as { credentialSummary: Element; credentialScroll: Element; credentialScrollTop: number };
    return element === state.credentialSummary && state.credentialScroll.scrollTop === state.credentialScrollTop;
  })).toBe(true);
  await expect(details.locator('.full-time time')).toHaveAttribute('datetime', laterUse);
});
