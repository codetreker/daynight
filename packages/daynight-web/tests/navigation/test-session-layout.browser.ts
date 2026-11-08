import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { sessionFence, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import type { SessionArchive } from '../../../daynight/src/session/archive';

const source = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const owner = '00000009-1111-4111-8111-111111111111';
const personalId = '00000000-0000-4000-8000-000000000701';
const { claimId: _claim, ...base } = source;
const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = source.identity;
const snapshot: SessionSnapshot = { ...base, testExecutionId: '00000010-1111-4111-8111-111111111111', identity: { ...identity, ownerUserId: owner }, lastEventSeq: '0', initialInputState: 'not_required' };
const root = `/api/v1/test-sessions/${snapshot.sessionId}`;
const entries: SessionArchive['entries'] = [{ kind: 'assistant_message', entryId: '00000012-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Readable conversation in the Test Session page.' }] }];
const install = async (page: Page, mode: 'live' | 'archived' | 'loading' | 'error') => {
  const session: SessionSnapshot = mode === 'archived' ? { ...snapshot, lifecycle: 'archived', connectionState: 'disconnected', operations: { canSend: false, canCancel: false, canRespond: false } } : snapshot;
  const archive: SessionArchive = { schemaVersion: 1, ...sessionFence(session), sessionId: session.sessionId, controllerId: session.identity.controllerId, controllerInstanceId: session.identity.controllerInstanceId, provider: session.identity.provider, nativeSessionId: session.identity.nativeSessionId, entries, resources: [] };
  const requests: string[] = [];
  await page.routeWebSocket('**/api/v1/test-sessions/**', socket => {
    socket.send(JSON.stringify({ protocol: session.protocol, type: 'snapshot', userId: owner, snapshot: session, cursor: 'zero' }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') requests.push(`${request.method()} ${path}`);
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': owner } });
    if (path === '/api/v1/me') return send({ id: owner, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams' || path === '/api/v1/projects' || path === '/api/v1/test-sessions') return send({ items: [], nextCursor: null });
    if (path === root) {
      if (mode === 'loading') return;
      if (mode === 'error') return send({ error: { code: 'internal', message: 'Unavailable', requestId: session.sessionId } }, 503);
      return send({ session });
    }
    if (path === `${root}/timeline`) return send({ sessionId: session.sessionId, historyEpoch: session.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path === `${root}/archive`) return send({ archive: { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null } });
    if (path === `${root}/archive/content`) return send({ archive });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: session.sessionId } }, 404);
  });
  return requests;
};
const geometry = (page: Page) => page.evaluate(() => {
  const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
  return { workspace: rect('.workspace'), content: rect('.content'), back: rect('.test-session-back'), session: rect('.test-session-page > .task-agent-session'), timeline: rect('.session-timeline-shell'), composer: rect('.session-composer'), heading: rect('.test-session-page > h1'), overflow: document.documentElement.scrollWidth > innerWidth };
});
for (const [width, height] of [[320, 640], [375, 667], [390, 844], [600, 640], [601, 700], [768, 900], [1360, 900], [375, 400]]) {
  test(`${width}x${height} preserves reading space and accessible navigation`, async ({ page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
    const requests = await install(page, 'live');
    await page.goto(`/test-sessions/${snapshot.sessionId}`);
    await expect(page.getByText('Readable conversation in the Test Session page.')).toBeVisible();
    const before = await geometry(page);
    await info.attach('geometry', { body: JSON.stringify(before), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('page.png') });
    expect(before.overflow).toBe(false);
    await expect(page.getByRole('heading', { name: '测试会话', level: 1 })).toHaveCount(1);
    if (width! <= 600) {
      expect(before.session.x).toBe(before.workspace.x);
      expect(before.session.width).toBe(before.workspace.width);
      expect(before.session.y).toBe(before.back.bottom);
      expect(before.back.height).toBeGreaterThanOrEqual(36);
      expect(before.back.height).toBeLessThanOrEqual(40);
      expect(before.session.bottom).toBe(height);
      expect(before.heading.width).toBeLessThanOrEqual(1);
      if (height! >= 640) expect(before.timeline.height).toBeGreaterThan(240);
    } else {
      expect(before.session.x - before.workspace.x).toBe(18);
      expect(before.session.bottom).toBe(height! - 18);
      expect(before.heading.height).toBeGreaterThan(18);
    }
    const toggle = page.locator('.session-fullscreen-toggle');
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect((await geometry(page)).session.width).toBe(width);
    await page.keyboard.press('Escape'); await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    expect((await geometry(page)).session).toEqual(before.session);
    const back = page.locator('.test-session-back');
    await back.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await expect(back).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/test-sessions$/);
    expect(requests).toEqual([]);
  });
}
for (const mode of ['archived', 'loading', 'error'] as const) {
  test(`${mode} uses the same narrow page frame`, async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await install(page, mode);
    await page.goto(`/test-sessions/${snapshot.sessionId}`);
    if (mode === 'archived') await expect(page.getByText('Readable conversation in the Test Session page.')).toBeVisible();
    else if (mode === 'error') await expect(page.locator('.session-empty')).toContainText('Unable to load the requested data. Please try again.');
    else await expect(page.locator('.session-empty')).toBeVisible();
    const bounds = await geometry(page);
    expect(bounds.session.x).toBe(bounds.workspace.x);
    expect(bounds.session.width).toBe(bounds.workspace.width);
    expect(bounds.session.y).toBe(bounds.back.bottom);
    expect(bounds.session.bottom).toBe(640);
    expect(bounds.overflow).toBe(false);
    await expect(page.locator('.session-composer')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`${mode}.png`) });
    await info.attach('geometry', { body: JSON.stringify(bounds), contentType: 'application/json' });
    await page.locator('.test-session-back').click(); await expect(page).toHaveURL(/\/test-sessions$/);
  });
}
