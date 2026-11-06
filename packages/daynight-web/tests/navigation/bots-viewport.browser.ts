import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { BOT_TIME, BOT_USER, botDefaults, botDefinition, botId } from '../helpers/bots';
import type {} from './bots-viewport-session';
import type { BotDefinition, BotDefaults } from '../../src/api/bots';
import { botConversationBack, botDetails, botDetailsOpener, closeBotConversation, expectBotDetailsMode, expectBotDetailText, expectBotHeading, focusBotControl } from '../e2e/bot-heading';

const personalId = botId(100), personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Viewport fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const bots = Array.from({ length: 70 }, (_, index) => ({ ...botDefinition(index + 1), name: index === 0 ? 'Bot A' : index === 1 ? 'Bot B' : `Assistant ${index + 1}`, sessionId: botId(index + 201), testExecutionId: botId(index + 401), roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } }));
const install = async (page: Page, options: { items?: readonly BotDefinition[]; defaults?: BotDefaults } = {}) => {
  const definitions = options.items ?? bots;
  const writes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER } });
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(options.defaults ?? botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: definitions, nextCursor: null });
    const bot = definitions.find(value => path === `/api/v1/me/bots/${value.id}`);
    return bot ? send(bot) : send({ error: { code: 'not_found', message: 'Not found', requestId: 'viewport-fixture' } }, 404);
  });
  return writes;
};
const visiblePane = '.bot-session-pane:not([hidden])';
const geometry = (page: Page) => page.evaluate(() => {
  const timeline = document.querySelector<HTMLElement>('.bot-session-pane:not([hidden]) .session-timeline')!;
  const composer = document.querySelector<HTMLElement>('.bot-session-pane:not([hidden]) .session-composer')!;
  const send = document.querySelector<HTMLElement>('.bot-session-pane:not([hidden]) .session-actions button')!;
  return { documentHeight: document.documentElement.scrollHeight, documentScroll: scrollY, width: innerWidth, height: innerHeight, composer: composer.getBoundingClientRect().toJSON(), send: send.getBoundingClientRect().toJSON(), timeline: { height: timeline.clientHeight, scrollHeight: timeline.scrollHeight, scrollTop: timeline.scrollTop }, metrics: { ...window.botViewport.metrics } };
});
const anchor = (page: Page) => page.locator(`${visiblePane} .session-timeline`).evaluate(timeline => {
  const bounds = timeline.getBoundingClientRect();
  const item = [...timeline.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.getBoundingClientRect().bottom > bounds.top + 1)!;
  return { key: item.dataset.entryKey, offset: item.getBoundingClientRect().top - bounds.top, scrollTop: timeline.scrollTop };
});
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px Bot viewport`, () => {
    test.use({ viewport });
    test('bounds long history, preserves A/B/A reading and drafts, and scrolls the list independently', async ({ page }, testInfo) => {
      const writes = await install(page), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`/bots/${botId(1)}`);
      const message = () => page.getByRole('textbox', { name: 'Message', exact: true });
      await expect(message()).toBeEnabled();
      await expect(page.locator(`${visiblePane} .session-entry`)).toHaveCount(100);
      await page.waitForTimeout(600);
      const initial = await geometry(page);
      expect(initial.documentHeight).toBeLessThanOrEqual(viewport.height + 1);
      expect(initial.composer.top).toBeGreaterThanOrEqual(0);
      expect(initial.composer.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(initial.send.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(initial.timeline.height).toBeGreaterThan(50);
      expect(initial.timeline.scrollHeight).toBeGreaterThan(initial.timeline.height);
      expect(initial.metrics.before).toBe(0);
      await page.screenshot({ path: testInfo.outputPath('bounded-session.png') });
      const originalMessage = await message().elementHandle(), originalTimeline = await page.locator(`${visiblePane} .session-timeline`).elementHandle();
      await message().fill('Draft A survives the bounded viewport');
      await page.locator(`${visiblePane} .session-timeline`).hover();
      await page.mouse.wheel(0, -900);
      await expect.poll(async () => (await geometry(page)).timeline.scrollTop).toBeLessThan(initial.timeline.scrollTop - 100);
      await page.waitForTimeout(150);
      const retained = await anchor(page);
      await closeBotConversation(page);
      const list = page.locator('.bot-list');
      await expect(list).toBeVisible();
      expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await list.hover(); await page.mouse.wheel(0, 700);
      await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await list.evaluate(node => { node.scrollTop = 0; });
      await page.getByRole('link', { name: /^Bot B / }).click();
      await expect(message()).toBeEnabled();
      await message().fill('Draft B');
      await closeBotConversation(page);
      await page.getByRole('link', { name: /^Bot A / }).click();
      await expect(message()).toHaveValue('Draft A survives the bounded viewport');
      expect(await message().evaluate((node, original) => node === original, originalMessage)).toBe(true);
      expect(await page.locator(`${visiblePane} .session-timeline`).evaluate((node, original) => node === original, originalTimeline)).toBe(true);
      const restored = await anchor(page);
      expect(restored.key).toBe(retained.key);
      expect(Math.abs(restored.offset - retained.offset)).toBeLessThanOrEqual(3);
      await page.waitForTimeout(600);
      expect((await geometry(page)).metrics.before).toBe(0);
      await page.locator(`${visiblePane} .session-timeline`).hover();
      await page.mouse.wheel(0, -100_000);
      await expect.poll(async () => (await geometry(page)).metrics.before).toBeGreaterThan(0);
      await page.waitForTimeout(600);
      const final = await geometry(page);
      expect(final.metrics.before).toBeLessThanOrEqual(2);
      expect(final.documentHeight).toBeLessThanOrEqual(viewport.height + 1);
      expect(final.composer.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(final.send.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(final.documentScroll).toBe(0);
      expect(final.metrics.commands).toBe(0);
      expect(writes).toEqual([]); expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('restored-session.png') });
      const evidence = testInfo.outputPath('viewport-evidence.json');
      await writeFile(evidence, JSON.stringify({ boundary: 'Production app shell and Bot Session rendering with controlled SessionApi and HTTP fixture; no real provider.', viewport, initial, retained, restored, final, writes, errors }, null, 2));
      await testInfo.attach('viewport-evidence', { contentType: 'application/json', path: evidence });
    });
  });
}

test('uses the available workspace width for tablet conversations', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 844 });
  const writes = await install(page);
  await page.goto(`/bots/${botId(1)}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await expect(page.locator('.bot-list-panel')).toBeHidden();
  const bounds = await page.locator('.bot-conversation').boundingBox();
  expect(bounds!.width).toBeGreaterThan(500);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(768);
  expect(writes).toEqual([]);
});

const panelGeometry = (page: Page) => page.evaluate(() => {
  const bounds = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().toJSON();
  return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, workspace: bounds('.bots-page'), list: bounds('.bot-list-panel'), conversation: bounds('.bot-conversation'), sidebar: bounds('#workspace-sidebar') };
});
const expectPanels = async (page: Page, selected: boolean) => {
  const bounds = await panelGeometry(page);
  const listVisible = await page.locator('.bot-list-panel').isVisible();
  const conversationVisible = await page.locator('.bot-conversation').isVisible();
  if (selected) {
    expect(conversationVisible).toBe(true);
    if (bounds.viewport <= 390) expect(listVisible).toBe(false);
    if (bounds.viewport >= 1440) expect(listVisible).toBe(true);
  } else expect(listVisible).toBe(true);
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport);
  if (listVisible && conversationVisible) {
    expect(bounds.list.right).toBeLessThanOrEqual(bounds.conversation.left + 1);
    expect(bounds.conversation.width).toBeGreaterThanOrEqual(420);
  } else {
    const visible = selected ? bounds.conversation : bounds.list;
    expect(Math.abs(visible.width - bounds.workspace.width)).toBeLessThanOrEqual(1);
  }
  if (selected && await page.locator(`${visiblePane} textarea`).count()) {
    const conversation = page.locator('.bot-conversation');
    const controls = [
      conversation.getByRole('button', { name: /^(Display|显示)$/ }),
      page.locator(`${visiblePane} textarea`),
      conversation.getByRole('button', { name: /^(Send|发送)$/ }),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(bounds.conversation.left - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds.conversation.right + 1);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(1001);
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  }
  return { ...bounds, listVisible, conversationVisible, selected };
};

for (const locale of ['en', 'zh-CN'] as const) {
  test(`responds to content width and sidebar changes in ${locale}`, async ({ page }, info) => {
    const writes = await install(page), evidence = [];
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.goto(`/bots/${botId(1)}`);
    await expect(page.locator(`${visiblePane} textarea`)).toBeEnabled();
    await page.locator('.locale-control select').selectOption(locale);
    const original = await page.locator('.bot-session-host').elementHandle();
    for (const width of [320, 390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      evidence.push(await expectPanels(page, true));
      if (width > 740) {
        await page.locator('.sidebar-toggle').click();
        evidence.push(await expectPanels(page, true));
        await page.locator('.sidebar-toggle').click();
      } else {
        await page.locator('.sidebar-toggle').click();
        await expect(page.locator('#workspace-sidebar')).toHaveAttribute('aria-modal', 'true');
        await page.keyboard.press('Escape');
        await expect(page.locator('#workspace-sidebar')).not.toHaveAttribute('aria-modal');
        evidence.push(await expectPanels(page, true));
      }
      await closeBotConversation(page);
      evidence.push(await expectPanels(page, false));
      await page.locator(`.bot-list a[href="/bots/${botId(1)}"]`).click();
      await expect(page.locator(`${visiblePane} textarea`)).toBeEnabled();
      expect(await page.locator('.bot-session-host').evaluate((node, before) => node === before, original)).toBe(true);
    }
    // Width changes must retain usable navigation without encoding a particular breakpoint.
    for (const width of [900, 1024, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      evidence.push(await expectPanels(page, true));
      await page.locator('.sidebar-toggle').click();
      evidence.push(await expectPanels(page, true));
      await page.locator('.sidebar-toggle').click();
    }
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    const path = info.outputPath('responsive-panels.json');
    await writeFile(path, JSON.stringify({ boundary: 'Production app with controlled HTTP and SessionApi; no native Provider.', locale, evidence, writes }, null, 2));
    await info.attach('responsive-panels', { path, contentType: 'application/json' });
  });
}

test('preserves selection, searches, drafts and reading through responsive navigation', { tag: '@routine' }, async ({ page }, info) => {
  const writes = await install(page);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto('/bots');
  const search = page.locator('.bot-search input'), message = () => page.locator(`${visiblePane} textarea`);
  await search.fill('Bot');
  await page.locator(`.bot-list a[href="/bots/${botId(1)}"]`).click();
  await expect(message()).toBeEnabled();
  const original = await message().elementHandle(), host = await page.locator('.bot-session-host').elementHandle();
  await message().fill('Independent draft A');
  await page.waitForTimeout(600);
  await page.locator(`${visiblePane} .session-timeline`).hover(); await page.mouse.wheel(0, -950);
  await expect(page.locator(`${visiblePane} .session-latest`)).toBeVisible();
  await page.waitForTimeout(150);
  const retained = await anchor(page);
  for (const width of [768, 390, 1440, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectPanels(page, true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  await page.waitForTimeout(150);
  const resized = await anchor(page);
  expect(resized.key).toBe(retained.key);
  expect(Math.abs(resized.offset - retained.offset)).toBeLessThanOrEqual(3);
  await page.setViewportSize({ width: 768, height: 1000 });
  await focusBotControl(page, botConversationBack(page)); await page.keyboard.press('Enter');
  await expect(search).toHaveValue('Bot');
  await expect(page.locator('.bot-list a')).toHaveCount(2);
  await focusBotControl(page, page.locator(`.bot-list a[href="/bots/${botId(2)}"]`)); await page.keyboard.press('Enter');
  await expect(message()).toBeEnabled();
  await focusBotControl(page, page.locator(`${visiblePane} textarea`)); await page.keyboard.type('Independent draft B');
  await closeBotConversation(page);
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.locator('.sidebar-toggle').click();
  await expect(search).toHaveValue('Bot');
  await page.locator(`.bot-list a[href="/bots/${botId(1)}"]`).click();
  await expect(message()).toHaveValue('Independent draft A');
  expect(await message().evaluate((node, before) => node === before, original)).toBe(true);
  expect(await page.locator('.bot-session-host').evaluate((node, before) => node === before, host)).toBe(true);
  await page.locator('.sidebar-toggle').click();
  await page.waitForTimeout(150);
  const restored = await anchor(page);
  expect(restored.key).toBe(retained.key);
  expect(Math.abs(restored.offset - retained.offset)).toBeLessThanOrEqual(3);
  const metrics = await page.evaluate(() => window.botViewport.metrics);
  expect(metrics.bindings).toHaveLength(2); expect(new Set(metrics.bindings).size).toBe(2);
  expect(metrics.channels).toBe(2); expect(metrics.closed).toBe(0); expect(metrics.commands).toBe(0);
  await closeBotConversation(page);
  await page.locator(`.bot-list a[href="/bots/${botId(2)}"]`).click();
  await expect(message()).toHaveValue('Independent draft B');
  expect(writes).toEqual([]);
  const path = info.outputPath('responsive-state.json');
  await writeFile(path, JSON.stringify({ boundary: 'Production cache and renderer with controlled HTTP and SessionApi; binding/channel counts do not prove native Provider lifetime.', retained, resized, restored, metrics, writes }, null, 2));
  await info.attach('responsive-state', { path, contentType: 'application/json' });
});

for (const locale of ['en', 'zh-CN'] as const) {
  test(`keeps long names and startup or offline status readable in ${locale}`, async ({ page }) => {
    const longName = locale === 'en' ? 'Long assistant name for tablet workspace' : '平板工作区中需要完整显示的长名称助手与状态验证';
    const hostName = locale === 'en' ? 'long-host-name-for-responsive-workspace.example.internal' : '用于响应式工作区验收的长主机名称';
    const defaults = botDefaults(), worker = defaults.workers[0]!;
    const failed: BotDefinition = { ...botDefinition(3), name: `${longName} C`.slice(0, 40), startupResult: { state: 'failed', code: 'provider_unavailable' } };
    const ready: BotDefinition = { ...bots[0]!, name: longName };
    const writes = await install(page, { items: [ready, failed], defaults: { ...defaults, workers: [{ ...worker, machine: { ...worker.machine, name: hostName } }] } });
    await page.setViewportSize({ width: 768, height: 1000 });
    await page.goto(`/bots/${ready.id}`);
    await page.locator('.locale-control select').selectOption(locale);
    await expectBotHeading(page, longName);
    await focusBotControl(page, botDetailsOpener(page, longName)); await page.keyboard.press('Enter');
    const details = await expectBotDetailsMode(page);
    await expectBotDetailText(details, longName);
    await expectBotDetailText(details, hostName);
    await page.keyboard.press('Escape');
    await expect(details).not.toBeVisible();
    await expect(botDetailsOpener(page, longName)).toBeFocused();
    await expectPanels(page, true);
    await closeBotConversation(page);
    await page.locator(`.bot-list a[href="/bots/${failed.id}"]`).click();
    await botDetailsOpener(page, failed.name).click();
    await expectBotDetailText(botDetails(page), locale === 'en' ? 'Startup failed' : '启动失败');
    await page.keyboard.press('Escape');
    await expect(page.locator('.bot-conversation')).toContainText('provider_unavailable');
    await expectPanels(page, true);
    await expect(page.locator(`${visiblePane} textarea`)).toHaveCount(0);
    // An offline Worker remains offline even when the persisted startup result is ready.
    await page.route('**/api/v1/me/bots/defaults', route => route.fulfill({ json: { ...defaults, workerId: null, configuration: null, reason: 'no_available_worker', workers: [{ ...worker, state: 'offline', reason: 'offline', configuration: null }] }, headers: { 'Daynight-User-ID': BOT_USER } }));
    await closeBotConversation(page);
    await page.locator('.bot-refresh').click();
    await page.locator(`.bot-list a[href="/bots/${ready.id}"]`).click();
    await botDetailsOpener(page, ready.name).click();
    await expectBotDetailText(botDetails(page), locale === 'en' ? 'Worker offline' : 'Worker 离线');
    await expectBotDetailText(botDetails(page), locale === 'en' ? 'Started' : '已启动');
    await page.keyboard.press('Escape');
    await expectPanels(page, true);
    expect(writes).toEqual([]);
  });
}

test('retains display, details and fullscreen across wide and narrow workspaces', { tag: '@routine' }, async ({ page }) => {
  const writes = await install(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/bots/${botId(1)}`);
  const message = page.locator(`${visiblePane} textarea`);
  await expect(message).toBeEnabled(); await message.fill('Draft while changing presentation');
  const original = await message.elementHandle();
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
  await page.keyboard.press('Escape');
  await botDetailsOpener(page, 'Bot A').click();
  await expectBotDetailsMode(page, 'nonmodal');
  await message.click();
  await expect(message).toBeFocused();
  await page.setViewportSize({ width: 768, height: 1000 });
  await expectBotDetailsMode(page, 'modal');
  await page.keyboard.press('Escape');
  await expect(botDetailsOpener(page, 'Bot A')).toBeFocused();
  await page.getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click();
  for (const width of [390, 1024, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator('.bot-conversation')).toHaveAttribute('data-session-fullscreen', 'true');
    await expect.poll(() => page.locator('.bot-conversation').boundingBox()).toEqual({ x: 0, y: 0, width, height: 1000 });
    await botDetailsOpener(page, 'Bot A').click();
    await expectBotDetailsMode(page, width === 390 ? 'modal' : undefined);
    await page.keyboard.press('Escape');
    await expect(page.locator('.bot-conversation')).toHaveAttribute('data-session-fullscreen', 'true');
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.bot-conversation')).not.toHaveAttribute('data-session-fullscreen');
  await expectPanels(page, true);
  await page.getByRole('button', { name: 'Display', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(message).toHaveValue('Draft while changing presentation');
  expect(await message.evaluate((node, before) => node === before, original)).toBe(true);
  const metrics = await page.evaluate(() => window.botViewport.metrics);
  expect(metrics.bindings).toHaveLength(1); expect(metrics.channels).toBe(1); expect(metrics.closed).toBe(0); expect(metrics.commands).toBe(0);
  expect(writes).toEqual([]);
});
