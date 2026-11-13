import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { sessionFence, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import { imageBrowserData } from '../helpers/sessionImageBrowser';
import { stringifyWireJson } from '../helpers/wireJson';

const namespace = `daynight:bot-display:v1:${BOT_USER}`;
const personal = { id: botId(100), kind: 'personal', name: null };
async function install(page: Page) {
  const data = imageBrowserData(), { claimId: _claim, identity: _identity, ...base } = data.source;
  const snapshot: SessionSnapshot = { ...base, sessionId: botId(201), testExecutionId: botId(401), lastEventSeq: '0', lastTimelineSeq: '6',
    lifecycle: 'active', activity: 'idle', connectionState: 'connected', currentTurnId: null,
    operations: { canSend: true, canCancel: false, canRespond: false },
    identity: { ownerUserId: BOT_USER, controllerId: data.source.identity.controllerId, controllerInstanceId: data.source.identity.controllerInstanceId, provider: 'codex', agentControlMode: 'web', nativeSessionId: 'image-bot-native' } };
  const bot = { ...botDefinition(1), name: 'Image assistant', sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId,
    roleConfiguration: { instructions: 'Browser fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready', code: null } };
  const root = `/api/v1/test-sessions/${snapshot.sessionId}`;
  const observed = { resources: [] as string[], writes: [] as string[], current: 0, channels: 0, errors: [] as string[] };
  let hold = false; const pending: (() => void)[] = [];
  page.on('pageerror', error => observed.errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.routeWebSocket('**/channel*', socket => {
    observed.channels++;
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: BOT_USER, snapshot, cursor: 'zero' }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) observed.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers(), status) } });
    if (path === '/api/v1/me') return send({ id: BOT_USER, personalTeam: personal, name: 'Image reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personal.id}`) return send({ ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personal.id, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: [bot], nextCursor: null });
    if (path === `/api/v1/me/bots/${bot.id}`) { if (hold) await new Promise<void>(resolve => pending.push(resolve)); return send(bot); }
    if (path === root) { observed.current++; return send({ session: snapshot }); }
    if (path === `${root}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: data.entries, resources: data.resources, beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    const resourceId = path.startsWith(`${root}/resources/`) && path.endsWith('/content') ? path.split('/').at(-2) : null;
    if (resourceId && data.bodies.has(resourceId)) {
      observed.resources.push(resourceId);
      const resource = data.resources.find(item => item.resourceId === resourceId)!, bytes = data.bodies.get(resourceId)!;
      return send({ resourceId, byteLength: resource.byteLength, sha256: resource.sha256, offset: '0', data: bytes.toString('base64'), eof: true });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: bot.id } }, 404);
  });
  return { ...data, snapshot, bot, observed, hold() { hold = true; }, release() { hold = false; pending.splice(0).forEach(resolve => resolve()); } };
}

for (const width of [1360, 390, 320]) test(`Bot images and cold descriptor preview at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await install(page), timeline = page.locator('.bot-session-pane:not([hidden]) .session-timeline');
  try {
    await page.goto(`/bots/${f.bot.id}`);
    await expect(timeline.locator('.session-entry')).toHaveCount(f.entries.length);
    const trigger = timeline.getByRole('button', { name: 'View image: Example.png', exact: true });
    await timeline.hover(); await page.mouse.wheel(0, -10000);
    await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBe(0);
    await expect(trigger.locator('img')).toBeVisible();
    await page.getByRole('button', { name: 'Enter Session fullscreen', exact: true }).click();
    await trigger.click();
    const dialog = page.locator('dialog.session-image-preview');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toBeVisible();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download image: Example.png', exact: true }).click();
    const file = await download, path = await file.path();
    expect(createHash('sha256').update(await readFile(path!)).digest('hex')).toBe(f.resources[0]!.sha256);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('button', { name: 'Exit Session fullscreen', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Enter Session fullscreen', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{"records":[]}').records.length, namespace)).toBe(1);
    const raw = await page.evaluate(key => localStorage.getItem(key), namespace);
    expect(raw).toContain('Example.png');
    expect(raw).not.toContain('blob:'); expect(raw).not.toContain('data:image');
    expect(raw).not.toContain(f.bodies.get(f.resources[0]!.resourceId)!.toString('base64'));
    const stored = JSON.parse(raw!);
    expect(stored.records[0].preview.fence).toEqual(sessionFence(f.snapshot));
    expect(stored.records[0].preview.resources).toHaveLength(5);
    f.hold(); const before = { reads: f.observed.resources.length, current: f.observed.current, channels: f.observed.channels };
    await page.reload();
    await expect(timeline.locator('.session-entry')).toHaveCount(f.entries.length);
    await expect(timeline.getByText('Image unavailable in the recent preview', { exact: true })).toHaveCount(5);
    await expect(timeline.getByText('Linked image — Resource unavailable', { exact: true })).toBeVisible();
    await expect(timeline.locator('img')).toHaveCount(0);
    await expect(timeline.getByRole('button', { name: /Download|View image/ })).toHaveCount(0);
    expect(f.observed.resources.length).toBe(before.reads); expect(f.observed.current).toBe(before.current); expect(f.observed.channels).toBe(before.channels);
    await page.screenshot({ path: info.outputPath('bot-image-cache.png') });
    f.release();
    await expect(trigger).toBeVisible(); await timeline.hover(); await page.mouse.wheel(0, -10000);
    await expect.poll(() => timeline.evaluate(node => node.scrollTop)).toBe(0); await expect(trigger.locator('img')).toBeVisible();
    expect(f.observed.writes).toEqual([]); expect(f.observed.errors).toEqual([]);
    await info.attach('image-bot-evidence', { body: JSON.stringify({ width, fence: sessionFence(f.snapshot), resources: f.resources, observed: f.observed, previewBefore: before, boundary: 'Production App, Bot resolver/client, renderer and persistent localStorage snapshot. Controlled HTTP/WebSocket responses; no Provider or service execution.' }), contentType: 'application/json' });
  } finally { f.release(); }
});
