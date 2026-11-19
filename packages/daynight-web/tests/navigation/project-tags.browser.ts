import { expect, test, type Locator, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { expectTagPalette } from '../helpers/tagPalette';

const projectId = '00000000-0000-4000-8000-000000000031';
const personalId = '00000000-0000-4000-8000-000000000701';
const tagId = '00000000-0000-4000-8000-000000000061';
const epoch = '00000000-0000-4000-8000-000000000062';
const time = '2026-10-20T09:00:00Z';
const task = detailFixture(projectId, '00000000-0000-4000-8000-000000000041', { title: 'Task' });
const graph = graphFixture([task]);
const tag = { id: tagId, projectId, name: 'Release', version: 3n, createdAt: time, updatedAt: time, usage: { tasks: 4, goals: 2 } };

async function expectSelectedTabVisible(tabs: Locator) {
  await expect.poll(() => tabs.evaluate(element => {
    const selected = element.querySelector('[aria-selected="true"]')!;
    const container = element.getBoundingClientRect(), tab = selected.getBoundingClientRect();
    return tab.left >= container.left - 1 && tab.right <= container.right + 1;
  })).toBe(true);
}

async function install(page: Page, locale: 'en' | 'zh-CN') {
  const gate = Promise.withResolvers<void>();
  const state = { hold: false, started: false, writes: [] as string[], bodies: [] as unknown[], tags: [{ ...tag }], colors: new Map([[tagId, '#D85656']]) };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.context().route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method()) && !path.endsWith('/tags/colors/resolve')) state.writes.push(`${request.method()} ${path}`);
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
      return send({ items: state.tags.filter(item => item.name.toLowerCase().includes(query.toLowerCase())), catalogEpoch: epoch, nextCursor: null });
    }
    if (path === `/api/v1/projects/${projectId}/tags/colors/resolve`) {
      const body = request.postDataJSON() as { tagIds: string[] };
      return send({ catalogEpoch: epoch, items: body.tagIds.map(id => {
        const found = state.tags.find(item => item.id === id);
        return found ? { id, state: 'found', version: found.version, color: state.colors.get(id) } : { id, state: 'missing' };
      }) });
    }
    if (path === `/api/v1/projects/${projectId}/tags` && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string; color: string }; state.bodies.push(body);
      const created = { ...tag, id: '00000000-0000-4000-8000-000000000063', name: body.name, version: 1n, usage: { tasks: 0, goals: 0 } };
      state.tags.push(created); state.colors.set(created.id, body.color);
      return send(created, 201);
    }
    if (path === `/api/v1/projects/${projectId}/tags/${tagId}` && request.method() === 'GET') return send(state.tags[0]);
    if (path === `/api/v1/projects/${projectId}/tags/${tagId}` && request.method() === 'PATCH') {
      const body = request.postDataJSON() as { name: string; color: string; version: number }; state.bodies.push(body);
      state.tags[0] = { ...state.tags[0]!, name: body.name, version: BigInt(body.version) + 1n };
      state.colors.set(tagId, body.color);
      return send(state.tags[0]);
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return { state, release: gate.resolve };
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1100, 320]) {
  test(`project tags retain draft and focus during background checks (${locale}, ${width}px)`, async ({ page }) => {
    const m = locale === 'en'
      ? { overview: 'Overview', tags: 'Tags', search: 'Search tags', create: 'New tag', name: 'Name', cancel: 'Cancel', rename: 'Edit: Release' }
      : { overview: '概览', tags: '标签', search: '搜索标签', create: '新建标签', name: '名称', cancel: '取消', rename: '编辑: Release' };
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
      await expect(input).toBeEnabled(); await input.focus(); await input.fill('Draft name');
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

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1100, 320]) {
  test(`create and edit tag colors with keyboard and responsive layout (${locale}, ${width}px)`, async ({ page }) => {
    const zh = locale === 'zh-CN';
    const { state, release } = await install(page, locale);
    try {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`/projects/${projectId}`);
      await page.getByRole('tab', { name: zh ? '标签' : 'Tags', exact: true }).click();
      const create = page.getByRole('button', { name: zh ? '新建标签' : 'New tag', exact: true });
      await expect(create).toBeEnabled();
      await create.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      const name = dialog.getByRole('textbox', { name: zh ? '名称' : 'Name', exact: true });
      const hex = dialog.getByRole('textbox', { name: zh ? '十六进制颜色' : 'Hex color' });
      await expect(name).toBeFocused(); await name.fill('Browser color');
      await expect(hex).toHaveValue('#9AA3B2');
      await expectTagPalette(dialog, locale, width);
      await hex.fill('#oops');
      await dialog.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
      await expect(hex).toHaveAttribute('aria-invalid', 'true');
      expect(state.writes).toEqual([]);
      await hex.fill('#12a4cd');
      await expect(dialog.locator('.tag-color-preview .task-tag')).toContainText('Browser color');
      await expect(dialog.locator('.tag-color-preview .task-tag-dot')).toHaveCSS('background-color', 'rgb(18, 164, 205)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(state.bodies).toEqual([{ name: 'Browser color', color: '#12A4CD' }]);
      const created = page.locator('.project-tags-list .task-tag').filter({ hasText: 'Browser color' });
      await expect(created.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(18, 164, 205)');

      await create.focus(); await page.keyboard.press('Enter');
      await expect(hex).toHaveValue('#9AA3B2');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0); await expect(create).toBeFocused();
      expect(state.writes).toHaveLength(1);

      const edit = page.getByRole('button', { name: zh ? '编辑: Release' : 'Edit: Release', exact: true });
      await edit.focus(); await page.keyboard.press('Enter');
      await expect(hex).toHaveValue('#D85656');
      await name.fill('Release changed');
      await expectTagPalette(dialog, locale, width);
      const plum = dialog.getByRole('button', { name: zh ? '梅紫色 #864C94' : 'Plum #864C94' });
      const magenta = dialog.getByRole('button', { name: zh ? '洋红色 #AF377D' : 'Magenta #AF377D' });
      await plum.focus(); await page.keyboard.press('Tab');
      await expect(magenta).toBeFocused(); await page.keyboard.press('Space');
      await expect(magenta).toHaveAttribute('aria-pressed', 'true');
      await expect(magenta.locator('span')).toHaveText('✓');
      expect(await magenta.evaluate(element => element.matches(':focus-visible'))).toBe(true);
      await expect(hex).toHaveValue('#AF377D');
      await expect(dialog.locator('.tag-color-preview .task-tag-dot')).toHaveCSS('background-color', 'rgb(175, 55, 125)');
      await dialog.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(state.bodies).toEqual([{ name: 'Browser color', color: '#12A4CD' }, { version: 3, name: 'Release changed', color: '#AF377D' }]);
      await expect(page.locator('.project-tags-list .task-tag').filter({ hasText: 'Release changed' }).locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(175, 55, 125)');
      const changed = page.getByRole('button', { name: zh ? '编辑: Release changed' : 'Edit: Release changed', exact: true });
      await changed.click(); await expect(hex).toHaveValue('#AF377D');
      await hex.fill('#FFFFFF'); await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0); await expect(changed).toBeFocused();
      expect(state.colors.get(tagId)).toBe('#AF377D'); expect(state.writes).toHaveLength(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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

for (const width of [1280, 390, 320]) {
  test(`project section URLs use real links and browser history (${width}px)`, async ({ page }) => {
    const { state, release } = await install(page, 'en');
    try {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript(id => localStorage.setItem(`daynight:project-section:${id}`, JSON.stringify('tags')), projectId);
      await page.goto(`/projects/${projectId}?tab=overview`);
      const tabs = page.getByRole('tablist', { name: 'Project views' });
      const overview = tabs.getByRole('tab', { name: 'Overview', exact: true });
      const tasks = tabs.getByRole('tab', { name: 'Task list', exact: true });
      const prs = tabs.getByRole('tab', { name: 'PR list', exact: true });
      const tags = tabs.getByRole('tab', { name: 'Tags', exact: true });
      await expect(overview).toHaveAttribute('aria-selected', 'true');
      for (const [tab, name] of [[overview, 'overview'], [tasks, 'tasks'], [prs, 'prs'], [tags, 'tags']] as const)
        await expect(tab).toHaveAttribute('href', `/projects/${projectId}?tab=${name}`);
      const before = await page.evaluate(() => history.length);
      await tasks.click();
      await expect(page).toHaveURL(new RegExp(`\\?tab=tasks$`));
      await expect(tasks).toHaveAttribute('aria-selected', 'true');
      await tasks.click();
      expect(await page.evaluate(() => history.length)).toBe(before + 1);
      await prs.click();
      await expect(page).toHaveURL(new RegExp(`\\?tab=prs$`));
      await page.goBack();
      await expect(tasks).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(new RegExp(`\\?tab=tasks$`));
      await page.goForward();
      await expect(prs).toHaveAttribute('aria-selected', 'true');
      await page.reload();
      await expect(prs).toHaveAttribute('aria-selected', 'true');
      await prs.focus();
      await page.keyboard.press('End');
      await expect(tags).toBeFocused();
      await expect(tags).toHaveAttribute('aria-selected', 'true');
      expect(await tags.evaluate(element => element.matches(':focus-visible'))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(state.writes).toEqual([]);
    } finally { release(); }
  });
}

test('selected project section stays visible on direct entry, reload and history restoration', async ({ page }) => {
  const { release } = await install(page, 'en');
  try {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/projects/${projectId}?tab=tags`);
    const tabs = page.locator('.project-section-tabs');
    const tags = tabs.getByRole('tab', { name: 'Tags', exact: true });
    await expect(tags).toHaveAttribute('aria-selected', 'true');
    await expectSelectedTabVisible(tabs);
    await page.reload();
    await expect(tags).toHaveAttribute('aria-selected', 'true');
    await expectSelectedTabVisible(tabs);
    await tabs.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expectSelectedTabVisible(tabs);
    await page.goBack();
    await expect(tags).toHaveAttribute('aria-selected', 'true');
    await expectSelectedTabVisible(tabs);
    await page.goForward();
    await expect(tabs.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expectSelectedTabVisible(tabs);
    await tabs.getByRole('tab', { name: 'Overview', exact: true }).focus();
    await page.keyboard.press('End');
    await expect(tags).toBeFocused();
    await expect(tags).toHaveAttribute('aria-selected', 'true');
    await expectSelectedTabVisible(tabs);
    await page.keyboard.press('Home');
    await expect(tabs.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
    await expectSelectedTabVisible(tabs);
    await page.keyboard.press('ArrowLeft');
    await expect(tags).toBeFocused();
    await expectSelectedTabVisible(tabs);
  } finally { release(); }
});

test('selected project section follows responsive and translated layouts without stealing focus', async ({ page }) => {
  const { release } = await install(page, 'zh-CN');
  try {
    await page.goto(`/projects/${projectId}?tab=tags`);
    const tabs = page.locator('.project-section-tabs');
    const search = page.locator('.project-tags-search input');
    await search.fill('Release');
    for (const locale of ['zh-CN', 'en']) {
      // A locale subscriber may update while an input owns focus.
      await page.locator('.topbar select').evaluate((element: HTMLSelectElement, value) => {
        element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
      }, locale);
      for (const width of [1360, 768, 741, 740, 739, 481, 480, 479, 390, 375, 320]) {
        await page.setViewportSize({ width, height: 640 });
        await expectSelectedTabVisible(tabs);
        await expect(search).toBeFocused();
        await expect(search).toHaveValue('Release');
        await expect(tabs).toHaveAttribute('aria-orientation', width <= 740 ? 'horizontal' : 'vertical');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width <= 480) {
          const rows = await tabs.locator('[role=tab]').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
          expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
        }
      }
    }
    // Changing text widths at an unchanged narrow viewport also needs correction.
    for (const locale of ['zh-CN', 'en']) {
      await page.locator('.topbar select').evaluate((element: HTMLSelectElement, value) => {
        element.value = value; element.dispatchEvent(new Event('change', { bubbles: true }));
      }, locale);
      await expectSelectedTabVisible(tabs);
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('Release');
    }
    const settled = await tabs.evaluate(element => element.scrollLeft);
    expect(settled).toBeGreaterThan(0);
    await page.setViewportSize({ width: 320, height: 680 });
    await expectSelectedTabVisible(tabs);
    expect(await tabs.evaluate(element => element.scrollLeft)).toBe(settled);
    await tabs.evaluate(element => { element.scrollLeft = 0; });
    // Sample through rendering frames so a scroll-triggered correction cannot hide.
    const manual = await tabs.evaluate(async element => {
      const values = [];
      for (let frame = 0; frame < 5; frame++) {
        await new Promise(requestAnimationFrame); values.push(element.scrollLeft);
      }
      return values;
    });
    expect(manual).toEqual([0, 0, 0, 0, 0]);
    await page.getByRole('button', { name: 'Edit: Release', exact: true }).click();
    const draft = page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true });
    await draft.fill('Unsaved name');
    await page.setViewportSize({ width: 375, height: 640 });
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await page.setViewportSize({ width: 320, height: 640 });
    await expectSelectedTabVisible(tabs);
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue('Unsaved name');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { release(); }
});

test('passive project tab correction preserves the document scroll position', async ({ page }) => {
  const { state, release } = await install(page, 'en');
  state.tags = Array.from({ length: 25 }, (_, index) => ({ ...tag, id: `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`, name: `Release ${index}` }));
  for (const item of state.tags) state.colors.set(item.id, '#D85656');
  try {
    await page.setViewportSize({ width: 321, height: 640 });
    await page.goto(`/projects/${projectId}?tab=tags`);
    await expect(page.locator('.project-tags-list .task-tag')).toHaveCount(25);
    const tabs = page.locator('.project-section-tabs');
    await expectSelectedTabVisible(tabs);
    await tabs.evaluate(element => { element.scrollLeft = 0; });
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(0);
    await page.setViewportSize({ width: 320, height: 640 });
    await expectSelectedTabVisible(tabs);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  } finally { release(); }
});

test('project section links open a new tab without navigating the source', async ({ page }) => {
  const { release } = await install(page, 'en');
  try {
    await page.goto(`/projects/${projectId}?tab=overview`);
    const tags = page.getByRole('tablist', { name: 'Project views' }).getByRole('tab', { name: 'Tags', exact: true });
    const [opened] = await Promise.all([page.context().waitForEvent('page'), tags.click({ modifiers: ['Control'] })]);
    try {
      await expect(opened).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=tags$`));
      await expect(opened.getByRole('tablist', { name: 'Project views' }).getByRole('tab', { name: 'Tags', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page).toHaveURL(new RegExp(`\\?tab=overview$`));
    } finally { await opened.close(); }
  } finally { release(); }
});

test('direct section URLs override preferences and bare entry normalizes without adding history', async ({ page }) => {
  const { release } = await install(page, 'en');
  try {
    await page.addInitScript(id => localStorage.setItem(`daynight:project-section:${id}`, JSON.stringify('tags')), projectId);
    for (const [tab, label] of [['overview', 'Overview'], ['tasks', 'Task list'], ['prs', 'PR list'], ['tags', 'Tags']] as const) {
      await page.goto(`/projects/${projectId}?tab=${tab}`);
      await expect(page.getByRole('tablist', { name: 'Project views' }).getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
    }
    await page.goto(`/projects/${projectId}?other=retained`);
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?other=retained&tab=tags$`));
    await expect(page.getByRole('tablist', { name: 'Project views' }).getByRole('tab', { name: 'Tags', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=tags$`));
    await page.goto(`/projects/${projectId}?tab=tags&tab=tasks`);
    await expect(page.getByRole('tablist', { name: 'Project views' })).toHaveCount(0);
  } finally { release(); }
});
