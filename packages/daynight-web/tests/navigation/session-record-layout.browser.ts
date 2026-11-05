import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { SessionArchive } from '../../../daynight/src/session/archive';
import { sessionFence } from '../../../daynight/src/session/protocol';
import type { SessionHistoryItem } from '../../src/api/terminal-sessions';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import type { TaskSessionSnapshot } from '../helpers/session';
import { stringifyWireJson } from '../helpers/wireJson';
import { navigateNativeSelect } from '../e2e/native-select';

test.use({ hasTouch: true });

const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const root = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-11-04T10:00:00Z';
const snapshot: TaskSessionSnapshot = { ...source, lifecycle: 'archived', connectionState: 'disconnected', lastEventSeq: '0', operations: { canSend: false, canCancel: false, canRespond: false } };
const archive = (sessionId: string): SessionArchive => ({ schemaVersion: 1, ...sessionFence(snapshot), sessionId,
  controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId,
  provider: snapshot.identity.provider, nativeSessionId: snapshot.identity.nativeSessionId,
  entries: [{ entryId: '00000009-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: `Saved conversation ${sessionId}` }] }], resources: [], });
const archiveStatus = { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null };
const record: SessionHistoryItem = { sessionId: source.sessionId, claimId: source.claimId, executionGeneration: source.executionGeneration,
  agentControlMode: 'web', contentKind: 'native_timeline', createdAt: time, endedAt: time,
  archive: { state: 'ready', sha256: archiveStatus.sha256, byteLength: '100', completeness: null } };
const older = { ...record, sessionId: '00000016-1111-4111-8111-111111111111', createdAt: '2026-11-03T09:30:00Z' };
const toolbar = (page: Page) => page.locator('.task-session-host > .terminal-host-toolbar');
const rectangle = (element: Locator) => element.evaluate(node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; });
const install = async (page: Page) => {
  const worker = { claimId: source.claimId, state: 'completed', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Layout fixture' }, platform: 'macos', agent: 'codex', agentControlMode: 'web',
    worktreeId: source.identity.worktreeId, phase: 'completing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Session recording layout', status: 'done', ready: false, completedAt: time, properties: { worker } });
  const graph = graphFixture([detail]);
  const state = { reads: 0, more: false, fail: false, hold: null as Promise<void> | null, writes: [] as string[] };
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === root) return send(detail);
    if (path === `${root}/sessions`) {
      state.reads++; if (state.hold) await state.hold;
      if (state.fail) return send({ error: { code: 'internal', message: 'History unavailable', requestId: source.sessionId } }, 503);
      return send({ items: [url.searchParams.has('cursor') ? older : record], nextCursor: state.more && !url.searchParams.has('cursor') ? 'older' : null });
    }
    if (path === `${root}/sessions/current`) return send({ status: 'registered', session: snapshot });
    for (const item of [record, older]) {
      if (path === `${root}/sessions/${item.sessionId}/archive`) return send({ archive: archiveStatus });
      if (path === `${root}/sessions/${item.sessionId}/archive/content`) return send({ archive: archive(item.sessionId) });
    }
    if (path.endsWith('/attachments') || path.endsWith('/steps')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: source.sessionId } }, 404);
  });
  return state;
};
const open = async (page: Page, locale: string) => {
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  const state = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=session`);
  await expect(page.getByText(`Saved conversation ${source.sessionId}`, { exact: true })).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: /^(Refresh|刷新)$/ })).toBeEnabled();
  return state;
};
const singleRow = async (page: Page) => {
  const row = toolbar(page), select = row.locator('select'), refresh = row.getByRole('button', { name: /^(Refresh|刷新)$/ });
  const geometry = { row: await rectangle(row), label: await rectangle(row.locator('label')), select: await rectangle(select), refresh: await rectangle(refresh), conversation: await rectangle(page.locator('.task-session-current .session-timeline-shell')) };
  expect(Math.abs(geometry.select.y + geometry.select.height / 2 - geometry.refresh.y - geometry.refresh.height / 2), 'Selection and Refresh share a row').toBeLessThanOrEqual(1);
  expect(geometry.row.height, 'The selector row leaves room for the conversation').toBeLessThanOrEqual(54);
  expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth), 'No toolbar overflow').toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page overflow').toBe(true);
  return geometry;
};
for (const locale of ['zh-CN', 'en']) for (const [width, height] of [[320, 640], [375, 667], [390, 844], [768, 900], [1360, 900]]) {
  test(`${locale} ${width}px record selection stays compact and operable`, async ({ page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    const state = await open(page, locale);
    const geometry = await singleRow(page);
    if (width! >= 768) expect(geometry.select.width).toBeLessThanOrEqual(440);
    if (width === 1360) expect(geometry.select.width).toBeGreaterThanOrEqual(360);
    await info.attach('geometry', { body: JSON.stringify({ viewport: { width, height }, locale, geometry }), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath('selector.png') });
    const row = toolbar(page), select = row.locator('select'), refresh = row.getByRole('button', { name: /^(Refresh|刷新)$/ });
    await select.focus(); await navigateNativeSelect(page, 'ArrowDown', '2'); await page.keyboard.press('Enter');
    await expect(select).toHaveValue(record.sessionId);
    await expect(page.locator('.terminal-session').getByText(`Saved conversation ${record.sessionId}`, { exact: true })).toBeVisible();
    const selectedGeometry = await singleRow(page);
    expect(selectedGeometry.select).toEqual(geometry.select);
    await select.selectOption(''); await select.focus(); await page.keyboard.press('Tab'); await expect(refresh).toBeFocused();
    const before = state.reads; await page.keyboard.press('Enter'); await expect.poll(() => state.reads).toBeGreaterThan(before);
    await expect(refresh).toBeEnabled();
    await select.tap(); await expect(select).toBeFocused(); await page.keyboard.press('Escape');
    await refresh.tap();
    await expect.poll(() => state.reads).toBeGreaterThan(before + 1);
    expect(state.writes).toEqual([]);
  });
}

test('busy, failure, pagination and sibling toolbars retain their behavior', async ({ page }, info) => {
  const state = await open(page, 'en');
  const row = toolbar(page), refresh = row.getByRole('button', { name: 'Refresh', exact: true });
  const initial = await singleRow(page);
  const pending = Promise.withResolvers<void>(); state.hold = pending.promise;
  await refresh.click(); await expect(refresh).toBeDisabled(); expect((await rectangle(row)).height).toBe(initial.row.height);
  state.fail = true; state.hold = null; pending.resolve();
  await expect(page.locator('.task-session-host > [role="alert"]')).toBeVisible(); await expect(refresh).toBeEnabled();
  expect((await rectangle(row)).height).toBe(initial.row.height);
  state.fail = false; state.more = true; await refresh.click();
  const more = row.getByRole('button', { name: 'Load earlier records', exact: true });
  await expect(more).toBeVisible(); await expect(page.locator('.task-session-host > [role="alert"]')).toHaveCount(0);
  const desktop = await rectangle(more); expect(Math.abs(desktop.y - (await rectangle(refresh)).y)).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await rectangle(more); expect(narrow.y).toBeGreaterThan((await rectangle(refresh)).y);
  expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await more.click(); await expect(more).toHaveCount(0); await expect(row.locator('option')).toHaveCount(3);
  await singleRow(page);
  await row.locator('select').selectOption(older.sessionId);
  const terminal = page.locator('.terminal-session > .terminal-host-toolbar');
  await expect(terminal).toBeVisible();
  const terminalStyle = await terminal.evaluate(node => ({ padding: getComputedStyle(node).padding, marginBottom: getComputedStyle(node).marginBottom, border: getComputedStyle(node).borderBottomWidth }));
  expect(terminalStyle).toEqual({ padding: '0px', marginBottom: '9.1px', border: '0px' });
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const sidebar = page.locator('.managed-session-records .terminal-host-toolbar'); await expect(sidebar).toBeVisible();
  const sidebarStyle = await sidebar.evaluate(node => ({ padding: getComputedStyle(node).padding, marginBottom: getComputedStyle(node).marginBottom, border: getComputedStyle(node).borderBottomWidth }));
  expect(sidebarStyle).toEqual({ padding: '0px', marginBottom: '7px', border: '0px' });
  await info.attach('states', { body: JSON.stringify({ initial, desktop, narrow, terminalStyle, sidebarStyle }), contentType: 'application/json' });
  expect(state.writes).toEqual([]);
});
