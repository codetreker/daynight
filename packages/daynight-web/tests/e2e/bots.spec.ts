import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { BotDefinition, BotDefaults } from '../../src/api/bots';
import { createProject, createTask, expect, test } from './fixtures';
import { openBotController, reportBotWorker } from './bot-controller';
import { expectBotHeading } from './bot-heading';

test.use({ locale: 'en-US' });

test('assistant navigation composes creation, shared conversations and authoritative deletion', {
  annotation: { type: 'scenario', description: 'assistant-composition' },
}, async ({ page, api, baseURL, allowBrowserWrites }, info) => {
  if (baseURL === undefined) throw new Error('Bot acceptance requires the isolated product origin.');
  const legacyWorkerId = randomUUID(), workerId = randomUUID();
  await reportBotWorker(api, legacyWorkerId, false);
  await reportBotWorker(api, workerId, true);
  const defaultsResponse = await api.get('/api/v1/me/bots/defaults'); expect(defaultsResponse.status()).toBe(200);
  const defaults = await defaultsResponse.json() as BotDefaults;
  expect(defaults.workerId).toBe(workerId);
  expect(defaults.workers.find(worker => worker.workerId === legacyWorkerId)?.state).toBe('unsupported');
  const project = await createProject(api, { name: 'Independent task preserved by assistant deletion', repoUrl: `https://example.com/assistant/${randomUUID()}` });
  const task = await createTask(api, project.id, { title: 'Keep this independent task' });
  const controllers: Awaited<ReturnType<typeof openBotController>>[] = [];
  const created: BotDefinition[] = [];
  allowBrowserWrites([{ method: 'POST', url: new URL('/api/v1/me/bots', baseURL).href, count: 2 }]);
  const pane = () => page.locator('.bot-session-pane:not([hidden])');
  const message = () => pane().getByRole('textbox', { name: 'Message', exact: true });
  const choose = async (bot: BotDefinition) => {
    if (await page.getByRole('link', { name: 'Close conversation', exact: true }).isVisible()) await page.getByRole('link', { name: 'Close conversation', exact: true }).click();
    await page.locator('.bot-list').getByRole('link', { name: new RegExp(`^${bot.name} `) }).click();
    await expect(message()).toBeEnabled();
  };
  try {
    await page.goto('/projects');
    const navigation = page.locator('#workspace-sidebar').getByRole('link', { name: 'Assistants', exact: true });
    await expect(navigation).toBeVisible(); await navigation.click();
    await expect(page).toHaveURL(`${baseURL}/bots`); await expect(navigation).toHaveAttribute('aria-current', 'page');
    for (const name of ['UI audit mobile 20261105', `Acceptance B ${randomUUID().slice(0, 8)}`]) {
      await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Create assistant', exact: true });
      await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
      await expect(dialog.locator('.bot-create-host strong')).toHaveText('Assistant acceptance host');
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/me/bots' && response.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Create assistant', exact: true }).click();
      const response = await responsePromise; expect(response.status()).toBe(200);
      const bot = await response.json() as BotDefinition; created.push(bot);
      expect(response.request().postDataJSON()).toEqual({ id: bot.id, name });
      expect(bot.workerId).toBe(workerId); expect(bot.resolvedConfiguration.cwd).toBe('/assistant-acceptance');
      expect(bot.startupResult.state).toBe('pending'); expect(bot.sessionId).toBeNull();
      await expect(page).toHaveURL(`${baseURL}/bots/${bot.id}`);
      controllers.push(await openBotController(api, baseURL, bot));
      await page.locator('.bot-list-panel').getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(message()).toBeEnabled();
      await expect(pane().locator('.session-entry')).toHaveCount(30);
    }
    const [a, b] = created as [BotDefinition, BotDefinition];
    await choose(a); await message().fill('Draft A retained');
    const original = await message().elementHandle();
    const shell = await page.locator('.bot-session-host').elementHandle();
    const timeline = pane().locator('.session-timeline');
    const bottom = await timeline.evaluate(node => node.scrollTop);
    await timeline.hover(); await page.mouse.wheel(0, -600);
    await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBe(Math.max(0, bottom - 600));
    await expect(pane().locator('.session-latest')).toBeVisible();
    const anchor = await timeline.evaluate(node => { const top = node.getBoundingClientRect().top; const entry = [...node.querySelectorAll<HTMLElement>('[data-entry-key]')].find(entry => entry.getBoundingClientRect().bottom > top + 1)!; return { key: entry.dataset.entryKey!, offset: entry.getBoundingClientRect().top - top }; });
    await choose(b); await message().fill('Draft B retained');
    await choose(a); await expect(message()).toHaveValue('Draft A retained');
    expect(await message().evaluate((node, original) => node === original, original)).toBe(true);
    expect(await page.locator('.bot-session-host').evaluate((node, original) => node === original, shell)).toBe(true);
    const restored = await timeline.locator(`[data-entry-key="${anchor.key}"]`).evaluate(node => node.getBoundingClientRect().top - node.closest('.session-timeline')!.getBoundingClientRect().top);
    expect(Math.abs(restored - anchor.offset)).toBeLessThanOrEqual(3);

    const headings: unknown[] = [];
    for (const width of [320, 390, 768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const locale of ['en', 'zh-CN']) {
        await page.locator('.topbar').getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
        const opener = page.getByRole('button', { name: a.name, exact: true });
        await expect(opener).toHaveAttribute('aria-expanded', 'false');
        const bounds = await expectBotHeading(page);
        headings.push({ width, locale, bounds });
        await expect(page.locator('.bot-conversation-heading .bot-status')).toContainText(locale === 'en' ? 'Started' : '已启动');
        await expect(page.locator('.bot-conversation-heading .bot-status')).toContainText('Assistant acceptance host');
        await opener.focus(); await page.keyboard.press('Enter');
        await expect(opener).toHaveAttribute('aria-expanded', 'true');
        const details = page.getByRole(width <= 1000 ? 'dialog' : 'complementary', { name: locale === 'en' ? 'Assistant details' : '助手详情', exact: true });
        await expect(details).toContainText('/assistant-acceptance');
        await expect(details.getByRole('button', { name: locale === 'en' ? 'Close assistant details' : '关闭助手详情', exact: true })).toBeFocused();
        await page.keyboard.press('Escape'); await expect(details).not.toBeVisible(); await expect(opener).toBeFocused();
        await expect(pane().getByRole('textbox')).toHaveValue('Draft A retained');
        expect(await pane().getByRole('textbox').evaluate((node, original) => node === original, original)).toBe(true);
        expect(await page.locator('.bot-session-host').evaluate((node, original) => node === original, shell)).toBe(true);
        expect(controllers[0]!.commands).toEqual([]); expect(controllers[1]!.commands).toEqual([]);
      }
    }
    await page.locator('.topbar').getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const opener = page.getByRole('button', { name: a.name, exact: true });
      await opener.click();
      const details = page.getByRole(viewport.width === 390 ? 'dialog' : 'complementary', { name: 'Assistant details', exact: true });
      await expect(details).toContainText('/assistant-acceptance'); await expect(details).toContainText('Codex');
      await page.keyboard.press('Escape'); await expect(details).not.toBeVisible(); await expect(opener).toBeFocused();
      expect(await message().evaluate((node, original) => node === original, original)).toBe(true);
      await pane().getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click();
      await opener.click(); await page.keyboard.press('Escape');
      await expect(page.locator('.bot-conversation')).toHaveAttribute('data-session-fullscreen', 'true');
      await page.keyboard.press('Escape'); await expect(page.locator('.bot-conversation')).not.toHaveAttribute('data-session-fullscreen');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const path = info.outputPath(`assistant-${viewport.width}.png`); await page.screenshot({ path }); await info.attach(`assistant-${viewport.width}`, { path, contentType: 'image/png' });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await choose(b); await expect(message()).toHaveValue('Draft B retained');
    allowBrowserWrites([{ method: 'POST', url: new URL(`/api/v1/test-sessions/${controllers[1]!.sessionId}/commands`, baseURL).href, count: 1 }]);
    await message().fill('Send only to assistant B'); await pane().getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => controllers[1]!.commands.length).toBe(1);
    expect(controllers[0]!.commands).toEqual([]);
    expect(controllers[1]!.commands[0]).toMatchObject({ sessionId: controllers[1]!.sessionId, kind: 'send_message', payload: { content: [{ type: 'text', text: 'Send only to assistant B' }] } });
    await expect(message()).toHaveValue('');
    await page.getByRole('link', { name: 'Close conversation', exact: true }).click();
    expect((await page.reload())?.status(), 'Assistant list reload serves the production application').toBe(200);
    await choose(a); await expect(message()).toHaveValue('Draft A retained');
    expect(controllers[0]!.commands).toEqual([]); expect(controllers[1]!.commands).toHaveLength(1);
    await page.getByRole('link', { name: 'Close conversation', exact: true }).click();
    allowBrowserWrites([{ method: 'DELETE', url: new URL(`/api/v1/me/bots/${a.id}`, baseURL).href, count: 1 }]);
    await page.getByRole('button', { name: `More actions for ${a.name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete assistant', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete assistant', exact: true }).click();
    await expect(page.getByText('Waiting for cleanup', { exact: true })).toBeVisible();
    const barrier = await api.get(`/api/v1/test-sessions/${controllers[0]!.sessionId}`); expect(barrier.status()).toBe(409);
    await controllers[0]!.remove();
    await expect(page.getByText('Deletion completed', { exact: true })).toBeVisible({ timeout: 15_000 });
    expect((await page.goto(`/bots/${a.id}`))?.status(), 'Deleted assistant URL still serves the application').toBe(200);
    await expect(page.locator('.bots-page')).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    const denied = await api.get(`/api/v1/test-sessions/${controllers[0]!.sessionId}`); expect(denied.status()).toBe(404);
    expect((await page.goto(`/test-sessions/${controllers[0]!.sessionId}`))?.status()).toBe(200);
    await expect(page.locator('.session-entry')).toHaveCount(0); await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
    const preserved = await api.get(`/api/v1/projects/${project.id}/tasks/${task.id}`); expect(preserved.status()).toBe(200); expect(await preserved.json()).toEqual(task);
    expect((await page.goto(`/bots/${b.id}`))?.status(), 'Assistant detail URL serves the production application').toBe(200);
    await expect(message()).toBeEnabled(); await expect(pane().locator('.session-entry')).toHaveCount(30);
    const evidence = info.outputPath('assistant-composition.json');
    await writeFile(evidence, JSON.stringify({ boundary: 'Production App, HTTP management, PostgreSQL and WebSocket relay with a controlled writer; no native Provider or Worker process.', workerId, legacyWorkerId, bots: controllers.map(controller => ({ botId: controller.botId, sessionId: controller.sessionId, commands: controller.commands.length })), independentTask: task.id, headings, originalNodesRetained: true, deletionBarrier: barrier.status(), deletedHistoryDenied: denied.status() }, null, 2));
    await info.attach('assistant-composition', { path: evidence, contentType: 'application/json' });
  } finally {
    const cleanup = await Promise.allSettled(controllers.map(controller => controller.remove()));
    const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Controlled Bot writers or histories were not cleaned.');
  }
});
