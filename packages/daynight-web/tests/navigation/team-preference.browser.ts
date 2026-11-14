import { expect, test, type Page, type Route } from '@playwright/test';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const personalA = '00000000-0000-4000-8000-000000000011';
const personalB = '00000000-0000-4000-8000-000000000012';
const alpha = '00000000-0000-4000-8000-000000000021';
const beta = '00000000-0000-4000-8000-000000000022';
const project = '00000000-0000-4000-8000-000000000031';
const secondProject = '00000000-0000-4000-8000-000000000032';
const sharedProject = '00000000-0000-4000-8000-000000000033';
const task = '00000000-0000-4000-8000-000000000041';
const key = (user: string) => `daynight.selectedTeam:${user}`;
const time = '2026-10-20T09:00:00Z';
const personal = (user: string) => user === alice ? personalA : personalB;
const user = (id: string) => ({ id, personalTeam: { id: personal(id), kind: 'personal', name: null }, name: id === alice ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null });
const team = (id: string, userId: string) => ({ id, kind: 'ordinary', name: id === alpha ? 'Alpha' : 'Beta', version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
const longProjectName = 'Infrastructure 跨团队协作 very-long-project-name-without-spaces '.repeat(5).trim();
const error = { error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } };

type Fixture = { actor: string; detail: 'ok' | '404' | '500' | 'network'; detailReads: string[]; projectQueries: string[]; paginated: boolean; holdDetail: Promise<void> | null; ordinaryName: string | null; projects: 'empty' | 'long' | 'error' | 'scoped'; holdProjects: Promise<void> | null; extraTeams: number; holdList: Promise<void> | null; listReads: number; holdMe: Promise<void> | null; meReads: number; listFailure: boolean; moreFailure: boolean; empty: boolean };
const install = async (page: Page): Promise<Fixture> => {
  const state: Fixture = { actor: alice, detail: 'ok', detailReads: [], projectQueries: [], paginated: false, holdDetail: null, ordinaryName: null, projects: 'empty', holdProjects: null, extraTeams: 0, holdList: null, listReads: 0, holdMe: null, meReads: 0, listFailure: false, moreFailure: false, empty: false };
  const ordinary = (id: string) => ({ ...team(id, state.actor), name: id === alpha && state.ordinaryName !== null ? state.ordinaryName : team(id, state.actor).name });
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'Daynight-User-ID': state.actor };
    const send = async (body: unknown, status = 200) => route.fulfill({ json: body, status, headers });
    if (path === '/api/v1/me') { state.meReads++; await state.holdMe; return send(user(state.actor)); }
    if (path === '/api/v1/teams') {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      state.listReads++;
      await state.holdList;
      if (state.listFailure || (cursor !== null && state.moreFailure)) return send({ error: { code: 'internal_error', message: 'Unavailable', requestId: '00000000-0000-4000-8000-000000000099' } }, 500);
      if (state.empty) return send({ items: [], nextCursor: null });
      const extras = Array.from({ length: state.extraTeams }, (_, index) => ({ ...team(`00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, state.actor), name: `Long Team ${index} ${'协作-very-long-name-'.repeat(8)}` }));
      return send(state.paginated ? cursor === null ? { items: [ordinary(beta)], nextCursor: 'next' } : { items: [ordinary(alpha), ...extras], nextCursor: null } : { items: [ordinary(alpha), ...extras, ordinary(beta)], nextCursor: null });
    }
    if (path === `/api/v1/teams/${alpha}` || path === `/api/v1/teams/${beta}` || path === `/api/v1/teams/${personal(state.actor)}`) {
      state.detailReads.push(path);
      await state.holdDetail;
      if (state.detail === 'network') return route.abort('failed');
      if (state.detail === '404') return send(error, 404);
      if (state.detail === '500') return send({ error: { code: 'internal_error', message: 'Unavailable', requestId: '00000000-0000-4000-8000-000000000099' } }, 500);
      const teamId = path.split('/').at(-1)!;
      return send(teamId === personal(state.actor) ? { ...team(teamId, state.actor), kind: 'personal', name: null } : ordinary(teamId));
    }
    const memberMatch = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(path);
    if (memberMatch) return send({ items: [{ ...team(memberMatch[1]!, state.actor).membership, profile: { name: 'Alice', email: null, avatarUrl: null } }] });
    if (path === '/api/v1/projects') {
      state.projectQueries.push(new URL(route.request().url()).search);
      await state.holdProjects;
      if (state.projects === 'error') return send({ error: { code: 'internal_error', message: 'Unavailable', requestId: '00000000-0000-4000-8000-000000000099' } }, 500);
      const longProject = { id: project, name: longProjectName, repoUrl: 'https://github.com/example/project', createdAt: time, updatedAt: time, ownership: { teamId: personal(state.actor), version: 1 }, settings: { version: 1, executionWarningMinutes: 60 } };
      if (state.projects === 'scoped') {
        const query = new URL(route.request().url()).searchParams;
        if (query.get('shared') === 'true') return send({ items: [{ ...longProject, id: sharedProject, name: 'Shared only' }], nextCursor: null });
        if (query.has('cursor')) return send({ items: [{ ...longProject, id: secondProject, name: 'Team second' }], nextCursor: null });
        return send({ items: [{ ...longProject, name: longProjectName }], nextCursor: 'next' });
      }
      return send({ items: state.projects === 'long' ? [longProject] : [], nextCursor: null });
    }
    return send(error, 404);
  });
  return state;
};
const selected = (page: Page, id: string) => page.evaluate((k) => localStorage.getItem(k), key(id));
const put = (page: Page, id: string, value: string) => page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [key(id), value]);
const openPicker = (page: Page) => page.locator('.team-selector .team-switch').click();
const heading = (page: Page, name: string) => name === 'Team settings' || name === 'Projects shared with me'
  ? page.getByRole('main').getByRole('heading', { name, exact: true })
  : page.locator('.project-list-information').filter({ has: page.getByText(name, { exact: true }) }).getByRole('heading', { name: /^(Projects|项目)$/, exact: true });

for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
  for (const locale of ['en', 'zh-CN']) {
    test(`retains the Team tree on shared navigation at ${viewport.width}px in ${locale}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const api = await install(page); api.projects = 'scoped';
      await page.goto(locale === 'en' ? `/teams/${alpha}` : '/projects');
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const narrow = viewport.width < 600, chinese = locale === 'zh-CN';
      const sidebar = page.locator('.sidebar nav');
      const open = async () => { if (narrow) await page.getByRole('button', { name: chinese ? '展开侧栏' : 'Expand sidebar', exact: true }).click(); };
      await open();
      await expect(sidebar.getByRole('link', { name: longProjectName })).toBeVisible();
      await sidebar.getByRole('button', { name: chinese ? '加载更多' : 'Load more', exact: true }).click();
      await expect(sidebar.getByRole('link', { name: 'Team second' })).toBeVisible();
      const teamQueries = () => api.projectQueries.filter((query) => query.includes('teamId='));
      expect(teamQueries()).toHaveLength(2);
      await sidebar.getByRole('link', { name: chinese ? '与我共享' : 'Shared with me', exact: true }).click();
      await expect(page.getByRole('main').getByRole('heading', { name: 'Shared only' })).toBeVisible();
      await open();
      await expect(sidebar.getByRole('link', { name: longProjectName })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Team second' })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'Shared only' })).toHaveCount(0);
      await expect(sidebar.getByRole('link', { name: chinese ? '与我共享' : 'Shared with me', exact: true })).toHaveAttribute('aria-current', 'page');
      expect(teamQueries()).toHaveLength(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.goBack();
      await expect.poll(() => new URL(page.url()).pathname).toBe(chinese ? '/projects' : `/teams/${alpha}`);
      await page.goForward();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/shared-projects');
      await expect(page.getByRole('main').getByRole('heading', { name: 'Shared only' })).toBeVisible();
      await open();
      await expect(sidebar.getByRole('link', { name: 'Team second' })).toBeVisible();
      expect(teamQueries()).toHaveLength(2);
      await sidebar.getByRole('link', { name: 'Team second' }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${secondProject}`);
      if (narrow) await expect(page.getByRole('dialog', { name: chinese ? '工作空间导航' : 'Workspace navigation' })).toHaveCount(0);
    });
  }
}

for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
  for (const locale of ['en', 'zh-CN']) {
    test(`shows Team empty guidance at ${viewport.width}px in ${locale}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const api = await install(page);
      const name = '跨团队协作 Team — checking a very long workspace name in the project list';
      api.ordinaryName = name;
      await page.goto(`/teams/${alpha}`);
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const chinese = locale === 'zh-CN';
      const detail = page.getByText(chinese ? '在这个 Team 中创建第一个项目，Team 成员都可以访问。' : 'Create the first project in this Team. Team members can access it.', { exact: true });
      const first = page.getByRole('button', { name: chinese ? '创建第一个项目' : 'Create your first project', exact: true });
      await expect(detail).toBeVisible();
      await expect(heading(page, name)).toBeVisible();
      await expect(first).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const titleBox = (await heading(page, name).boundingBox())!;
      const detailBox = (await detail.boundingBox())!;
      const buttonBox = (await first.boundingBox())!;
      for (const box of [titleBox, detailBox, buttonBox]) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
      expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(detailBox.y);
      expect(detailBox.y + detailBox.height).toBeLessThanOrEqual(buttonBox.y);
      await page.screenshot({ path: testInfo.outputPath('team-empty.png'), fullPage: true });
      await first.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(name, { exact: true })).toBeVisible();
      await expect(dialog.getByText(chinese ? '创建到：' : 'Create in:', { exact: false })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('team-create.png'), fullPage: true });
    });
  }
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 500 }, { width: 320, height: 320 }]) {
  for (const locale of ['en-US', 'zh-CN']) {
    test(`keeps a long Team popover reachable at ${viewport.width}x${viewport.height} in ${locale}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const api = await install(page); api.extraTeams = 24;
      await page.goto('/projects');
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale === 'zh-CN' ? 'zh-CN' : 'en');
      const trigger = page.locator('.team-switch');
      const menu = page.locator('.team-options');
      const nav = page.locator('.sidebar nav');
      const navBefore = await nav.boundingBox();
      const sidebarBefore = await page.locator('.sidebar').boundingBox();
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(menu).toBeVisible();
      expect(await nav.boundingBox()).toEqual(navBefore);
      expect(await page.locator('.sidebar').boundingBox()).toEqual(sidebarBefore);
      const assertWithinViewport = async () => {
        const bounds = await menu.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await assertWithinViewport();
      const anchor = await trigger.boundingBox(), initialBox = await menu.boundingBox();
      expect(initialBox!.y >= anchor!.y + anchor!.height || initialBox!.y + initialBox!.height <= anchor!.y).toBe(true);
      const last = menu.getByRole('menuitemradio', { name: /Long Team 23/ });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await assertWithinViewport();
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 30 });
      await expect.poll(async () => { const resized = await menu.boundingBox(); return resized!.y + resized!.height; }).toBeLessThanOrEqual(viewport.height - 30);
      await expect(last).toBeVisible();
      await trigger.click();
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });
  }
}

test('opens directly in collapsed desktop and phone rail, and closes the drawer in layers', async ({ page }) => {
  await install(page); await page.goto('/projects');
  const trigger = page.locator('.team-switch');
  const menu = page.locator('.team-options');
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  const collapsed = await page.locator('.sidebar').boundingBox();
  await trigger.click(); await expect(menu).toBeVisible();
  expect(await page.locator('.sidebar').boundingBox()).toEqual(collapsed);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 390, height: 700 });
  await trigger.click(); await expect(menu).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toHaveCount(0);
  await trigger.click(); await expect(menu).toBeHidden();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  await expect(drawer).toBeVisible();
  await trigger.click(); await expect(menu).toBeVisible();
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden();
  await expect(drawer).toBeVisible(); await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0);
});

test('supports keyboard navigation, dismissal, native links and route changes', async ({ page }) => {
  await install(page); await page.goto('/projects');
  const trigger = page.locator('.team-switch');
  const menu = page.locator('.team-options');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(menu.getByRole('menuitemradio', { name: 'Personal', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const alphaLink = menu.locator(`a[href="/teams/${alpha}"]`);
  await expect(alphaLink).toBeFocused();
  await expect(alphaLink).toHaveAttribute('href', `/teams/${alpha}`);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await page.keyboard.press('Space'); await expect(menu).toBeVisible();
  await page.keyboard.press('Tab'); await expect(menu).toBeHidden();
  await trigger.click(); await expect(menu).toBeVisible();
  await page.mouse.click(1100, 500);
  await expect(menu).toBeHidden();
  await trigger.click();
  await page.getByRole('link', { name: 'Shared with me', exact: true }).evaluate((element: HTMLAnchorElement) => element.click());
  await expect(page).toHaveURL(/\/shared-projects$/);
  await expect(menu).toBeHidden();
});

test('preserves a two-page menu, focus and scroll on a healthy foreground return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  const api = await install(page); api.paginated = true; api.extraTeams = 16;
  await page.goto('/projects');
  await openPicker(page);
  const menu = page.locator('.team-options');
  const continuation = Promise.withResolvers<void>(); api.holdList = continuation.promise;
  await menu.getByRole('menuitem', { name: 'Load more Teams' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Loading Teams' })).toBeDisabled();
  api.holdList = null; continuation.resolve();
  const last = menu.getByRole('menuitemradio', { name: /Long Team 15/ });
  await expect(last).toBeVisible(); await last.focus();
  const before = await menu.evaluate(element => {
    (element as HTMLElement & { marker?: number }).marker = 42;
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(0);
  const meReads = api.meReads, list = Promise.withResolvers<void>();
  api.holdList = list.promise;
  await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); window.dispatchEvent(new Event('blur')); Reflect.deleteProperty(document, 'hasFocus'); window.dispatchEvent(new Event('focus')); });
  const stable = async () => {
    await expect(menu).toBeVisible(); await expect(last).toBeFocused();
    expect(await menu.evaluate(element => [(element as HTMLElement & { marker?: number }).marker, element.scrollTop])).toEqual([42, before]);
  };
  await stable();
  await expect.poll(() => api.listReads).toBe(3);
  expect(api.meReads).toBe(meReads);
  await stable();
  const finalPage = page.waitForResponse(response => response.url().includes('cursor=next'));
  api.holdList = null; list.resolve();
  await (await finalPage).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(api.listReads).toBe(4);
  await stable();
});

test('activates a Team with the keyboard', async ({ page }) => {
  await install(page); await page.goto('/projects');
  const trigger = page.locator('.team-switch');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(page.locator(`.team-options a[href="/teams/${alpha}"]`)).toBeVisible();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/teams/${alpha}$`));
  await expect(heading(page, 'Alpha')).toBeVisible();
  await expect(page.locator('.team-options')).toBeHidden();
});

test('repositions the open menu when the sidebar scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await install(page); await page.goto('/projects'); await openPicker(page);
  const sidebar = page.locator('.sidebar-main'), trigger = page.locator('.team-switch'), menu = page.locator('.team-options');
  const before = await trigger.boundingBox();
  await sidebar.evaluate(element => { element.scrollTop = 25; });
  await expect.poll(() => sidebar.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(async () => (await trigger.boundingBox())!.y).toBeLessThan(before!.y);
  await expect.poll(async () => {
    const anchor = (await trigger.boundingBox())!, box = (await menu.boundingBox())!;
    return Math.min(Math.abs(box.y - (anchor.y + anchor.height + 4)), Math.abs(box.y + box.height - (anchor.y - 4)));
  }).toBeLessThanOrEqual(1);
  const bounds = await menu.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320);
});

test('restores a selected last Team without moving the sidebar on reopen', async ({ page }) => {
  const api = await install(page); api.extraTeams = 24;
  await page.goto('/projects'); await openPicker(page);
  const menu = page.locator('.team-options');
  const betaLink = menu.locator(`a[href="/teams/${beta}"]`);
  await betaLink.scrollIntoViewIfNeeded(); await betaLink.click();
  await expect(heading(page, 'Beta')).toBeVisible();
  const sidebar = page.locator('.sidebar-main');
  const sidebarScroll = await sidebar.evaluate(element => element.scrollTop);
  await openPicker(page);
  await expect(menu.locator(`a[href="/teams/${beta}"]`)).toBeFocused();
  expect(await sidebar.evaluate(element => element.scrollTop)).toBe(sidebarScroll);
  const box = await menu.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
});

test('selects ordinary Teams with identical names by ID', async ({ page }) => {
  const api = await install(page); api.ordinaryName = 'Beta';
  await page.goto('/projects'); await openPicker(page);
  const menu = page.locator('.team-options');
  await expect(menu.getByRole('menuitemradio', { name: 'Beta', exact: true })).toHaveCount(2);
  await menu.locator(`a[href="/teams/${alpha}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/teams/${alpha}$`));
  await openPicker(page);
  await expect(menu.locator(`a[href="/teams/${alpha}"]`)).toHaveAttribute('aria-checked', 'true');
  await menu.locator(`a[href="/teams/${beta}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/teams/${beta}$`));
});

test('preserves the raw Team name in the menu beside its avatar', async ({ page }) => {
  const api = await install(page); api.ordinaryName = '  Alpha\n团队  ';
  await page.goto('/projects'); await openPicker(page);
  const link = page.locator(`.team-options a[href="/teams/${alpha}"]`);
  await expect(link).toBeVisible();
  expect(await link.locator('.menu-name').textContent()).toBe('  Alpha\n团队  ');
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/teams/${alpha}$`));
});

test('opens a modified Team link in a new tab', async ({ page, context }) => {
  await install(page); await page.goto('/projects');
  const baselinePromise = context.waitForEvent('page', { timeout: 5000 });
  await page.locator('a.brand').click({ modifiers: ['ControlOrMeta'] });
  await (await baselinePromise).close();
  await openPicker(page);
  const popupPromise = context.waitForEvent('page', { timeout: 5000 });
  await page.locator(`.team-options a[href="/teams/${alpha}"]`).click({ modifiers: ['ControlOrMeta'] });
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp(`/teams/${alpha}$`));
  expect(new URL(page.url()).pathname).toBe('/projects');
  await popup.close();
});

test('keeps native middle-click and context-menu behavior', async ({ page, context }) => {
  await install(page); await page.goto('/projects'); await openPicker(page);
  const link = page.locator(`.team-options a[href="/teams/${alpha}"]`);
  await link.click({ button: 'right' });
  await expect(page.locator('.team-options')).toBeVisible();
  await page.keyboard.press('Escape');
  await openPicker(page);
  const popupPromise = context.waitForEvent('page', { timeout: 5000 });
  await link.click({ button: 'middle' });
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp(`/teams/${alpha}$`));
  await popup.close();
});

test('recovers initial loading and error into a Personal-only directory and creation', async ({ page }) => {
  const api = await install(page);
  const initial = Promise.withResolvers<void>(); api.holdList = initial.promise; api.listFailure = true;
  await page.goto('/projects'); await openPicker(page);
  const menu = page.locator('.team-options');
  await expect(menu.getByRole('status')).toContainText('Loading Teams');
  await expect(menu.getByRole('menuitemradio', { name: 'Personal' })).toBeVisible();
  api.holdList = null; initial.resolve();
  await expect(menu.getByRole('alert')).toContainText('Unable to load Teams');
  api.listFailure = false; api.empty = true;
  await menu.getByRole('menuitem', { name: 'Retry' }).click();
  await expect(menu.getByRole('alert')).toHaveCount(0);
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
  await menu.getByRole('menuitem', { name: 'Create Team' }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Create Team' })).toBeVisible();
});

test('keeps continuation failure reachable and retries it', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 320 });
  const api = await install(page); api.paginated = true; api.extraTeams = 16; api.moreFailure = true;
  await page.goto('/projects'); await openPicker(page);
  const menu = page.locator('.team-options');
  await menu.getByRole('menuitem', { name: 'Load more Teams' }).click();
  await expect(menu.getByRole('alert')).toBeVisible();
  api.moreFailure = false;
  await menu.getByRole('menuitem', { name: 'Retry' }).click();
  await expect(menu.getByRole('menuitemradio', { name: /Long Team 15/ })).toBeVisible();
  await expect(menu.getByRole('alert')).toHaveCount(0);
});

for (const locale of ['en-US', 'zh-CN'] as const) for (const narrow of [false, true]) {
  test.describe(`${locale} ${narrow ? 'narrow' : 'desktop'} Personal sidebar`, () => {
    test.use({ locale, viewport: narrow ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    test('switches by Team identity and keeps navigation continuous', async ({ page }) => {
      const api = await install(page);
      const chinese = locale === 'zh-CN';
      const members = chinese ? 'Team 成员' : 'Team members';
      const settings = chinese ? '团队设置' : 'Team settings';
      const shared = chinese ? '与我共享' : 'Shared with me';
      const personalLabel = chinese ? '个人' : 'Personal';
      const expand = chinese ? '展开侧栏' : 'Expand sidebar';
      const collapse = chinese ? '折叠侧栏' : 'Collapse sidebar';
      const nav = page.locator('.sidebar nav');
      const assertPersonal = async () => {
        await expect(nav.locator('a').filter({ has: page.locator('span.nav-text') }).filter({ hasText: /^(Team members|Team settings|Team 成员|团队设置)$/ })).toHaveCount(0);
        await expect(nav.getByRole('link', { name: shared, exact: true })).toHaveAttribute('aria-label', shared);
      };
      const open = async () => { if (narrow) await page.getByRole('button', { name: expand, exact: true }).click(); };
      await page.goto('/projects');
      await expect(heading(page, personalLabel)).toBeVisible();
      await open();
      await assertPersonal();
      if (!narrow) {
        await page.getByRole('button', { name: collapse, exact: true }).click();
        await assertPersonal();
        await page.getByRole('button', { name: expand, exact: true }).click();
      }
      for (const name of ['Personal', '个人']) {
        api.ordinaryName = name;
        await openPicker(page);
        await page.locator(`.team-selector a[href="/teams/${alpha}"]`).click();
        await expect(heading(page, name)).toBeVisible();
        await open();
        await expect(nav.getByRole('link', { name: members, exact: true })).toHaveCount(0);
        await expect(nav.getByRole('link', { name: settings, exact: true })).toHaveAttribute('href', `/teams/${alpha}/settings`);
        if (!narrow) {
          await page.getByRole('button', { name: collapse, exact: true }).click();
          await expect(nav.getByRole('link', { name: members, exact: true })).toHaveCount(0);
          await expect(nav.getByRole('link', { name: settings, exact: true })).toBeVisible();
          await page.getByRole('button', { name: expand, exact: true }).click();
        }
        await openPicker(page);
        await page.locator(`.team-selector a[href="/teams/${personalA}"]`).click();
        await expect(heading(page, personalLabel)).toBeVisible();
        await open();
        await assertPersonal();
      }
    });
  });
}

for (const path of [`/projects/${project}`, '/shared-projects', '/workers', '/account']) {
  test(`hides Personal management links on ${path}`, async ({ page }) => {
    await install(page);
    await page.goto(path);
    await expect(page.locator('.team-selector .team-switch')).toContainText('Personal');
    await expect(page.locator('.sidebar nav a[aria-label="Team members"], .sidebar nav a[aria-label="Team settings"]')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(path);
  });
}

test('keeps Personal management links absent throughout project loading, failure, retry and long names', async ({ page }) => {
  const api = await install(page);
  const gate = Promise.withResolvers<void>();
  api.holdProjects = gate.promise;
  api.projects = 'error';
  const sidebar = page.locator('.sidebar nav');
  const absent = async () => {
    await expect(sidebar.locator('a[aria-label="Team members"], a[aria-label="Team settings"]')).toHaveCount(0);
    await expect(sidebar.locator('.sidebar-group').nth(0).locator('.sidebar-projects')).toHaveCount(1);
    const myGroup = sidebar.locator('.sidebar-group').nth(1);
    await expect(myGroup.locator('.nav-label')).toHaveText('My');
    await expect(myGroup.locator('a').first()).toHaveAttribute('aria-label', 'Shared with me');
  };
  try {
    await page.goto('/projects');
    await expect(heading(page, 'Personal')).toBeVisible();
    await expect(sidebar.getByRole('status')).toHaveText('Loading projects');
    await absent();
    gate.resolve(); api.holdProjects = null;
    await expect(sidebar.getByRole('alert')).toContainText('Projects could not be loaded');
    await absent();
    api.projects = 'empty';
    await sidebar.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(sidebar.getByText('No projects yet')).toBeVisible();
    await absent();
    api.projects = 'long';
    await page.getByRole('main').getByRole('button', { name: 'Refresh', exact: true }).click();
    const projectLink = sidebar.getByRole('link', { name: longProjectName, exact: true });
    await expect(projectLink).toHaveAttribute('href', `/projects/${project}`);
    await expect(projectLink).toHaveAttribute('title', longProjectName);
    await absent();
  } finally { gate.resolve(); }
});

test('remembers confirmed Team selection on reload and keeps accounts isolated', async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects');
  await expect(heading(page, 'Personal')).toBeVisible();
  expect(await selected(page, alice)).toBeNull();
  await openPicker(page);
  await page.locator(`a[href="/teams/${alpha}"]`).click();
  await expect(heading(page, 'Alpha')).toBeVisible();
  await expect.poll(() => selected(page, alice)).toBe(alpha);
  await page.goto('/projects');
  await expect(heading(page, 'Alpha')).toBeVisible();
  expect(api.detailReads).toContain(`/api/v1/teams/${alpha}`);
  api.actor = bob;
  await page.goto('/projects');
  await expect(heading(page, 'Personal')).toBeVisible();
  expect(await selected(page, bob)).toBeNull();
  expect(await selected(page, alice)).toBe(alpha);
  await openPicker(page);
  await page.locator(`a[href="/teams/${beta}"]`).click();
  await expect(heading(page, 'Beta')).toBeVisible();
  await expect.poll(() => selected(page, bob)).toBe(beta);
  api.actor = alice;
  await page.goto('/projects');
  await expect(heading(page, 'Alpha')).toBeVisible();
  expect(await selected(page, bob)).toBe(beta);
});

for (const path of [`/projects/${project}`, `/projects/${project}/members`, `/projects/${project}/settings`, '/shared-projects', '/workers', '/account', '/bots', '/test-sessions']) {
  test(`restores the sidebar Team on cold entry and reload at ${path}`, async ({ page }) => {
    const api = await install(page);
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await openPicker(page); await page.locator(`a[href="/teams/${alpha}"]`).click();
    await expect(heading(page, 'Alpha')).toBeVisible();
    api.projectQueries.length = 0;
    await page.goto(path);
    await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
    await page.reload();
    await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
    await expect(page.locator('.sidebar a').filter({ hasText: 'Team members' })).toHaveCount(0);
    await expect(page.locator('.sidebar a').filter({ hasText: 'Team settings' })).toHaveAttribute('href', `/teams/${alpha}/settings`);
    expect(new URL(page.url()).pathname).toBe(path);
    expect(await selected(page, alice)).toBe(alpha);
    expect(api.projectQueries.some((query) => query.includes(`teamId=${personalA}`))).toBe(false);
  });
}

for (const suffix of ['members', 'settings']) {
  test(`explicit Team ${suffix} reload follows the URL ahead of the saved preference`, async ({ page }) => {
    await install(page);
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await put(page, alice, beta);
    await page.goto(`/teams/${alpha}/${suffix}`);
    await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
    await put(page, alice, beta);
    await page.reload();
    await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
    expect(await selected(page, alice)).toBe(alpha);
    await page.goto(`/teams/${personalA}/${suffix}`);
    await expect(page.locator('.team-selector .team-switch')).toContainText('Personal');
    await expect(page.locator('.sidebar nav a[aria-label="Team members"], .sidebar nav a[aria-label="Team settings"]')).toHaveCount(0);
    await expect(heading(page, 'Team settings')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/teams/${personalA}/${suffix}`);
  });
}

test('sidebar restoration leaves shared content available during slow and failed Team reads', async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha);
  const gate = Promise.withResolvers<void>(); api.holdDetail = gate.promise;
  api.projectQueries.length = 0;
  try {
    await page.goto('/shared-projects');
    await expect(heading(page, 'Projects shared with me')).toBeVisible();
    await expect(page.locator('.team-selector .team-switch')).toContainText('Loading Teams');
    await expect.poll(() => api.projectQueries.some((query) => query.includes('shared=true'))).toBe(true);
    await expect(page.locator(`a[href="/teams/${personalA}/members"]`)).toHaveCount(0);
    const settings = page.locator('.sidebar nav').getByRole('link', { name: 'Team settings', exact: true });
    await expect(settings).toHaveAttribute('aria-disabled', 'true');
    await expect(settings).not.toHaveAttribute('href', /./);
    api.detail = '500'; gate.resolve(); api.holdDetail = null;
    const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Retry', exact: true }) });
    await expect(alert).toBeVisible();
    expect(await selected(page, alice)).toBe(alpha);
    await expect(page.locator('.sidebar nav').getByRole('link', { name: 'Team settings', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(heading(page, 'Projects shared with me')).toBeVisible();
    api.detail = 'ok'; await alert.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
    await expect(page.locator('.sidebar nav').getByRole('link', { name: 'Team members', exact: true })).toHaveCount(0);
    await expect(page.locator('.sidebar nav').getByRole('link', { name: 'Team settings', exact: true })).toHaveAttribute('href', `/teams/${alpha}/settings`);
    expect(new URL(page.url()).pathname).toBe('/shared-projects');
  } finally { gate.resolve(); }
});

test('ordinary workspace navigation retains the current Team until explicit default re-entry', async ({ page }) => {
  await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha);
  await page.goto(`/projects/${project}`);
  await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
  await put(page, alice, beta);
  await page.getByRole('link', { name: 'Shared with me', exact: true }).click();
  await expect(heading(page, 'Projects shared with me')).toBeVisible();
  await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
  await page.locator('a.brand').click();
  await expect(heading(page, 'Beta')).toBeVisible();
});

test.describe('Chinese narrow sidebar', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  test('restores the Team and its links after reloading a project page', async ({ page }) => {
    await install(page);
    await page.goto('/projects'); await expect(heading(page, '个人')).toBeVisible();
    await put(page, alice, alpha);
    await page.goto(`/projects/${project}`); await page.reload();
    const control = page.getByRole('button', { name: '切换 Team: 团队, Alpha', exact: true });
    await expect(control).toBeVisible(); await control.click();
    await expect(page.locator('.team-options')).toBeVisible();
    await control.click();
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await expect(page.locator('.team-selector .team-switch')).toContainText('Alpha');
    await expect(page.locator(`.sidebar a[href="/teams/${alpha}/members"]`)).toHaveCount(0);
    await expect(page.locator(`.sidebar a[href="/teams/${alpha}/settings"]`)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/projects/${project}`);
  });
});

test('confirmed 404 clears only the current account and restores Personal', async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha); await put(page, bob, beta);
  api.detail = '404';
  await page.goto('/projects');
  await expect(heading(page, 'Personal')).toBeVisible();
  await expect.poll(() => selected(page, alice)).toBeNull();
  expect(await selected(page, bob)).toBe(beta);
});

for (const failure of ['network', '500'] as const) test(`${failure} failure retains the preference and retry restores the exact Team`, async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha); api.detail = failure;
  await page.goto('/projects');
  const alert = page.getByRole('alert'); await expect(alert).toBeVisible();
  expect(await selected(page, alice)).toBe(alpha);
  api.detail = 'ok';
  await alert.getByRole('button', { name: /retry/i }).click();
  await expect(heading(page, 'Alpha')).toBeVisible();
  expect(await selected(page, alice)).toBe(alpha);
});

test('a saved Team outside the first picker page still restores, and Personal is selectable', async ({ page }) => {
  const api = await install(page); api.paginated = true;
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha);
  await page.goto('/projects'); await expect(heading(page, 'Alpha')).toBeVisible();
  await openPicker(page);
  await expect(page.locator(`.team-selector a[href="/teams/${alpha}"]`)).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Load more Teams' }).click();
  await expect(page.locator(`.team-selector a[href="/teams/${alpha}"]`)).toBeVisible();
  await page.locator(`a[href="/teams/${personalA}"]`).click();
  await expect(heading(page, 'Personal')).toBeVisible();
  await expect.poll(() => selected(page, alice)).toBe(personalA);
  await expect(page.locator('main')).toBeFocused();
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  expect(await selected(page, alice)).toBe(personalA);
  expect(api.detailReads).toContain(`/api/v1/teams/${personalA}`);
});

test('storage read and write failures are visible and recover without changing other account data', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key.startsWith('daynight.selectedTeam:') && (window as unknown as { failTeamRead?: boolean }).failTeamRead) throw new DOMException('read failed', 'SecurityError'); return originalGet.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('daynight.selectedTeam:') && (window as unknown as { failTeamWrite?: boolean }).failTeamWrite) throw new DOMException('write failed', 'QuotaExceededError'); return originalSet.call(this, key, value); };
    (window as unknown as { failTeamRead: boolean; failTeamWrite: boolean }).failTeamRead = true;
  });
  await page.goto('/projects');
  const readAlert = page.getByRole('alert'); await expect(readAlert).toBeVisible();
  await page.evaluate(() => { (window as unknown as { failTeamRead: boolean }).failTeamRead = false; });
  await readAlert.getByRole('button', { name: /retry/i }).click();
  await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, bob, beta);
  await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = true; });
  await openPicker(page); await page.locator(`a[href="/teams/${alpha}"]`).click();
  await expect(heading(page, 'Alpha')).toBeVisible();
  const writeAlert = page.getByRole('alert'); await expect(writeAlert).toBeVisible();
  expect(await selected(page, alice)).toBeNull(); expect(await selected(page, bob)).toBe(beta);
  await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = false; });
  await writeAlert.getByRole('button', { name: /retry/i }).click();
  await expect.poll(() => selected(page, alice)).toBe(alpha);
  expect(await selected(page, bob)).toBe(beta);
});

for (const path of [`/projects/${project}/tasks/${task}`, `/projects/${project}/tasks/${task}/attachments/readme.md`]) {
  test(`explicit resource path ${path} bypasses default restoration`, async ({ page }) => {
    const api = await install(page);
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await put(page, alice, alpha); api.detailReads.length = 0;
    await page.goto(path);
    await expect.poll(() => new URL(page.url()).pathname).toBe(path);
    await expect(page.getByRole('main')).toBeVisible();
    expect(api.detailReads).not.toContain(`/api/v1/teams/${alpha}`);
    expect(await selected(page, alice)).toBe(alpha);
  });
}

for (const path of [`/projects/${project}/tasks/${task}`, `/projects/${project}/tasks/${task}/attachments/readme.md`]) {
  test(`retains an unsaved Team across same-page navigation to ${path}`, async ({ page }) => {
    await install(page);
    await page.addInitScript(() => {
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('daynight.selectedTeam:') && (window as unknown as { failTeamWrite?: boolean }).failTeamWrite) throw new DOMException('write failed', 'QuotaExceededError');
        return originalSet.call(this, key, value);
      };
      (window as unknown as { failTeamWrite: boolean; samePage: string }).failTeamWrite = false;
      (window as unknown as { failTeamWrite: boolean; samePage: string }).samePage = 'original';
    });
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await put(page, bob, beta);
    await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = true; });
    await openPicker(page); await page.locator(`a[href="/teams/${alpha}"]`).click();
    await expect(heading(page, 'Alpha')).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await selected(page, alice)).toBeNull();
    const traverse = async (target: string) => {
      await page.evaluate((url) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate', { state: null })); }, target);
      await expect.poll(() => new URL(page.url()).pathname).toBe(target);
    };
    await traverse(path);
    await expect(page.locator('main.task-detail-page')).toBeVisible();
    await traverse('/projects');
    await expect(heading(page, 'Alpha')).toBeVisible();
    const alert = page.getByRole('alert'); await expect(alert).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { samePage: string }).samePage)).toBe('original');
    expect(await selected(page, alice)).toBeNull(); expect(await selected(page, bob)).toBe(beta);
    await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = false; });
    await alert.getByRole('button', { name: /retry/i }).click();
    await expect.poll(() => selected(page, alice)).toBe(alpha);
    expect(await selected(page, bob)).toBe(beta);
    await expect(alert).toHaveCount(0);
  });
}
