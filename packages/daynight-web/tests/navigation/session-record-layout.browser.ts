import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { SessionArchive } from '../../../daynight/src/session/archive';
import type { SessionHistoryItem } from '../../src/api/terminal-sessions';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import type { TaskSessionSnapshot } from '../helpers/session';
import { stringifyWireJson } from '../helpers/wireJson';

test.use({ hasTouch: true });
const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const root = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const v2 = (name: string, origin: string) => {
  let raw = readFileSync(new URL(`../../../daynight/test/session/fixtures/v2/${name}.json`, import.meta.url), 'utf8');
  const replacements = [source.identity.projectId, source.identity.taskId, source.identity.workerId, source.identity.worktreeId, TEST_VIEWER_ID, source.sessionId, source.claimId];
  for (let index = 0; index < replacements.length; index++) raw = raw.replaceAll(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, replacements[index]!);
  return JSON.parse(raw.replaceAll('https://daynight.cc', origin));
};
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-11-04T10:00:00Z';
const savedText = (id: string) => `Saved conversation ${id}`;
const archiveStatus = { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null };
const record: SessionHistoryItem = { sessionId: source.sessionId, claimId: source.claimId, executionGeneration: source.executionGeneration,
  agentControlMode: 'web', contentKind: 'native_timeline', createdAt: time, endedAt: time,
  archive: { state: 'ready', sha256: archiveStatus.sha256, byteLength: '100', completeness: null } };
// A newer timestamp belongs to another claim and must never replace the current claim.
const other = { ...record, sessionId: '00000016-1111-4111-8111-111111111111', claimId: '00000017-1111-4111-8111-111111111111', createdAt: '2026-11-05T09:30:00Z' };
type Scenario = 'completed' | 'working' | 'starting' | 'empty' | 'history' | 'herdr';
type Presentation = 'page' | 'dialog' | 'fullscreen';
async function install(page: Page, scenario: Scenario = 'completed', locale = 'en') {
  const completed = scenario === 'completed' || scenario === 'herdr';
  const snapshot: TaskSessionSnapshot = { ...source, lifecycle: completed ? 'archived' : 'active', connectionState: completed ? 'disconnected' : 'connected', lastEventSeq: '0', lastTimelineSeq: '30', activity: completed ? 'idle' : 'working', currentTurnId: completed ? null : 'turn', operations: { canSend: !completed, canCancel: !completed, canRespond: false } };
  const worker = { claimId: source.claimId, state: completed ? 'completed' : 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Lifecycle fixture' }, platform: 'macos', agent: 'codex', agentControlMode: scenario === 'herdr' ? 'herdr' : 'web',
    worktreeId: source.identity.worktreeId, phase: completed ? 'completing' : 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  let detail = detailFixture(projectId, taskId, { title: 'Session lifecycle acceptance', status: completed ? 'done' : scenario === 'empty' || scenario === 'history' ? 'todo' : 'in_progress', ready: scenario === 'empty' || scenario === 'history', completedAt: completed ? time : null, properties: scenario === 'empty' || scenario === 'history' ? {} : { worker } });
  let graph = graphFixture([detail]);
  const entries = (id: string) => Array.from({ length: 30 }, (_, index) => ({ entryId: `00000009-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, entrySeq: String(index + 1), revision: '1', kind: 'assistant_message' as const, content: [{ type: 'text' as const, text: index === 29 ? savedText(id) : `Reading line ${index + 1}: ${'Retained conversation content. '.repeat(6)}` }] }));
  const archive = (item: SessionHistoryItem): SessionArchive => ({ schemaVersion: 1, sessionId: item.sessionId, claimId: item.claimId, executionGeneration: item.executionGeneration,
    controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId,
    provider: snapshot.identity.provider, nativeSessionId: snapshot.identity.nativeSessionId, entries: entries(item.sessionId), resources: [] });
  const state = { historyReads: 0, currentReads: 0, archiveReads: 0, identityReads: 0, registered: scenario !== 'starting', archiveState: 'ready' as 'ready' | 'pending' | 'failed' | 'unavailable', historyError: 0, currentError: 0, holdHistory: null as Promise<void> | null, items: scenario === 'empty' ? [] as SessionHistoryItem[] : [other, record], writes: [] as string[], channels: 0, sent: [] as string[] };
  await page.addInitScript(({ locale, key, item }) => { localStorage.setItem('daynight.web.locale', locale); sessionStorage.setItem(key, JSON.stringify(item)); sessionStorage.setItem('unrelated-session-key', 'preserve'); }, { locale, key: `daynight:recording:${TEST_VIEWER_ID}:${projectId}:${taskId}`, item: other });
  await page.routeWebSocket('**/channel*', socket => { state.channels++; socket.onMessage(message => state.sent.push(String(message))); socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' })); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    const failure = (status: number) => send({ error: { code: status === 403 ? 'permission_denied' : 'internal', message: 'Fixture read rejected', requestId: source.sessionId } }, status);
    if (path === '/api/v1/me') { state.identityReads++; return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null }); }
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/members`) return send({ items: [], nextCursor: null, actorAccess: directAccessFixture(projectId) });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === root) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${root}/sessions`) { state.historyReads++; if (state.holdHistory) await state.holdHistory; if (state.historyError) return failure(state.historyError); return send({ items: state.items, nextCursor: null }); }
    if (scenario === 'herdr') {
      const registration = v2('valid-registration', url.origin), owner = registration.payload.owner;
      const terminalArchive = v2('valid-archive', url.origin), bytes = JSON.stringify(terminalArchive);
      const status = { ...v2('valid-status', url.origin), payload: { ...v2('valid-status', url.origin).payload, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: String(Buffer.byteLength(bytes)), completeness: terminalArchive.completeness, finalizationId: terminalArchive.finalizationId } };
      if (path === `${root}/sessions/current`) { state.currentReads++; return send({ status: 'registered', protocol: registration.protocol, schemaVersion: 2, projectionVersion: 1, sessionId: source.sessionId, claimId: source.claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', owner, binding: registration.payload.binding, connectionEpoch: '1', connected: false, capabilities: registration.payload.capabilities, control: v2('valid-control', url.origin).payload, snapshot: v2('valid-snapshot', url.origin).payload, ledger: v2('valid-active-ledger', url.origin).payload, archive: status.payload, recording: [] }); }
      if (path === `${root}/sessions/${source.sessionId}/archive`) { state.archiveReads++; return send(state.archiveState === 'pending' ? v2('valid-status-pending', url.origin) : status); }
      if (path === `${root}/sessions/${source.sessionId}/archive/content`) return send(terminalArchive);
    }
    if (path === `${root}/sessions/current`) { state.currentReads++; if (state.currentError) return failure(state.currentError); return send(state.registered ? { status: 'registered', session: snapshot } : { status: 'not_registered', claimId: source.claimId, agentControlMode: 'web' }); }
    if (path === `${root}/sessions/${source.sessionId}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: entries(source.sessionId), resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    for (const item of [record, other]) {
      if (path === `${root}/sessions/${item.sessionId}/archive`) { state.archiveReads++; return send({ archive: state.archiveState === 'ready' ? archiveStatus : { state: state.archiveState, sha256: null, byteLength: null, errorCode: state.archiveState === 'failed' ? 'archive_invalid' : null } }); }
      if (path === `${root}/sessions/${item.sessionId}/archive/content`) return send({ archive: archive(item) });
    }
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/steps')) return send({ projectId, taskId, version: detail.version, steps: [] });
    return failure(404);
  });
  return Object.assign(state, {
    complete: () => { detail = { ...detail, status: 'done', version: detail.version + 1n, updatedAt: new Date().toISOString(), completedAt: time, properties: { worker: { ...worker, state: 'completed' } } }; graph = graphFixture([detail]); },
    release: () => { detail = { ...detail, status: 'todo', ready: true, version: detail.version + 1n, updatedAt: new Date().toISOString(), properties: {} }; graph = graphFixture([detail]); },
  });
}
async function navigate(page: Page, presentation: Presentation = 'page') {
  if (presentation === 'dialog') {
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    await page.getByRole('tab', { name: 'Session', exact: true }).click();
  } else await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=session`);
  if (presentation === 'fullscreen') await page.getByRole('button', { name: /^(Enter Session fullscreen|会话全屏)$/ }).click();
}
async function returnToPage(page: Page) {
  // Headless Chrome keeps focus emulation enabled for every tab. Exercise the
  // product's top-level departure/return admission with controlled focus facts.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur'));
    Reflect.deleteProperty(document, 'hasFocus');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
const noSelector = async (page: Page) => {
  await expect(page.locator('.task-session-host > .terminal-host-toolbar')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^(Execution record|执行记录)$/ })).toHaveCount(0);
};
const readonly = async (page: Page) => {
  const host = page.locator('.task-session-host');
  await expect(host.locator('textarea')).toHaveCount(0);
  await expect(host.getByRole('button', { name: /^(Send|发送|Interrupt|Model|模型|Permissions|权限|Take control|取得控制|Paste text|粘贴文字)$/ })).toHaveCount(0);
};
for (const locale of ['zh-CN', 'en']) for (const width of [390, 1360]) for (const presentation of ['page', 'dialog', 'fullscreen'] as const) {
  test(`${locale} ${width}px ${presentation} automatically reads the completed claim`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, 'completed', locale); await navigate(page, presentation);
    await expect(page.getByText(savedText(record.sessionId), { exact: true })).toBeVisible();
    await expect(page.getByText(savedText(other.sessionId), { exact: true })).toHaveCount(0);
    await noSelector(page); await readonly(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem('unrelated-session-key'))).toBe('preserve');
    await page.screenshot({ path: info.outputPath('automatic-session.png') });
    if (presentation === 'fullscreen') await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /^(Attachments|附件)$/ }).click();
    await page.locator('.managed-session-records').getByRole('button', { name: /2026-11-05/ }).click();
    await expect(page.getByText(savedText(other.sessionId), { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Session', exact: true }).click();
    await expect(page.getByText(savedText(record.sessionId), { exact: true })).toBeVisible();
    expect(state.writes).toEqual([]); expect(state.sent).toEqual([]);
  });
}

test('confirmed empty history hides Session; failed and first reads stay distinguishable', async ({ page }) => {
  const state = await install(page, 'empty');
  const pending = Promise.withResolvers<void>(); state.holdHistory = pending.promise;
  await navigate(page); await expect(page.getByRole('tab', { name: 'Session', exact: true })).toBeVisible();
  await expect.poll(() => state.historyReads).toBeGreaterThan(0);
  state.historyError = 503; state.holdHistory = null; pending.resolve();
  await expect(page.locator('.task-session-host [role="alert"]')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Session', exact: true })).toBeVisible();
  state.historyError = 0;
  await page.locator('.task-session-host').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test('todo without a current claim automatically reads the latest real history without writes', async ({ page }) => {
  const state = await install(page, 'history'); await navigate(page);
  await expect(page.getByText(savedText(other.sessionId), { exact: true })).toBeVisible();
  await expect(page.locator('.task-claim')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Force withdraw' })).toHaveCount(0);
  await noSelector(page); await readonly(page); expect(state.currentReads).toBe(0); expect(state.writes).toEqual([]);
});

test('new claim waiting for registration never borrows an older conversation', async ({ page }) => {
  const state = await install(page, 'starting'); await navigate(page);
  await expect(page.locator('.task-session-host')).toContainText(/not registered|waiting/i);
  await expect(page.getByText(savedText(other.sessionId), { exact: true })).toHaveCount(0);
  await expect(page.locator('.task-session-host textarea')).toHaveCount(0);
  state.registered = true; await page.locator('.task-session-host').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  await expect(page.getByText(savedText(record.sessionId), { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]); expect(state.sent).toEqual([]);
});

for (const status of ['pending', 'failed', 'unavailable'] as const) test(`completed ${status} remains read-only and retry reads its original archive`, async ({ page }) => {
  const state = await install(page); state.archiveState = status; await navigate(page);
  await expect(page.locator('.task-session-host')).toContainText(status === 'pending' ? /waiting to be archived/ : status === 'failed' ? /could not be saved or verified/ : /No recording is available/);
  await readonly(page);
  state.archiveState = 'ready'; await page.locator('.task-session-host').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(savedText(record.sessionId), { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('working refresh and a healthy foreground return preserve the draft and rendered reading state', async ({ page }) => {
  const state = await install(page, 'working'); await navigate(page);
  const input = page.getByRole('textbox', { name: 'Message', exact: true }); await input.fill('Retained unsent draft');
  await noSelector(page);
  await input.evaluate(node => { node.setAttribute('data-retained-input', 'yes'); });
  const message = page.getByText(savedText(record.sessionId), { exact: true }); await message.evaluate(node => node.setAttribute('data-retained-message', 'yes'));
  const before = state.identityReads;
  await returnToPage(page);
  await expect(input).toHaveValue('Retained unsent draft'); await expect(input).toHaveAttribute('data-retained-input', 'yes');
  await expect(message).toHaveAttribute('data-retained-message', 'yes');
  expect(state.identityReads).toBe(before);
  await expect(input).toHaveValue('Retained unsent draft');
  await page.locator('.task-session-host').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(input).toHaveValue('Retained unsent draft');
  expect(state.writes).toEqual([]); expect(state.sent).toEqual([]);
});


test('completed Herdr reads its bound terminal archive without acquiring control', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page, 'herdr'); state.archiveState = 'pending'; await navigate(page);
  await expect(page.locator('.task-session-host')).toContainText('Recording is waiting to be archived.');
  await readonly(page); state.archiveState = 'ready';
  await page.locator('.task-session-host').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.terminal-recording')).toBeVisible();
  await expect(page.locator('.terminal-recording input[type="range"]')).toBeVisible();
  await noSelector(page); await readonly(page);
  await page.screenshot({ path: info.outputPath('herdr-readonly-390.png') });
  expect(state.writes).toEqual([]); expect(state.channels).toBe(0); expect(state.sent).toEqual([]);
});

test('terminal recording native zoom Escape cancels before leaving fullscreen', async ({ page }, info) => {
  const state = await install(page, 'herdr');
  await navigate(page);
  await expect(page.locator('.terminal-recording')).toBeVisible();
  const toggle = page.locator('.session-fullscreen-toggle');
  await toggle.click();
  const zoom = page.locator('.terminal-recording-summary select');
  await zoom.selectOption('125');
  await expect(zoom.locator('..')).toHaveAttribute('data-density', 'filter');
  expect(await zoom.evaluate(node => node.getBoundingClientRect().height)).toBe(32);
  await zoom.click();
  await expect.poll(() => zoom.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => zoom.evaluate(node => node.matches(':open'))).toBe(false);
  await expect(zoom).toHaveValue('125');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await expect(toggle).toBeFocused();
  expect(state.writes).toEqual([]); expect(state.channels).toBe(0); expect(state.sent).toEqual([]);
  await info.attach('native-recording-cancel', { body: JSON.stringify({ zoom: '125', height: 32, nativePopupObserved: true, firstEscapeRetainsFullscreen: true, secondEscapeRestoresFocus: true }), contentType: 'application/json' });
});


test('an already open working Session becomes readonly before its native lifecycle drains, then survives release', async ({ page }) => {
  const state = await install(page, 'working'); await navigate(page);
  const input = page.getByRole('textbox', { name: 'Message', exact: true }); await input.fill('Keep this draft private');
  state.archiveState = 'pending'; state.complete();
  await returnToPage(page);
  await expect(page.locator('.task-session-host')).toContainText('Recording is waiting to be archived.');
  await readonly(page); expect(state.writes).toEqual([]);
  state.archiveState = 'ready'; await page.locator('.task-session-host').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText(savedText(record.sessionId), { exact: true })).toBeVisible();
  state.release();
  await returnToPage(page);
  await expect(page.getByText(savedText(other.sessionId), { exact: true })).toBeVisible();
  await readonly(page); expect(state.writes).toEqual([]); expect(state.sent).toEqual([]);
});
