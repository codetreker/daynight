import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const personalId = '00000000-0000-4000-8000-000000000701';
const tagId = '00000000-0000-4000-8000-000000000061';
const epoch = '00000000-0000-4000-8000-000000000062';
const time = '2026-10-20T09:00:00Z';
const task = detailFixture(projectId, '00000000-0000-4000-8000-000000000041', { title: 'Task' });
const graph = graphFixture([task]);
const tag = { id: tagId, projectId, name: 'Release', version: 3n, createdAt: time, updatedAt: time, usage: { tasks: 4, goals: 2 } };

async function install(page: Page, locale: 'en' | 'zh-CN') {
  const gate = Promise.withResolvers<void>();
  const state = { hold: false, started: false, writes: [] as string[] };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 1n }));
    if (path === `/api/v1/projects/${projectId}/tags` && request.method() === 'GET') {
      if (state.hold) { state.hold = false; state.started = true; await gate.promise; }
      const query = url.searchParams.get('query') ?? '';
      return send({ items: tag.name.toLowerCase().includes(query.toLowerCase()) ? [tag] : [], catalogEpoch: epoch, nextCursor: null });
    }
    if (path === `/api/v1/projects/${projectId}/tags/${tagId}` && request.method() === 'GET') return send(tag);
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return { state, release: gate.resolve };
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1100, 320]) {
  test(`project tags retain draft and focus during background checks (${locale}, ${width}px)`, async ({ page }) => {
    const m = locale === 'en'
      ? { overview: 'Overview', tags: 'Tags', search: 'Search tags', create: 'New tag', name: 'Name', cancel: 'Cancel', rename: 'Rename: Release' }
      : { overview: '概览', tags: '标签', search: '搜索标签', create: '新建标签', name: '名称', cancel: '取消', rename: '重命名: Release' };
    const { state, release } = await install(page, locale);
    try {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/projects/${projectId}`);
      const overview = page.getByRole('tab', { name: m.overview, exact: true });
      const tabs = page.getByRole('tablist', { name: locale === 'en' ? 'Project views' : '项目视图' });
      await overview.focus();
      await page.keyboard.press('End');
      const tagsTab = tabs.getByRole('tab', { name: m.tags, exact: true });
      await expect(tagsTab).toBeFocused(); await expect(tagsTab).toHaveAttribute('aria-selected', 'true');
      expect(await tagsTab.evaluate(element => element.matches(':focus-visible'))).toBe(true);
      await expect(page.getByText('Release', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const search = page.locator('.project-tags-search input');
      await expect(search).toHaveAccessibleName(m.search);
      await search.fill('Rele');
      await expect(page.getByText('Release', { exact: true })).toBeVisible();
      const opener = page.getByRole('button', { name: m.rename, exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog');
      const input = dialog.getByRole('textbox', { name: new RegExp(`^${m.name}`) });
      await expect(input).toBeFocused(); await input.fill('Draft name');
      await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(2, 6));
      state.hold = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => state.started).toBe(true);
      await expect(dialog).toBeVisible(); await expect(input).toHaveValue('Draft name'); await expect(input).toBeFocused();
      expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 6]);
      await expect(search).toHaveValue('Rele');
      await expect(page.locator('.project-tags-list').getByText('Release', { exact: true })).toBeVisible();
      const bounds = await dialog.evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; });
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width);
      release();
      await expect(input).toHaveValue('Draft name'); await expect(input).toBeFocused();
      await page.goBack();
      await expect(overview).toHaveAttribute('aria-selected', 'true');
      await expect(dialog).toBeHidden();
      await page.goForward();
      await expect(tagsTab).toHaveAttribute('aria-selected', 'true');
      await expect(dialog).toBeVisible(); await expect(input).toHaveValue('Draft name');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
      expect(state.writes).toEqual([]);
    } finally { release(); }
  });
}

test('delete preview focuses cancellation and does not write when dismissed', async ({ page }) => {
  const { state, release } = await install(page, 'en');
  try {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: 'Tags', exact: true }).click();
    const opener = page.getByRole('button', { name: 'Delete: Release', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Delete tag?' });
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();
    await expect(dialog.getByText('Release', { exact: true })).toBeVisible();
    await expect(dialog.getByText('4 Tasks · 2 Goals', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Version: 3', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    expect(state.writes).toEqual([]);
  } finally { release(); }
});
