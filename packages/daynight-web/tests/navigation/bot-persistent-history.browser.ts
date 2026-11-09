import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { BOT_TIME, BOT_USER, botDefaults, botDefinition, botId } from '../helpers/bots';
import type {} from './bots-viewport-session';

const namespace = `daynight:bot-display:v1:${BOT_USER}`;
const personal = { id: botId(100), kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Persistent browser fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personal.id, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const bots = Array.from({ length: 4 }, (_, index) => ({ ...botDefinition(index + 1), name: `Persistent assistant ${index + 1}`, sessionId: botId(index + 201), testExecutionId: botId(index + 401), roleConfiguration: { instructions: 'Browser fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } }));
const selected = '.bot-session-pane:not([hidden])';
const timeline = `${selected} .session-timeline`;
const row = `${selected} [data-entry-key]`;
const entryId = (n: number) => `30000000-0000-4000-8000-${String(10000 + n).padStart(12, '0')}`;

async function install(page: Page) {
  let holdDetail = false, missing = false;
  const pending: (() => void)[] = [], writes: string[] = [];
  await page.addInitScript(() => {
    const restored = sessionStorage.getItem('b2-history-barriers') === 'true';
    window.botViewportOptions = { scenario: 'persistent', holdCurrent: restored, holdHistory: restored, revision: restored ? '2' : '1' };
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER } });
    if (request.method() !== 'GET' && !path.endsWith('/readonly/requests')) writes.push(`${request.method()} ${path}`);
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personal.id}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: bots, nextCursor: null });
    const bot = bots.find(value => path === `/api/v1/me/bots/${value.id}`);
    if (bot && holdDetail) await new Promise<void>(resolve => pending.push(resolve));
    if (bot && !missing) return send(bot);
    return send({ error: { code: 'not_found', message: 'Assistant is unavailable.', requestId: 'persistent-browser' } }, 404);
  });
  return { writes, hold() { holdDetail = true; }, release() { holdDetail = false; pending.splice(0).forEach(resolve => resolve()); }, missing() { missing = true; } };
}

async function saved(page: Page, target = bots[0]!.id) {
  await expect.poll(() => page.evaluate(({ namespace, target }) => {
    const raw = localStorage.getItem(namespace);
    if (!raw) return 0;
    return (JSON.parse(raw).records as { preview: { botId: string; entries: unknown[] } }[]).find(record => record.preview.botId === target)?.preview.entries.length ?? 0;
  }, { namespace, target })).toBe(100);
}

async function anchor(page: Page) {
  return page.locator(timeline).evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const entry = [...node.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.getBoundingClientRect().bottom > top + 1)!;
    return { key: entry.dataset.entryKey!, offset: entry.getBoundingClientRect().top - top };
  });
}

for (const width of [1440, 390, 320]) {
  test(`persists real history and preserves preview DOM through all cold stages at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await install(page), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/bots/${bots[0]!.id}`);
    await expect(page.locator(row)).toHaveCount(100);
    await saved(page);
    // The following document has no previous JS realm. Storage is written by
    // the production observer from accepted history, never seeded by the test.
    const disk = await page.evaluate(key => localStorage.getItem(key), namespace);
    expect(disk).toContain('Persistent message 100');
    await page.evaluate(() => sessionStorage.setItem('b2-history-barriers', 'true'));
    api.hold();
    await page.reload();
    await expect(page.locator(row)).toHaveCount(100);
    expect(await page.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(0);
    expect(await page.evaluate(() => window.botViewport.metrics.resourceReads)).toBe(0);
    await expect(page.locator(`${selected} button`).filter({ hasText: /Download/ })).toHaveCount(0);
    await expect(page.locator(`${selected} .bot-conversation-empty`)).toHaveCount(0);
    await expect(page.locator(`${selected} textarea:enabled`)).toHaveCount(0);
    const originalTimeline = await page.locator(timeline).elementHandle();
    const originalRow = await page.locator(`${row}[data-entry-key="${entryId(80)}"]`).elementHandle();
    await page.locator(timeline).hover();
    await page.mouse.wheel(0, -900);
    await expect(page.locator(`${selected} .session-latest`)).toBeVisible();
    await page.locator(timeline).evaluate(node => { node.scrollTop = node.scrollHeight * 0.6; node.dispatchEvent(new Event('scroll')); });
    const reading = await anchor(page);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
    api.release();
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(1);
    await expect(page.locator(row)).toHaveCount(100);
    expect(await page.locator(timeline).evaluate((node, original) => node === original, originalTimeline)).toBe(true);
    await page.evaluate(() => window.botViewport.releaseCurrent());
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.tail)).toBeGreaterThan(0);
    await expect(page.locator(row)).toHaveCount(100);
    expect(await page.locator(`${row}[data-entry-key="${entryId(80)}"]`).evaluate((node, original) => node === original, originalRow)).toBe(true);
    expect(await page.evaluate(() => window.botViewport.metrics.resourceReads)).toBe(0);
    await page.evaluate(() => window.botViewport.releaseHistory());
    await expect(page.locator(`${row}[data-entry-key="${entryId(80)}"]`)).toContainText('Revision 2');
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.resourceReads)).toBeGreaterThan(0);
    await expect(page.locator(row)).toHaveCount(100);
    expect(await page.locator(timeline).evaluate((node, original) => node === original, originalTimeline)).toBe(true);
    expect(await page.locator(`${row}[data-entry-key="${entryId(80)}"]`).evaluate((node, original) => node === original, originalRow)).toBe(true);
    const restored = await anchor(page);
    expect(restored.key).toBe(reading.key);
    expect(Math.abs(restored.offset - reading.offset)).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    expect(api.writes).toEqual([]); expect(errors).toEqual([]);
    const evidence = { boundary: 'Production app/client/store/renderer; controlled HTTP and SessionApi; real Chrome localStorage and document reload, no real Worker/Provider.', width, reading, restored, writes: api.writes, errors };
    await page.screenshot({ path: info.outputPath(`persistent-${width}.png`) });
    const path = info.outputPath(`persistent-${width}.json`);
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await info.attach('persistent-history', { path, contentType: 'application/json' });
  });
}

test('recovers persisted history after closing the page and evicting the fourth pane', async ({ context, page }) => {
  await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  await page.close();
  const reopened = await context.newPage(), api = await install(reopened);
  await reopened.addInitScript(() => { window.botViewportOptions = { scenario: 'persistent', holdCurrent: true, holdHistory: true }; });
  api.hold();
  await reopened.goto(`/bots/${bots[0]!.id}`);
  await expect(reopened.locator(row)).toHaveCount(100);
  expect(await reopened.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(0);
  api.release();
  await reopened.evaluate(() => { window.botViewport.releaseCurrent(); window.botViewport.releaseHistory(); });
  await expect(reopened.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  for (const bot of bots.slice(1)) {
    await reopened.getByRole('link', { name: new RegExp(`^${bot.name} `) }).click();
    await saved(reopened, bot.id);
  }
  expect(await reopened.locator('.bot-session-pane').count()).toBe(3);
  const closed = await reopened.evaluate(() => window.botViewport.metrics.closed);
  expect(closed).toBeGreaterThan(0);
  api.hold();
  await reopened.getByRole('link', { name: new RegExp(`^${bots[0]!.name} `) }).click();
  await expect(reopened.locator(row)).toHaveCount(100);
  expect(await reopened.evaluate(() => window.botViewport.metrics.channels - window.botViewport.metrics.closed)).toBeLessThanOrEqual(3);
  api.release();
  expect(api.writes).toEqual([]);
});

test('withdraws a cold preview across tabs after an authoritative missing target', async ({ context, page }) => {
  const api = await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  const peer = await context.newPage(), peerApi = await install(peer);
  peerApi.hold();
  await peer.goto(`/bots/${bots[0]!.id}`);
  await expect(peer.locator(row)).toHaveCount(100);
  api.missing();
  await page.reload();
  await expect.poll(() => peer.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw).records.length : 0;
  }, namespace)).toBe(0);
  await expect(peer.locator(row)).toHaveCount(0);
  peerApi.release();
  await peer.close();
});

test('does not feed cross-tab storage reads back into repeated LRU writes', async ({ context, page }) => {
  await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  const peer = await context.newPage(); await install(peer);
  await peer.goto(`/bots/${bots[1]!.id}`); await saved(peer, bots[1]!.id);
  // Both production observers have flushed, and both accounts have seen the
  // other tab's real storage event. A bounded idle observation detects a
  // read->LRU-write feedback loop without manufacturing events in the test.
  await page.waitForTimeout(2_500);
  const before = await Promise.all([page, peer].map(tab => tab.evaluate(() => window.botViewport.metrics.snapshotWrites)));
  await page.waitForTimeout(500);
  const after = await Promise.all([page, peer].map(tab => tab.evaluate(() => window.botViewport.metrics.snapshotWrites)));
  expect(after).toEqual(before);
  expect(after.reduce((sum, count) => sum + count, 0)).toBeLessThan(12);
  await peer.close();
});

test('keeps a product return path after access loss on a 320px cold target', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const api = await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  api.missing(); await page.reload();
  const back = page.getByRole('link', { name: 'Back to assistants', exact: true });
  await expect(back).toBeVisible();
  await expect(page.locator(row)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await back.click();
  await expect(page.locator('.bot-list')).toBeVisible();
  await expect(page).toHaveURL(/\/bots$/);
});
