import { expect, test, type Page } from '@playwright/test';
import type { BotDefinition } from '../../src/api/bots';
import type { BotObservation } from '../../src/api/bot-observation';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import { botDetails, botDetailsOpener, expectBotDetailText, expectBotHeading } from '../helpers/bot-heading';
import type {} from './bots-viewport-session';

const machine = 'Office-长期助手恢复机器-' + 'WindowsWorkstation'.repeat(5);
const definition = (n: number): BotDefinition => ({ ...botDefinition(n), name: `Observed assistant ${n}`, sessionId: botId(n + 200), testExecutionId: botId(n + 400), roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready', code: null } });
const observation = (bot: BotDefinition, patch: Partial<BotObservation> = {}): BotObservation => ({
  schemaVersion: 1, botId: bot.id, botVersion: bot.version, workerId: botId(21), machine: { id: botId(121), name: machine }, provider: 'codex',
  sessionId: bot.sessionId, testExecutionId: bot.testExecutionId, nativeSessionId: `native-${bot.id}`, hostingGeneration: '2', executionGeneration: '3', connectionEpoch: '4',
  state: 'idle', reason: 'idle', observedAt: BOT_TIME, workerLastSeenAt: BOT_TIME, sessionLastSeenAt: BOT_TIME, freshUntil: '2026-11-04T12:01:00Z', currentTurnId: null, ...patch,
});

async function install(page: Page, definitions: readonly BotDefinition[], values: ReadonlyMap<string, BotObservation>) {
  const personalId = botId(100), personal = { id: personalId, kind: 'personal', name: null };
  let unavailable = false;
  const reads = new Map<string, number>();
  await page.addInitScript(() => { window.botViewportOptions = { scenario: 'empty' }; });
  await page.route('**/api/v1/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(request.headers(), status) } });
    if (path === '/api/v1/me') return send({ id: BOT_USER, personalTeam: personal, name: 'Observation fixture', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams' || path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: definitions, nextCursor: null });
    if (path === `/api/v1/me/workers/${botId(21)}/alias`) return send({ workerId: botId(21), alias: { value: null, version: '1' } });
    for (const bot of definitions) {
      if (path === `/api/v1/me/bots/${bot.id}`) return send(bot);
      if (path === `/api/v1/me/bots/${bot.id}/observation`) {
        reads.set(bot.id, (reads.get(bot.id) ?? 0) + 1);
        return unavailable ? send({ error: { code: 'capability_error', message: 'Observation unavailable', requestId: 'observation-fixture' } }, 503) : send(values.get(bot.id));
      }
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'observation-fixture' } }, 404);
  });
  return { reads, failObservations: () => { unavailable = true; } };
}

for (const locale of ['en', 'zh-CN']) for (const width of [1440, 390, 320]) {
  test(`keeps observed location readable and details keyboard-accessible at ${width}px in ${locale}`, async ({ page }, info) => {
    const bot = definition(1), value = observation(bot, { state: 'abnormal', reason: 'provider_unavailable' });
    await install(page, [bot], new Map([[bot.id, value]]));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/bots');
    await page.locator('.locale-control select').selectOption(locale);
    const row = page.locator(`.bot-list a[href="/bots/${bot.id}"]`);
    await expect(row.locator('.bot-status > span').first()).toHaveText(locale === 'en' ? 'Abnormal' : '异常');
    await expect(row.locator('.bot-observation-machine')).toHaveText(machine);
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await row.click();
    await expectBotHeading(page, bot.name);
    await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText(locale === 'en' ? 'Abnormal' : '异常');
    const opener = botDetailsOpener(page, bot.name);
    await opener.focus(); await page.keyboard.press('Enter');
    const details = botDetails(page);
    await expect(details).toBeVisible();
    await expect(details.locator('.bot-status > span').first()).toHaveText(locale === 'en' ? 'Abnormal' : '异常');
    await expectBotDetailText(details, machine);
    await expect(details.getByText('provider_unavailable', { exact: true })).toBeVisible();
    await expect(details.getByText(locale === 'en' ? 'On this machine, check that the selected Provider is installed and signed in, then check the Worker report again.' : '请在这台机器检查所选 Provider 的安装与登录状态，然后重新核对 Worker 报告。', { exact: true })).toBeVisible();
    await expect(details.getByText(value.nativeSessionId!, { exact: true })).toBeVisible();
    expect(await details.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`bot-observation-${locale}-${width}.png`) });
    await page.keyboard.press('Tab');
    if (await details.evaluate(node => node.matches(':modal'))) expect(await details.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0); await expect(opener).toBeFocused();
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  });
}

test('keeps same-machine Bot states independent and shows first native identity as pending', async ({ page }) => {
  const first = definition(1), second = definition(2), pending = definition(3);
  await install(page, [first, second, pending], new Map([
    [first.id, observation(first, { state: 'working', reason: 'working', currentTurnId: 'current-turn' })],
    [second.id, observation(second)],
    [pending.id, observation(pending, { state: 'connecting', reason: 'native_session_pending', nativeSessionId: null })],
  ]));
  await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/bots');
  const row = (bot: BotDefinition) => page.locator(`.bot-list a[href="/bots/${bot.id}"]`);
  await expect(row(first).locator('.bot-status > span').first()).toHaveText('Working');
  await expect(row(second).locator('.bot-status > span').first()).toHaveText('Online · idle');
  await expect(row(pending).locator('.bot-status > span').first()).toHaveText('Connecting');
  await row(pending).click(); await botDetailsOpener(page, pending.name).click();
  const details = botDetails(page);
  await expect(details.getByText('Waiting for the first native Session ID.')).toBeVisible();
  await expect(details.locator('dl > div').filter({ has: page.locator('dt').filter({ hasText: /^Native Session ID$/ }) }).locator('dd')).toHaveText('Unknown');
  await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText('Connecting');
});

test('expires all presentations together while retaining timestamped location on a failed refresh', async ({ page }) => {
  const bot = definition(1), value = observation(bot, { state: 'working', reason: 'working', currentTurnId: 'turn', freshUntil: '2026-11-04T12:00:03Z' });
  const control = await install(page, [bot], new Map([[bot.id, value]]));
  await page.clock.install(); await page.setViewportSize({ width: 1600, height: 900 }); await page.goto(`/bots/${bot.id}`);
  await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText('Working');
  await botDetailsOpener(page, bot.name).click();
  control.failObservations(); await page.clock.fastForward(3_001);
  const details = botDetails(page);
  await expect(page.locator(`.bot-list a[href="/bots/${bot.id}"] .bot-status > span`).first()).toHaveText('Observation out of date');
  await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText('Observation out of date');
  await expect(details.locator('.bot-status > span').first()).toHaveText('Observation out of date');
  await expect(details.getByText(machine, { exact: true })).toBeVisible();
  await expect(details.locator(`time[datetime="${BOT_TIME}"]`).first()).toBeVisible();
  await expect.poll(() => control.reads.get(bot.id) ?? 0).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
});

for (const width of [1440, 320]) {
  test(`preserves the Session description for the composer without duplicating visible status at ${width}px`, async ({ page }, info) => {
    const bot = definition(1);
    await install(page, [bot], new Map([[bot.id, observation(bot)]]));
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/bots/${bot.id}`);
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(input).toBeEnabled();
    await expect(input).toHaveAccessibleDescription('Ready');
    const descriptionId = await input.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    const description = page.locator('.bot-session-description .session-status');
    await expect(description).toHaveCount(1);
    await expect(description).toHaveAttribute('id', descriptionId!);
    await expect(description).toHaveAttribute('role', 'status');
    await expect(description).toHaveText('Ready');
    const visibleStatus = page.locator('.bot-header-state .bot-status');
    await expect(visibleStatus).toHaveCount(1);
    await expect(visibleStatus.locator('> span').first()).toHaveText('Online · idle');
    await expect(page.locator('.bot-header-state')).not.toContainText('Ready');
    const geometry = await page.locator('.bot-session-description').evaluate(node => {
      const element = node as HTMLElement, style = getComputedStyle(element);
      const header = element.closest('header')!;
      const rect = () => ({ header: header.getBoundingClientRect().toJSON(), title: header.querySelector('h2')!.getBoundingClientRect().toJSON() });
      const before = rect(), hidden = { position: style.position, overflow: style.overflow, clipPath: style.clipPath, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height, ariaHidden: element.getAttribute('aria-hidden') };
      element.style.display = 'none'; const withoutDescription = rect(); element.style.removeProperty('display');
      return { hidden, before, withoutDescription };
    });
    expect(geometry.hidden).toEqual({ position: 'absolute', overflow: 'hidden', clipPath: 'inset(50%)', width: 1, height: 1, ariaHidden: null });
    expect(geometry.withoutDescription).toEqual(geometry.before);
    await expect(input).toHaveAccessibleDescription('Ready');
    expect(await page.evaluate(id => [...document.querySelectorAll('[id]')].filter(node => node.id === id).length, descriptionId)).toBe(1);
    await info.attach('composer-status-description', { body: JSON.stringify({ width, descriptionId, accessibleDescription: 'Ready', visibleBotStatus: 'Online · idle', geometry }), contentType: 'application/json' });
  });
}
