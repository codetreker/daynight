import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
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

const warning = {
  en: 'All Goal dependencies associated with this project will be permanently removed. This includes dependencies within the project, external prerequisites, and dependencies from other projects on Goals in this project. These relationships cannot be restored.',
  zh: '所有与此项目相关的 Goal 依赖将永久移除，包括项目内依赖、外部前置及其他项目对本项目 Goal 的依赖。这些关系无法恢复。',
};

const installDeletion = async (page: Page) => {
  const state = { admin: true, reject: false, writes: [] as { header: string | null; body: string | null }[], previews: [] as (string | null)[] };
  const project = { id: deleting, name: 'Project', repoUrl: 'https://example.com/repo', createdAt: time, updatedAt: time,
    ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...headers } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send(personalTeamPage(TEST_VIEWER_ID));
    if (path === `/api/v1/teams/${teamId}`) return send(personalTeamPage(TEST_VIEWER_ID).items[0]);
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === `/api/v1/projects/${deleting}/access`) return send({ ...directAccessFixture(deleting, TEST_VIEWER_ID, 'admin'), teamRole: state.admin ? 'admin' : null, canTransfer: state.admin });
    if (path === `/api/v1/projects/${deleting}/deletion-preview`) {
      state.previews.push(request.headers()['daynight-confirm-goal-dependency-removal'] ?? null);
      return send({ observedAt: time, project: { id: deleting, name: 'Project', repoUrl: project.repoUrl, ownerTeam: personal }, summary: { taskCount: 0, unfinishedTaskCount: 0, attachmentCount: 0 }, activeClaims: [], nextCursor: null });
    }
    if (path === `/api/v1/projects/${deleting}` && request.method() === 'DELETE') {
      state.writes.push({ header: request.headers()['daynight-confirm-goal-dependency-removal'] ?? null, body: request.postData() });
      if (state.reject) {
        const requestId = request.headers()['x-request-id']!;
        return send({ error: { code: 'invalid_input', message: 'Rejected', requestId } }, 400, { 'X-Request-ID': requestId });
      }
      return send({ projectId: deleting, deleted: true });
    }
    if (path === `/api/v1/projects/${deleting}`) return send(project);
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'missing' } }, 404);
  });
  return state;
};

for (const [width, locale] of [[1280, 'en'], [320, 'en'], [1280, 'zh'], [320, 'zh']] as const) {
  test(`project deletion warns and confirms safely at ${width}px in ${locale}`, async ({ page }) => {
    const state = await installDeletion(page); await page.setViewportSize({ width, height: 720 });
    await page.goto(`/projects/${deleting}/settings?tab=management`);
    if (locale === 'zh') await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
    const open = page.getByRole('button', { name: locale === 'en' ? 'Delete project' : '删除项目', exact: true });
    const title = locale === 'en' ? 'Delete this project?' : '删除此项目？';
    const cancel = locale === 'en' ? 'Cancel' : '取消';
    const inputLabel = locale === 'en' ? 'Enter the project name to confirm' : '输入项目名称以确认';
    const submit = locale === 'en' ? 'Confirm deletion' : '确认删除';
    await open.click(); let dialog = page.getByRole('dialog', { name: title });
    const notice = dialog.getByText(warning[locale], { exact: true });
    await expect(notice).toBeVisible();
    await expect(dialog.getByRole('button', { name: submit })).toHaveAccessibleDescription(warning[locale]);
    const initialBounds = await notice.evaluate(element => {
      const text = element.getBoundingClientRect(), body = element.closest('.dialog-body')!.getBoundingClientRect();
      return { top: text.top, bottom: text.bottom, bodyTop: body.top, bodyBottom: body.bottom };
    });
    expect(initialBounds.top, JSON.stringify(initialBounds)).toBeGreaterThanOrEqual(initialBounds.bodyTop);
    expect(initialBounds.bottom, JSON.stringify(initialBounds)).toBeLessThanOrEqual(initialBounds.bodyBottom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: cancel }).click(); await expect(dialog).toHaveCount(0);
    await open.click(); dialog = page.getByRole('dialog', { name: title });
    await expect(dialog.getByText(warning[locale], { exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(open).toBeFocused();
    expect(state.writes).toEqual([]); expect(state.previews).toEqual([null, null]);
    await open.click(); dialog = page.getByRole('dialog', { name: title });
    const input = dialog.getByLabel(inputLabel), confirm = dialog.getByRole('button', { name: submit });
    await input.fill('project'); await expect(confirm).toBeDisabled();
    await input.fill(' Project '); await expect(confirm).toBeDisabled();
    await input.fill('Project'); await expect(confirm).toBeEnabled();
    state.reject = true; await confirm.click();
    await expect(dialog.getByRole('alert')).toContainText(locale === 'en' ? 'Deletion was not committed' : '删除未提交');
    expect(state.writes).toEqual([{ header: 'true', body: null }]);
    state.reject = false; await confirm.click();
    await expect.poll(() => state.writes.length).toBe(2);
    await expect(dialog).toHaveCount(0);
    expect(state.writes).toEqual([{ header: 'true', body: null }, { header: 'true', body: null }]);
    expect(state.previews).toEqual([null, null, null]);
  });
}

test('withdraws deletion confirmation after owner admin access is lost', async ({ page }) => {
  const state = await installDeletion(page); await page.goto(`/projects/${deleting}/settings?tab=management`);
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this project?' });
  await dialog.getByLabel('Enter the project name to confirm').fill('Project');
  await expect(dialog.getByRole('button', { name: 'Confirm deletion' })).toBeEnabled();
  state.admin = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(dialog.getByRole('button', { name: 'Confirm deletion' })).toBeDisabled();
  await expect(dialog.getByText(warning.en, { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.previews).toEqual([null]);
});

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
    if (path === `/api/v1/projects/${projectId}/tags` && request.method() === 'GET') return send({ items: [{ id: '00000000-0000-4000-8000-000000000099', projectId, name: 'Draft label', version: 1, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } }], catalogEpoch: '00000000-0000-4000-8000-000000000098', nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/tags/colors/resolve`) return send({ catalogEpoch: '00000000-0000-4000-8000-000000000098', items: [{ id: '00000000-0000-4000-8000-000000000099', state: 'found', version: 1, color: '#9AA3B2' }] });
    if (path === `/api/v1/projects/${projectId}/tags/resolve`) return send({ items: [{ id: '00000000-0000-4000-8000-000000000099', name: 'Draft label' }] });
    if (path === root) return route.fulfill({ status: 200, body: stringifyWireJson(detail), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': fixtureTaskEpoch(projectId) } });
    if (path === `${root}/sessions/current`) return send({ status: 'registered', session: snapshot });
    if (path === `${root}/thread/messages`) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
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
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Edit tags', exact: true }).click();
  const draft = page.locator('.task-tags-editor').getByRole('checkbox', { name: 'Draft label' });
  await draft.check();
  // Keyboard activation gives every engine the same explicit focus owner.
  await lastResult.focus(); await page.keyboard.press('Enter');
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await expect(page.locator('.standalone-deletion-slot')).toHaveAttribute('inert');
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.standalone-deletion-slot')).not.toHaveAttribute('inert');
  await expect(lastResult).toBeFocused();
  await expect(draft).toBeChecked();
});
