import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sessionFence, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import type { TaskSessionSnapshot } from '../helpers/session';
import { stringifyWireJson } from '../helpers/wireJson';

const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const taskRoot = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-11-06T00:00:00Z';
const providers = { codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot' } as const;
const states = { idle: 'Ready', working: 'Working', waiting_input: 'Waiting for an answer', archived: 'Completed · Read-only history' } as const;
type State = keyof typeof states;
type Provider = keyof typeof providers;

async function open(page: Page, locale: string, provider: Provider, state: State, entry: 'task' | 'test' = 'task') {
  const archived = state === 'archived';
  const taskSnapshot: TaskSessionSnapshot = { ...source, identity: { ...source.identity, provider }, lastEventSeq: '0', lastTimelineSeq: '1',
    lifecycle: archived ? 'archived' : 'active', activity: archived ? 'idle' : state, connectionState: archived ? 'disconnected' : 'connected',
    currentTurnId: state === 'working' || state === 'waiting_input' ? 'header-fixture-turn' : null,
    operations: { canSend: state === 'idle' || state === 'working', canCancel: state === 'working' || state === 'waiting_input', canRespond: false } };
  const { claimId: _claim, identity: _identity, ...base } = taskSnapshot;
  const snapshot: SessionSnapshot = entry === 'task' ? taskSnapshot : { ...base, testExecutionId: '00000003-1111-4111-8111-111111111112',
    identity: { ownerUserId: TEST_VIEWER_ID, controllerId: source.identity.controllerId, controllerInstanceId: source.identity.controllerInstanceId, provider, agentControlMode: 'web', nativeSessionId: 'header-fixture' } };
  const root = entry === 'task' ? `${taskRoot}/sessions/${source.sessionId}` : `/api/v1/test-sessions/${source.sessionId}`;
  const entries = [{ entryId: '00000009-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: 'Header layout acceptance conversation' }] }];
  const worker = { claimId: source.claimId, state: archived ? 'completed' : 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Header fixture' }, platform: 'macos', agent: provider, agentControlMode: 'web',
    worktreeId: source.identity.worktreeId, phase: archived ? 'completing' : 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Session header layout', status: archived ? 'done' : 'in_progress', ready: false,
    completedAt: archived ? time : null, properties: { worker } });
  const graph = graphFixture([detail]);
  const observations = { currentReads: 0, writes: [] as string[] };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.routeWebSocket('**/channel*', socket => {
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) observations.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === taskRoot) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${taskRoot}/sessions`) return send({ items: [], nextCursor: null });
    if (path === (entry === 'task' ? `${taskRoot}/sessions/current` : root)) {
      observations.currentReads++; return send(entry === 'task' ? { status: 'registered', session: snapshot } : { session: snapshot });
    }
    if (path === `${root}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path === `${root}/archive`) return send({ archive: { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null } });
    if (path === `${root}/archive/content`) return send({ archive: { schemaVersion: 1, ...sessionFence(snapshot), controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, provider, nativeSessionId: snapshot.identity.nativeSessionId, entries, resources: [] } });
    if (path.endsWith('/attachments') || path.endsWith('/steps')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: source.sessionId } }, 404);
  });
  await page.goto(entry === 'task' ? `/projects/${projectId}/tasks/${taskId}?tab=session` : `/test-sessions/${source.sessionId}`);
  const header = page.locator('.session-header');
  await expect(header.locator('.session-status')).toHaveText(states[state]);
  await expect(page.getByText('Header layout acceptance conversation', { exact: true })).toBeVisible();
  return { header, observations };
}

async function geometry(header: Locator) {
  return header.evaluate(element => {
    const box = (node: Element) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, center: r.top + r.height / 2 }; };
    return { header: box(element), provider: box(element.querySelector('strong')!), status: box(element.querySelector('.session-status')!),
      buttons: [...element.querySelectorAll('button')].map(box), overflow: element.scrollWidth > element.clientWidth };
  });
}

async function assertLayout(header: Locator) {
  const measured = await geometry(header), { provider, status, buttons } = measured;
  expect(measured.overflow).toBe(false);
  for (const rect of [provider, status, ...buttons]) {
    expect(rect.left).toBeGreaterThanOrEqual(measured.header.left - 1);
    expect(rect.right).toBeLessThanOrEqual(measured.header.right + 1);
  }
  for (let index = 1; index < buttons.length; index++) {
    expect(Math.abs(buttons[index]!.center - buttons[0]!.center)).toBeLessThan(2);
    expect(buttons[index]!.left).toBeGreaterThanOrEqual(buttons[index - 1]!.right);
  }
  if (measured.header.width >= 480) {
    expect(Math.abs(provider.center - status.center)).toBeLessThan(2);
    expect(Math.abs(provider.center - buttons[0]!.center)).toBeLessThan(2);
  } else {
    expect(status.top).toBeGreaterThanOrEqual(provider.bottom);
    if (measured.header.width >= 260) {
      expect(Math.abs(provider.center - buttons[0]!.center)).toBeLessThan(2);
      expect(provider.right).toBeLessThanOrEqual(buttons[0]!.left);
      expect(measured.header.height).toBeLessThan(87);
    } else expect(buttons[0]!.top).toBeGreaterThanOrEqual(status.bottom);
    for (const rect of buttons.slice(-2)) { expect(rect.width).toBe(36); expect(rect.height).toBe(36); }
  }
  return measured;
}

for (const entry of ['task', 'test'] as const) for (const locale of ['zh-CN', 'en']) for (const provider of Object.keys(providers) as Provider[]) for (const state of Object.keys(states) as State[]) {
  test(`${entry} ${locale} ${provider} ${state} header follows container width`, async ({ page }, info) => {
    const { header, observations } = await open(page, locale, provider, state, entry);
    await expect(header.locator('strong')).toHaveText(providers[provider]);
    const measured = [];
    for (const [width, height] of [[320, 640], [375, 667], [390, 844], [1360, 900]]) {
      await page.setViewportSize({ width: width!, height: height! });
      measured.push({ viewport: { width, height }, ...await geometry(header) });
      if (width === 390) await page.screenshot({ path: info.outputPath('header-390.png') });
    }
    await info.attach('geometry', { body: JSON.stringify({ measured, boundary: 'Production App routes, Session client and renderer; HTTP and WebSocket fixture, no real Provider.' }), contentType: 'application/json' });
    for (const { viewport } of measured) {
      await page.setViewportSize({ width: viewport.width!, height: viewport.height! });
      await assertLayout(header);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(observations.writes).toEqual([]);
  });
}

test('container breakpoints work inside a desktop page', async ({ page }, info) => {
  const { header } = await open(page, 'en', 'copilot', 'waiting_input');
  const measured = [];
  for (const width of [259, 260, 261, 479]) {
    await page.locator('.task-agent-session').evaluate((node, target) => { (node as HTMLElement).style.width = `${target}px`; (node as HTMLElement).style.maxWidth = '100%'; }, width);
    const current = { width, ...await geometry(header), styles: await header.evaluate(node => ({ padding: getComputedStyle(node).padding,
      gap: getComputedStyle(node).gap, identityGap: getComputedStyle(node.querySelector('.session-header-identity')!).gap,
      actionsGap: getComputedStyle(node.querySelector('.session-header-actions')!).gap })) };
    measured.push(current);
    await info.attach(`breakpoint-${width}`, { body: JSON.stringify(current), contentType: 'application/json' });
    await assertLayout(header);
    await expect(header.locator('strong')).toHaveText('GitHub Copilot');
    if (width === 260) {
      expect(await header.locator('strong').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
      expect(await header.ariaSnapshot()).toContain('GitHub Copilot');
    }
  }
  await info.attach('breakpoints', { body: JSON.stringify(measured), contentType: 'application/json' });
});

test('desktop header retains existing text controls and geometry', async ({ page }, info) => {
  const { header } = await open(page, 'en', 'copilot', 'waiting_input');
  const measurements = [];
  for (const width of [480, 481, 560, 1360]) {
    await page.locator('.task-agent-session').evaluate((node, target) => { (node as HTMLElement).style.width = `${target}px`; }, width);
    const measured = await geometry(header);
    const styles = await header.evaluate(node => ({ display: getComputedStyle(node).display, padding: getComputedStyle(node).padding,
      gap: getComputedStyle(node).gap, actionsGap: getComputedStyle(node.querySelector('.session-header-actions')!).gap }));
    measurements.push({ width, ...measured, styles });
    expect(styles).toEqual({ display: 'flex', padding: '12px 26px', gap: '12px', actionsGap: '10px' });
    const refresh = header.getByRole('button', { name: 'Refresh', exact: true });
    await expect(refresh).toBeVisible();
    expect(await refresh.innerText()).toBe('Refresh');
    expect(measured.buttons.at(-1)!.width).toBeGreaterThan(36);
    expect(measured.buttons[1]!.width).toBe(32);
    expect(measured.overflow).toBe(false);
    if (width >= 560) await assertLayout(header);
    else {
      // The existing desktop flex layout wraps long English content at this width.
      expect(measured.buttons[0]!.top).toBeGreaterThanOrEqual(measured.provider.bottom);
      expect(Math.abs(measured.provider.center - measured.status.center)).toBeLessThan(2);
    }
  }
  await info.attach('desktop-geometry', { body: JSON.stringify(measurements), contentType: 'application/json' });
});

for (const entry of ['task', 'test'] as const) for (const hasTouch of [false, true]) test.describe(`${entry} ${hasTouch ? 'touch' : 'mouse'}`, () => {
  test.use({ hasTouch });
  test('refresh, display and fullscreen retain keyboard and pointer behavior', async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const { header, observations } = await open(page, 'zh-CN', 'claude', 'idle', entry);
    const refresh = header.getByRole('button', { name: '刷新', exact: true });
    const count = observations.currentReads;
    if (hasTouch) await refresh.tap(); else await refresh.click();
    await expect.poll(() => observations.currentReads).toBeGreaterThan(count);
    await refresh.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => observations.currentReads).toBeGreaterThan(count + 1);
    await refresh.focus();
    await expect(refresh).toHaveAccessibleName('刷新');
    const tooltip = refresh.locator('[aria-hidden="true"]').filter({ hasText: '刷新' });
    await expect(tooltip).toBeVisible();
    const fullscreen = header.locator('.session-fullscreen-toggle');
    await fullscreen.click(); await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await assertLayout(header);
    await header.getByRole('button', { name: '显示', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape'); await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    await expect(fullscreen).toBeFocused();
    await info.attach('interactions', { body: JSON.stringify({ entry, hasTouch, refreshReads: observations.currentReads, writes: observations.writes }), contentType: 'application/json' });
    expect(observations.writes).toEqual([]);
  });
});
