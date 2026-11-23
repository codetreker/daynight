import { expect, test, type Page } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const personal = { id: teamId, kind: 'personal', name: null };
const time = '2026-10-20T09:00:00Z';
const team = { ...personal, version: 1, createdAt: time, updatedAt: time, membership: { teamId, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } };
const picture = 'https://avatars.example.test/account.svg';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/><rect x="20" width="40" height="40" fill="blue"/></svg>';

async function install(page: Page, avatarUrl: string | null, name: string | null = 'Long Account Name For Truncation', locale = 'en') {
  let meReads = 0;
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me') { meReads++; return send({ id: userId, personalTeam: personal, name, email: null, emailVerified: null, avatarUrl }); }
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  return () => meReads;
}

for (const width of [1360, 390, 320]) {
  test(`account image retains its frame and menu at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const reads = await install(page, picture, 'Long Account Name For Truncation', width === 390 ? 'zh-CN' : 'en');
    const gate = Promise.withResolvers<void>();
    let imageReads = 0;
    await page.route(picture, async route => { imageReads++; await gate.promise; await route.fulfill({ contentType: 'image/svg+xml', body: svg }); });
    try {
      await page.goto('/projects');
      const button = page.locator('.account-button'), avatar = button.locator('.avatar');
      await expect(button).toBeVisible();
      await expect.poll(() => imageReads).toBe(1);
      await expect(avatar).toContainText('L');
      const before = await avatar.boundingBox();
      expect(before?.width).toBe(width <= 600 ? 26 : 30);
      expect(before?.height).toBe(width <= 600 ? 26 : 30);
      gate.resolve();
      const img = avatar.locator('img');
      await expect(img).toHaveAttribute('src', picture);
      await expect.poll(() => img.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(80);
      await expect(img).toBeVisible();
      await expect(img).toHaveCSS('opacity', '1');
      expect(await avatar.boundingBox()).toEqual(before);
      expect(await img.evaluate(element => {
        const style = getComputedStyle(element), parent = getComputedStyle(element.parentElement!);
        return { width: style.width, height: style.height, fit: style.objectFit, radius: parent.borderRadius, overflow: parent.overflow };
      })).toEqual({ width: `${before!.width}px`, height: `${before!.height}px`, fit: 'cover', radius: '50%', overflow: 'hidden' });
      await expect(avatar).toHaveAttribute('aria-hidden', 'true');
      await expect(img).toHaveAttribute('alt', '');
      await button.focus(); await page.keyboard.press('ArrowUp');
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const items = menu.getByRole('menuitem');
      await expect(items.last()).toBeFocused();
      await page.keyboard.press('Home'); await expect(items.first()).toBeFocused();
      await page.keyboard.press('ArrowUp'); await expect(items.last()).toBeFocused();
      await page.keyboard.press('ArrowDown'); await expect(items.first()).toBeFocused();
      await page.keyboard.press('End'); await expect(items.last()).toBeFocused();
      await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(button).toBeFocused();
      await button.click(); await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.mouse.click(width - 10, 890); await expect(menu).toBeHidden();
      expect(imageReads).toBe(1); expect(reads()).toBe(1);
    } finally { gate.resolve(); }
  });
}

test('data URL decodes and hides the initial through a transparent image', async ({ page }) => {
  const transparent = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"/>')}`;
  await install(page, transparent);
  await page.goto('/projects');
  const image = page.locator('.account-button .avatar img');
  await expect(image).toHaveAttribute('src', transparent);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(80);
  await expect(image).toHaveCSS('opacity', '1');
  await expect(page.locator('.account-button .avatar > span')).toBeHidden();
});

for (const source of [null, '', 'https://avatars.example.test/missing.svg']) {
  test(`missing or failed avatar falls back without a broken image (${String(source)})`, async ({ page }) => {
    await install(page, source, null);
    let imageReads = 0;
    page.on('request', request => { if (request.resourceType() === 'image') imageReads++; });
    await page.route('https://avatars.example.test/**', route => route.abort('failed'));
    await page.goto('/projects');
    const button = page.getByRole('button', { name: 'Account menu: Current account' });
    const avatar = button.locator('.avatar');
    await expect(avatar).toHaveText('C');
    await expect(avatar.locator('img')).toHaveCount(0);
    expect(imageReads).toBe(source ? 1 : 0);
    await button.click(); await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(button).toBeFocused();
  });
}
