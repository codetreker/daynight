import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
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
  const pending = new Set<string>(), requests = new Map<string, number>();
  let gate: Promise<void> | null = null, release = () => {};
  await page.addInitScript(() => { window.botViewportOptions = { scenario: 'empty' }; });
  await page.route('**/api/v1/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(request.headers(), status) } });
    const read = async (json: unknown, status = 200) => {
      requests.set(path, (requests.get(path) ?? 0) + 1);
      if (gate) { pending.add(path); await gate; pending.delete(path); }
      return send(json, status);
    };
    if (path === '/api/v1/me') return send({ id: BOT_USER, personalTeam: personal, name: 'Observation fixture', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams' || path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/assistant-tasks' || path === '/api/v1/assistant-task-events') return send({ items: [], nextCursor: null, observedAt: BOT_TIME });
    if (path === `/api/v1/teams/${personalId}`) return send({ ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } });
    if (path === '/api/v1/me/bots/defaults') return read(botDefaults());
    if (path === '/api/v1/me/bots') return read({ items: definitions, nextCursor: null });
    if (path === `/api/v1/me/workers/${botId(21)}/alias`) return send({ workerId: botId(21), alias: { value: null, version: '1' } });
    for (const bot of definitions) {
      if (path === `/api/v1/me/bots/${bot.id}`) return read(bot);
      if (path === `/api/v1/me/bots/${bot.id}/observation`) {
        reads.set(bot.id, (reads.get(bot.id) ?? 0) + 1);
        return unavailable ? read({ error: { code: 'capability_error', message: 'Observation unavailable', requestId: 'observation-fixture' } }, 503) : read(values.get(bot.id));
      }
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'observation-fixture' } }, 404);
  });
  return { reads, pending, requests, failObservations: () => { unavailable = true; }, recoverObservations: () => { unavailable = false; },
    hold: () => { expect(gate).toBeNull(); gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => { gate = null; release(); },
  };
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
  const values = new Map([[bot.id, value]]), control = await install(page, [bot], values);
  await page.clock.install(); await page.setViewportSize({ width: 1600, height: 900 }); await page.goto(`/bots/${bot.id}`);
  await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText('Working');
  await botDetailsOpener(page, bot.name).click();
  control.failObservations(); await page.clock.fastForward(3_001);
  const details = botDetails(page);
  await expect(page.locator(`.bot-list a[href="/bots/${bot.id}"] .bot-status > span`).first()).toHaveText('Expired');
  await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText('Observation out of date');
  await expect(details.locator('.bot-status > span').first()).toHaveText('Observation out of date');
  await expect(details.getByText(machine, { exact: true })).toBeVisible();
  await expect(details.locator(`time[datetime="${BOT_TIME}"]`).first()).toBeVisible();
  await expect.poll(() => control.reads.get(bot.id) ?? 0).toBeGreaterThan(1);
  control.recoverObservations();
  const refresh = page.locator('.bot-list-section .bot-refresh'), reads = control.reads.get(bot.id)!;
  await refresh.click(); await expect.poll(() => control.reads.get(bot.id) ?? 0).toBeGreaterThan(reads);
  await expect(refresh).toHaveAttribute('aria-busy', 'false');
  await expect(details.locator('.bot-status > span').first()).toHaveText('Observation out of date');
  values.set(bot.id, { ...value, observedAt: '2026-11-04T12:00:04Z', freshUntil: '2026-11-04T12:01:04Z',
    state: 'abnormal', reason: 'provider_unavailable', currentTurnId: null, machine: { id: botId(122), name: 'Recovered host' }, hostingGeneration: '3' });
  await refresh.click();
  await expect(details.locator('.bot-status > span').first()).toHaveText('Abnormal');
  await expect(page.locator('.bot-header-state .bot-status > span').first()).toHaveText('Abnormal');
  await expectBotDetailText(details, 'Recovered host');
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
});

for (const width of [1440, 390]) {
  test(`retains list and conversation through three delayed offline polls at ${width}px`, async ({ page }, info) => {
    const bots = [1, 2, 3, 4].map(definition), first = bots[0]!;
    const values = new Map(bots.map(bot => [bot.id, observation(bot, { state: 'offline', reason: 'worker_offline', freshUntil: null })]));
    const control = await install(page, bots, values);
    let documents = 0;
    page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
    await page.clock.install({ time: new Date(BOT_TIME) }); await page.clock.pauseAt(new Date(BOT_TIME));
    await page.setViewportSize({ width, height: 600 }); await page.goto('/bots');
    const rows = page.locator('.bot-list-item'), status = rows.first().locator('.bot-status > span').first();
    const refresh = page.locator('.bot-list-section .bot-refresh'), search = page.locator('.bot-search input');
    await expect(rows).toHaveCount(4); await expect(status).toHaveText('Offline');
    await search.fill('Observed assistant');
    await rows.nth(1).locator('.bot-more').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.locator('.bot-list-content').evaluate(node => { node.scrollTop = 30; });
    const retainedList = await page.evaluateHandle(() => ({
      rows: [...document.querySelectorAll('.bot-list-item')], list: document.querySelector('.bot-list-content')!,
      search: document.querySelector<HTMLInputElement>('.bot-search input')!, menu: document.querySelector('[role="menu"]')!,
      focus: document.activeElement,
    }));
    const listSnapshot = () => retainedList.evaluate(saved => ({
      rows: saved.rows.map(node => ({ top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })),
      scrollTop: saved.list.scrollTop, search: saved.search.value,
      sameNodes: saved.rows.every((node, index) => node === document.querySelectorAll('.bot-list-item')[index]),
      sameSearch: saved.search === document.querySelector('.bot-search input'),
      sameMenu: saved.menu === document.querySelector('[role="menu"]') && saved.menu.matches(':popover-open'),
      sameFocus: saved.focus === document.activeElement,
      busy: document.querySelector('.bot-list-section .bot-refresh')!.getAttribute('aria-busy'),
    }));
    const listBaseline = await listSnapshot(), evidence: unknown[] = [];
    expect(listBaseline.scrollTop).toBeGreaterThan(0);
    const newSamples = (round: number) => {
      for (const bot of bots) values.set(bot.id, { ...values.get(bot.id)!, observedAt: new Date(Date.parse(BOT_TIME) + round * 10_000).toISOString() });
    };
    for (let round = 1; round <= 3; round++) {
      const before = await listSnapshot(); control.hold(); newSamples(round);
      await page.clock.fastForward(5_001);
      await expect.poll(() => control.pending.size).toBe(6);
      await expect(status).toHaveText('Expired');
      await page.clock.fastForward(1_100);
      const pending = await listSnapshot();
      expect(pending).toEqual(listBaseline); await expect(refresh).toBeEnabled();
      if (round === 1) await page.screenshot({ path: info.outputPath(`delayed-list-${width}-pending.png`) });
      control.release(); await expect(status).toHaveText('Offline');
      const completed = await listSnapshot(); expect(completed).toEqual(listBaseline);
      evidence.push({ view: 'list', round, before, pending, completed });
    }
    await page.keyboard.press('Escape'); await search.focus();
    control.hold(); newSamples(4); await page.clock.fastForward(5_001);
    await expect.poll(() => control.pending.size).toBe(6);
    await expect(search).toBeFocused(); await expect(search).toHaveValue('Observed assistant');
    await expect(refresh).toHaveAttribute('aria-busy', 'false');
    const beforeManual = Object.fromEntries(control.requests);
    await refresh.click(); await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await expect(refresh).toBeDisabled(); expect(Object.fromEntries(control.requests)).toEqual(beforeManual);
    control.release(); await expect(refresh).toHaveAttribute('aria-busy', 'false'); await expect(status).toHaveText('Offline');
    await rows.first().locator('a').click();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await expect(composer).toBeEnabled(); await composer.fill('Draft survives background observations');
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.tail)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.channels)).toBe(1);
    await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(6, 14));
    const retainedSession = await page.evaluateHandle(() => ({
      input: document.querySelector<HTMLTextAreaElement>('.session-composer textarea')!,
      session: document.querySelector('.bot-conversation-session')!,
      channels: window.botViewport.metrics.channels, closed: window.botViewport.metrics.closed,
      bindings: window.botViewport.metrics.bindings.length, tail: window.botViewport.metrics.tail,
    }));
    const sessionSnapshot = () => retainedSession.evaluate(saved => ({
      sameInput: saved.input === document.querySelector('.session-composer textarea'),
      sameSession: saved.session === document.querySelector('.bot-conversation-session'),
      focused: document.activeElement === saved.input, draft: saved.input.value,
      selection: [saved.input.selectionStart, saved.input.selectionEnd],
      selected: document.querySelector('.bot-list a[aria-current]')!.getAttribute('href'),
      channels: window.botViewport.metrics.channels - saved.channels, closed: window.botViewport.metrics.closed - saved.closed,
      bindings: window.botViewport.metrics.bindings.length - saved.bindings, tail: window.botViewport.metrics.tail - saved.tail,
    }));
    const sessionBaseline = await sessionSnapshot();
    expect(sessionBaseline).toMatchObject({ sameInput: true, sameSession: true, focused: true, selected: `/bots/${first.id}`, selection: [6, 14] });
    for (let round = 5; round <= 7; round++) {
      const before = await sessionSnapshot(); control.hold(); newSamples(round);
      await page.clock.fastForward(5_001);
      await expect.poll(() => control.pending.size).toBe(7);
      await expect(status).toHaveText('Expired'); await page.clock.fastForward(1_100);
      const pending = await sessionSnapshot(); expect(pending).toEqual(sessionBaseline);
      if (round === 5) await page.screenshot({ path: info.outputPath(`delayed-session-${width}-pending.png`) });
      control.release(); await expect(status).toHaveText('Offline');
      const completed = await sessionSnapshot(); expect(completed).toEqual(sessionBaseline);
      evidence.push({ view: 'conversation', round: round - 4, before, pending, completed });
    }
    expect(documents).toBe(1); expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    await expect(page).toHaveURL(new RegExp(`/bots/${first.id}$`));
    const evidencePath = info.outputPath('delayed-observation-continuity.json');
    await writeFile(evidencePath, JSON.stringify({ width, documents, evidence }, null, 2));
    await info.attach('delayed-observation-continuity', { path: evidencePath, contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`delayed-observation-${width}.png`) });
    await retainedList.dispose(); await retainedSession.dispose();
  });
}

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
