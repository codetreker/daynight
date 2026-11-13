import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
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

async function install(page: Page, tail: { readonly initialStart: number; readonly restoredStart: number; readonly end: number } | null = null, history: { readonly epoch: string; readonly revision: string; readonly lastEventSeq: string } | null = null) {
  let holdDetail = false, missing = false, noSession = false, replacement = false;
  const pending: (() => void)[] = [], writes: string[] = [];
  await page.addInitScript(({ tail, history }) => {
    const restored = sessionStorage.getItem('b2-history-barriers') === 'true';
    window.botViewportOptions = { scenario: 'persistent', holdCurrent: restored, holdHistory: restored, revision: history?.revision ?? (restored ? '2' : '1'), ...(history ? { historyEpoch: history.epoch, lastEventSeq: history.lastEventSeq } : {}), ...(tail ? { persistentTail: { start: restored ? tail.restoredStart : tail.initialStart, end: tail.end } } : {}) };
  }, { tail, history });
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
    if (bot && holdDetail) await new Promise<void>(resolve => pending.push(resolve));
    if (bot && !missing) return send(bot.id === bots[0]!.id && noSession ? { ...bot, sessionId: null, testExecutionId: null, roleConfiguration: null, startupResult: { state: 'pending', code: null } } : bot.id === bots[0]!.id && replacement ? { ...bot, sessionId: botId(901), testExecutionId: botId(902) } : bot);
    return send({ error: { code: 'not_found', message: 'Assistant is unavailable.', requestId: 'persistent-browser' } }, 404);
  });
  return { writes, hold() { holdDetail = true; }, release() { holdDetail = false; pending.splice(0).forEach(resolve => resolve()); }, missing() { missing = true; }, noSession() { noSession = true; }, replaceSession() { noSession = false; replacement = true; } };
}

async function saved(page: Page, target = bots[0]!.id, count = 100) {
  await expect.poll(() => page.evaluate(({ namespace, target }) => {
    const raw = localStorage.getItem(namespace);
    if (!raw) return 0;
    return (JSON.parse(raw).records as { preview: { botId: string; entries: unknown[] } }[]).find(record => record.preview.botId === target)?.preview.entries.length ?? 0;
  }, { namespace, target })).toBe(count);
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
    await expect(page.locator(row)).toHaveCount(100);
    expect(await page.locator(timeline).evaluate((node, original) => node === original, originalTimeline)).toBe(true);
    expect(await page.locator(`${row}[data-entry-key="${entryId(80)}"]`).evaluate((node, original) => node === original, originalRow)).toBe(true);
    const restored = await anchor(page);
    expect(restored.key).toBe(reading.key);
    expect(Math.abs(restored.offset - reading.offset)).toBeLessThanOrEqual(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
    expect(api.writes).toEqual([]); expect(errors).toEqual([]);
    const imageFrame = page.locator(`${row}[data-entry-key="${entryId(80)}"] .session-image-frame`);
    await imageFrame.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.resourceReads)).toBeGreaterThan(0);
    await expect.poll(() => imageFrame.locator('img').evaluateAll(nodes => nodes.map(node => {
      const image = node as HTMLImageElement;
      return { width: image.naturalWidth, height: image.naturalHeight };
    }))).toEqual([{ width: 3, height: 2 }]);
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

test('withdraws confirmed no-Session history and permits a later real Session', async ({ page }, info) => {
  const api = await install(page);
  await page.goto(`/bots/${bots[0]!.id}`);
  await saved(page);
  await page.evaluate(() => sessionStorage.setItem('b2-history-barriers', 'true'));
  api.hold(); api.noSession();
  await page.reload();
  await expect(page.locator(row)).toHaveCount(100);
  const pendingPreviewEntries = await page.locator(row).count();
  expect(await page.evaluate(() => window.botViewport.metrics.bindings.length)).toBe(0);
  api.release();
  await expect(page.locator(row)).toHaveCount(0);
  const targetEntries = () => page.evaluate(({ namespace, target }) => {
    const raw = localStorage.getItem(namespace);
    return raw ? (JSON.parse(raw).records as { preview: { botId: string } }[]).filter(record => record.preview.botId === target).length : 0;
  }, { namespace, target: bots[0]!.id });
  await expect.poll(targetEntries).toBe(0);
  await page.getByRole('link', { name: new RegExp(`^${bots[1]!.name} `) }).click();
  await page.getByRole('link', { name: new RegExp(`^${bots[0]!.name} `) }).click();
  await expect(page.locator(row)).toHaveCount(0);
  api.replaceSession();
  await page.locator('.bot-refresh').click();
  await expect.poll(() => page.evaluate(sessionId => window.botViewport.metrics.bindings.some(raw => JSON.parse(raw).sessionId === sessionId), botId(901))).toBe(true);
  await page.evaluate(() => { window.botViewport.releaseCurrent(); window.botViewport.releaseHistory(); });
  await expect(page.locator(row)).toHaveCount(100);
  await saved(page);
  api.noSession();
  await page.locator('.bot-refresh').click();
  await expect(page.locator(row)).toHaveCount(0);
  await expect.poll(targetEntries).toBe(0);
  const metrics = await page.evaluate(() => window.botViewport.metrics);
  expect(metrics.commands).toBe(0);
  expect(api.writes).toEqual([]);
  const path = info.outputPath('confirmed-no-session.json');
  await writeFile(path, JSON.stringify({ boundary: 'Production app/client/observer/store; controlled detail and SessionApi; real Chrome storage and reload.', pendingPreviewEntries, withdrawnEntries: await page.locator(row).count(), targetRecords: await targetEntries(), replacementSessionId: botId(901), metrics, writes: api.writes }, null, 2));
  await info.attach('confirmed-no-session', { path, contentType: 'application/json' });
});

async function drainSnapshots(page: Page) {
  await expect.poll(() => page.evaluate(async key => {
    const states = window.botViewport.observerStates();
    if (states.length === 0 || !states.every(state => !state.candidate && !state.timer && state.saving === 0)) return false;
    // Check observer state inside the store's actual shared lock: new polls may
    // enqueue work while a lock acquisition is pending.
    return navigator.locks.request(key, () => window.botViewport.observerStates().every(state => !state.candidate && !state.timer && state.saving === 0));
  }, namespace), { timeout: 10_000 }).toBe(true);
}

test('does not persist unchanged current polls after the observer and store drain', async ({ page }) => {
  await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  await drainSnapshots(page);
  const before = await page.evaluate(() => window.botViewport.metrics.snapshotWrites);
  const start = await page.evaluate(() => window.botViewport.metrics.currentCalls.length);
  for (let count = start + 1; count <= start + 2; count++) {
    const previousFlushes = await page.evaluate(() => window.botViewport.metrics.snapshotFlushes.length);
    const observation = await page.evaluate(() => Math.max(...window.botViewport.observerStates().map(state => state.observation)));
    await expect.poll(() => page.evaluate(() => window.botViewport.metrics.currentCalls.length), { timeout: 7_000 }).toBeGreaterThanOrEqual(count);
    const at = await page.evaluate(index => window.botViewport.metrics.currentCalls[index]!, count - 1);
    await expect.poll(() => page.evaluate(() => Math.max(...window.botViewport.observerStates().map(state => state.observation)))).toBeGreaterThan(observation);
    // Wait for this publication's real flush to complete, then verify both the
    // observer queue and the shared storage lock are idle.
    await expect.poll(() => page.evaluate(({ index, at, observation }) => window.botViewport.metrics.snapshotFlushes.slice(index).some(item => item.at >= at && item.observation > observation && item.source !== null && item.result !== undefined), { index: previousFlushes, at, observation }), { timeout: 5_000 }).toBe(true);
    const flushedAt = await page.evaluate(({ index, at, observation }) => window.botViewport.metrics.snapshotFlushes.slice(index).find(item => item.at >= at && item.observation > observation && item.source !== null && item.result !== undefined)!.at, { index: previousFlushes, at, observation });
    expect(flushedAt - at).toBeGreaterThanOrEqual(2_000);
    await drainSnapshots(page);
    expect(await page.evaluate(() => window.botViewport.metrics.snapshotWrites)).toBe(before);
  }
});

test('does not touch LRU when a native storage event triggers a passive cross-tab read', async ({ context, page }) => {
  await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  await drainSnapshots(page);
  const before = await page.evaluate(() => window.botViewport.metrics.snapshotWrites);
  const peer = await context.newPage(); await install(peer);
  await peer.goto(`/bots/${bots[1]!.id}`); await saved(peer, bots[1]!.id);
  await expect.poll(() => page.evaluate(() => window.botViewport.metrics.snapshotEvents.length)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const event = window.botViewport.metrics.snapshotChanges.at(-1);
    return !!event && window.botViewport.metrics.snapshotReads.some(read => read.at >= event.at && read.touch === false && read.complete);
  })).toBe(true);
  await drainSnapshots(peer); await drainSnapshots(page);
  const result = await page.evaluate(key => ({ writes: window.botViewport.metrics.snapshotWrites, events: window.botViewport.metrics.snapshotEvents, disk: localStorage.getItem(key) }), namespace);
  expect(result.writes).toBe(before);
  expect(result.disk).toBe(result.events.at(-1));
  expect(JSON.parse(result.disk!).records.map((record: { preview: { botId: string } }) => record.preview.botId)).toEqual([bots[0]!.id, bots[1]!.id]);
  await peer.close();
});

test('persists accepted history revisions and appends after unchanged polls', async ({ page }) => {
  await install(page);
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  await drainSnapshots(page);
  await page.evaluate(bot => {
    window.botViewport.upsert(bot, 80, '2', 'Accepted revision');
    window.botViewport.upsert(bot, 101, '1', 'Accepted append');
  }, bots[0]!.id);
  await expect(page.locator(`${row}[data-entry-key="${entryId(80)}"]`)).toContainText('Accepted revision');
  await expect(page.locator(`${row}[data-entry-key="${entryId(101)}"]`)).toContainText('Accepted append');
  await expect.poll(() => page.evaluate(({ key, target }) => {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const preview = JSON.parse(raw).records.find((record: { preview: { botId: string } }) => record.preview.botId === target)?.preview;
    return !!preview && JSON.stringify(preview.entries).includes('Accepted revision') && JSON.stringify(preview.entries).includes('Accepted append');
  }, { key: namespace, target: bots[0]!.id }), { timeout: 10_000 }).toBe(true);
  await drainSnapshots(page);
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


test('keeps uncovered preview rows and the reading anchor after a shorter real tail is persisted', async ({ page }) => {
  const api = await install(page, { initialStart: 1, restoredStart: 51, end: 150 });
  await page.goto(`/bots/${bots[0]!.id}`);
  await expect(page.locator(row)).toHaveCount(150);
  await saved(page, bots[0]!.id, 150);
  await page.evaluate(() => sessionStorage.setItem('b2-history-barriers', 'true'));
  api.hold(); await page.reload();
  await expect(page.locator(row)).toHaveCount(150);
  const originalTimeline = await page.locator(timeline).elementHandle();
  const originalRow = await page.locator(`${row}[data-entry-key="${entryId(21)}"]`).elementHandle();
  await expect.poll(() => page.locator(timeline).evaluate(node => node.scrollTop)).toBeGreaterThan(900);
  const beforeWheel = await page.locator(timeline).evaluate(node => node.scrollTop);
  await page.locator(timeline).hover(); await page.mouse.wheel(0, -900);
  await expect(page.locator(`${selected} .session-latest`)).toBeVisible();
  await expect.poll(() => page.locator(timeline).evaluate(node => node.scrollTop)).toBeLessThanOrEqual(beforeWheel - 899);
  await page.locator(timeline).evaluate(node => {
    const target = node.querySelector<HTMLElement>('[data-entry-key="30000000-0000-4000-8000-000000010021"]')!;
    node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
    node.dispatchEvent(new Event('scroll'));
  });
  const reading = await anchor(page);
  expect(reading.key).toBe(entryId(21));
  api.release(); await page.evaluate(() => { window.botViewport.releaseCurrent(); window.botViewport.releaseHistory(); });
  await saved(page, bots[0]!.id, 100);
  await expect(page.locator(`${row}[data-history-preview="true"]`)).toHaveCount(50);
  await expect(page.locator(row)).toHaveCount(150);
  expect(await page.locator(timeline).evaluate((node, original) => node === original, originalTimeline)).toBe(true);
  expect(await page.locator(`${row}[data-entry-key="${entryId(21)}"]`).evaluate((node, original) => node === original, originalRow)).toBe(true);
  const restored = await anchor(page);
  expect(restored.key).toBe(reading.key); expect(Math.abs(restored.offset - reading.offset)).toBeLessThanOrEqual(3);
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  expect(api.writes).toEqual([]);
});

test('does not replace another tab history from passive reads or local drafts', async ({ context, page }) => {
  const oldEpoch = 'tab-a-history', peerEpoch = 'tab-b-history';
  const api = await install(page, null, { epoch: oldEpoch, revision: '1', lastEventSeq: '0' });
  await page.goto(`/bots/${bots[0]!.id}`); await saved(page);
  const stored = () => page.evaluate(({ namespace, target }) => {
    const raw = localStorage.getItem(namespace);
    if (!raw) return null;
    return (JSON.parse(raw).records as { preview: { botId: string; historyEpoch: string; lastEventSeq: string; entries: { revision: string }[] } }[]).find(record => record.preview.botId === target)?.preview ?? null;
  }, { namespace, target: bots[0]!.id });
  const peer = await context.newPage();
  const peerApi = await install(peer, null, { epoch: peerEpoch, revision: '2', lastEventSeq: '0' });
  await peer.goto(`/bots/${bots[0]!.id}`);
  await expect(peer.locator(`${row}[data-entry-key="${entryId(80)}"]`)).toContainText('Revision 2');
  // Read only real StorageEvents produced by the peer's production observer.
  // Keeping every newValue detects deletion/rewrite cycles hidden by a final read.
  await expect.poll(() => page.evaluate(({ target, peerEpoch }) => window.botViewport.metrics.snapshotEvents.findIndex(raw => {
    if (!raw) return false;
    return (JSON.parse(raw).records as { preview: { botId: string; historyEpoch: string } }[]).some(record => record.preview.botId === target && record.preview.historyEpoch === peerEpoch);
  }), { target: bots[0]!.id, peerEpoch })).toBeGreaterThanOrEqual(0);
  const notifications = () => page.evaluate(({ target, peerEpoch }) => {
    const events = window.botViewport.metrics.snapshotEvents;
    const first = events.findIndex(raw => raw !== null && (JSON.parse(raw).records as { preview: { botId: string; historyEpoch: string } }[]).some(record => record.preview.botId === target && record.preview.historyEpoch === peerEpoch));
    return events.slice(first).map(raw => raw === null ? null : (JSON.parse(raw).records as { preview: { botId: string; historyEpoch: string } }[]).find(record => record.preview.botId === target)?.preview.historyEpoch ?? null);
  }, { target: bots[0]!.id, peerEpoch });
  const peerNotifications = () => peer.evaluate(({ target, peerEpoch }) => {
    const epoch = (raw: string | null) => raw === null ? null : (JSON.parse(raw).records as { preview: { botId: string; historyEpoch: string } }[]).find(record => record.preview.botId === target)?.preview.historyEpoch ?? null;
    const events = window.botViewport.metrics.snapshotChanges.map(event => ({ before: epoch(event.oldValue), after: epoch(event.newValue) }));
    // The peer does not receive its own save event. Include the first event
    // touching its epoch so a first deletion or rollback cannot be skipped.
    const first = events.findIndex(event => event.before === peerEpoch || event.after === peerEpoch);
    return first < 0 ? [] : events.slice(first).map(event => event.after);
  }, { target: bots[0]!.id, peerEpoch });
  const changes = (tab: Page) => tab.evaluate(target => {
    const epoch = (raw: string | null) => raw === null ? null : (JSON.parse(raw).records as { preview: { botId: string; historyEpoch: string } }[]).find(record => record.preview.botId === target)?.preview.historyEpoch ?? null;
    return window.botViewport.metrics.snapshotChanges.map(event => ({ ...event, before: epoch(event.oldValue), after: epoch(event.newValue) }));
  }, bots[0]!.id);
  const metrics = async (tab: Page) => ({ changes: await changes(tab), snapshotWrites: await tab.evaluate(() => window.botViewport.metrics.snapshotWrites) });
  const captureEvidence = async (phase: string, closedPeer?: Awaited<ReturnType<typeof metrics>>) => {
    const [a, b, preview] = await Promise.all([metrics(page), closedPeer ? Promise.resolve(closedPeer) : metrics(peer), stored()]);
    const eventsPath = test.info().outputPath(`passive-history-storage-events-${phase}.json`);
    await writeFile(eventsPath, JSON.stringify({ phase, a, b, peerClosed: Boolean(closedPeer), stored: { epoch: preview?.historyEpoch, lastEventSeq: preview?.lastEventSeq, revision: preview?.entries[0]?.revision } }, null, 2));
    await test.info().attach(`passive-history-storage-events-${phase}`, { path: eventsPath, contentType: 'application/json' });
    return b;
  };
  await expect.poll(async () => (await stored())?.historyEpoch).toBe(peerEpoch);
  const writes = await page.evaluate(() => window.botViewport.metrics.snapshotWrites);
  await page.waitForTimeout(2_500);
  await captureEvidence('idle');
  expect((await stored())?.historyEpoch).toBe(peerEpoch);
  expect(await notifications()).not.toContain(null);
  expect((await notifications()).every(epoch => epoch === peerEpoch)).toBe(true);
  const peerEvents = await peerNotifications();
  expect(peerEvents).toEqual(peerEvents.map(() => peerEpoch));
  expect(await page.evaluate(() => window.botViewport.metrics.snapshotWrites)).toBe(writes);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Local draft must not renew old history');
  await page.waitForTimeout(2_500);
  const peerFinal = await captureEvidence('draft');
  expect((await stored())?.historyEpoch).toBe(peerEpoch);
  expect((await notifications()).every(epoch => epoch === peerEpoch)).toBe(true);
  expect((await peerNotifications()).every(epoch => epoch === peerEpoch)).toBe(true);
  expect(await page.evaluate(() => window.botViewport.metrics.snapshotWrites)).toBe(writes);
  expect(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()).toBe('Local draft must not renew old history');
  expect(await peer.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  await peer.close();
  // Epoch labels are opaque. A genuinely newer accepted page, obtained through
  // the real Refresh action, can establish authority again even with A's label.
  await page.evaluate(() => Object.assign(window.botViewportOptions!, { revision: '3', lastEventSeq: '1' }));
  const header = page.locator(`${selected} .session-header`);
  await header.getByRole('button', { name: 'More actions', exact: true }).click();
  await header.getByRole('group', { name: 'More actions', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator(`${row}[data-entry-key="${entryId(80)}"]`)).toContainText('Revision 3');
  await expect.poll(async () => {
    const preview = await stored();
    return { epoch: preview?.historyEpoch, lastEventSeq: preview?.lastEventSeq, revision: preview?.entries[0]?.revision };
  }).toEqual({ epoch: oldEpoch, lastEventSeq: '1', revision: '3' });
  await captureEvidence('refresh', peerFinal);
  expect(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue()).toBe('Local draft must not renew old history');
  expect(await page.evaluate(() => window.botViewport.metrics.commands)).toBe(0);
  expect(api.writes).toEqual([]); expect(peerApi.writes).toEqual([]);
});
