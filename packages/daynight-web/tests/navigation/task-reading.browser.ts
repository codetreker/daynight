import { expectTextContrast, roleColors } from './color-roles';
import type { TaskDetail } from '../../src/api/types';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const successorId = '00000000-0000-4000-8000-000000000042';
const standaloneId = '00000000-0000-4000-8000-000000000043';
const personalId = '00000000-0000-4000-8000-000000000011';
const messageId = '00000000-0000-4000-8000-000000000051';
const time = '2026-10-20T09:00:00Z';
const description = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\nLong task description remains readable.`).join('\n\n');

async function expectChainTimeLayout(header: Locator) {
  const layout = await header.evaluate(element => {
    const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const title = box('.root-title'), meta = box('.chain-summary-meta'), time = box('.chain-completion-time');
    const headerBox = element.getBoundingClientRect();
    const other = ['.root-progress', '.session-status-slot', '.goal-graph-button'].map(box);
    const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    return {
      belowTitle: time.top >= title.bottom - 1,
      inMeta: time.left >= meta.left - 1 && time.right <= meta.right + 1 && time.top >= meta.top - 1 && time.bottom <= meta.bottom + 1,
      alignedLeft: Math.abs(meta.left - title.left) <= 8,
      insideHeader: [title, time, ...other].every(rect => rect.width > 0 && rect.height > 0 && rect.left >= headerBox.left - 1 && rect.right <= headerBox.right + 1 && rect.top >= headerBox.top - 1 && rect.bottom <= headerBox.bottom + 1),
      separate: other.every(rect => separate(time, rect)),
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth,
    };
  });
  expect(layout).toEqual({ belowTitle: true, inMeta: true, alignedLeft: true, insideHeader: true, separate: true, noHorizontalOverflow: true });
}

async function install(page: Page, timing = false, completion = false, title = 'Reading task', variants?: readonly TaskDetail[]) {
  const task = detailFixture(projectId, taskId, { title, description, version: 5n, ...(timing ? { status: 'in_progress' as const, ready: false, allowAgents: true, startedAt: '2026-10-22T09:00:10Z' } : {}), ...(completion ? { status: 'done' as const, ready: false, completedAt: '2026-10-22T09:59:30Z' } : {}) });
  const successor = detailFixture(projectId, successorId, { title: 'Successor', version: 5n, dependsOn: [taskId], blockedBy: completion ? [] : [taskId], ready: false, ...(completion ? { status: 'done' as const, completedAt: '2026-10-22T09:59:50Z' } : {}) });
  const standalone = detailFixture(projectId, standaloneId, { title: 'Running standalone task', version: 5n, status: completion ? 'done' : 'in_progress', ready: false, allowAgents: true, startedAt: '2026-10-22T09:00:10Z', ...(completion ? { completedAt: '2026-10-22T09:59:40Z' } : {}) });
  const details = variants ?? (timing || completion ? [task, successor, standalone] : [task]); const graph = graphFixture(details);
  const message = { id: messageId, author: { userId: TEST_VIEWER_ID, displayName: 'Reader', Agent: false }, body: 'Discussion text', createdAt: '2026-10-20T09:00:00.000Z' };
  const state = { writes: [] as string[], holdSync: null as Promise<void> | null, syncReads: 0 };
  await page.context().route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) { state.syncReads++; if (state.holdSync) await state.holdSync; return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 5n, propertiesForTask: row => details.find(detail => detail.id === row.id)!.properties })); }
    for (const detail of details) {
      const base = `/api/v1/projects/${projectId}/tasks/${detail.id}`;
      if (path === base) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
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

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`completion hints preserve navigation and focus at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page, false, true);
    await page.clock.install({ time: new Date('2055-01-01T00:00:00Z') });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
    const header = page.locator(`[data-chain-id="${taskId}"] > .goal-header`);
    const expand = page.locator(`#task-root-${taskId}`);
    const completionButton = header.getByRole('button', { name: locale === 'en' ? 'View completion time for Reading task' : '查看 Reading task 的完成时间' });
    const completionLabel = completionButton.locator('time[datetime="2026-10-22T09:59:50Z"]');
    await expect(completionLabel).toBeVisible();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expectChainTimeLayout(header);
    if (width === 1280) {
      expect(Math.abs(await header.evaluate(element => element.getBoundingClientRect().height) - 62)).toBeLessThanOrEqual(1);
      expect(Math.abs(await header.locator('..').evaluate(element => element.getBoundingClientRect().height) - 64)).toBeLessThanOrEqual(1);
    }
    await completionButton.focus();
    const tooltip = header.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await completionButton.click();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    const oldButton = await completionButton.elementHandle();
    const oldText = await completionLabel.textContent();
    const gate = Promise.withResolvers<void>(); state.holdSync = gate.promise;
    try {
      await page.clock.fastForward(61_000);
      await expect(completionLabel).not.toHaveText(oldText!);
      await expect(tooltip).toBeVisible();
      await expect(completionButton).toBeFocused();
      expect(await completionButton.evaluate((element, old) => element === old, oldButton)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
      await expect(completionButton).toBeFocused();
      await expect(expand).toHaveAttribute('aria-expanded', 'false');
      await page.mouse.move(0, 0);
      await completionLabel.hover();
      await expect(tooltip).toBeVisible();
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await expand.click();
      await expectChainTimeLayout(header);
      await expect(page.locator(`[data-chain-id="${taskId}"] .goal-children-heading time[datetime="2026-10-22T09:59:30Z"]`)).toBeVisible();
      const member = page.locator(`#chain-task-${taskId}-${successorId}`);
      await expect(member.locator('time[datetime="2026-10-22T09:59:50Z"]')).toBeVisible();
      await member.focus();
      await expect(page.locator(`[data-chain-id="${taskId}"]`).getByRole('tooltip')).toBeVisible();
      await page.keyboard.press('Tab');
      await expect(member).not.toBeFocused();
      await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
      const row = page.locator(`#standalone-task-${standaloneId}`);
      await expect(row.locator('time[datetime="2026-10-22T09:59:40Z"]')).toBeVisible();
      const descriptions = await row.getAttribute('aria-describedby');
      expect(descriptions?.split(/\s+/).length).toBe(2);
      const descriptionText = await row.evaluate(element => (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' '));
      expect(descriptionText).toContain('2026');
      expect(descriptionText).toContain('40');
      await row.click();
      const dialog = page.locator('.task-detail-dialog');
      const metadata = dialog.locator('.task-detail-metadata');
      await expect(metadata.getByText(locale === 'en' ? 'Completion time' : '完成时间', { exact: true })).toBeVisible();
      await expect(metadata.locator('time[datetime="2026-10-22T09:59:40Z"]')).toBeVisible();
      await expect(metadata.locator('time[datetime="2026-10-22T09:59:40Z"]')).toContainText('2026');
      await expect(metadata.locator('time[datetime="2026-10-22T09:59:40Z"]')).toContainText('40');
      expect(await page.locator('button button, button a, a button').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(state.writes).toEqual([]);
    } finally { state.holdSync = null; gate.resolve(); }
  });
}

test('mouse can reach the completion hint above a long chain title near the viewport bottom', async ({ page }) => {
  const title = 'A long chain title that wraps across multiple lines and stays readable while the completion hint remains reachable';
  const state = await install(page, false, true, title);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Task chains' }).click();
  const header = page.locator(`[data-chain-id="${taskId}"] > .goal-header`);
  const label = header.locator('.chain-completion-time time');
  await label.scrollIntoViewIfNeeded();
  await page.evaluate(() => { const rect = document.querySelector('.chain-completion-time')!.getBoundingClientRect(); window.scrollBy(0, rect.bottom - innerHeight + 16); });
  await label.hover();
  const hint = header.getByRole('tooltip');
  await expect(hint).toBeVisible();
  await expect.poll(async () => {
    const labelBox = (await label.boundingBox())!, hintBox = (await hint.boundingBox())!;
    return { above: hintBox.y + hintBox.height <= labelBox.y, reachable: labelBox.y - hintBox.y - hintBox.height <= 18 };
  }).toEqual({ above: true, reachable: true });
  const labelBox = (await label.boundingBox())!, hintBox = (await hint.boundingBox())!;
  expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(labelBox.y);
  expect(labelBox.y - (hintBox.y + hintBox.height)).toBeLessThanOrEqual(18);
  const x = Math.max(labelBox.x, hintBox.x) + 5;
  await page.mouse.move(x, labelBox.y + labelBox.height / 2);
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(x, labelBox.y + labelBox.height / 2 + (hintBox.y + hintBox.height - 2 - labelBox.y - labelBox.height / 2) * step / 8);
    await page.waitForTimeout(10);
  }
  await expect(hint).toBeVisible();
  await expect(page.locator(`#task-root-${taskId}`)).toHaveAttribute('aria-expanded', 'false');
  expect(state.writes).toEqual([]);
});

test.describe('touch completion hints', () => {
  test.use({ hasTouch: true });
  test('tapping chain time does not expand or navigate and outside tap retains its action', async ({ page }) => {
    const state = await install(page, false, true);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: 'Task chains' }).click();
    const header = page.locator(`[data-chain-id="${taskId}"] > .goal-header`);
    const expand = page.locator(`#task-root-${taskId}`);
    await header.getByRole('button', { name: 'View completion time for Reading task' }).tap();
    await expect(header.getByRole('tooltip')).toBeVisible();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expand.tap();
    await expect(header.getByRole('tooltip')).toBeHidden();
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(await page.locator('.task-detail-dialog, .task-chain-dialog').count()).toBe(0);
    expect(state.writes).toEqual([]);
  });
});

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

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`semantic lifecycle roles remain distinct from attention at ${width}px in ${locale}`, async ({ page }) => {
    const statuses = ['proposed', 'todo', 'in_progress', 'done', 'cancelled'] as const;
    const ids = statuses.map((_, index) => `00000000-0000-4000-8000-${String(60 + index).padStart(12, '0')}`);
    const overdueId = '00000000-0000-4000-8000-000000000065', blockedId = '00000000-0000-4000-8000-000000000066';
    const details = statuses.map((status, index) => detailFixture(projectId, ids[index]!, {
      title: `Palette ${status} · 长标题与执行信息 `.repeat(4), version: 5n, status, ready: status === 'todo',
      completedAt: status === 'done' ? '2026-10-22T09:59:50Z' : null,
      cancelledAt: status === 'cancelled' ? '2026-10-22T09:59:55Z' : null,
      properties: { pullRequests: [], ...(status === 'in_progress' ? { paused: true } : {}) },
    }));
    details.push(detailFixture(projectId, overdueId, { title: 'Overdue task', version: 5n, status: 'in_progress', ready: false, allowAgents: true, startedAt: '2026-10-22T08:00:00Z' }));
    details.push(detailFixture(projectId, taskId, { title: 'Proposed chain', version: 5n, status: 'proposed', ready: false, dependsOn: [ids[3]!, overdueId], externalDependsOn: [ids[3]!, overdueId] }));
    details.push(detailFixture(projectId, successorId, { title: 'Proposed successor', version: 5n, status: 'proposed', ready: false, dependsOn: [taskId], blockedBy: [taskId] }));
    details.push(detailFixture(projectId, blockedId, { title: 'Blocked task', version: 5n, dependsOn: [taskId], externalDependsOn: [taskId], ready: false, blockedBy: [taskId] }));
    const state = await install(page, false, false, 'Reading task', details);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    for (const [index, status] of statuses.entries()) {
      const row = page.locator(`#standalone-task-${ids[index]}`);
      await expect(row).toHaveAttribute('data-task-status', status);
      await page.mouse.move(0, 0);
      await expect(row).toHaveCSS('background-color', roleColors[status][0]);
      await expect(row).toHaveCSS('border-top-color', roleColors[status][2]);
      await expect(row).toHaveCSS('opacity', '1');
      await expect(row.locator('.task-agent-permission')).toHaveCSS('color', roleColors.todo[3]);
      await expect(row.locator('.task-agent-permission')).toHaveCSS('background-color', roleColors.todo[0]);
      for (const hover of [false, true]) {
        if (hover) await row.hover();
        await expect(row).toHaveCSS('background-color', roleColors[status][hover ? 1 : 0]);
        for (const selector of ['.root-title', '.root-meta', '.root-status', '.task-agent-permission']) await expectTextContrast(row.locator(selector));
      }
    }
    const overdue = page.locator(`#standalone-task-${overdueId}`), blocked = page.locator(`#standalone-task-${blockedId}`);
    await page.mouse.move(0, 0);
    await expect(overdue).toHaveCSS('background-color', roleColors.attention[0]);
    await expect(overdue.locator('.root-status')).toHaveCSS('color', roleColors.in_progress[3]);
    await expect(overdue.locator('.task-stuck-label')).toBeVisible();
    await expect(blocked).toHaveCSS('background-color', roleColors.todo[0]);
    await expect(blocked.locator('.graph-blocked-badge')).toHaveCSS('color', roleColors.attention[3]);
    await expect(page.locator(`#standalone-task-${ids[2]} .task-paused-badge`)).toHaveCSS('color', roleColors.attention[3]);
    await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
    const chain = page.locator(`[data-chain-id="${taskId}"]`), header = chain.locator('.goal-header');
    await expect(header).toHaveCSS('background-color', roleColors.proposed[0]);
    await expect(header.locator('.root-progress-track i')).toHaveCSS('background-color', roleColors.done[3]);
    await header.locator('[aria-expanded]').click();
    await expect(chain.locator('.goal-task-row')).toHaveCSS('background-color', roleColors.proposed[0]);
    await page.locator(`#task-chain-graph-${taskId}`).click();
    const node = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node`);
    const body = node.locator('.task-node-body');
    await page.mouse.move(0, 0);
    await expect(node).toHaveCSS('background-color', roleColors.proposed[0]);
    await body.click();
    await body.press('Tab'); await page.keyboard.press('Shift+Tab');
    await expect(body).toBeFocused();
    await expect(node).toHaveCSS('outline-color', 'rgb(82, 100, 155)');
    await expect(node).toHaveCSS('outline-width', '2px');
    await expect(body).toHaveCSS('outline-color', 'rgb(52, 64, 84)');
    await expect(body).toHaveCSS('outline-width', '2px');
    await expect(body).toHaveCSS('outline-offset', '-3px');
    for (const selector of ['.task-node-title', '.task-node-meta', '.graph-status']) await expectTextContrast(node.locator(selector));
    await expect(page.locator(`.react-flow__node[data-id="${ids[3]}"] .task-node`)).toHaveCSS('background-color', roleColors.done[0]);
    await expect(page.locator(`.react-flow__node[data-id="${overdueId}"] .task-node`)).toHaveCSS('background-color', roleColors.attention[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(state.writes).toEqual([]);
  });
}
