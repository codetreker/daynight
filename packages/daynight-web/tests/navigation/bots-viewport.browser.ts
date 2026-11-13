import { expect, test, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import type {} from './bots-viewport-session';
import type { BotDefinition, BotDefaults } from '../../src/api/bots';
import { botConversationBack, botDetails, botDetailsOpener, closeBotConversation, expectBotDetailsMode, expectBotDetailText, expectBotHeading, focusBotControl } from '../helpers/bot-heading';

const personalId = botId(100), personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Viewport fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const bots = Array.from({ length: 70 }, (_, index) => ({ ...botDefinition(index + 1), name: index === 0 ? 'Bot A' : index === 1 ? 'Bot B' : `Assistant ${index + 1}`, sessionId: botId(index + 201), testExecutionId: botId(index + 401), roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } }));
const install = async (page: Page, options: { items?: readonly BotDefinition[]; defaults?: BotDefaults } = {}) => {
  const definitions = options.items ?? bots;
  const writes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && !path.endsWith('/readonly/requests')) writes.push(`${request.method()} ${path}`);
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers(), status) } });
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
  return { viewport: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, workspace: bounds('.bots-page'), list: bounds('.bot-list-panel'), conversation: bounds('.bot-conversation'), sidebar: bounds('#workspace-sidebar') };
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
      expect(box!.y + box!.height).toBeLessThanOrEqual(bounds.height + 1);
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
    for (const width of [320, 390, 768, 1024, 1280, 1440]) {
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

test('preserves selection, searches, drafts and reading through responsive navigation', async ({ page }, info) => {
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
  await expect(message()).toBeEditable();
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

test('retains display, details and fullscreen across wide and narrow workspaces', async ({ page }) => {
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

// docs/spec/bot-management-web.md: verification, creation, unified heading and details.
const expectInViewport = async (control: Locator, page: Page, minimum = 1) => {
  await expect(control).toBeVisible();
  const box = await control.boundingBox(), viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
};

for (const locale of ['en', 'zh-CN'] as const) {
  test(`keeps short-viewport title, input and long details reachable in ${locale}`, async ({ page }, info) => {
    const name = locale === 'en' ? 'A long assistant name with forty letters' : '负责跨项目需求整理代码检查与开发进度协调的长名称助手';
    const directory = `/ordinary/${'long-directory-'.repeat(15)}/工作目录`;
    const bot = { ...bots[0]!, name, resolvedConfiguration: { ...bots[0]!.resolvedConfiguration, cwd: directory } };
    const writes = await install(page, { items: [bot] });
    await page.setViewportSize({ width: 390, height: 300 });
    await page.goto(`/bots/${bot.id}`);
    await page.locator('.locale-control select').selectOption(locale);
    const input = page.locator(`${visiblePane} textarea`);
    await expect(input).toBeEnabled();
    await input.fill('A draft kept while inspecting details');
    const original = await input.elementHandle();
    await expectPanels(page, true);
    await expectBotHeading(page, name);
    for (const control of [botConversationBack(page), botDetailsOpener(page, name), page.locator('.bot-header-more > button'), page.locator(`${visiblePane} .session-actions button`)]) {
      await expect(control).toHaveAccessibleName(/\S/);
      await expectInViewport(control, page, 44);
    }
    await expectInViewport(input, page);
    await page.screenshot({ path: info.outputPath('short-conversation.png') });
    await focusBotControl(page, botDetailsOpener(page, name));
    expect(await botDetailsOpener(page, name).evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Enter');
    const details = await expectBotDetailsMode(page, 'modal');
    await expectBotDetailText(details, name);
    await expectBotDetailText(details, directory);
    await expectInViewport(details.getByRole('button', { name: /^(Close assistant details|关闭助手详情)$/ }), page, 44);
    const remove = details.getByRole('button', { name: /^(Delete assistant|删除助手)$/ });
    await expectInViewport(remove, page, 44);
    await remove.click();
    const confirmation = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^(Cancel|取消)$/ }) });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
    await expect(details).toBeVisible();
    await page.screenshot({ path: info.outputPath('short-details.png') });
    await page.keyboard.press('Escape');
    await expect(details).not.toBeVisible();
    await expect(botDetailsOpener(page, name)).toBeFocused();
    await input.click();
    await expect(input).toHaveValue('A draft kept while inspecting details');
    expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  });

  test(`distinguishes search and empty list and operates dialog creation in ${locale}`, async ({ page }, info) => {
    const writes = await install(page);
    await page.setViewportSize({ width: 390, height: 300 });
    await page.goto('/bots');
    await page.locator('.locale-control select').selectOption(locale);
    const search = page.locator('.bot-search input');
    await search.fill('nothing-matches-this-name');
    await expect(page.locator('.bot-list a')).toHaveCount(0);
    await expect(page.getByText(locale === 'en' ? 'No matching assistants' : '没有匹配的助手', { exact: true })).toBeVisible();
    await expect(page.getByText(locale === 'en' ? 'No assistants yet' : '还没有助手', { exact: true })).toHaveCount(0);
    await search.fill('');
    const create = page.locator('.bot-create');
    await page.keyboard.press('Shift+Tab'); await expect(create).toBeFocused(); await page.keyboard.press('Enter');
    const form = page.locator('.bot-create-form'), name = form.getByRole('textbox', { name: /^(Name|名称)$/ });
    await expect(name).toBeFocused();
    await name.fill('Created with keyboard');
    const advanced = form.locator('.bot-create-advanced > summary');
    await focusBotControl(page, advanced); await page.keyboard.press('Enter');
    await expect(form.locator('.bot-create-advanced')).toHaveAttribute('open', '');
    const cwd = form.getByRole('textbox', { name: /^(Working directory|工作目录)$/ });
    await cwd.fill('/ordinary/long-directory-for-creation');
    await cwd.scrollIntoViewIfNeeded();
    await expectInViewport(cwd, page, 44);
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0); await expect(create).toBeFocused();
    expect(writes).toEqual([]);
    await create.click(); await name.fill('Created with keyboard');
    const submissions: { id: string; name: string; overrides?: unknown }[] = [];
    let created: BotDefinition | null = null;
    await page.route('**/api/v1/me/bots', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON(); submissions.push(body);
      if (submissions.length === 1) return route.fulfill({ status: 400, headers: { 'Daynight-User-ID': BOT_USER }, json: { error: { code: 'invalid_request', message: 'Controlled creation rejection', requestId: 'create-rejection' } } });
      created = { ...botDefinition(90), id: body.id, name: body.name };
      await route.fulfill({ status: 200, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers()) }, json: created });
    });
    await page.route('**/api/v1/me/bots/*', async route => {
      if (created && new URL(route.request().url()).pathname.endsWith(`/${created.id}`)) return route.fulfill({ headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers()) }, json: created });
      return route.fallback();
    });
    const submit = form.getByRole('button', { name: /^(Create assistant|创建助手)$/, exact: true });
    await submit.click();
    await expect(form.getByRole('alert')).toContainText(locale === 'en' ? 'Could not create the assistant.' : '无法创建助手。');
    await expect(form.getByRole('alert')).toContainText('create-rejection');
    await expect(name).toHaveValue('Created with keyboard');
    expect(submissions).toHaveLength(1);
    await submit.scrollIntoViewIfNeeded(); await expectInViewport(submit, page, 44);
    await page.screenshot({ path: info.outputPath('short-creation-error.png') });
    await name.click(); await focusBotControl(page, submit); await page.keyboard.press('Enter');
    await expect(form).toHaveCount(0);
    expect(submissions).toHaveLength(2);
    expect(submissions.every(value => value.name === 'Created with keyboard' && value.overrides === undefined)).toBe(true);
    expect(submissions[0]!.id).not.toBe(submissions[1]!.id);
    await expect(page.locator('.bot-conversation-title')).toContainText('Created with keyboard');
    await closeBotConversation(page);
    await page.route(/\/api\/v1\/me\/bots(?:\?.*)?$/, route => route.fulfill({ json: { items: [], nextCursor: null }, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers()) } }));
    await page.reload();
    await expect(page.getByText(locale === 'en' ? 'No assistants yet' : '还没有助手', { exact: true })).toBeVisible();
    await expect(page.locator(`${visiblePane} textarea`)).toHaveCount(0);
  });
}

test('uses inclusive window and stable-container details thresholds without oscillation', async ({ page }, info) => {
  const writes = await install(page), evidence = [];
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto(`/bots/${botId(1)}`);
  const input = page.locator(`${visiblePane} textarea`);
  await expect(input).toBeEnabled(); await input.fill('Threshold draft');
  const original = await input.elementHandle();
  // Constrain only the parent layout allocation: the production ResizeObserver
  // still measures the real common container, including the 759/760 equality.
  await page.locator('.sidebar-toggle').click();
  for (const width of [1279, 1280]) {
    await page.setViewportSize({ width, height: 960 });
    for (const available of [759, 760]) {
      await page.locator('.bot-conversation').evaluate((node, size) => { node.style.flex = `0 0 ${size}px`; }, available);
      await expect.poll(() => page.locator('.bot-conversation-body').evaluate(node => node.clientWidth)).toBe(available);
      const modal = width < 1280 || available < 760;
      for (let cycle = 0; cycle < 2; cycle++) {
        await botDetailsOpener(page, 'Bot A').click();
        const details = await expectBotDetailsMode(page, modal ? 'modal' : 'nonmodal');
        const observations = await details.evaluate(async panel => {
          const samples = [];
          for (let index = 0; index < 12; index++) {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            samples.push({ modal: panel.matches(':modal'), common: panel.parentElement!.clientWidth, details: panel.getBoundingClientRect().width, conversation: panel.parentElement!.querySelector('.bot-conversation-content')!.getBoundingClientRect().width });
          }
          return samples;
        });
        expect(observations.every(value => value.modal === modal && value.common === available)).toBe(true);
        if (!modal) {
          expect(observations.every(value => value.details === 340 && value.conversation >= 420)).toBe(true);
          await input.click(); await expect(input).toBeFocused();
        }
        evidence.push({ width, available, cycle, observations });
        await details.getByRole('button', { name: 'Close assistant details', exact: true }).click();
        await expect(botDetailsOpener(page, 'Bot A')).toBeFocused();
        await input.click(); await expect(input).toBeFocused();
      }
    }
  }
  await expect(input).toHaveValue('Threshold draft');
  expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
  expect(await page.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(1);
  expect(writes).toEqual([]);
  await writeFile(info.outputPath('details-thresholds.json'), JSON.stringify(evidence, null, 2));
});

// docs/spec/bot-session-view.md: layout changes retain the visible text, not
// merely the first message box when that message wraps onto different lines.
test('preserves a visible text anchor through details, focus mode and navigation width', async ({ page }, info) => {
  const writes = await install(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`/bots/${botId(1)}`);
  const input = page.locator(`${visiblePane} textarea`), timeline = page.locator(`${visiblePane} .session-timeline`);
  await expect(input).toBeEnabled();
  await expect(page.locator(`${visiblePane} .session-entry`)).toHaveCount(100);
  await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
  await timeline.hover(); await page.mouse.wheel(0, -950);
  await expect(page.locator(`${visiblePane} .session-latest`)).toBeVisible();
  const saved = await timeline.evaluate(node => {
    const top = node.getBoundingClientRect().top;
    for (const entry of node.querySelectorAll<HTMLElement>('[data-entry-key]')) {
      if (entry.getBoundingClientRect().bottom <= top) continue;
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        for (let index = 0; index < text.length; index++) {
          if (!text.data[index]!.trim()) continue;
          const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1);
          const rect = range.getBoundingClientRect();
          if (rect.height && rect.top >= top && rect.top < top + node.clientHeight) return { key: entry.dataset.entryKey!, text: text.data, index, offset: rect.top - top };
        }
      }
    }
    throw new Error('No visible text anchor');
  });
  const readOffset = () => timeline.evaluate((node, anchor) => {
    const entry = [...node.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.dataset.entryKey === anchor.key)!;
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.data !== anchor.text) continue;
      const range = document.createRange(); range.setStart(text, anchor.index); range.setEnd(text, anchor.index + 1);
      return range.getBoundingClientRect().top - node.getBoundingClientRect().top;
    }
    throw new Error('The saved text disappeared');
  }, saved);
  const offsets: number[] = [], originalTimeline = await timeline.elementHandle(), originalInput = await input.elementHandle();
  const check = async () => {
    await expect.poll(async () => Math.abs(await readOffset() - saved.offset)).toBeLessThanOrEqual(1);
    expect(await timeline.evaluate((node, before) => node === before, originalTimeline)).toBe(true);
    expect(await input.evaluate((node, before) => node === before, originalInput)).toBe(true);
    expect(await page.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(1);
    offsets.push(await readOffset());
  };
  await botDetailsOpener(page, 'Bot A').click();
  await expectBotDetailsMode(page, 'nonmodal'); await check();
  await page.keyboard.press('Escape'); await expect(botDetails(page)).toHaveCount(0); await check();
  await page.getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click();
  await expect(page.locator('.bot-conversation')).toHaveAttribute('data-session-fullscreen', 'true'); await check();
  await page.keyboard.press('Escape');
  await expect(page.locator('.bot-conversation')).not.toHaveAttribute('data-session-fullscreen'); await check();
  const sidebarWidth = (await page.locator('#workspace-sidebar').boundingBox())!.width;
  await page.locator('.sidebar-toggle').click();
  await expect.poll(async () => (await page.locator('#workspace-sidebar').boundingBox())!.width).not.toBe(sidebarWidth); await check();
  await page.locator('.sidebar-toggle').click();
  await expect.poll(async () => (await page.locator('#workspace-sidebar').boundingBox())!.width).toBe(sidebarWidth); await check();
  await expect(page.locator(`${visiblePane} .session-latest`)).toBeVisible();
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  await writeFile(info.outputPath('text-anchor.json'), JSON.stringify({ saved, offsets }, null, 2));
});

test('creation dialog leaves the active Session, draft and reading position intact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const writes = await install(page);
  await page.goto(`/bots/${botId(1)}`);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await expect(input).toBeEnabled(); await input.fill('Session draft remains here');
  const timeline = page.locator(`${visiblePane} .session-timeline`);
  await expect(page.locator(`${visiblePane} .session-entry`)).toHaveCount(100);
  await page.waitForTimeout(500);
  await timeline.hover(); await page.mouse.wheel(0, -600); await page.waitForTimeout(150);
  const saved = await anchor(page), originalInput = await input.elementHandle(), originalTimeline = await timeline.elementHandle();
  const metrics = await page.evaluate(() => ({ ...window.botViewport.metrics }));
  await page.locator('.bot-create').click();
  await expect(page.locator('dialog.bot-create-dialog')).toBeVisible();
  await page.locator('#bot-name').fill('Unsubmitted assistant');
  await page.locator('.bot-create-advanced > summary').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.bot-create-dialog')).toHaveCount(0);
  await expect(page.locator('.bot-create')).toBeFocused();
  await expect(input).toHaveValue('Session draft remains here');
  expect(await input.evaluate((node, previous) => node === previous, originalInput)).toBe(true);
  expect(await timeline.evaluate((node, previous) => node === previous, originalTimeline)).toBe(true);
  const restored = await anchor(page);
  expect(restored.key).toBe(saved.key); expect(Math.abs(restored.offset - saved.offset)).toBeLessThanOrEqual(3);
  expect(await page.evaluate(() => ({ ...window.botViewport.metrics }))).toEqual(metrics);
  expect(writes).toEqual([]);
});

for (const width of [1440, 390, 320]) {
  test(`restores the resident A before detail revalidation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => { window.botViewportOptions = { scenario: 'hot-switch' }; });
    const writes = await install(page, { items: bots.slice(0, 3) });
    let frozen = false, release: (() => void) | undefined, reads = 0;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/v1/me/bots/${botId(1)}`, async route => {
      if (!frozen) return route.fallback();
      reads++; await barrier;
      await route.fulfill({ json: bots[0], headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers()) } });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`/bots/${botId(1)}`);
      const message = page.locator(`${visiblePane} textarea`), timeline = page.locator(`${visiblePane} .session-timeline`);
      await expect(message).toBeEnabled();
      await expect(page.locator(`${visiblePane} .session-entry`)).toHaveCount(99);
      await page.getByRole('button', { name: 'Display', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Standard', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator(`${visiblePane} .session-entry`)).toHaveCount(100);
      const tool = page.locator(`${visiblePane} .session-tool`);
      await tool.locator('summary').click();
      await expect(tool).toHaveAttribute('open', '');
      await expect(tool).toContainText('Retained tool output');
      await message.fill('Draft A before revalidation');
      const scrollStart = await timeline.evaluate(node => node.scrollTop);
      await timeline.hover(); await page.mouse.wheel(0, -700);
      await expect.poll(() => timeline.evaluate((node, expected) => Math.abs(node.scrollTop - expected), Math.max(0, scrollStart - 700))).toBeLessThanOrEqual(1);
      await expect(page.locator(`${visiblePane} .session-latest`)).toBeVisible();
      const before = await anchor(page);
      const originalInput = await message.elementHandle(), originalTimeline = await timeline.elementHandle(), originalTool = await tool.elementHandle();
      const select = async (id: string) => {
        await closeBotConversation(page);
        await page.locator(`.bot-list a[href="/bots/${id}"]`).click();
      };
      await select(botId(2));
      await expect(message).toBeEnabled(); await message.fill('Draft B');
      frozen = true;
      await select(botId(1));
      await expect.poll(() => reads).toBeGreaterThan(0);
      // The response is still blocked. These are the original production DOM nodes.
      await expect(message).toHaveValue('Draft A before revalidation');
      await expect(message).toBeEnabled();
      expect(await message.evaluate((node, old) => node === old, originalInput)).toBe(true);
      expect(await timeline.evaluate((node, old) => node === old, originalTimeline)).toBe(true);
      expect(await tool.evaluate((node, old) => node === old, originalTool)).toBe(true);
      await expect(tool).toHaveAttribute('open', '');
      const restored = await anchor(page);
      expect(restored.key).toBe(before.key); expect(Math.abs(restored.offset - before.offset)).toBeLessThanOrEqual(3);
      await expect(page.locator(`${visiblePane} .session-actions button[type=submit]`)).toBeDisabled();
      expect(await message.evaluate(node => document.activeElement === node)).toBe(false);
      await message.fill('Local edit during revalidation');
      await message.press('Enter');
      await expect(message).toHaveValue('Local edit during revalidation');
      const held = await page.evaluate(() => ({ ...window.botViewport.metrics }));
      expect(held.bindings).toHaveLength(2); expect(held.channels).toBe(2); expect(held.closed).toBe(0); expect(held.commands).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: info.outputPath(`hot-switch-${width}.png`) });
      frozen = false; release!();
      await expect(page.locator(`${visiblePane} .session-actions button[type=submit]`)).toBeEnabled();
      await expect(message).toHaveValue('Local edit during revalidation');
      expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
      expect(writes).toEqual([]); expect(errors).toEqual([]);
      await writeFile(info.outputPath(`hot-switch-${width}.json`), JSON.stringify({ boundary: 'Production Web DOM in Chromium with controlled HTTP and SessionApi; no Worker or Provider.', width, before, restored, held, writes, errors }, null, 2));
    } finally { frozen = false; release?.(); }
  });
}
