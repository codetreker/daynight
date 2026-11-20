import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const personalId = '00000000-0000-4000-8000-000000000701';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-20T09:00:00Z';
const tasks = [
  detailFixture(projectId, id(1), { title: 'Unrestricted example', assignedTo: TEST_VIEWER_ID }),
  detailFixture(projectId, id(2), { title: 'Linux example', assignedTo: TEST_VIEWER_ID, requiredPlatform: 'linux' }),
  detailFixture(projectId, id(3), { title: 'Windows example', assignedTo: TEST_VIEWER_ID, requiredPlatform: 'windows' }),
  detailFixture(projectId, id(4), { title: 'macOS example', assignedTo: TEST_VIEWER_ID, requiredPlatform: 'macos' }),
  detailFixture(projectId, id(5), { title: 'Chain Linux', assignedTo: TEST_VIEWER_ID, requiredPlatform: 'linux' }),
  detailFixture(projectId, id(6), { title: 'Chain Windows', assignedTo: TEST_VIEWER_ID, requiredPlatform: 'windows', dependsOn: [id(5)] }),
];

async function install(page: Page, locale: string) {
  const graph = graphFixture(tasks), epoch = taskSyncEpoch(projectId), writes: string[] = [];
  await page.addInitScript((language) => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/tags`) return send({ items: [], catalogEpoch: epoch, nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: TEST_VIEWER_ID, name: 'Reader', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch, versionForTask: () => 1n }));
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return writes;
}

for (const locale of ['en', 'zh-CN'] as const) test(`platform filter is usable without business writes at 320px in ${locale}`, async ({ page }) => {
  const writes = await install(page, locale);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const platform = page.getByRole('combobox', { name: locale === 'en' ? 'Platform' : '平台' });
  await expect(platform).toHaveValue('all');
  await expect(platform.locator('option')).toHaveText(locale === 'en'
    ? ['All tasks', 'Any platform', 'Linux', 'Windows', 'macOS']
    : ['所有任务', '任何平台', 'Linux', 'Windows', 'macOS']);
  await expect(page.getByText('Linux example', { exact: true })).toBeVisible();
  await platform.focus();
  await page.keyboard.press('ArrowDown');
  await expect(platform).toHaveValue('any');
  await expect(page.getByText('Unrestricted example', { exact: true })).toBeVisible();
  await expect(page.getByText('Linux example', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(platform).toHaveValue('linux');
  await expect(page.getByText('Linux example', { exact: true })).toBeVisible();
  await expect(page.getByText('Windows example', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(platform).toBeFocused();
  const geometry = await platform.evaluate((control) => {
    const bounds = control.getBoundingClientRect();
    const toolbar = control.closest('.task-list-filters')!;
    const controls = [...toolbar.querySelectorAll<HTMLElement>('button, summary, select')].filter(item => item.getClientRects().length > 0 && (item.tagName === 'SUMMARY' || item.closest('details:not([open])') === null));
    const fits = controls.map((item) => {
      const box = item.getBoundingClientRect();
      return { name: item.textContent?.trim(), left: box.left, right: box.right, height: box.height };
    });
    const style = getComputedStyle(control);
    return { width: document.documentElement.scrollWidth, viewport: innerWidth, height: bounds.height, font: style.fontSize, outline: style.outlineColor, outlineStyle: style.outlineStyle, controls: fits };
  });
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.font).toBe('14px');
  expect(geometry.outline).toBe('rgb(52, 64, 84)');
  expect(geometry.outlineStyle).not.toBe('none');
  for (const control of geometry.controls) {
    expect(control.left, control.name).toBeGreaterThanOrEqual(0);
    expect(control.right, control.name).toBeLessThanOrEqual(geometry.viewport);
    expect(control.height, control.name).toBeGreaterThanOrEqual(44);
  }
  await page.locator('#project-task-tab-chains').click();
  await expect(platform).toHaveValue('linux');
  await expect(page.locator('.root-title').filter({ hasText: 'Chain Linux' })).toBeVisible();
  await page.locator('#project-task-tab-goals').click();
  await expect(platform).toHaveCount(0);
  await page.locator('#project-task-tab-standalone').click();
  await expect(platform).toHaveValue('linux');
  expect(writes).toEqual([]);
});

for (const coarse of [false, true]) test(`project filters fit their labels at enlarged and reduced root sizes with ${coarse ? 'coarse' : 'fine'} pointer`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 800 }, hasTouch: coarse });
  try {
    const page = await context.newPage();
    const writes = await install(page, 'en');
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    await page.locator('#project-task-tab-standalone').click();
    expect(await page.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(coarse);
    const platform = page.getByRole('combobox', { name: 'Platform' });
    for (const root of [12, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
      const observed = await platform.evaluate(control => {
        const bounds = control.getBoundingClientRect(), style = getComputedStyle(control);
        const label = control.closest('label')!.querySelector('span')!, labelBounds = label.getBoundingClientRect();
        return { width: document.documentElement.scrollWidth, viewport: innerWidth, height: bounds.height,
          font: style.fontSize, paddingTop: parseFloat(style.paddingTop), labelHeight: labelBounds.height };
      });
      expect(observed.width).toBeLessThanOrEqual(observed.viewport);
      expect(observed.font).toBe(`${coarse ? Math.max(root, 16) : root * .875}px`);
      expect(observed.height).toBeGreaterThanOrEqual(44);
      expect(observed.paddingTop).toBeCloseTo(root * .75 * 1.5, 1);
      expect(observed.height - observed.paddingTop - 2).toBeGreaterThanOrEqual(parseFloat(observed.font) * 1.5);
      expect(observed.paddingTop).toBeGreaterThanOrEqual(observed.labelHeight);
      await expect(platform.locator('option').first()).toHaveCSS('font-size', observed.font);
    }
    expect(writes).toEqual([]);
  } finally { await context.close(); }
});
