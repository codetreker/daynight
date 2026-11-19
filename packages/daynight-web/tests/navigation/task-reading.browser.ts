import { expectTextContrast, roleColors } from './color-roles';
import { expectCopyButtonSkin } from './copy-button-assertions';
import type { TaskDetail } from '../../src/api/types';
import { usageMetricKeys } from '../../src/api/usage';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { unsupportedSessionObservation } from '../../../daynight/src/api/task-observation';
import { TEST_PROFILE_VERSION } from '../helpers/taskSync';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const successorId = '00000000-0000-4000-8000-000000000042';
const standaloneId = '00000000-0000-4000-8000-000000000043';
const personalId = '00000000-0000-4000-8000-000000000011';
const messageId = '00000000-0000-4000-8000-000000000051';
const time = '2026-10-20T09:00:00Z';
const taskRow = (link: Locator) => link.locator('..').locator('..').locator('..');
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

async function install(page: Page, timing = false, completion = false, title = 'Reading task', variants?: readonly TaskDetail[], sessionObservations = false, withAttachment = false) {
  const task = detailFixture(projectId, taskId, { title, description, version: 5n, ...(timing ? { status: 'in_progress' as const, ready: false, allowAgents: true, startedAt: '2026-10-22T09:00:10Z' } : {}), ...(completion ? { status: 'done' as const, ready: false, completedAt: '2026-10-22T09:59:30Z' } : {}) });
  const successor = detailFixture(projectId, successorId, { title: 'Successor', version: 5n, dependsOn: [taskId], blockedBy: completion ? [] : [taskId], ready: false, ...(completion ? { status: 'done' as const, completedAt: '2026-10-22T09:59:50Z' } : {}) });
  const standalone = detailFixture(projectId, standaloneId, { title: 'Running standalone task', version: 5n, status: completion ? 'done' : 'in_progress', ready: false, allowAgents: true, startedAt: '2026-10-22T09:00:10Z', ...(completion ? { completedAt: '2026-10-22T09:59:40Z' } : {}) });
  const details = variants ?? (timing || completion ? [task, successor, standalone] : [task]); const graph = graphFixture(details);
  const message = { id: messageId, author: { userId: TEST_VIEWER_ID, displayName: 'Reader', Agent: false }, body: 'Discussion text', createdAt: '2026-10-20T09:00:00.000Z' };
  const state = { reads: [] as string[], writes: [] as string[], holdSync: null as Promise<void> | null, syncReads: 0 };
  await page.context().route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === 'GET') state.reads.push(path);
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) { state.syncReads++; if (state.holdSync) await state.holdSync; return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 5n, propertiesForTask: row => details.find(detail => detail.id === row.id)!.properties, tagsForTask: row => details.find(detail => detail.id === row.id)!.tags, ...(sessionObservations ? { taskObservations: Object.fromEntries(details.filter(detail => detail.type === 'task' && detail.status === 'in_progress').map(detail => [detail.id, { taskVersion: 5n, state: detail.id === successorId ? 'notice' as const : detail.id.endsWith('061') ? 'warning' as const : 'unavailable' as const, observedAt: graph.observedAt, freshUntil: '2026-10-22T10:00:30Z', needsAttention: detail.id === standaloneId, canOpen: true }])) } : {}) })); }
    for (const detail of details) {
      const base = `/api/v1/projects/${projectId}/tasks/${detail.id}`;
      if (path === base) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
      if (path === `${base}/thread/messages`) return send({ items: url.searchParams.has('afterId') ? [] : [message], hasMoreBefore: false, hasMoreAfter: false });
      if (path === `${base}/steps` && request.method() === 'GET') return send({ projectId, taskId: detail.id, version: detail.version, steps: [] });
      if (path === `${base}/attachments`) return send({ items: withAttachment ? [{ path: 'reading.txt', contentType: 'text/plain', sizeBytes: 4, createdAt: time, updatedAt: time }] : [], nextCursor: null });
      if (path === `${base}/attachments/files/reading.txt`) return route.fulfill({ body: 'text', headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
      if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`copy task overview from dialog, fullscreen and page at ${width}px in ${locale}`, async ({ page, context }) => {
    const state = await install(page, false, true);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
    await page.locator(`#task-chain-graph-${taskId}`).click();
    await page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`).click();
    const dialog = page.locator('.task-detail-dialog');
    const more = locale === 'en' ? 'More task actions' : '更多任务操作';
    const copy = locale === 'en' ? 'Copy link' : '复制链接';
    const copied = locale === 'en' ? 'Link copied' : '已复制链接';
    const target = `${new URL(page.url()).origin}/projects/${projectId}/tasks/${taskId}`;
    const check = async (surface: Locator) => {
      const before = page.url(); const historyLength = await page.evaluate(() => history.length); const trigger = surface.getByRole('button', { name: more });
      await trigger.press('ArrowDown');
      const item = surface.getByRole('menuitem', { name: copy });
      await expect(item).toBeVisible();
      const enabled = surface.locator('[role="menuitem"]:not(:disabled)');
      await page.keyboard.press('End'); await expect(enabled.last()).toBeFocused();
      await page.keyboard.press('Home'); await expect(enabled.first()).toBeFocused();
      await page.keyboard.press('ArrowDown'); await expect(enabled.nth(await enabled.count() > 1 ? 1 : 0)).toBeFocused();
      await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
      await trigger.press('ArrowDown');
      expect(await item.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })).toBe(true);
      await item.focus(); await page.keyboard.press('Enter');
      await expect(trigger).toBeFocused(); await expect(surface.getByText(copied)).toBeVisible();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target);
      expect(page.url()).toBe(before);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    };
    const overview = dialog.locator('.task-detail-panel-overview');
    await overview.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const scroll = await overview.evaluate(element => element.scrollTop); expect(scroll).toBeGreaterThan(0);
    await check(dialog); expect(await overview.evaluate(element => element.scrollTop)).toBe(scroll);
    await dialog.getByRole('tab', { name: locale === 'en' ? 'Discussion' : '讨论', exact: true }).click();
    const draft = dialog.locator('.thread-composer textarea'); await draft.fill('Retained draft');
    await check(dialog); await expect(draft).toHaveValue('Retained draft');
    await dialog.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
    await check(dialog); await expect(draft).toHaveValue('Retained draft');
    await page.goto(`${target}?tab=discussion`);
    const surface = page.locator('.task-detail-page'); await check(surface);
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
    await surface.getByRole('button', { name: more }).click(); await surface.getByRole('menuitem', { name: copy }).click();
    await expect(surface.getByRole('alert')).toContainText(locale === 'en' ? 'Could not copy the link. Try again.' : '无法复制链接，请重试。');
    await page.evaluate(() => { delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText; });
    await check(surface);
    await page.goto(await page.evaluate(() => navigator.clipboard.readText()));
    await expect(page.locator('.task-detail-page .task-detail-title')).toHaveText('Reading task');
    await expect(page.locator('.task-detail-page').getByRole('tab', { name: locale === 'en' ? 'Overview' : '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(state.writes).toEqual([]);
  });
}

test('selected attachment keeps its new-tab target while copy uses overview', async ({ page, context }) => {
  const state = await install(page, false, false, 'Reading task', undefined, false, true);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Standalone tasks' }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog');
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await dialog.getByRole('button', { name: /^reading\.txt/ }).click();
  await dialog.getByRole('button', { name: 'More task actions' }).click();
  const popout = dialog.getByRole('menuitem', { name: 'Open in new tab' });
  await expect(popout).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId}/attachments/reading.txt`);
  const [reader] = await Promise.all([context.waitForEvent('page'), popout.click()]);
  await expect(reader).toHaveURL(new RegExp(`/attachments/reading\\.txt$`));
  await dialog.getByRole('button', { name: 'More task actions' }).click();
  await dialog.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/projects/${projectId}/tasks/${taskId}`);
  expect(state.writes).toEqual([]); await reader.close();
});

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
      const row = taskRow(page.locator(`#standalone-task-${standaloneId}`));
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
      await expect(taskRow(member).locator('time[datetime="2026-10-22T09:59:50Z"]')).toBeVisible();
      await member.focus();
      await expect(member).toHaveAttribute('aria-describedby', /.+/);
      await page.keyboard.press('Tab');
      await expect(member).not.toBeFocused();
      await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
      const row = page.locator(`#standalone-task-${standaloneId}`);
      await expect(taskRow(row).locator('time[datetime="2026-10-22T09:59:40Z"]')).toBeVisible();
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
      title: `Palette ${status} · 长标题与执行信息 `.repeat(4), version: 5n, status, ready: status === 'todo', allowAgents: index % 2 === 0,
      completedAt: status === 'done' ? '2026-10-22T09:59:50Z' : null,
      cancelledAt: status === 'cancelled' ? '2026-10-22T09:59:55Z' : null,
      properties: { pullRequests: [], ...(status === 'in_progress' ? { paused: true } : {}) },
    }));
    details.push(detailFixture(projectId, overdueId, { title: 'Overdue task', version: 5n, status: 'in_progress', ready: false, allowAgents: true, startedAt: '2026-10-22T08:00:00Z' }));
    details.push(detailFixture(projectId, taskId, { title: 'Proposed chain', version: 5n, status: 'proposed', ready: false, allowAgents: true, dependsOn: [ids[3]!, overdueId], externalDependsOn: [ids[3]!, overdueId] }));
    details.push(detailFixture(projectId, successorId, { title: 'Proposed successor', version: 5n, status: 'proposed', ready: false, dependsOn: [taskId], blockedBy: [taskId] }));
    details.push(detailFixture(projectId, blockedId, { title: 'Blocked task', version: 5n, dependsOn: [taskId], externalDependsOn: [taskId], ready: false, blockedBy: [taskId] }));
    const state = await install(page, false, false, 'Reading task', details);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    for (const [index, status] of statuses.entries()) {
      const row = taskRow(page.locator(`#standalone-task-${ids[index]}`));
      await expect(row).toHaveAttribute('data-task-status', status);
      await page.mouse.move(0, 0);
      await expect(row).toHaveCSS('background-color', roleColors[status][0]);
      await expect(row).toHaveCSS('border-top-color', roleColors[status][2]);
      await expect(row).toHaveCSS('opacity', '1');
      const badge = row.locator('.task-agent-permission');
      await expect(badge).toHaveCount(index % 2 === 0 ? 1 : 0);
      if (index % 2 === 0) {
        await expect(badge).toHaveText(locale === 'en' ? 'Automatic execution' : '自动执行');
        await expect(badge).toHaveCSS('color', roleColors.done[3]);
        await expect(badge).toHaveCSS('background-color', roleColors.done[0]);
        await expect(badge).toHaveCSS('border-top-color', roleColors.done[2]);
      }
      for (const hover of [false, true]) {
        if (hover) await row.hover();
        await expect(row).toHaveCSS('background-color', roleColors[status][hover ? 1 : 0]);
        for (const selector of ['.task-row-title', '.task-row-meta', '.root-status']) await expectTextContrast(row.locator(selector));
        if (index % 2 === 0) await expectTextContrast(badge);
      }
    }
    const overdue = taskRow(page.locator(`#standalone-task-${overdueId}`)), blocked = taskRow(page.locator(`#standalone-task-${blockedId}`));
    await page.mouse.move(0, 0);
    await expect(overdue).toHaveCSS('background-color', roleColors.attention[0]);
    await expect(overdue.locator('.root-status')).toHaveCSS('color', roleColors.in_progress[3]);
    await expect(overdue.locator('.task-stuck-label')).toBeVisible();
    await expect(overdue.locator('.task-agent-permission')).toHaveCount(1);
    await expectTextContrast(overdue.locator('.task-agent-permission'));
    await overdue.hover();
    await expectTextContrast(overdue.locator('.task-agent-permission'));
    await expect(blocked).toHaveCSS('background-color', roleColors.todo[0]);
    await expect(blocked.locator('.graph-blocked-badge')).toHaveCSS('color', roleColors.attention[3]);
    await expect(taskRow(page.locator(`#standalone-task-${ids[2]}`)).locator('.task-paused-badge')).toHaveCSS('color', roleColors.attention[3]);
    await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
    const chain = page.locator(`[data-chain-id="${taskId}"]`), header = chain.locator('.goal-header');
    await expect(header).toHaveCSS('background-color', roleColors.proposed[0]);
    await expect(header.locator('.root-progress-track i')).toHaveCSS('background-color', roleColors.done[3]);
    await header.locator('[aria-expanded]').click();
    await expect(chain.locator('.task-row')).toHaveCSS('background-color', roleColors.proposed[0]);
    await page.locator(`#task-chain-graph-${taskId}`).click();
    const node = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node`);
    const body = node.locator('.task-node-body');
    const graphBadge = node.locator('.task-agent-permission');
    await expect(graphBadge).toHaveText(locale === 'en' ? 'Auto' : '自动');
    await expect(graphBadge).toHaveAttribute('aria-label', locale === 'en' ? 'Automatic execution' : '自动执行');
    await expect(graphBadge).toHaveAttribute('title', locale === 'en' ? 'Automatic execution' : '自动执行');
    await expect(graphBadge).toHaveCSS('background-color', roleColors.done[0]);
    await expect(graphBadge).toHaveCSS('border-top-color', roleColors.done[2]);
    await expect(graphBadge).toHaveCSS('color', roleColors.done[3]);
    await expectTextContrast(graphBadge);
    await expect(body).toHaveAccessibleName(new RegExp(locale === 'en' ? 'Automatic execution' : '自动执行'));
    const disabledNode = page.locator(`.react-flow__node[data-id="${successorId}"]`);
    await expect(disabledNode.locator('.task-agent-permission')).toHaveCount(0);
    await expect(disabledNode.locator('.task-node-body')).not.toHaveAccessibleName(new RegExp(locale === 'en' ? 'Automatic execution' : '自动执行'));
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

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) test(`project Session entries remain separate and fit at ${width}px in ${locale}`, async ({ page }) => {
  const goalId = '00000000-0000-4000-8000-000000000060';
  const memberId = '00000000-0000-4000-8000-000000000061';
  const worker = { claimId: '00000000-0000-4000-8000-000000000071', state: 'active' as const, userId: TEST_VIEWER_ID,
    workerId: '00000000-0000-4000-8000-000000000072', worktreeId: '00000000-0000-4000-8000-000000000073',
    machine: { id: '00000000-0000-4000-8000-000000000074', name: 'Long machine name for layout verification' }, platform: 'linux' as const,
    agent: 'codex' as const, agentControlMode: 'web' as const, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
  const running = { version: 5n, status: 'in_progress' as const, ready: false, startedAt: time, properties: { worker } };
  const details = [detailFixture(projectId, taskId, { version: 5n, title: 'Chain root', status: 'done' }),
    detailFixture(projectId, successorId, { ...running, title: 'A long chain member title to check wrapping', dependsOn: [taskId] }),
    detailFixture(projectId, standaloneId, { ...running, properties: { worker, paused: true }, requiredPlatform: 'linux', title: 'A long standalone task title to check wrapping' }),
    detailFixture(projectId, goalId, { version: 5n, type: 'goal', title: 'Goal', status: 'todo' }),
    detailFixture(projectId, memberId, { ...running, parentId: goalId, title: 'A long goal member title to check wrapping' })];
  const state = await install(page, false, false, 'unused', details, true);
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
  await page.locator('#project-section-tab-tasks').click();
  const openLabel = locale === 'en' ? /Open Session/ : /打开 Session/;
  const assertFit = async (item: Locator) => {
    const action = item.getByRole('button', { name: openLabel });
    await expect(action).toBeVisible(); await expectTextContrast(action); await action.focus(); await expect(action).toBeFocused();
    expect(await item.evaluate(element => {
      const a = element.querySelector('.project-session-control')!.getBoundingClientRect();
      const title = element.querySelector('.task-row-title')!.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return a.left >= bounds.left && a.right <= bounds.right && a.top >= bounds.top && a.bottom <= bounds.bottom &&
        (a.left >= title.right || a.top >= title.bottom || a.bottom <= title.top) && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    return action;
  };
  await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
  const standalone = taskRow(page.locator(`#standalone-task-${standaloneId}`));
  await assertFit(standalone);
  const titleWidth = await standalone.locator('.task-row-title').evaluate(element => element.getBoundingClientRect().width);
  expect(titleWidth).toBeGreaterThanOrEqual(width === 320 ? 100 : 240);
  await page.keyboard.press('Enter');
  await expect(page.locator('.task-detail-dialog [role=tab][aria-selected=true]')).toHaveText('Session');
  await expect.poll(() => state.reads).toContain(`/api/v1/projects/${projectId}/tasks/${standaloneId}/sessions/current`);
  await page.keyboard.press('Escape'); await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
  await page.locator(`#task-root-${taskId}`).click();
  const chainToggle = page.locator(`#task-root-${taskId}`);
  const chainAction = await assertFit(taskRow(page.locator(`#chain-task-${taskId}-${successorId}`)));
  await expect(chainAction).toHaveCSS('color', roleColors.attention[3]);
  await page.keyboard.press('Enter');
  await expect(page.locator('.task-detail-dialog [role=tab][aria-selected=true]')).toHaveText('Session');
  await expect.poll(() => state.reads).toContain(`/api/v1/projects/${projectId}/tasks/${successorId}/sessions/current`);
  await expect(chainToggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape'); await expect(chainAction).toBeFocused();
  await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
  await page.getByRole('tab', { name: locale === 'en' ? 'Goals' : 'Goal' }).click();
  const goalToggle = page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`);
  await goalToggle.click();
  const goalAction = await assertFit(page.locator(`[data-goal-id="${goalId}"] .task-row`).first());
  await expect(goalAction).toHaveCSS('color', roleColors.attention[3]);
  await page.keyboard.press('Enter');
  await expect(page.locator('.task-detail-dialog [role=tab][aria-selected=true]')).toHaveText('Session');
  await expect.poll(() => state.reads).toContain(`/api/v1/projects/${projectId}/tasks/${memberId}/sessions/current`);
  await expect(goalToggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape'); await expect(goalAction).toBeFocused();
  await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});


for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 390, 320]) {
  test(`shared row keeps ID selection and clipboard separate from navigation at ${width}px in ${locale}`, async ({ page, context }) => {
    const title = 'A long complete task title 长标题 '.repeat(5);
    await install(page, false, false, title);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    const link = page.locator(`#standalone-task-${taskId}`);
    const row = link.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " task-row ")]');
    const idText = row.locator('.task-row-id');
    const copy = row.getByRole('button', { name: locale === 'en' ? 'Copy task ID' : '复制任务 ID' });
    await expect(link).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId}`);
    await expect(idText).toHaveText(taskId);
    await expect(link).toHaveCSS('font-size', '13px');
    await expect(idText).toHaveCSS('font-size', '11px');
    expect(await row.evaluate(element => {
      const heading = element.querySelector('.task-row-heading')!;
      const title = element.querySelector('.task-row-title')!.getBoundingClientRect();
      const id = element.querySelector('.task-row-id')!.getBoundingClientRect();
      const button = element.querySelector('.task-copy-button')!.getBoundingClientRect();
      const bounds = heading.getBoundingClientRect();
      return [title, id, button].every(box => box.width > 0 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1)
        && element.querySelector('button button, a button, button a, a a') === null && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    await expectCopyButtonSkin(page, copy);
    await copy.focus(); await page.keyboard.press('Enter');
    await expect(row.getByRole('status')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(taskId);
    await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
    const box = await idText.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const rect = range.getClientRects()[0]!; return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    await page.mouse.move(box!.x + 2, box!.y + box!.height / 2); await page.mouse.down();
    await page.mouse.move(box!.x + Math.min(box!.width - 2, 80), box!.y + box!.height / 2, { steps: 6 }); await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected.length).toBeGreaterThan(0);
    await page.keyboard.press('Control+C');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
    await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await link.click();
    await expect(page.locator('.task-detail-dialog')).toBeVisible();
    const dialog = page.locator('.task-detail-dialog');
    await expectCopyButtonSkin(page, dialog.getByRole('button', { name: locale === 'en' ? 'Copy task title' : '复制任务标题' }));
    await expectCopyButtonSkin(page, dialog.getByRole('button', { name: locale === 'en' ? 'Copy task ID' : '复制任务 ID' }));
    await page.keyboard.press('Escape'); await expect(link).toBeFocused();
  });
}

for (const kind of ['chain', 'goal'] as const) test(`shared ${kind} row supports modified links, clipboard failure and independent Session`, async ({ page, context }) => {
  const goalId = '00000000-0000-4000-8000-000000000060';
  const memberId = '00000000-0000-4000-8000-000000000061';
  const worker = { claimId: '00000000-0000-4000-8000-000000000071', state: 'active' as const, userId: TEST_VIEWER_ID,
    workerId: '00000000-0000-4000-8000-000000000072', worktreeId: '00000000-0000-4000-8000-000000000073',
    machine: { id: '00000000-0000-4000-8000-000000000074', name: 'Test host' }, platform: 'linux' as const,
    agent: 'codex' as const, agentControlMode: 'web' as const, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
  const running = { version: 5n, status: 'in_progress' as const, ready: false, startedAt: time, properties: { worker } };
  const details = [detailFixture(projectId, taskId, { version: 5n, title: 'Chain root', status: 'done' }),
    detailFixture(projectId, successorId, { ...running, title: 'Chain member', dependsOn: [taskId] }),
    detailFixture(projectId, goalId, { version: 5n, type: 'goal', title: 'Goal', status: 'todo' }),
    detailFixture(projectId, memberId, { ...running, parentId: goalId, title: 'Goal member' })];
  await install(page, false, false, 'unused', details, true);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: kind === 'chain' ? 'Task chains' : 'Goals' }).click();
  const toggle = kind === 'chain' ? page.locator(`#task-root-${taskId}`) : page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`);
  await toggle.click();
  const id = kind === 'chain' ? successorId : memberId;
  const link = page.locator(kind === 'chain' ? `#chain-task-${taskId}-${id}` : `#chain-task-goal-${goalId}-${id}`);
  const row = link.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " task-row ")]');
  await expect(link).toHaveAttribute('href', `/projects/${projectId}/tasks/${id}`);
  const metaWasHandled = await link.evaluate(element => {
    let prevented = true;
    const observe = (event: Event) => { prevented = event.defaultPrevented; event.preventDefault(); };
    window.addEventListener('click', observe, { once: true });
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    return prevented;
  });
  expect(metaWasHandled).toBe(false);
  const popupPromise = context.waitForEvent('page');
  await link.click({ modifiers: ['Control'] });
  const popup = await popupPromise; await popup.waitForLoadState();
  expect(new URL(popup.url()).pathname).toBe(`/projects/${projectId}/tasks/${id}`);
  await popup.close();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    Object.defineProperty(clipboard, 'writeText', { configurable: true, value: () => { Object.defineProperty(clipboard, 'writeText', { configurable: true, value: original }); return Promise.reject(new Error('denied')); } });
  });
  const copy = row.getByRole('button', { name: 'Copy task ID' });
  await copy.click(); await expect(row.getByRole('alert')).toContainText('Select and copy it manually');
  await expect(row.locator('.task-row-id')).toHaveText(id);
  await copy.click(); await expect(row.getByRole('status')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
  const session = row.getByRole('button', { name: /Open Session/ });
  await session.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.task-detail-dialog [role=tab][aria-selected=true]')).toHaveText('Session');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape'); await expect(session).toBeFocused();
});

for (const allowAgents of [false, true]) test(`equivalent ordinary Tasks share facts across standalone, chain, Goal and personal lists with permission ${allowAgents}`, async ({ page }) => {
  const goalId = '00000000-0000-4000-8000-000000000060';
  const memberId = '00000000-0000-4000-8000-000000000061';
  const common = { version: 5n, status: 'in_progress' as const, ready: false, assignedTo: TEST_VIEWER_ID, requiredPlatform: 'linux' as const, allowAgents };
  const details = [detailFixture(projectId, taskId, { version: 5n, title: 'Completed root', status: 'done' }),
    detailFixture(projectId, standaloneId, { ...common, title: 'Equivalent standalone' }),
    detailFixture(projectId, successorId, { ...common, title: 'Equivalent chain', dependsOn: [taskId] }),
    detailFixture(projectId, goalId, { version: 5n, type: 'goal', title: 'Actual Goal' }),
    detailFixture(projectId, memberId, { ...common, parentId: goalId, title: 'Equivalent Goal member' })];
  await install(page, false, false, 'unused', details);
  const graph = graphFixture(details), running = details.filter(task => task.status === 'in_progress');
  const row = { taskVersion: 5n, state: 'no_session' as const, observedAt: graph.observedAt, freshUntil: '2026-10-22T10:00:30Z', needsAttention: false, canOpen: false };
  await page.route('**/api/v1/projects/*/task-assignees*', route => route.fulfill({ body: stringifyWireJson({ items: [{ userId: TEST_VIEWER_ID, name: 'Reader', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] }), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } }));
  await page.route('**/api/v1/projects/*/task-sync*', route => route.fulfill({ body: stringifyWireJson(taskSyncFixture(graph, { query: taskSyncQuery(new URL(route.request().url())), versionForTask: () => 5n, taskObservations: Object.fromEntries(running.map(task => [task.id, row])) })), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } }));
  await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ body: stringifyWireJson({ observedAt: graph.observedAt, responseTaskAt: graph.observedAt, responseSessionAt: graph.observedAt, inventoryRevision: 'b'.repeat(64), totalTaskCount: 3, totalProjectCount: 1, sessionPartial: false, nextCursor: null,
    items: running.map(task => ({ project: { id: projectId, name: graph.project.name, ownerTeam: directAccessFixture(projectId).ownerTeam, executionWarningMinutes: 60, matchedTaskCount: 3 },
      task: { id: task.id, version: '5', title: task.title, status: 'in_progress', startedAt: null, createdAt: task.createdAt, requiredPlatform: task.requiredPlatform, tags: [], blockedBy: [], ready: false, allowAgents: task.allowAgents, paused: false, worker: null, goal: task.parentId === null ? null : { id: goalId, title: 'Actual Goal' } },
      session: { ...unsupportedSessionObservation(), observation: 'observed', registration: 'not_applicable', reason: 'no_execution', error: null, observedAt: row.observedAt, freshUntil: row.freshUntil }, sessionRow: { ...row, taskVersion: '5' } })) }), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } }));
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  await page.locator('#project-section-tab-tasks').click();
  const facts = async (id: string) => {
    const element = page.locator('.task-row').filter({ has: page.locator(`.task-row-id:text-is("${id}")`) });
    await expect(element.locator('.assignee-name')).toHaveText('Reader');
    await expect(element.locator('.task-agent-permission')).toHaveCount(allowAgents ? 1 : 0);
    if (allowAgents) await expect(element.locator('.task-agent-permission')).toHaveText('Automatic execution');
    return element.evaluate(row => ({ meta: Array.from(row.querySelector('.task-row-meta')!.children).filter(child => !child.matches('.task-row-goal')).map(child => child.textContent), state: row.querySelector('.task-row-status')!.textContent, background: getComputedStyle(row).backgroundColor, titleSize: getComputedStyle(row.querySelector('.task-row-title')!).fontSize, idSize: getComputedStyle(row.querySelector('.task-row-id')!).fontSize }));
  };
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  const expected = await facts(standaloneId);
  await page.getByRole('tab', { name: 'Task chains', exact: true }).click();
  await page.locator(`#task-root-${taskId}`).click();
  expect(await facts(successorId)).toEqual(expected);
  await page.getByRole('tab', { name: 'Goals', exact: true }).click();
  await page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`).click();
  expect(await facts(memberId)).toEqual(expected);
  await expect(page.locator('.task-row-goal')).toHaveCount(0);
  await page.getByRole('link', { name: 'In-progress tasks', exact: true }).click();
  for (const task of running) {
    expect(await facts(task.id)).toEqual(expected);
    await expect(page.getByRole('link', { name: task.title, exact: true })).toHaveAttribute('href', `/projects/${projectId}/tasks/${task.id}`);
  }
  await expect(page.locator('.task-row-goal')).toHaveCount(1);
  await expect(page.locator('.task-row-goal')).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
});


test('project section history protects a real task draft through cancellation and departure', async ({ page }) => {
  const state = await install(page); await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.goto(`/projects/${projectId}?tab=overview`);
  await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
  const overviewIndex = await page.evaluate(() => history.state.__daynightNavigation.index as number);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog');
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = dialog.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await draft.fill('Project task draft');
  await dialog.getByRole('tab', { name: 'Overview', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await expect(draft).toHaveValue('Project task draft');
  await draft.focus();
  const original = await page.evaluate(id => ({ url: location.href, state: JSON.stringify(history.state), length: history.length,
    preference: localStorage.getItem(`daynight:project-section:${id}`), index: history.state.__daynightNavigation.index as number }), projectId);
  expect(original.preference).toBe(JSON.stringify('tasks'));
  const goToOverview = () => page.evaluate(delta => history.go(delta), overviewIndex - original.index);
  await goToOverview();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect.poll(() => page.url()).toBe(original.url);
  await expect(draft).toHaveValue('Project task draft');
  await expect(draft).toBeFocused();
  expect(await draft.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  expect(await page.evaluate(id => ({ state: JSON.stringify(history.state), length: history.length,
    preference: localStorage.getItem(`daynight:project-section:${id}`) }), projectId)).toEqual({ state: original.state, length: original.length, preference: original.preference });
  await goToOverview();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=overview$`));
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(id => localStorage.getItem(`daynight:project-section:${id}`), projectId)).toBe(original.preference);
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`shares an ordinary chain without changing its reading state at ${width}px in ${locale}`, async ({ page, context }) => {
    const state = await install(page, false, true, 'A long chain title '.repeat(8));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}?tab=tasks`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
    await page.locator(`#task-chain-graph-${taskId}`).click();
    const graph = page.locator('.task-chain-dialog');
    const more = locale === 'en' ? 'More task chain actions' : '更多任务链操作';
    const copy = locale === 'en' ? 'Copy link' : '复制链接';
    const target = `${new URL(page.url()).origin}/projects/${projectId}?tab=tasks&chain=${taskId}`;
    const viewport = graph.locator('.react-flow__viewport');
    await expect(viewport).toBeVisible();
    const before = await viewport.getAttribute('style');
    const trigger = graph.getByRole('button', { name: more });
    await trigger.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused(); await expect(graph).toBeVisible();
    await trigger.click(); await graph.getByRole('menuitem', { name: copy }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target);
    await expect(viewport).toHaveAttribute('style', before!);
    await graph.getByRole('button', { name: locale === 'en' ? 'View fullscreen' : '全屏查看' }).click();
    await trigger.click(); await graph.getByRole('menuitem', { name: copy }).click();
    await expect(graph).toHaveClass(/task-chain-dialog-fullscreen/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target);
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
    await trigger.click(); await graph.getByRole('menuitem', { name: copy }).click();
    await expect(graph.getByRole('alert')).toContainText(locale === 'en' ? 'Could not copy the link. Try again.' : '无法复制链接，请重试。');
    await page.evaluate(() => { delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText; });
    await trigger.click(); await graph.getByRole('menuitem', { name: copy }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target);
    const reader = await context.newPage(); await reader.goto(target);
    await expect(reader.locator('.task-chain-dialog .react-flow__node')).toHaveCount(2);
    await expect(reader).toHaveURL(`${new URL(target).origin}/projects/${projectId}?tab=tasks`);
    expect(state.writes).toEqual([]); await reader.close();
  });
}

type RowUsageMode = 'loading' | 'no_data' | 'unknown' | 'unsupported' | 'failed' | 'zero' | 'partial' | 'large';
const rowUsageSummary = (mode: RowUsageMode) => {
  const values: Partial<Record<typeof usageMetricKeys[number], string>> = mode === 'zero' ? { totalTokens: '0' }
    : mode === 'partial' ? { inputTokens: '84', outputTokens: '42' }
      : mode === 'large' ? { totalTokens: '9007199254740993', outputTokens: '42' }
        : mode === 'unknown' ? { cacheReadTokens: '123' } : {};
  return {
    metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: values[key] ?? null, contributingRecords: values[key] === undefined ? '0' : '1', unknownRecords: '0' }])),
    scope: 'registered_web_executions', completeness: mode === 'no_data' ? 'no_data' : mode === 'zero' ? 'complete' : 'partial', reasonCodes: [],
    coverage: { executions: '1', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '0' },
    measurementRecords: mode === 'no_data' ? '0' : '1', lastMeasuredAt: null, observedAt: time, etag: 'row-usage',
  };
};

for (const kind of ['standalone', 'goal'] as const) for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`ordinary ${kind} usage shows only numeric readings at ${width}px in ${locale}`, async ({ page }) => {
    const goalId = '00000000-0000-4000-8000-000000000060';
    const title = (locale === 'en' ? 'A long task title for numeric usage layout ' : '用于检查数字用量布局的很长任务标题').repeat(8);
    const details = [detailFixture(projectId, taskId, { version: 5n, title, ...(kind === 'goal' ? { parentId: goalId } : {}) }),
      ...(kind === 'goal' ? [detailFixture(projectId, goalId, { version: 5n, type: 'goal', title: 'Usage Goal' })] : [])];
    const fixture = await install(page, false, false, title, details);
    const usage = { mode: 'loading' as RowUsageMode, completed: 0, pending: false };
    const gate = Promise.withResolvers<void>();
    const send = (route: Route, body: unknown, status = 200) => route.fulfill({ status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    await page.route('**/api/usage/v1/capabilities', async route => {
      if (usage.mode === 'unsupported') { await route.fulfill({ status: 404, body: 'not found' }); usage.completed++; return; }
      await send(route, { protocol: 'daynight.usage.v1' });
    });
    await page.route('**/api/projects/*/usage/v1/task-summaries', async route => {
      if (usage.mode === 'loading') { usage.pending = true; await gate.promise; }
      const ids = (route.request().postDataJSON() as { taskIds: string[] }).taskIds;
      if (usage.mode === 'failed') await send(route, { error: { code: 'unavailable', requestId: 'row-usage-failure' } }, 503);
      else await send(route, { items: ids.map(taskId => ({ taskId, summary: rowUsageSummary(usage.mode) })) });
      usage.completed++;
    });
    await page.route('**/api/projects/*/tasks/*/usage/v1/records?*', route => send(route, { error: { code: 'unavailable', requestId: 'record-usage-failure' } }, 503));
    await page.clock.install();
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: kind === 'goal' ? locale === 'en' ? 'Goals' : 'Goal' : locale === 'en' ? 'Standalone tasks' : '独立任务', exact: true }).click();
    if (kind === 'goal') await page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`).click();
    const row = page.locator('.task-row').filter({ hasText: title });
    await expect(row.locator('.task-row-title')).toHaveText(title);
    await expect.poll(() => usage.pending).toBe(true);
    const assertEmpty = async () => {
      await expect(row.locator('.task-usage-summary, .usage-error, .task-row-usage-unsupported')).toHaveCount(0);
      expect(await row.locator('.task-row-content').evaluate(element => [...element.children].map(child => child.className))).toEqual(['task-row-heading', 'task-row-meta']);
    };
    const assertLayout = async () => {
      expect(await row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const parts = ['.task-row-title', '.task-row-status', '.task-usage-summary'].flatMap(selector => [...element.querySelectorAll(selector)].map(part => part.getBoundingClientRect()));
        const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
        return parts.every((part, index) => part.width > 0 && part.height > 0 && part.left >= bounds.left - 1 && part.right <= bounds.right + 1 && part.top >= bounds.top - 1 && part.bottom <= bounds.bottom + 1 && parts.slice(index + 1).every(other => separate(part, other))) && document.documentElement.scrollWidth <= innerWidth;
      })).toBe(true);
    };
    const refresh = async (mode: RowUsageMode) => {
      const before = usage.completed; usage.mode = mode;
      await page.clock.fastForward(15_001);
      await expect.poll(() => usage.completed).toBeGreaterThan(before);
    };
    await assertEmpty(); await assertLayout();
    const loadingHeight = await row.evaluate(element => element.getBoundingClientRect().height);
    usage.mode = 'failed'; gate.resolve();
    await expect.poll(() => usage.completed).toBeGreaterThan(0);
    await assertEmpty();
    for (const mode of ['no_data', 'unknown', 'unsupported'] as const) {
      await refresh(mode); await assertEmpty(); await assertLayout();
      expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(loadingHeight, 0);
    }
    await refresh('zero');
    await expect(row.locator('.usage-summary strong')).toHaveText('0');
    await assertLayout();
    await refresh('partial');
    await expect(row.locator('.usage-summary')).toContainText(locale === 'en' ? 'Known Output: 42' : '已知输出: 42');
    await expect(row.locator('.usage-summary')).toContainText(locale === 'en' ? 'Partial' : '部分');
    await assertLayout();
    await refresh('large');
    await expect(row.locator('.usage-summary strong')).toHaveText('9,007,199,254,740,993');
    await assertLayout();
    await refresh('failed');
    await expect(row.locator('.usage-summary strong')).toHaveText('9,007,199,254,740,993');
    await expect(row.locator('.usage-error')).toHaveCount(0);
    const link = row.locator('.usage-summary-link');
    await link.focus(); await expect(link).toBeFocused(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}\\?tab=usage`));
    await expect(page.locator('.usage-panel')).toBeVisible();
    await expect(page.locator('.usage-panel .task-usage-summary .usage-error')).toContainText(locale === 'en' ? 'Usage unavailable' : '用量暂不可用');
    await expect(page.locator('.usage-panel .task-usage-summary').getByRole('button', { name: locale === 'en' ? 'Retry' : '重试', exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`usage detail stays usable in each surface at ${width}px in ${locale}`, async ({ page }) => {
    await install(page);
    const metrics = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'providerTotalTokens'].map(key => [key, '9007199254740993']));
    const summaryMetrics = Object.fromEntries(Object.keys(metrics).filter(key => key !== 'providerTotalTokens').map(key => [key, { known: '9007199254740993', contributingRecords: '1', unknownRecords: '0' }]));
    const summary = { metrics: summaryMetrics, scope: 'registered_web_executions', completeness: 'partial', reasonCodes: [], coverage: { executions: '1', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '0' }, measurementRecords: '1', lastMeasuredAt: time, observedAt: time, etag: 'etag' };
    const requests: string[] = [];
    await page.route('**/api/**/usage/v1/**', async route => {
      const url = new URL(route.request().url()); requests.push(url.pathname + url.search);
      const send = (body: unknown) => route.fulfill({ json: body, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
      if (url.pathname.endsWith('/capabilities')) return send({ protocol: 'daynight.usage.v1' });
      if (url.pathname.endsWith('/task-summaries')) return send({ items: [{ taskId, summary }], observedAt: time, etag: 'batch' });
      if (url.pathname.endsWith('/records')) {
        const kind = url.searchParams.get('kind');
        return send({ items: Array.from({ length: 8 }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, recordKind: kind, sessionId: taskId, stateId: null, executionGeneration: '1', provider: 'provider-with-a-very-long-name', model: 'model-with-a-very-long-name-that-must-wrap-on-narrow-screens', sourceKey: kind === 'measurement' ? 'a-very-long-source-key-that-must-wrap-on-narrow-screens' : null, profileId: 'test-profile', providerVersion: '1', collectionState: 'complete', aggregationRole: 'counted', finality: 'final', disposition: 'active', metrics, reasonCodes: [], observedAt: time, updatedAt: time })), nextCursor: 'next', snapshotToken: 'snapshot', observedAt: time });
      }
      return route.abort();
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    const dialog = page.locator('.task-detail-dialog');
    await dialog.getByRole('tab', { name: locale === 'en' ? 'Usage' : '用量', exact: true }).click();
    const check = async (surface: Locator) => {
      const panel = surface.locator('.task-detail-panel-usage');
      await expect(panel.locator('.usage-record')).toHaveCount(8);
      expect(await panel.evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop > 0 && el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= innerWidth; })).toBe(true);
      expect(await panel.locator('.usage-filters').evaluate((el, narrow) => {
        const fields = [...el.querySelectorAll<HTMLElement>('label')];
        const controls = [...el.querySelectorAll<HTMLElement>('input, select, button')];
        const boxes = fields.map(field => field.getBoundingClientRect());
        return narrow ? controls.every(control => control.getBoundingClientRect().height >= 44) : boxes.every(box => Math.abs(box.bottom - boxes[0]!.bottom) < 2);
      }, width === 320)).toBe(true);
      await expect(panel.getByRole('button', { name: locale === 'en' ? 'Next page' : '下一页' })).toBeVisible();
      const provider = panel.getByLabel('Provider'); await provider.fill('provider');
      const filtered = page.waitForResponse(response => response.url().includes('/records?') && response.url().includes('provider=provider'));
      await provider.press('Enter'); await filtered;
      const measurement = page.waitForResponse(response => response.url().includes('/records?') && response.url().includes('kind=measurement'));
      await panel.getByLabel(locale === 'en' ? 'View' : '查看').selectOption('measurement'); await measurement;
      await expect(panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' })).toBeEnabled();
      await expect(panel.getByText('9,007,199,254,740,993').first()).toBeVisible();
      const details = panel.locator('details').first();
      if (await details.getAttribute('open') === null) await details.locator('summary').click();
      await expect(panel.locator('details[open] code').first()).toBeVisible();
      await panel.getByRole('button', { name: locale === 'en' ? 'Next page' : '下一页' }).click();
      await expect.poll(() => requests.some(value => value.includes('cursor=next'))).toBe(true);
      await panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' }).focus();
      await expect(panel.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' })).toBeFocused();
    };
    await check(dialog);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
    await check(dialog);
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=usage`);
    await check(page.locator('.task-detail-page'));
  });
}

test('unsupported service shows one neutral usage explanation without a records request', async ({ page }) => {
  await install(page);
  let records = 0;
  await page.route('**/api/**/usage/v1/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/records')) records++;
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', requestId: 'fixture' } }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=usage`);
  const surface = page.locator('.task-detail-page');
  await expect(surface.getByText('This service does not support usage')).toHaveCount(1);
  await expect(surface.locator('.usage-filters, .usage-pagination, .usage-error')).toHaveCount(0);
  expect(records).toBe(0);
  await surface.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(surface.locator('.task-detail-heading').getByText('This service does not support usage')).toHaveCount(0);
});
for (const entry of ['dialog', 'page'] as const) for (const width of [320, 1280]) {
  test(`task detail keeps usage inside its tab in ${entry} at ${width}px`, async ({ page }, info) => {
    const zh = width === 320;
    const labels = {
      usage: zh ? '用量' : 'Usage', overview: zh ? '概览' : 'Overview',
      loading: zh ? '读取用量…' : 'Loading usage…',
      empty: zh ? '暂无计量记录；未知不代表零。' : 'No measurements; unknown does not mean zero.',
      error: zh ? '用量暂不可用' : 'Usage unavailable',
      unsupported: zh ? '此服务不支持用量查询' : 'This service does not support usage',
    };
    type UsageState = 'loading' | 'data' | 'empty' | 'error' | 'unsupported';
    let usageState: UsageState = 'loading';
    const loading = Promise.withResolvers<void>();
    await install(page);
    await page.route(/\/api\/(usage\/v1\/capabilities|projects\/.*\/usage\/v1\/)/, async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const state = usageState;
      const send = (body: unknown, status = 200) => route.fulfill({ status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
      if (state === 'loading') await loading.promise;
      if (path.endsWith('/capabilities')) return state === 'unsupported' ? send({}, 404) : send({ protocol: 'daynight.usage.v1' });
      if (state === 'error') return send({ error: { code: 'internal_error', requestId: 'usage-detail' } }, 503);
      if (state === 'unsupported') return send({ error: { code: 'usage_unsupported', requestId: 'usage-detail' } }, 404);
      if (path.endsWith('/task-summaries')) {
        const { taskIds } = request.postDataJSON() as { taskIds: string[] };
        const summary = {
          metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: state === 'empty' ? null : '12345', contributingRecords: state === 'empty' ? '0' : '1', unknownRecords: '0' }])),
          scope: 'registered_web_executions', completeness: state === 'empty' ? 'no_data' : 'complete', reasonCodes: [],
          coverage: { executions: '1', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '1', partialExecutions: '0', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '0' },
          measurementRecords: state === 'empty' ? '0' : '1', lastMeasuredAt: state === 'empty' ? null : time, observedAt: time, etag: 'detail-usage',
        };
        return send({ items: taskIds.map(id => ({ taskId: id, summary })) });
      }
      if (path.endsWith('/records')) return send({ items: [], nextCursor: null, snapshotToken: 'detail-usage', observedAt: time });
      throw new Error(`Unexpected usage request ${request.method()} ${path}`);
    });
    await page.setViewportSize({ width, height: 900 });
    const surface = page.locator(entry === 'dialog' ? '.task-detail-dialog' : '.task-detail-page');
    const heading = surface.locator('.task-detail-heading');
    const usage = surface.getByRole('tab', { name: labels.usage, exact: true });
    const overview = surface.getByRole('tab', { name: labels.overview, exact: true });
    const panel = surface.locator('.task-detail-panel-usage');
    const open = async (deepLink: boolean) => {
      if (entry === 'page') await page.goto(`/projects/${projectId}/tasks/${taskId}${deepLink ? '?tab=usage' : ''}`);
      else {
        await page.goto(`/projects/${projectId}`);
        await page.locator('#project-section-tab-tasks').click();
        await page.getByRole('tab', { name: zh ? '独立任务' : 'Standalone tasks' }).click();
        await page.locator(`#standalone-task-${taskId}`).click();
      }
      await expect(heading.locator('.task-detail-status-row')).toBeVisible();
      await expect(heading.locator('.task-usage-summary, .usage-summary, .usage-error')).toHaveCount(0);
      await expect(heading.locator(':scope > *')).toHaveCount(1);
      if (deepLink && entry === 'page') await expect(usage).toHaveAttribute('aria-selected', 'true');
      await overview.click();
      await usage.click();
      await expect(panel).toBeVisible();
      await usage.press('Home');
      await expect(overview).toBeFocused();
      await overview.press('End');
      await expect(usage).toBeFocused();
      await expect(usage).toHaveAttribute('aria-selected', 'true');
    };
    const layout = () => heading.evaluate(element => {
      const status = element.querySelector('.task-detail-status-row')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const tabs = element.parentElement!.querySelector('.task-detail-tabs')!.getBoundingClientRect();
      return { headerHeight: box.height, belowControls: Math.abs(box.bottom - status.bottom) < 1, tabsBelow: tabs.top >= box.bottom, controlsInside: status.left >= box.left && status.right <= box.right, noPageOverflow: document.documentElement.scrollWidth <= innerWidth };
    });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(zh ? 'zh-CN' : 'en');
    try {
      await open(false);
      await expect(panel.getByText(labels.loading, { exact: true }).first()).toBeVisible();
      const initial = await layout();
      expect(initial).toMatchObject({ belowControls: true, tabsBelow: true, controlsInside: true, noPageOverflow: true });
      usageState = 'data'; loading.resolve();
      await expect(panel.locator('.usage-metrics dd').first()).toHaveText('12,345');
      for (const state of ['data', 'empty', 'error', 'unsupported'] as const) {
        usageState = state;
        await open(entry === 'page');
        if (state === 'data') await expect(panel.locator('.usage-metrics dd').first()).toHaveText('12,345');
        else await expect(panel.getByText(labels[state], { exact: true }).first()).toBeVisible();
        expect(await layout()).toEqual(initial);
        await page.screenshot({ path: info.outputPath(`${entry}-${width}-${state}.png`) });
      }
    } finally { loading.resolve(); }
  });
}
