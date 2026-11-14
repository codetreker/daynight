import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
const imageUrl = 'https://avatar.example.test/portrait.png';
const name = 'Alice — Platform Engineering and Infrastructure Collaboration';
const email = 'very.long.member.address.for.layout.verification@example.enterprise.test';

const portrait = async (page: Page) => page.evaluate(() => {
  const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 120;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ce5147'; context.fillRect(0, 0, 80, 60);
  context.fillStyle = '#4869ad'; context.fillRect(0, 60, 80, 60);
  return canvas.toDataURL('image/png');
});

const install = async (page: Page, src: string, png: string) => {
  const requests: string[] = [];
  const personal = { id: personalId, kind: 'personal', name: null };
  const membership = (id: string, team = teamId) => ({ teamId: team, userId: id, role: id === userId ? 'admin' : 'member', version: 1, createdAt: time, updatedAt: time });
  const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : 'Alpha', version: 1, createdAt: time, updatedAt: time, membership: membership(userId, id) });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route(imageUrl, route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png.split(',')[1]!, 'base64') }));
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me') return send({ id: userId, personalTeam: personal, name, email, emailVerified: true, avatarUrl: src });
    if (path === '/api/v1/teams') return send({ items: [team(teamId)], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}` || path === `/api/v1/teams/${personalId}`) return send(team(path.split('/').at(-1)!));
    if (path === `/api/v1/teams/${teamId}/members`) return send({ items: [
      { ...membership(userId), profile: { name, email, avatarUrl: src } },
      { ...membership(memberId), profile: { name: 'Bob', email: 'bob@example.test', avatarUrl: src } },
    ] });
    if (path === `/api/v1/teams/${teamId}/invitations` || path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/tokens') return send({ items: [] });
    if (path === '/api/v2/oauth/grants') return send({ userId, grants: [] });
    if (path === '/api/v1/me/worker-prompt') return send({ scope: 'user', scopeId: userId, revision: '1', text: 'Original prompt', updatedAt: time });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  return requests;
};

const checkAvatar = async (avatar: Locator, src: string, size: number) => {
  const image = avatar.locator('img');
  await expect(image).toBeVisible(); await expect(image).toHaveAttribute('src', src);
  expect(await image.evaluate((img: HTMLImageElement) => [img.complete, img.naturalWidth, img.naturalHeight])).toEqual([true, 80, 120]);
  expect(await avatar.evaluate((el) => {
    const style = getComputedStyle(el), image = el.querySelector('img')!, picture = getComputedStyle(image);
    const rect = el.getBoundingClientRect(), imageRect = image.getBoundingClientRect();
    return { width: rect.width, height: rect.height, radius: style.borderRadius, overflow: style.overflow, imageWidth: imageRect.width, imageHeight: imageRect.height, fit: picture.objectFit, alt: image.alt, hidden: el.getAttribute('aria-hidden') };
  })).toEqual({ width: size, height: size, radius: '50%', overflow: 'hidden', imageWidth: size, imageHeight: size, fit: 'cover', alt: '', hidden: 'true' });
};

for (const width of [1360, 390, 320]) for (const locale of ['en', 'zh-CN']) {
  test(`management avatars decode and preserve account and member layouts at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const png = await portrait(page), src = locale === 'en' ? imageUrl : png;
    const requests = await install(page, src, png);
    await page.goto('/account');
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await checkAvatar(page.locator('.profile-info .management-avatar'), src, 49);
    await expect(page.locator('.profile-info .person-name')).toHaveText(name);
    await expect(page.locator('.profile-info .person-meta')).toHaveText(email);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const tabs = page.getByRole('navigation', { name: locale === 'en' ? 'Account settings' : '账户设置' });
    await tabs.getByRole('button', { name: locale === 'en' ? 'Access credentials' : '访问凭据' }).click();
    await tabs.getByRole('button', { name: locale === 'en' ? 'User prompt' : '用户级 Prompt' }).click();
    await expect(page.locator('.worker-prompt-text')).toHaveValue('Original prompt');
    await tabs.getByRole('button', { name: locale === 'en' ? 'Profile' : '个人资料' }).click();
    await checkAvatar(page.locator('.profile-info .management-avatar'), src, 49);
    await expect(page.getByRole('button', { name: locale === 'en' ? 'Sign out' : '退出登录' })).toBeVisible();

    await page.goto(`/teams/${teamId}/members`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const row = page.locator('.team-member-row').filter({ hasText: 'Bob' });
    await expect(row).toBeVisible(); await checkAvatar(row.locator('.management-avatar'), src, 30);
    const self = page.locator('.team-member-row').filter({ hasText: name });
    await checkAvatar(self.locator('.management-avatar'), src, 30);
    await expect(self.locator('.person-name')).toContainText(locale === 'en' ? 'you' : '你');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await row.getByRole('button', { name: locale === 'en' ? 'Remove' : '移除' }).click();
    const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await checkAvatar(dialog.locator('.management-avatar'), src, 30);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消' }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests.filter(request => !request.startsWith('GET '))).toEqual([]);
  });
}

test('a delayed invalid image keeps the profile size and does not retry on rerender', async ({ page }) => {
  const png = await portrait(page);
  await install(page, imageUrl, png);
  const gate = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route(imageUrl, async route => {
    attempts++;
    await gate.promise;
    await route.fulfill({ contentType: 'image/png', body: 'not an image' });
  });
  try {
    await page.goto('/account');
    const avatar = page.locator('.profile-info .management-avatar');
    await expect.poll(() => attempts).toBeGreaterThan(0);
    await expect(avatar).toHaveText('AL');
    await expect(avatar.locator('img')).toBeHidden();
    expect(await avatar.evaluate(el => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([49, 49]);
    gate.resolve();
    await expect(avatar.locator('img')).toHaveCount(0);
    await expect(avatar).toHaveText('AL');
    expect(await avatar.evaluate(el => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([49, 49]);
    const failedAttempts = attempts;
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
    const tabs = page.getByRole('navigation', { name: '账户设置' });
    await tabs.getByRole('button', { name: '访问凭据' }).click();
    await tabs.getByRole('button', { name: '个人资料' }).click();
    await expect(avatar.locator('img')).toHaveCount(0);
    expect(attempts).toBe(failedAttempts);
  } finally { gate.resolve(); }
});
