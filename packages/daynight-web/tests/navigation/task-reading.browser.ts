import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const successorId = '00000000-0000-4000-8000-000000000042';
const standaloneId = '00000000-0000-4000-8000-000000000043';
const personalId = '00000000-0000-4000-8000-000000000011';
const messageId = '00000000-0000-4000-8000-000000000051';
const time = '2026-10-20T09:00:00Z';
const description = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nLong task description remains readable.`).join('\n\n');

async function install(page: Page, timing = false) {
  const task = detailFixture(projectId, taskId, { title: 'Reading task', description, version: 5n, ...(timing ? { status: 'in_progress' as const, ready: false, allowAgents: true, startedAt: '2026-10-22T09:00:10Z' } : {}) });
  const successor = detailFixture(projectId, successorId, { title: 'Successor', version: 5n, dependsOn: [taskId], blockedBy: [taskId], ready: false });
  const standalone = detailFixture(projectId, standaloneId, { title: 'Running standalone task', version: 5n, status: 'in_progress', ready: false, allowAgents: true, startedAt: '2026-10-22T09:00:10Z' });
  const details = timing ? [task, successor, standalone] : [task]; const graph = graphFixture(details);
  const message = { id: messageId, author: { userId: TEST_VIEWER_ID, displayName: 'Reader', Agent: false }, body: 'Discussion text', createdAt: '2026-10-20T09:00:00.000Z' };
  const state = { writes: [] as string[], holdSync: null as Promise<void> | null, syncReads: 0 };
  await page.context().route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) { state.syncReads++; if (state.holdSync) await state.holdSync; return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 5n, propertiesForTask: () => task.properties })); }
    for (const detail of details) {
      const base = `/api/v1/projects/${projectId}/tasks/${detail.id}`;
      if (path === base) return send(detail);
      if (path === `${base}/thread/messages`) return send({ items: url.searchParams.has('afterId') ? [] : [message], hasMoreBefore: false, hasMoreAfter: false });
      if (path === `${base}/sessions` || path === `${base}/attachments`) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390]) {
  test(`execution time advances during a held sync without moving the graph at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page, true);
    await page.clock.install({ time: new Date('2055-01-01T00:00:00Z') });
    await page.setViewportSize({ width, height: 844 }); await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
    await page.locator(`#task-chain-graph-${taskId}`).click();
    const node = page.locator(`.react-flow__node[data-id="${taskId}"]`);
    const duration = node.locator('.task-duration'), details = node.locator('.task-node-details');
    await expect(duration).toBeVisible(); await expect(node.locator('.task-stuck-label')).toHaveCount(0);
    const beforeDuration = await duration.getAttribute('datetime');
    expect(beforeDuration).toMatch(/^PT[0-9.]+S$/);
    await details.focus(); await expect(details).toBeFocused();
    const original = await details.elementHandle(); const before = await node.boundingBox();
    expect(before).not.toBeNull();
    expect(await node.evaluate(element => {
      const card = element.getBoundingClientRect();
      const parts = [...element.querySelectorAll('.task-duration, .task-node-details, .graph-status')].map(part => part.getBoundingClientRect());
      return parts.every(part => part.width > 0 && part.height > 0 && part.left >= card.left - 1 && part.right <= card.right + 1);
    })).toBe(true);
    const gate = Promise.withResolvers<void>(); state.holdSync = gate.promise; const reads = state.syncReads;
    try {
      await page.clock.fastForward(16_000);
      await expect.poll(() => state.syncReads).toBeGreaterThan(reads);
      await expect(node.locator('.task-stuck-label')).toHaveText(locale === 'en' ? 'Possibly stuck' : '可能卡住了');
      const afterDuration = await duration.getAttribute('datetime');
      expect(afterDuration).toMatch(/^PT[0-9.]+S$/);
      expect(Number(afterDuration!.slice(2, -1))).toBeGreaterThan(Number(beforeDuration!.slice(2, -1)));
      await expect(details).toBeFocused(); expect(await details.evaluate((element, old) => element === old, original)).toBe(true);
      expect(await node.boundingBox()).toEqual(before);
      expect(await node.locator('.task-node').evaluate(element => {
        const card = element.getBoundingClientRect(), timing = element.querySelector('.task-duration')!.getBoundingClientRect(), detail = element.querySelector('.task-node-details')!.getBoundingClientRect();
        const decorations = [...element.querySelectorAll('.task-stuck-label, .task-agent-permission')];
        return (element as HTMLElement).offsetWidth === 220 && [96, 136].includes((element as HTMLElement).offsetHeight) && timing.left >= card.left && timing.right <= card.right && timing.top >= card.top && timing.bottom <= card.bottom && (timing.right <= detail.left || timing.bottom <= detail.top || timing.top >= detail.bottom) && decorations.every(item => { const box = item.getBoundingClientRect(); return box.left >= card.left && box.right <= card.right && item.scrollWidth <= item.clientWidth; });
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: locale === 'en' ? 'Close dependency graph' : '关闭依赖图' }).click();
      await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
      const row = page.locator(`#standalone-task-${standaloneId}`);
      await expect(row.locator('.task-stuck-label')).toHaveText(locale === 'en' ? 'Possibly stuck' : '可能卡住了');
      expect(await row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth && [...element.querySelectorAll('.task-duration, .task-stuck-label')].every(item => { const box = item.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom && item.scrollWidth <= item.clientWidth; });
      })).toBe(true);
      expect(state.writes).toEqual([]);
    } finally { state.holdSync = null; gate.resolve(); }
  });
}

test('wide discussion keeps its reading widths and draft in modal, fullscreen and standalone views', async ({ page }) => {
  test.setTimeout(120_000);
  const state = await install(page); await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.setViewportSize({ width: 2560, height: 1100 }); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog'); await dialog.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const modalInput = dialog.locator('.thread-composer textarea'); await modalInput.fill('Modal discussion draft');
  const check = async (target: Page, selector: string, expectedWidth: number, draft: string) => {
    const surface = target.locator(selector), input = surface.locator('.thread-composer textarea');
    await expect(input).toHaveValue(draft); await expect(input).toBeEnabled();
    await expect(surface.locator(`[data-entry-key="${messageId}"] .thread-message-markdown`)).toBeVisible();
    await expect.poll(() => surface.evaluate((element, expected) => {
      const bounds = element.getBoundingClientRect();
      const selectors = ['.thread-bar', '.thread-timeline', '.thread-timeline-content', '.thread-composer-wrap', '.thread-composer-inner', '.thread-composer', '.thread-composer textarea', '.thread-send-button', '.thread-bar button', '.thread-message-markdown'];
      const boxes = selectors.map(selector => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect());
      return boxes.every(box => box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.width > 20 && box.height > 0) && Math.abs(boxes[2]!.width - expected) <= 20 && Math.abs(boxes[4]!.width - expected) <= 20 && boxes[6]!.width > 700 && boxes[9]!.width > 600;
    }, expectedWidth)).toBe(true);
    await expect(input).toBeInViewport({ ratio: 1 }); await expect(surface.locator('.thread-send-button')).toBeInViewport({ ratio: 1 }); await expect(surface.locator('.thread-bar button')).toBeInViewport({ ratio: 1 });
    await input.click(); await expect(input).toBeFocused(); await surface.locator('.thread-bar button').click();
    await expect(input).toHaveValue(draft); await expect(surface.locator('.thread-bar button')).toBeEnabled();
  };
  for (const width of [2560, 3840]) {
    await page.setViewportSize({ width, height: 1100 }); await check(page, '.task-detail-dialog', 900, 'Modal discussion draft');
    await dialog.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
    await check(page, '.task-detail-dialog', 1280, 'Modal discussion draft');
    await dialog.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
    await dialog.getByRole('tab', { name: 'Overview', exact: true }).click(); await dialog.getByRole('tab', { name: 'Discussion', exact: true }).click();
    await expect(modalInput).toHaveValue('Modal discussion draft');
  }
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=discussion`);
  const surface = page.locator('.task-detail-page'), input = surface.locator('.thread-composer textarea'); await input.fill('Standalone discussion draft');
  for (const width of [1440, 2560, 3840]) {
    await page.setViewportSize({ width, height: 1100 }); await check(page, '.task-detail-page', width === 1440 ? 1080 : 1280, 'Standalone discussion draft');
    await surface.getByRole('tab', { name: 'Overview', exact: true }).click(); await surface.getByRole('tab', { name: 'Discussion', exact: true }).click();
    await expect(input).toHaveValue('Standalone discussion draft');
  }
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390]) {
  test(`standalone detail, popup and discussion history retain reading at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page); await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    const dialog = page.locator('.task-detail-dialog');
    await dialog.getByRole('button', { name: locale === 'en' ? 'More task actions' : '更多任务操作' }).click();
    const popout = dialog.getByRole('menuitem', { name: locale === 'en' ? 'Open in new tab' : '在新标签页打开' });
    const [reader] = await Promise.all([page.context().waitForEvent('page'), popout.click()]);
    await expect(reader.locator('.task-detail-page .task-detail-title')).toHaveText('Reading task');
    expect(await reader.evaluate(() => window.opener)).toBeNull();
    const surface = reader.locator('.task-detail-page');
    await expect(surface.locator('.task-detail-header')).toBeInViewport({ ratio: 1 });
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const overview = surface.locator('.task-detail-panel-overview');
    await overview.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await overview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await expect(surface.locator('.task-detail-header')).toBeInViewport({ ratio: 1 });
    await surface.getByRole('tab', { name: locale === 'en' ? 'Discussion' : '讨论', exact: true }).click();
    const input = surface.locator('.thread-composer textarea'); await expect(input).toBeVisible(); await input.fill('Retained draft');
    await expect(surface.locator(`[data-entry-key="${messageId}"]`)).toContainText('Discussion text');
    await expect(input).toBeInViewport({ ratio: 1 });
    expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await surface.getByRole('tab', { name: locale === 'en' ? 'Overview' : '概览', exact: true }).click();
    await reader.goBack(); await expect(input).toHaveValue('Retained draft');
    await input.focus(); await expect(input).toBeFocused();
    expect(state.writes).toEqual([]); await reader.close();
  });
}
