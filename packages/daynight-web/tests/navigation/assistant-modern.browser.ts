import { expect, test, type Page } from '@playwright/test';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import { focusBotControl } from '../helpers/bot-heading';
import type { BotViewportOptions } from './bots-viewport-session';

const personalId = botId(100), personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Assistant browser fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const assistant = { ...botDefinition(), name: 'Browser assistant', sessionId: botId(201), testExecutionId: botId(401), roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } };
const pane = '.bot-session-pane:not([hidden])';

async function install(page: Page, options?: BotViewportOptions) {
  if (options) await page.addInitScript(value => { window.botViewportOptions = value; }, options);
  const writes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers(), status) } });
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return send({ error: { code: 'method_not_allowed', message: 'No HTTP writes are expected.', requestId: 'assistant-browser-fixture' } }, 405);
    }
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: [assistant], nextCursor: null });
    if (path === `/api/v1/me/bots/${assistant.id}`) return send(assistant);
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'assistant-browser-fixture' } }, 404);
  });
  return writes;
}

async function open(page: Page, locale: 'en' | 'zh-CN') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/bots/${assistant.id}`);
  await page.locator('.locale-control select').selectOption(locale);
}

for (const locale of ['en', 'zh-CN'] as const) {
  // docs/spec/bot-session-view.md: display modes, reading and empty conversations;
  // focus, fullscreen and accessibility. Suggestions never dispatch a command.
  test(`fills an empty conversation draft from accessible suggestions in ${locale}`, async ({ page }, info) => {
    const writes = await install(page, { scenario: 'empty' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, locale);
    await page.setViewportSize({ width: 390, height: 844 });
    const welcome = page.locator('.bot-conversation-empty');
    await expect(welcome.getByRole('heading', { name: locale === 'en' ? 'Start with a conversation' : '从一段对话开始' })).toBeVisible();
    const suggestions = welcome.getByRole('button');
    await expect(suggestions).toHaveCount(3);
    const prompts = locale === 'en'
      ? ['Show me which tasks are running right now', 'Help me break this idea into smaller tasks', 'Help me work out what to prioritize today']
      : ['看看我现在有哪些任务在执行', '帮我把这个想法拆成几个小任务', '帮我梳理今天应该优先处理什么'];
    const input = page.locator(`${pane} textarea`);
    for (let index = 0; index < prompts.length; index++) {
      const suggestion = suggestions.nth(index);
      await expect(suggestion).toHaveAccessibleName(/\S/);
      const box = await suggestion.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      if (index === 1) { await focusBotControl(page, suggestion); await page.keyboard.press('Enter'); }
      else await suggestion.click();
      await expect(input).toHaveValue(prompts[index]!);
      await expect(input).toBeFocused();
      expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    }
    const motion = await page.locator('.bot-conversation-starters button, .session-composer-surface').evaluateAll(nodes => nodes.map(node => ({ transition: getComputedStyle(node).transitionDuration, animation: getComputedStyle(node).animationDuration })));
    expect(motion.every(value => value.transition.split(',').every(duration => parseFloat(duration) === 0) && value.animation.split(',').every(duration => parseFloat(duration) === 0))).toBe(true);
    expect(writes).toEqual([]);
    await page.screenshot({ path: info.outputPath(`empty-${locale}.png`) });
  });

  // docs/spec/bot-session-view.md: reading column and typography. The actual
  // renderer must contain overflow locally and preserve the 760px shared column.
  test(`contains long code and keeps the reading column aligned in ${locale}`, async ({ page }, info) => {
    const paragraph = locale === 'en' ? 'Readable assistant paragraph with enough text to wrap naturally. '.repeat(18) : '这是一段用于验证正常正文对比度与换行的中文助手回复。'.repeat(18);
    const code = `const longIdentifier = '${'unchanged_code_content_'.repeat(35)}';`;
    const writes = await install(page, { scenario: 'long', text: `Introductory response.\n\n${paragraph}\n\n\`\`\`ts\n${code}\n\`\`\`` });
    await open(page, locale);
    const input = page.locator(`${pane} textarea`), pre = page.locator(`${pane} .session-markdown pre`);
    await expect(input).toBeEnabled();
    await expect(pre).toContainText(code);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const readGeometry = () => page.locator(pane).evaluate(node => {
        const column = node.querySelector('.session-timeline-content')!.getBoundingClientRect();
        const composer = node.querySelector('.session-composer-surface')!.getBoundingClientRect();
        const block = node.querySelector('pre')!;
        return { column: column.toJSON(), composer: composer.toJSON(), codeWidth: block.clientWidth, codeScrollWidth: block.scrollWidth };
      });
      // ResizeObserver updates composer insets after the viewport resize; inspect
      // the settled column rather than a frame using the preceding width.
      await expect.poll(async () => {
        const geometry = await readGeometry();
        return Math.max(Math.abs(geometry.column.left - geometry.composer.left), Math.abs(geometry.column.right - geometry.composer.right));
      }).toBeLessThanOrEqual(1);
      const geometry = await readGeometry();
      expect(geometry.column.width).toBeLessThanOrEqual(760);
      expect(Math.abs(geometry.column.left - geometry.composer.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.column.right - geometry.composer.right)).toBeLessThanOrEqual(1);
      expect(geometry.codeScrollWidth).toBeGreaterThan(geometry.codeWidth);
      await pre.scrollIntoViewIfNeeded();
      await pre.hover();
      await page.mouse.wheel(600, 0);
      await expect.poll(() => pre.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
      expect(await page.evaluate(() => scrollX)).toBe(0);
      await page.screenshot({ path: info.outputPath(`reading-${locale}-${width}.png`) });
    }
    const contrast = await page.locator(`${pane} .session-markdown > p`).nth(1).evaluate(node => {
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (channels: number[]) => channels.map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
      let background: Element | null = node;
      while (background && getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement;
      const foreground = luminance(rgb(getComputedStyle(node).color));
      const behind = luminance(rgb(background ? getComputedStyle(background).backgroundColor : 'rgb(255, 255, 255)'));
      return (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  });

  // docs/spec/bot-session-view.md: history failures cannot become an empty
  // welcome, and completed archives retain reading without any write controls.
  test(`keeps history errors distinct from an empty conversation in ${locale}`, async ({ page }, info) => {
    const writes = await install(page, { scenario: 'error' });
    await open(page, locale);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(pane).getByRole('alert').filter({ hasText: 'Controlled history unavailable' })).toBeVisible();
    await expect(page.locator('.bot-conversation-empty')).toHaveCount(0);
    const input = page.locator(`${pane} textarea`);
    await expect(input).toBeVisible();
    await input.fill('Draft survives the visible history error');
    await expect(input).toBeFocused();
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    await page.screenshot({ path: info.outputPath(`history-error-${locale}.png`) });
  });

  test(`renders archived assistant history without write controls in ${locale}`, async ({ page }, info) => {
    const text = locale === 'en' ? 'The saved assistant response remains readable.' : '已保存的助手回复仍可阅读。';
    const writes = await install(page, { scenario: 'archive', text });
    await open(page, locale);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(pane).getByText(text, { exact: true })).toBeVisible();
    await expect(page.locator(pane).getByRole('status')).toContainText('Completed · Read-only history');
    await expect(page.locator(`${pane} textarea, ${pane} .session-composer, .bot-conversation-starters`)).toHaveCount(0);
    const metrics = await page.evaluate(() => window.botViewport.metrics);
    expect(metrics.archives).toBeGreaterThan(0);
    expect(metrics.archiveContents).toBeGreaterThan(0);
    expect(metrics.channels).toBe(0);
    expect(metrics.tail).toBe(0);
    expect(metrics.commands).toBe(0);
    expect(writes).toEqual([]);
    await page.screenshot({ path: info.outputPath(`archive-${locale}.png`) });
  });
}

test('retains the assistant DOM and draft when another page changes account', async ({ page, context }, info) => {
  const writes = await install(page);
  await open(page, 'en');
  const input = page.locator(`${pane} textarea`);
  await expect(input).toBeEnabled();
  await input.fill('Draft retained while confirming the same account');
  const original = await input.elementHandle(), timeline = await page.locator(`${pane} .session-timeline`).elementHandle();
  let rechecks = 0;
  await page.route('**/api/v1/me', async route => {
    rechecks++;
    await route.fulfill({ json: profile, headers: { 'Daynight-User-ID': BOT_USER } });
  });
  const other = await context.newPage();
  await other.route('**/api/v1/me', route => route.fulfill({ json: profile, headers: { 'Daynight-User-ID': BOT_USER } }));
  try {
    await other.goto('/bots');
    await other.evaluate(id => localStorage.setItem('daynight.activeUser', JSON.stringify(id)), botId(999));
    await expect(page.getByText('Account changed', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('Draft retained while confirming the same account');
    expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
    await expect(page.locator(`${pane} .session-actions button[type="submit"]`)).toBeDisabled();
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.closed)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    await page.screenshot({ path: info.outputPath('identity-paused.png') });
    await expect(input).toBeEnabled();
    await input.fill('Local edit after account change');
    await expect(input).toHaveValue('Local edit after account change');
    expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
    expect(await page.locator(`${pane} .session-timeline`).evaluate((node, before) => node === before, timeline)).toBe(true);
    expect(rechecks).toBe(0);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  } finally { await other.close(); }
});
