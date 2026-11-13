import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { personalTeamPage } from '../helpers/team';
import { directAccessFixture, fixtureTaskEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import type { TaskSessionSnapshot } from '../helpers/session';
import { stringifyWireJson } from '../helpers/wireJson';

const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const deleting = '00000000-0000-4000-8000-000000000003';
const teamId = '00000000-0000-4000-8000-000000000701';
const personal = { id: teamId, kind: 'personal', name: null };
const time = '2026-10-22T10:00:00Z';
const root = `/api/v1/projects/${projectId}/tasks/${taskId}`;

test('a collapsed deletion result reserves space for the task Session composer', async ({ page }) => {
  const pending = Promise.withResolvers<void>(); let dispatched = false;
  const snapshot: TaskSessionSnapshot = { ...source, lastEventSeq: '0', lastTimelineSeq: '0', lifecycle: 'active', activity: 'idle', connectionState: 'connected', currentTurnId: null,
    operations: { canSend: true, canCancel: false, canRespond: false } };
  const worker = { claimId: source.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Worker' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: source.identity.worktreeId,
    phase: 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Other task', status: 'in_progress', ready: false, properties: { worker } });
  const graph = graphFixture([detail]);
  const deletedProject = { id: deleting, name: 'Project', repoUrl: 'https://example.com/repo', createdAt: time, updatedAt: time,
    ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
  const access = (id: string) => ({ ...directAccessFixture(id, TEST_VIEWER_ID, 'admin'), teamRole: 'admin' as const, canTransfer: true });
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    (window as unknown as { viewportProbe: typeof viewport }).viewportProbe = viewport;
  });
  await page.routeWebSocket('**/channel*', socket => socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' })));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send(personalTeamPage(TEST_VIEWER_ID));
    if (path === `/api/v1/teams/${teamId}`) return send(personalTeamPage(TEST_VIEWER_ID).items[0]);
    if (path === '/api/v1/projects') return send({ items: [deletedProject], nextCursor: null });
    if (path === `/api/v1/projects/${deleting}` && request.method() === 'DELETE') { dispatched = true; await pending.promise; return route.abort('failed'); }
    if (path === `/api/v1/projects/${deleting}`) return send(deletedProject);
    if (path === `/api/v1/projects/${deleting}/access`) return send(access(deleting));
    if (path === `/api/v1/projects/${deleting}/deletion-preview`) return send({ observedAt: time, project: { id: deleting, name: 'Project', repoUrl: deletedProject.repoUrl, ownerTeam: personal }, summary: { taskCount: 0, unfinishedTaskCount: 0, attachmentCount: 0 }, activeClaims: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { actorAccess: access(projectId), query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === `/api/v1/projects/${projectId}/access`) return send(access(projectId));
    if (path === root) return route.fulfill({ status: 200, body: stringifyWireJson(detail), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': fixtureTaskEpoch(projectId) } });
    if (path === `${root}/sessions/current`) return send({ status: 'registered', session: snapshot });
    if (path === `${root}/steps`) return send({ projectId, taskId, version: detail.version, steps: [] });
    if (path === `${root}/sessions/${snapshot.sessionId}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path === `${root}/sessions` || path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'missing' } }, 404);
  });
  const visual = async (width: number, height: number, top: number, left: number, event = 'resize') => page.evaluate(({ width, height, top, left, event }) => {
    const viewport = (window as unknown as { viewportProbe: EventTarget & { width: number; height: number; offsetTop: number; offsetLeft: number } }).viewportProbe;
    Object.assign(viewport, { width, height, offsetTop: top, offsetLeft: left }); viewport.dispatchEvent(new Event(event));
  }, { width, height, top, left, event });
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=session`);
  await expect(page.locator('.session-composer textarea')).toBeVisible();
  await visual(280, 400, 50, 20);
  await page.locator('.session-fullscreen-toggle').click();
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'true');
  const originalViewport = await page.locator('.task-agent-session').boundingBox();
  expect(originalViewport).toEqual({ x: 0, y: 0, ...page.viewportSize()! });
  await expect.poll(() => page.locator('.session-header').evaluate(node => node.getBoundingClientRect().top)).toBe(50);
  await visual(280, 400, 70, 30, 'scroll');
  await expect.poll(() => page.locator('.session-header').evaluate(node => ({ x: node.getBoundingClientRect().left, y: node.getBoundingClientRect().top }))).toEqual({ x: 30, y: 70 });
  expect(await page.locator('.task-agent-session').boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize()! });
  await page.locator('.session-fullscreen-toggle').click();
  await page.goto(`/projects/${deleting}/settings?tab=management`);
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this project?' });
  await dialog.getByLabel('Enter the project name to confirm').fill('Project');
  await dialog.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect.poll(() => dispatched).toBe(true);
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/projects/${projectId}/tasks/${taskId}?tab=session`);
  await expect(page.locator('.session-composer textarea')).toBeVisible();
  pending.resolve();
  await expect(page.getByText(/project deletion result is unknown/i)).toBeVisible();
  const toggle = page.locator('.standalone-deletion-toggle');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const assertSpace = async () => {
    const result = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      const composer = rect('.session-composer'), slot = rect('.standalone-deletion-slot'), button = rect('.standalone-deletion-toggle');
      return { composer, slot, button, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(result.composer.bottom).toBeLessThanOrEqual(result.slot.top + 1);
    expect(result.button.right).toBeLessThanOrEqual(result.width);
    expect(result.button.bottom).toBeLessThanOrEqual(result.height);
    expect(result.overflow).toBe(false);
    await expect(page.locator('.session-composer textarea')).toBeEnabled();
  };
  for (const width of [320, 375, 768]) { await page.setViewportSize({ width, height: 720 }); await assertSpace(); }
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await assertSpace();
  await visual(768, 720, 0, 0);
  await page.locator('.session-fullscreen-toggle').click();
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'true');
  await assertSpace();
  await page.locator('.session-composer textarea').fill('Unsent message');
  await expect(page.locator('.session-composer button[type="submit"]')).toBeEnabled();
  await visual(350, 300, 80, 45);
  await expect.poll(async () => page.locator('.session-header').evaluate(root => root.getBoundingClientRect().top)).toBe(80);
  const verifyVisualBounds = async (top: number, left: number, width: number, height: number) => {
    const rects = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      const send = document.querySelector<HTMLElement>('.session-composer button[type="submit"]')!;
      const box = send.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { session: rect('.task-agent-session'), slot: rect('.standalone-deletion-slot'), composer: rect('.session-composer'), header: rect('.session-header'), send: box.toJSON(), hit: hit === send || send.contains(hit) };
    });
    expect(rects.session.left).toBe(0); expect(rects.session.top).toBe(0);
    expect(rects.session.width).toBe(page.viewportSize()!.width); expect(rects.session.height).toBe(page.viewportSize()!.height);
    expect(rects.header.left).toBeCloseTo(left, 1); expect(rects.header.top).toBeCloseTo(top, 1);
    expect(rects.header.width).toBeCloseTo(width, 1); expect(rects.composer.bottom).toBeLessThanOrEqual(rects.slot.top + 1);
    expect(rects.slot.bottom).toBeLessThanOrEqual(top + height + 1); expect(rects.slot.left).toBeCloseTo(left, 1);
    expect(rects.send.bottom, JSON.stringify(rects)).toBeLessThanOrEqual(rects.slot.top + 1); expect(rects.hit, JSON.stringify(rects)).toBe(true);
    await page.locator('.session-composer textarea').focus(); await expect(page.locator('.session-composer textarea')).toBeFocused();
  };
  await verifyVisualBounds(80, 45, 350, 300);
  await visual(350, 300, 110, 65, 'scroll');
  await expect.poll(async () => page.locator('.session-header').evaluate(root => root.getBoundingClientRect().left)).toBe(65);
  await verifyVisualBounds(110, 65, 350, 300);
  await page.getByRole('button', { name: 'Show deletion results' }).click(); await expect(page.getByText(/project deletion result is unknown/i)).toBeVisible();
  const expanded = await page.locator('.standalone-deletion-panel').boundingBox();
  expect(expanded!.y).toBeGreaterThanOrEqual(110); expect(expanded!.x).toBeGreaterThanOrEqual(65);
  expect(expanded!.x + expanded!.width).toBeLessThanOrEqual(415);
  expect(expanded!.y + expanded!.height).toBeLessThanOrEqual(410);
  const lastResult = page.getByRole('link', { name: 'Return to projects' });
  await lastResult.focus(); await page.keyboard.press('Tab');
  expect(await page.locator('.task-agent-session').evaluate(root => root.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab'); await expect(lastResult).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.session-fullscreen-toggle')).toBeFocused();
  await page.getByRole('tab', { name: 'Steps' }).click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Other task draft');
  // Keyboard activation gives every engine the same explicit focus owner.
  await lastResult.focus(); await page.keyboard.press('Enter');
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await expect(page.locator('.standalone-deletion-slot')).toHaveAttribute('inert');
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.standalone-deletion-slot')).not.toHaveAttribute('inert');
  await expect(lastResult).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Other task draft');
});
