import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { AssistantTask } from '../../src/api/assistant-tasks';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import { botObservation } from '../helpers/bot-observation';
import { botConversationBack, focusBotControl } from '../helpers/bot-heading';
import type {} from './bots-viewport-session';

const viewports = [{ width: 320, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1360, height: 900 }];
const definition = (index: number) => ({
  ...botDefinition(index), name: index === 1 ? 'Ready assistant' : index === 2 ? 'Abnormal assistant' : `Assistant ${index} ${'LongName中文'.repeat(12)}`,
  roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) },
  sessionId: botId(index + 200), testExecutionId: botId(index + 400), startupResult: { state: 'ready' as const, code: null },
});
const assistantTask = (index: number): AssistantTask => ({
  id: botId(index + 500), ownerUserId: BOT_USER, name: `Task ${index} ${'Long task name 中文'.repeat(6)}`,
  purpose: 'Verify sidebar access', scope: 'Frontend fixture', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null,
  version: '1', manualVersion: '1', claimGeneration: '1', claimState: 'active', holderBotId: botId(1), credentialOperationId: botId(index + 700),
  claimedAt: BOT_TIME, renewedAt: BOT_TIME, leaseUntil: '2099-01-01T00:00:00Z', observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME,
});
const install = async (page: Page, count = 2, initialTasks: number | 'loading' = 'loading') => {
  const personalId = botId(100), personal = { id: personalId, kind: 'personal', name: null };
  const bots = Array.from({ length: count }, (_, index) => definition(index + 1));
  let taskCount = initialTasks === 'loading' ? 0 : initialTasks, taskError = false;
  let release = () => {};
  const loading = new Promise<void>(resolve => { release = resolve; });
  let blocked = initialTasks === 'loading';
  const writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.botViewportOptions = { scenario: 'empty' }; });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(request.headers(), status) } });
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      throw new Error(`Unexpected sidebar fixture write: ${request.method()} ${path}`);
    }
    if (path === '/api/v1/me') return send({ id: BOT_USER, personalTeam: personal, name: 'List budget fixture', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams' || path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/webhook-event-types') return send({ error: { code: 'not_found', message: 'Webhook capability unavailable', requestId: 'list-budget-fixture' } }, 404);
    if (path === `/api/v1/teams/${personalId}`) return send({ ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: bots, nextCursor: null });
    if (path === '/api/v1/assistant-tasks') {
      if (blocked) await loading;
      return taskError ? send({ error: { code: 'unavailable', message: 'Task read failed', requestId: 'list-budget-fixture' } }, 503)
        : send({ items: Array.from({ length: taskCount }, (_, index) => assistantTask(index + 1)), nextCursor: null, observedAt: BOT_TIME });
    }
    if (path === '/api/v1/assistant-task-events') return send({ items: [], nextCursor: null, observedAt: BOT_TIME });
    if (path.startsWith('/api/v1/assistant-tasks/') && ['/proposals', '/events', '/items'].some(suffix => path.endsWith(suffix))) return send({ items: [], nextCursor: null, observedAt: BOT_TIME });
    if (path === `/api/v1/me/workers/${botId(20)}/alias`) return send({ workerId: botId(20), alias: { value: null, version: '1' } });
    const bot = bots.find(value => path === `/api/v1/me/bots/${value.id}` || path === `/api/v1/me/bots/${value.id}/observation`);
    if (bot && path.endsWith('/observation')) return send(botObservation(1, {
      botId: bot.id, sessionId: bot.sessionId, testExecutionId: bot.testExecutionId,
      machine: { id: botId(120), name: 'Office' }, state: bot.id === botId(2) ? 'abnormal' : 'idle', reason: bot.id === botId(2) ? 'provider_unavailable' : 'idle',
      observedAt: new Date().toISOString(), freshUntil: new Date(Date.now() + 60_000).toISOString(),
    }));
    if (bot) return send(bot);
    throw new Error(`Unexpected sidebar fixture read: ${path}`);
  });
  return {
    writes, errors,
    tasks: (value: number | 'error') => { taskError = value === 'error'; if (value !== 'error') taskCount = value; blocked = false; release(); },
  };
};
const geometry = (page: Page) => page.locator('.bot-list').evaluate(list => {
  const panel = list.closest<HTMLElement>('.bot-list-panel')!, tasks = panel.querySelector<HTMLElement>('.assistant-task-section')!;
  const bounds = list.getBoundingClientRect();
  return {
    height: bounds.height, rowsHeight: [...list.children].reduce((sum, row) => sum + row.getBoundingClientRect().height + parseFloat(getComputedStyle(row).marginBottom), 0),
    scrollHeight: list.scrollHeight, panelHeight: panel.clientHeight, panelScrollHeight: panel.scrollHeight, panelScrollTop: panel.scrollTop,
    gap: tasks.getBoundingClientRect().top - bounds.bottom, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
    listWidth: list.clientWidth, listScrollWidth: list.scrollWidth, panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
  };
});
const assertNaturalRows = async (page: Page) => {
  const value = await geometry(page);
  expect(value.height).toBeGreaterThanOrEqual(144);
  expect(Math.abs(value.height - value.rowsHeight)).toBeLessThanOrEqual(1);
  expect(value.gap).toBeLessThanOrEqual(21);
  expect(value.documentWidth).toBeLessThanOrEqual(value.viewportWidth);
  expect(value.listScrollWidth).toBeLessThanOrEqual(value.listWidth);
  expect(value.panelScrollWidth).toBeLessThanOrEqual(value.panelWidth);
  return value;
};
const save = async (info: TestInfo, value: unknown) => {
  await info.attach('sidebar-geometry', { body: JSON.stringify({ boundary: 'Production Web app with controlled HTTP and Session API responses; no backend or physical-device acceptance.', value }, null, 2), contentType: 'application/json' });
};

test.describe('assistant list height budget', () => {
  for (const locale of ['en', 'zh-CN']) for (const viewport of viewports) {
    test(`retains two natural rows across task states at ${viewport.width}px in ${locale}`, async ({ page }, info) => {
      const fixture = await install(page);
      await page.setViewportSize(viewport); await page.goto('/bots');
      await page.locator('.locale-control select').selectOption(locale);
      await expect(page.locator('.bot-list a')).toHaveCount(2);
      const section = page.locator('.assistant-task-section'), refresh = section.locator('.assistant-task-list-actions button').last();
      await expect(section.getByRole('status')).toBeVisible();
      const states = [{ state: 'loading', geometry: await assertNaturalRows(page) }];
      for (const count of [0, 2, 6]) {
        fixture.tasks(count);
        if (count !== 0) await refresh.click();
        await expect(section.locator('li')).toHaveCount(count);
        await expect(refresh).toHaveAttribute('aria-busy', 'false');
        states.push({ state: String(count), geometry: await assertNaturalRows(page) });
      }
      fixture.tasks('error'); await refresh.click();
      await expect(section.getByRole('alert')).toBeVisible();
      states.push({ state: 'error', geometry: await assertNaturalRows(page) });
      fixture.tasks(2); await section.getByRole('alert').getByRole('button').click();
      await expect(section.getByRole('alert')).toHaveCount(0);
      await expect(section.locator('li')).toHaveCount(2);
      states.push({ state: 'retry', geometry: await assertNaturalRows(page) });
      for (const index of [0, 1]) {
        const row = page.locator('.bot-list a').nth(index);
        await row.scrollIntoViewIfNeeded(); await row.click();
        await expect(page.locator('.bot-conversation-title h2:visible')).toHaveText(index === 0 ? 'Ready assistant' : 'Abnormal assistant');
        if (viewport.width === 1360) { await expect(page.locator('.bot-list-panel')).toBeVisible(); await expect(page.locator('.bot-conversation')).toBeVisible(); }
        await botConversationBack(page).click();
        await expect(page.locator('.bot-list-panel')).toBeVisible();
      }
      await page.locator('.bot-list-panel').evaluate(node => { node.scrollTop = 0; });
      await focusBotControl(page, page.locator('.bot-list a').first());
      await page.keyboard.press('Enter');
      await expect(page.locator('.bot-conversation-title h2:visible')).toHaveText('Ready assistant');
      await botConversationBack(page).click();
      const more = page.locator('.bot-more').first(); await more.focus(); await page.keyboard.press('Enter');
      await page.keyboard.press('Escape'); await expect(more).toBeFocused();
      expect(fixture.writes).toEqual([]); expect(fixture.errors).toEqual([]);
      await page.locator('.bot-list-panel').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: info.outputPath(`sidebar-${locale}-${viewport.width}.png`) });
      await save(info, { viewport, locale, states });
    });
  }

  for (const locale of ['en', 'zh-CN']) {
    test(`bounds dense rows and leaves no blank list for zero matches in ${locale}`, async ({ page }, info) => {
      const fixture = await install(page, 14, 6);
      await page.setViewportSize({ width: 320, height: 400 }); await page.goto('/bots');
      await page.locator('.locale-control select').selectOption(locale);
      const list = page.locator('.bot-list'), tasks = page.locator('.assistant-task-list a');
      await expect(list.locator('a')).toHaveCount(14); await expect(tasks).toHaveCount(6);
      const initial = await geometry(page);
      expect(initial.height).toBeGreaterThanOrEqual(144);
      expect(initial.height).toBeLessThanOrEqual(161);
      expect(initial.scrollHeight).toBeGreaterThan(initial.height);
      expect(initial.documentWidth).toBe(320);
      expect(initial.panelScrollWidth).toBeLessThanOrEqual(initial.panelWidth);
      await list.locator('a').first().focus();
      await focusBotControl(page, list.locator('a').last());
      expect(await list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await expect(tasks.first()).toBeFocused();
      expect((await geometry(page)).panelScrollTop).toBeGreaterThan(0);
      await tasks.last().focus(); await expect(tasks.last()).toBeInViewport();
      const search = page.locator('.bot-search input'); await search.fill('Ready assistant');
      await expect(list.locator('a')).toHaveCount(1);
      const one = await geometry(page);
      expect(one.height).toBeLessThan(100); expect(Math.abs(one.height - one.rowsHeight)).toBeLessThanOrEqual(1);
      await search.fill('nothing-can-match-this'); await expect(list.locator('a')).toHaveCount(0);
      expect((await geometry(page)).height).toBe(0);
      await search.fill(''); await expect(list.locator('a')).toHaveCount(14);
      expect(fixture.writes).toEqual([]); expect(fixture.errors).toEqual([]);
      await save(info, { initial, one, restored: await geometry(page) });
    });
  }

  test.describe('touch scroll handoff', () => {
    test.use({ hasTouch: true });
    test('chains a gesture from the dense assistant list to its task section', async ({ page }, info) => {
      const fixture = await install(page, 14, 6);
      await page.setViewportSize({ width: 320, height: 640 }); await page.goto('/bots');
      const list = page.locator('.bot-list'); await expect(list.locator('a')).toHaveCount(14);
      await expect(page.locator('.assistant-task-list a')).toHaveCount(6);
      await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
      const bounds = (await list.boundingBox())!, x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height - 30;
      const before = await geometry(page), cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let distance = 20; distance <= 160; distance += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - distance }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(async () => (await geometry(page)).panelScrollTop).toBeGreaterThan(before.panelScrollTop);
      await cdp.detach();
      const task = page.locator('.assistant-task-list a').first(); await task.scrollIntoViewIfNeeded(); await expect(task).toBeInViewport();
      expect(fixture.writes).toEqual([]); expect(fixture.errors).toEqual([]);
      await page.screenshot({ path: info.outputPath('touch-sidebar.png') }); await save(info, { before, after: await geometry(page) });
    });
  });
});
