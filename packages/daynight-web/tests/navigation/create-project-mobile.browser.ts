import { expect, test, type Page } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000201', personalId = '00000000-0000-4000-8000-000000000701', time = '2026-10-20T09:00:00Z';
async function install(page: Page) {
  const state = { writes: 0, meReads: 0, teamReads: 0, teamGate: null as Promise<void> | null, createGate: Promise.withResolvers<void>(), repositoryConflict: false, unknown: false };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ json: body, status, headers: { 'Daynight-User-ID': userId } });
    const error = { error: { code: 'internal_error', message: 'Fixture refusal', requestId: 'fixture-error' } };
    if (path === '/api/v1/me') { state.meReads++; return send({ id: userId, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null }); }
    if (path === '/api/v1/projects' && request.method() === 'POST') { state.writes++; await state.createGate.promise; return state.unknown ? route.abort('failed') : state.repositoryConflict ? send({ error: { code: 'project_repository_conflict', message: 'Fixture refusal', requestId: 'repository-conflict' } }, 409) : send(error, 400); }
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/teams') { state.teamReads++; await state.teamGate; return send({ items: [], nextCursor: null }); }
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    return send(error, 404);
  });
  return state;
}

for (const locale of ['en', 'zh-CN'] as const) test(`unknown project creation shows a base-sized recovery heading in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const state = await install(page); state.unknown = true; state.createGate.resolve();
  await page.goto('/projects');
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
  await page.getByRole('button', { name: locale === 'en' ? '＋ Create project' : '＋ 创建项目', exact: true }).click();
  const dialog = page.locator('dialog.auth-dialog');
  await dialog.getByLabel(locale === 'en' ? 'Project name' : '项目名称').fill('Recovery project');
  await dialog.getByLabel(locale === 'en' ? 'Repository URL' : '仓库地址').fill('https://example.com/team/project');
  await dialog.getByRole('button', { name: locale === 'en' ? 'Create project' : '创建项目', exact: true }).click();
  await dialog.getByRole('button', { name: locale === 'en' ? 'Check projects' : '查看项目' }).click();
  const heading = dialog.getByRole('heading', { name: locale === 'en' ? 'Current projects' : '当前项目' });
  await expect(heading).toBeVisible();
  for (const size of [12, 24]) {
    await page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
    await expect(heading).toHaveCSS('font-size', `${size}px`);
  }
  await expect(dialog.getByText(locale === 'en' ? 'No projects found.' : '未找到项目。')).toBeVisible();
  expect(state.writes).toBe(1);
});

for (const locale of ['en', 'zh-CN'] as const) for (const [width, repositoryConflict] of [[320, false], [390, false], [320, true], [1280, true]] as const) {
  test(`create project retains focus and failed draft at ${width}px in ${locale} (repository conflict: ${repositoryConflict})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); const state = await install(page); state.repositoryConflict = repositoryConflict; await page.goto('/projects');
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const opener = page.getByRole('button', { name: locale === 'en' ? '＋ Create project' : '＋ 创建项目', exact: true });
    await opener.click(); const dialog = page.locator('dialog.auth-dialog'); await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.matches(':modal'))).toBe(true);
    const name = dialog.getByLabel(locale === 'en' ? 'Project name' : '项目名称'), repository = dialog.getByLabel(locale === 'en' ? 'Repository URL' : '仓库地址');
    await expect(name).toBeFocused(); await expect(dialog.locator('select,.locale-preference,.locale-notice')).toHaveCount(0);
    const geometry = await dialog.locator('header').evaluate(element => { const title = element.querySelector('h2')!.getBoundingClientRect(), close = element.querySelector('button')!.getBoundingClientRect(); return { title: { right: title.right, top: title.top, bottom: title.bottom }, close: { left: close.left, right: close.right, top: close.top, bottom: close.bottom }, document: document.documentElement.scrollWidth }; });
    expect(geometry.title.right).toBeLessThanOrEqual(geometry.close.left); expect(geometry.title.top).toBeLessThan(geometry.close.bottom); expect(geometry.close.top).toBeLessThan(geometry.title.bottom); expect(geometry.close.right).toBeLessThanOrEqual(width); expect(geometry.document).toBeLessThanOrEqual(width);
    await page.keyboard.press('Tab'); await expect(repository).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(name).toBeFocused();
    await dialog.getByRole('button', { name: locale === 'en' ? 'Create project' : '创建项目', exact: true }).click();
    await expect(name).toBeFocused(); expect(await name.evaluate((element: HTMLInputElement) => element.validity.valueMissing)).toBe(true);
    const rawName = 'Retained draft ' + 'long '.repeat(24), rawRepo = 'https://example.com/' + 'long-path/'.repeat(20);
    await name.fill(rawName); await repository.fill(rawRepo);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Create project' : '创建项目', exact: true }).click();
    try {
      await expect.poll(() => state.writes).toBe(1); await expect(name).toBeDisabled(); await expect(repository).toBeDisabled();
      await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
      state.createGate.resolve(); await expect(dialog.getByRole('alert')).toContainText(repositoryConflict ? 'repository-conflict' : 'fixture-error');
      await expect(dialog.getByRole('alert')).toContainText(repositoryConflict
        ? locale === 'en' ? 'The target Team already has a project for this repository.' : '目标 Team 已有同一仓库的项目。'
        : locale === 'en' ? 'The project could not be created.' : '项目创建失败');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(name).toHaveValue(rawName); await expect(repository).toHaveValue(rawRepo); expect(state.writes).toBe(1);
      await dialog.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
      await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    } finally { state.createGate.resolve(); }
  });
}

test('same-account Team revalidation preserves the mobile drawer and its focus', async ({ page, context }) => {
  const state = await install(page); await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const opener = page.getByRole('button', { name: 'Open navigation', exact: true }); await opener.click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true }), workspace = page.locator('.workspace');
  const focused = drawer.getByRole('link', { name: 'My Workers', exact: true }); await focused.focus();
  const primary = await context.newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await context.newPage(); await other.goto('about:blank');
  const secondary = await context.newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
  const gate = Promise.withResolvers<void>(); state.teamGate = gate.promise;
  const retained = async () => {
    await expect(drawer).toBeVisible(); await expect(focused).toBeFocused();
    await expect(workspace).toHaveAttribute('inert', ''); await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  };
  try {
    await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    const reads = state.teamReads, meReads = state.meReads;
    await page.bringToFront(); await expect.poll(() => state.teamReads).toBeGreaterThan(reads);
    await retained(); expect(state.meReads).toBe(meReads);
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/teams');
    state.teamGate = null; gate.resolve(); await (await completed).finished();
    await retained(); expect(state.meReads).toBe(meReads); expect(state.writes).toBe(0);
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0); await expect(opener).toBeFocused();
    await expect(workspace).not.toHaveAttribute('inert'); await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  } finally { gate.resolve(); state.createGate.resolve(); await other.close(); }
});

test('modified shared-project link opens a new tab without moving the originating page', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); await install(page);
  await context.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (body: unknown) => route.fulfill({ json: body, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me') return send({ id: userId, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    return send({ items: [], nextCursor: null });
  });
  await page.goto('/projects');
  const link = page.getByRole('link', { name: 'Shared with me', exact: true });
  await expect(link).toHaveAttribute('href', '/shared-projects');
  const opened = context.waitForEvent('page'); await link.click({ modifiers: ['ControlOrMeta'] });
  const other = await opened;
  try {
    await expect(other).toHaveURL(/\/shared-projects$/);
    await expect(other.getByRole('heading', { name: 'Projects shared with me', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/projects$/);
  } finally { await other.close(); }
});
