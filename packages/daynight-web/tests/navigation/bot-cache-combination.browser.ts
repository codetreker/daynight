import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { BotHistoryWindowEntry } from '../../../daynight/src/session/bot-history-window';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import type { BotViewportOptions } from './bots-viewport-session';

const namespace = `daynight:bot-display:v1:${BOT_USER}`;
const personal = { id: botId(100), kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Cache combination fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personal.id, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const bots = Array.from({ length: 7 }, (_, index) => ({ ...botDefinition(index + 1), name: `Cached assistant ${index + 1}`, sessionId: botId(index + 201), testExecutionId: botId(index + 401), roleConfiguration: { instructions: 'Browser fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready' as const, code: null } }));
const pane = '.bot-session-pane:not([hidden])', rows = `${pane} [data-entry-key]`, timeline = `${pane} .session-timeline`;
const entryId = (sequence: number) => `30000000-0000-4000-8000-${String(10000 + sequence).padStart(12, '0')}`;

type HistoryWindowFixture = NonNullable<BotViewportOptions['historyWindow']>;

async function install(page: Page, pagination = false, windowFixture?: { historyWindow: HistoryWindowFixture; refuseSnapshotWrites?: boolean }) {
  let held = false, denied = false;
  const releases: (() => void)[] = [], writes: string[] = [];
  await page.addInitScript(({ pagination, windowFixture }) => {
    const restored = sessionStorage.getItem('b3-restored') === 'true';
    window.botViewportOptions = { scenario: 'persistent', holdCurrent: restored, holdHistory: restored, holdBefore: pagination, revision: restored ? '2' : '1', ...(pagination ? { persistentTail: { start: restored ? 51 : 1, end: 150 } } : {}) };
    if (windowFixture) {
      const offline = sessionStorage.getItem('b3-window-offline') === 'true';
      Object.assign(window.botViewportOptions, { ...windowFixture, historyEpoch: '20000000-0000-4000-8000-000000000910', ...(offline ? { historyWindow: { tail: 'controller_offline' } } : {}) });
    }
  }, { pagination, windowFixture });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers(), status) } });
    if (request.method() !== 'GET' && !path.endsWith('/readonly/requests')) writes.push(`${request.method()} ${path}`);
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personal.id}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: bots, nextCursor: null });
    const bot = bots.find(value => path === `/api/v1/me/bots/${value.id}`);
    if (bot && held) await new Promise<void>(resolve => releases.push(resolve));
    if (bot && !denied) return send(bot);
    return send({ error: { code: 'forbidden', message: 'Assistant access revoked.', requestId: 'cache-combination' } }, 403);
  });
  return { writes, hold() { held = true; }, release() { held = false; releases.splice(0).forEach(resolve => resolve()); }, deny() { denied = true; }, allow() { denied = false; } };
}

type Stored = { botId: string; historyEpoch: string; fence: { executionGeneration: string }; entries: { entryId: string; revision: string }[] };
const stored = (page: Page) => page.evaluate(key => {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw).records as { preview: Stored & { botHistoryWindow?: { entries: Stored['entries'] } } }[])
    .map(({ preview: { botHistoryWindow, ...preview } }) => ({ ...preview, entries: botHistoryWindow?.entries ?? preview.entries })) : [];
}, namespace);
const saved = (page: Page, bot = bots[0]!.id, count = 100) => expect.poll(async () => (await stored(page)).find(item => item.botId === bot)?.entries.length).toBe(count);
const gap = (page: Page) => page.locator(timeline).evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
async function attachJSON(name: string, value: unknown) {
  const path = test.info().outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { contentType: 'application/json', path });
}
async function evidence(page: Page, name: string) {
  await attachJSON(name, { boundary: 'Production App/client/observer/store/renderer; controlled HTTP and SessionApi; native browser storage, locks and DOM. No Worker/Provider or physical keyboard.', stored: await stored(page), metrics: await page.evaluate(() => window.botViewport.metrics) });
}

function windowEntry(sequence: number, preview: string, revision = '1', kind: BotHistoryWindowEntry['kind'] = 'assistant_message', truncated = false): BotHistoryWindowEntry {
  const bytes = new TextEncoder().encode(preview).length;
  return {
    entryId: entryId(sequence), entrySeq: String(sequence), revision, kind, preview, truncated,
    previewBytes: String(bytes), originalBytes: String(bytes + (truncated ? 100 : 0)),
    omissionReason: truncated ? 'preview_limit' : null, omittedEntryCount: 0, resourceIds: [],
    tool: kind === 'tool_call' ? { toolName: 'commandExecution', command: 'print-preview', cwd: '/fixture', status: 'completed', exitCode: 0 } : null,
  };
}

const windowTail = (items: readonly BotHistoryWindowEntry[], version: number, from: number, through: number, earlierHistoryUnavailable = false) => ({
  items, windowRevision: String(version), retainedFromSeq: String(from), throughSeq: String(through), earlierHistoryUnavailable,
  beforeCursor: null, hasEarlierHistory: false, nextCursor: `window-${version}`,
});

test('opens a read-only window snapshot and applies revisions and cursor reset', async ({ context, page }) => {
  const target = bots[0]!;
  const initial = [windowEntry(1, 'Earlier retained row'), windowEntry(2, 'Message 😀…', '1', 'assistant_message', true), windowEntry(3, 'Tool output 🧪…', '1', 'tool_call', true)];
  const fixture = { historyWindow: { tail: windowTail(initial, 1, 1, 3) } };
  const api = await install(page, false, fixture);
  await page.goto(`/bots/${target.id}`);
  await page.locator(pane).getByRole('button', { name: 'Display', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Standard' }).click();
  await expect(page.locator(rows)).toHaveCount(3);
  await saved(page, target.id, 3);
  const message = page.locator(`${rows}[data-entry-key="${entryId(2)}"]`);
  const tool = page.locator(`${rows}[data-entry-key="${entryId(3)}"]`);
  await expect(message).toContainText('Message 😀…');
  await expect(message.locator('[data-bot-history-omission="message"]')).toBeVisible();
  await tool.locator('summary').click();
  await expect(tool).toContainText('Tool output 🧪…');
  await expect(tool.locator('[data-bot-history-omission="tool"]')).toBeVisible();

  await page.evaluate(() => sessionStorage.setItem('b3-restored', 'true'));
  api.hold();
  await page.reload();
  await expect(message).toContainText('Message 😀…');
  await expect(page.locator(`${pane} .session-history-preview-label time`)).toBeVisible();
  await expect(page.locator(`${pane} button[type="submit"]:enabled`)).toHaveCount(0);
  expect(await page.evaluate(() => window.botViewport.windowRequests)).toEqual([]);
  const row = await message.elementHandle();
  api.release();
  await page.evaluate(() => { window.botViewport.releaseCurrent(); window.botViewport.releaseHistory(); });
  const draft = page.locator(`${pane} textarea`);
  await draft.fill('Local draft checks send admission');
  await expect(page.locator(`${pane} button[type="submit"]`)).toBeEnabled();
  await draft.clear();
  const revised = windowEntry(2, 'Same message revised 🎉…', '2', 'assistant_message', true);
  const updated = windowTail([initial[0]!, revised, initial[2]!], 2, 1, 3);
  await page.evaluate(({ id, updated }) => {
    Object.assign(window.botViewportOptions!, { historyWindow: { tail: updated, changes: {
      'window-1': { ...updated, nextCursor: 'window-2-scan' },
      'window-2-scan': { ...updated, items: [] },
    } } });
    window.botViewport.publishSnapshot(id, { lastEventSeq: '1' });
  }, { id: target.id, updated });
  await expect(message).toContainText('Same message revised 🎉…');
  await expect(message).toHaveCount(1);
  expect(await message.evaluate((node, before) => node === before, row)).toBe(true);
  expect(await page.evaluate(() => window.botViewport.windowRequests)).toContainEqual({ mode: 'changes', cursor: 'window-1' });

  await page.evaluate(({ id, tail }) => {
    Object.assign(window.botViewportOptions!, { historyWindow: { changes: { 'window-2': 'reset_required' }, tail } });
    window.botViewport.publishSnapshot(id, { lastEventSeq: '2', lastTimelineSeq: '4' });
  }, { id: target.id, tail: windowTail([revised, initial[2]!, windowEntry(4, 'Recent row after reset')], 3, 2, 4, true) });
  await expect(page.getByText('Recent row after reset')).toBeVisible();
  await expect(page.getByText('Earlier retained row')).toHaveCount(0);
  await expect(page.locator(`${timeline} [data-bot-history-gap]`)).toBeVisible();
  await expect.poll(async () => (await stored(page))[0]?.entries.map(entry => entry.entryId)).toEqual([entryId(2), entryId(3), entryId(4)]);
  const requests = await page.evaluate(() => window.botViewport.windowRequests);
  const rejected = requests.findIndex(request => request.mode === 'changes' && request.cursor === 'window-2');
  expect(rejected).toBeGreaterThanOrEqual(0);
  expect(requests.slice(rejected + 1)).toContainEqual({ mode: 'tail', cursor: null });

  const peer = await context.newPage();
  const peerApi = await install(peer, false, { historyWindow: { tail: 'controller_offline' } });
  await peer.goto(`/bots/${target.id}`);
  await expect(peer.getByText('Recent row after reset')).toBeVisible();
  await expect.poll(() => peer.evaluate(() => window.botViewport.windowRequests.length)).toBeGreaterThan(0);
  await peer.locator(`${pane} textarea`).fill('Offline local draft');
  await expect(peer.locator(`${pane} button[type="submit"]`)).toBeDisabled();
  api.deny();
  await page.bringToFront();
  await page.locator('.bot-refresh').click();
  await expect(peer.locator(rows)).toHaveCount(0);
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  expect(await peer.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  expect([...api.writes, ...peerApi.writes]).toEqual([]);
  await attachJSON('bot-window-requests', requests);
  await evidence(page, 'bot-window-revocation');
});

test('keeps accepted history readable when browser snapshot writes fail', async ({ page }) => {
  const target = bots[0]!;
  const api = await install(page, false, { historyWindow: { tail: windowTail([windowEntry(1, 'Live despite browser quota')], 1, 1, 1) }, refuseSnapshotWrites: true });
  await page.goto(`/bots/${target.id}`);
  await expect(page.getByText('Live despite browser quota')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.botViewport.metrics.snapshotWrites)).toBeGreaterThan(0);
  expect(await stored(page)).toEqual([]);

  await page.evaluate(() => sessionStorage.setItem('b3-window-offline', 'true'));
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.botViewport.windowRequests.length)).toBeGreaterThan(0);
  await expect(page.locator(rows)).toHaveCount(0);
  await expect(page.locator(`${pane} [data-bot-history-unavailable]`)).toBeVisible();
  await page.locator(`${pane} textarea`).fill('Offline local draft without a snapshot');
  await expect(page.locator(`${pane} button[type="submit"]`)).toBeDisabled();
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  expect(api.writes).toEqual([]);
  await evidence(page, 'bot-window-offline-without-cached-history');
});

test('hands persisted preview to real pagination without restoring a cancelled reading position', async ({ page }) => {
  const api = await install(page, true);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page, bots[0]!.id, 150);
  await page.evaluate(() => sessionStorage.setItem('b3-restored', 'true'));
  api.hold(); await page.reload();
  await expect(page.locator(rows)).toHaveCount(150);
  const originalTimeline = await page.locator(timeline).elementHandle(), originalRow = await page.locator(`${rows}[data-entry-key="${entryId(80)}"]`).elementHandle();
  api.release(); await page.evaluate(() => { window.botViewport.releaseCurrent(); window.botViewport.releaseHistory(); });
  await expect(page.locator(`${rows}[data-history-preview="true"]`)).toHaveCount(50);
  await page.locator(timeline).hover(); await page.mouse.wheel(0, -100_000);
  await expect.poll(() => page.evaluate(() => window.botViewport.metrics.before)).toBe(1);
  await page.locator(`${pane} .session-latest`).click();
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
  await page.evaluate(() => window.botViewport.releaseBefore());
  await expect(page.locator(`${rows}[data-history-preview="true"]`)).toHaveCount(0);
  await expect(page.locator(rows)).toHaveCount(150);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(3);
  expect(await page.locator(timeline).evaluate((node, previous) => node === previous, originalTimeline)).toBe(true);
  expect(await page.locator(`${rows}[data-entry-key="${entryId(80)}"]`).evaluate((node, previous) => node === previous, originalRow)).toBe(true);
  await page.evaluate(bot => { window.botViewport.upsert(bot, 80, '3', 'Revised authoritative row'); window.botViewport.upsert(bot, 151, '1', 'Appended authoritative row'); }, bots[0]!.id);
  await expect(page.locator(rows)).toHaveCount(151);
  await expect(page.locator(`${rows}[data-entry-key="${entryId(80)}"]`)).toContainText('Revised authoritative row');
  await expect.poll(async () => (await stored(page))[0]?.entries.find(entry => entry.entryId === entryId(80))?.revision).toBe('3');
  expect((await stored(page))[0]!.entries).toHaveLength(150);
  expect((await stored(page))[0]!.entries.at(-1)?.entryId).toBe(entryId(151));
  await page.evaluate(bot => {
    Object.assign(window.botViewportOptions!, { persistentTail: { start: 1, end: 0 }, lastEventSeq: '0' });
    window.botViewport.publishSnapshot(bot, { historyEpoch: 'empty-authoritative-history', lastEventSeq: '0', lastTimelineSeq: '0' });
  }, bots[0]!.id);
  await expect(page.locator(rows)).toHaveCount(0); await saved(page, bots[0]!.id, 0);
  await page.evaluate(bot => {
    Object.assign(window.botViewportOptions!, { persistentTail: { start: 1, end: 2 }, revision: '1' });
    window.botViewport.publishSnapshot(bot, { executionGeneration: '2', lastTimelineSeq: '2' });
  }, bots[0]!.id);
  await expect(page.locator(rows)).toHaveCount(2); await saved(page, bots[0]!.id, 2);
  expect((await stored(page))[0]!.fence.executionGeneration).toBe('2');
  expect((await stored(page))[0]!.historyEpoch).toBe('empty-authoritative-history');
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0); expect(api.writes).toEqual([]);
  await evidence(page, 'history-handoff');
});

test('bounds seven observed targets to three resident panes and six persisted histories', async ({ page }) => {
  const api = await install(page);
  await page.goto(`/bots/${bots[0]!.id}`);
  for (const [index, bot] of bots.entries()) {
    if (index) await page.getByRole('link', { name: new RegExp(`^${bot.name} `) }).click();
    await saved(page, bot.id);
    expect(await page.locator('.bot-session-pane').count()).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => window.botViewport.metrics.channels - window.botViewport.metrics.closed)).toBeLessThanOrEqual(3);
    expect((await stored(page)).length).toBeLessThanOrEqual(6);
  }
  expect((await stored(page)).map(item => item.botId).sort()).toEqual(bots.slice(1).map(bot => bot.id).sort());
  const created = await page.evaluate(() => window.botViewport.metrics.bindings.length);
  api.hold(); await page.getByRole('link', { name: new RegExp(`^${bots[1]!.name} `) }).click();
  await expect(page.locator(rows)).toHaveCount(100);
  expect(await page.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(created);
  api.release(); await expect(page.locator(`${pane} textarea`)).toBeEnabled();
  expect(await page.evaluate(() => window.botViewport.metrics.channels - window.botViewport.metrics.closed)).toBe(3);
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0); expect(api.writes).toEqual([]);
  await evidence(page, 'pane-and-disk-budgets');
});

declare global { interface Window { releaseCacheCombinationLock?: () => void } }
const holdLock = (page: Page) => page.evaluate(key => new Promise<void>(started => {
  const hold = new Promise<void>(release => { window.releaseCacheCombinationLock = release; });
  void navigator.locks.request(key, async () => { started(); await hold; });
}), namespace);
const pendingLocks = (page: Page) => page.evaluate(async key => (await navigator.locks.query()).pending?.filter(lock => lock.name === key).length ?? 0, namespace);
const lockState = (page: Page) => page.evaluate(async key => {
  const state = await navigator.locks.query();
  return { held: state.held?.filter(lock => lock.name === key) ?? [], pending: state.pending?.filter(lock => lock.name === key) ?? [] };
}, namespace);
const releaseLock = (page: Page) => page.evaluate(() => window.releaseCacheCombinationLock?.());

test('fences queued observer writes and cold reads through native locks and cross-tab revocation', async ({ page, context }) => {
  const api = await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  let peer = await context.newPage(), peerApi = await install(peer);
  const lockPhases: { phase: string; state: Awaited<ReturnType<typeof lockState>> }[] = [];
  peerApi.hold(); await peer.goto(`/bots/${bots[0]!.id}`);
  await expect(peer.locator(rows)).toHaveCount(100);
  try {
    await expect.poll(() => pendingLocks(page)).toBe(0);
    lockPhases.push({ phase: 'saved-history-and-peer-read-drained', state: await lockState(page) });
    await holdLock(page);
    await expect.poll(() => pendingLocks(page)).toBe(0);
    const held = await lockState(page), writer = held.held[0]!.clientId;
    lockPhases.push({ phase: 'native-lock-held-before-upsert', state: held });
    // Saving established the observer's lease. A same-identity upsert reuses
    // that lease, so its next native request is the throttled save, not observe.
    await page.evaluate(bot => window.botViewport.upsert(bot, 101, '1', 'Queued private history must not be persisted'), bots[0]!.id);
    await expect(page.locator(rows)).toHaveCount(101);
    await expect.poll(async () => (await lockState(page)).pending.some(lock => lock.clientId === writer)).toBe(true);
    lockPhases.push({ phase: 'accepted-observer-write-queued', state: await lockState(page) });
    api.deny(); await page.locator('.bot-refresh').click();
    await expect(page.locator(rows)).toHaveCount(0);
    await releaseLock(page);
    await expect.poll(async () => (await stored(page)).length).toBe(0);
    await expect(peer.locator(rows)).toHaveCount(0);
    expect(await peer.evaluate(() => window.botViewport.metrics.snapshotEvents.some(raw => raw?.includes('Queued private history must not be persisted')))).toBe(false);
    await evidence(peer, 'queued-write-revocation');
    peerApi.deny(); peerApi.release(); await peer.close();

    api.allow(); await page.reload(); await saved(page);
    await holdLock(page);
    api.deny(); await page.locator('.bot-refresh').click();
    await expect(page.locator(rows)).toHaveCount(0);
    await expect.poll(() => pendingLocks(page)).toBeGreaterThan(0);
    const clearing = await lockState(page);
    lockPhases.push({ phase: 'authoritative-clear-queued', state: clearing });
    peer = await context.newPage(); peerApi = await install(peer); peerApi.hold();
    await peer.goto(`/bots/${bots[0]!.id}`);
    // The target clear is queued first. The cold read must see its committed
    // revocation when the browser grants the next native lock.
    await expect.poll(() => pendingLocks(page)).toBeGreaterThanOrEqual(2);
    const reading = await lockState(page);
    expect(reading.pending.some(lock => lock.clientId !== clearing.pending[0]!.clientId)).toBe(true);
    lockPhases.push({ phase: 'cold-read-queued-after-clear', state: reading });
    await releaseLock(page);
    await expect.poll(async () => { const state = await lockState(page); return state.held.length + state.pending.length; }).toBe(0);
    lockPhases.push({ phase: 'clear-and-cold-read-completed', state: await lockState(page) });
    await expect.poll(async () => (await stored(peer)).length).toBe(0);
    await expect(peer.locator(rows)).toHaveCount(0);
    expect(await peer.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(0);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0); expect(api.writes).toEqual([]);
    await attachJSON('native-lock-barriers', lockPhases);
    await evidence(peer, 'native-lock-revocation');
  } finally { await releaseLock(page); peerApi.deny(); peerApi.release(); await peer.close(); }
});
