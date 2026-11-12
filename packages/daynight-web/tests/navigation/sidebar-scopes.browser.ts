import { expect, test, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
const longName = 'LongTeamNameWithoutAnySpaces'.repeat(12);
const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : longName, version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });

const install = async (page: Page) => {
  let projectReads = 0;
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me') return send({ id: userId, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [team(teamId)], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}` || path === `/api/v1/teams/${personalId}`) return send(team(path.split('/').at(-1)!));
    if (path === '/api/v1/projects') {
      projectReads++;
      return send({ items: Array.from({ length: 28 }, (_, index) => ({ id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, name: `Project ${index} ${'long-project-name-without-spaces'.repeat(4)}`, repoUrl: 'https://github.com/example/project', createdAt: time, updatedAt: time, ownership: { teamId, version: 1 }, settings: { version: 1, executionWarningMinutes: 60 } })), nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  return () => projectReads;
};

for (const width of [320, 390, 768, 1360]) {
  for (const locale of ['en', 'zh-CN']) {
    test(`groups long navigation without overflow at ${width}px in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const reads = await install(page);
      await page.goto(`/teams/${teamId}`);
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const chinese = locale === 'zh-CN';
      await expect(page.getByRole('heading', { name: chinese ? '项目' : 'Projects', exact: true })).toBeVisible();
      const breadcrumb = page.locator('.crumb');
      const eyebrow = page.locator('.project-list-heading .eyebrow');
      await expect(breadcrumb).toContainText(longName);
      await expect(eyebrow).toHaveText(longName);
      for (const element of [breadcrumb, eyebrow]) {
        expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        const box = (await element.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const sidebar = page.locator('.sidebar');
      if (width <= 740) {
        expect((await sidebar.boundingBox())!.width).toBe(60);
        await page.getByRole('button', { name: chinese ? '展开侧栏' : 'Expand sidebar' }).click();
        expect((await sidebar.boundingBox())!.width).toBe(220);
      } else expect((await sidebar.boundingBox())!.width).toBe(190);
      const selector = sidebar.locator('.team-switch');
      await expect(selector).toHaveAttribute('title', new RegExp(chinese ? '团队' : 'Team'));
      await expect(selector).toHaveAttribute('title', new RegExp(longName.trim().slice(0, 20)));
      const geometry = await selector.evaluate(element => {
        const name = element.querySelector<HTMLElement>('.team-switch-name')!;
        const arrow = element.querySelector<HTMLElement>('.team-chevron')!;
        const parent = element.getBoundingClientRect(), arrowBox = arrow.getBoundingClientRect();
        return { truncated: name.scrollWidth > name.clientWidth, arrowRight: arrowBox.right, parentRight: parent.right };
      });
      expect(geometry.truncated).toBe(true);
      expect(geometry.arrowRight).toBeLessThanOrEqual(geometry.parentRight);
      const groups = sidebar.locator('.sidebar-group');
      await expect(groups).toHaveCount(3);
      await expect(groups.nth(0).getByRole('link', { name: chinese ? '项目' : 'Projects', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(groups.nth(1).locator('.nav-label')).toHaveText(chinese ? '我的' : 'My');
      await expect(groups.nth(2).locator('.nav-label')).toHaveText(chinese ? '工具' : 'Tools');
      const main = sidebar.locator('.sidebar-main');
      await expect(sidebar.locator('.sidebar-project-link')).toHaveCount(28);
      const before = reads();
      await groups.nth(2).getByRole('link', { name: chinese ? '测试会话' : 'Test sessions' }).scrollIntoViewIfNeeded();
      expect(await main.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      expect(await main.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await main.evaluate(element => { element.scrollTop = 0; });
      await selector.click();
      await expect(sidebar.locator('.team-options')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(selector).toBeFocused();
      await expect(sidebar.locator('.team-options')).toBeHidden();
      if (width <= 740) {
        await expect(sidebar).toHaveAttribute('role', 'dialog');
        await page.keyboard.press('Escape');
        await expect(sidebar).not.toHaveAttribute('role', 'dialog');
        await expect(page.getByRole('button', { name: chinese ? '展开侧栏' : 'Expand sidebar' })).toBeFocused();
      } else {
        await page.getByRole('button', { name: chinese ? '折叠侧栏' : 'Collapse sidebar' }).click();
        expect((await sidebar.boundingBox())!.width).toBe(68);
        await expect(sidebar.locator('.sidebar-projects')).toBeHidden();
      }
      expect(reads()).toBe(before);
    });
  }
}


test('keeps the long Team breadcrumb link usable on settings at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await install(page);
  await page.goto(`/teams/${teamId}/settings`);
  const breadcrumb = page.locator('.crumb');
  const teamLink = breadcrumb.getByRole('link', { name: longName });
  await expect(teamLink).toHaveAttribute('href', `/teams/${teamId}`);
  await expect(teamLink).toBeVisible();
  expect(await breadcrumb.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
