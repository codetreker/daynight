import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { sessionFence, type SessionCommand, type SessionSnapshot } from '../../../daynight/src/session/protocol';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import type { TaskSessionSnapshot } from '../helpers/session';
import { stringifyWireJson } from '../helpers/wireJson';
import { botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';
import { closeBotConversation } from '../helpers/bot-heading';
import type { SessionControls } from '../../../daynight/src/session/controls';

const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const taskRoot = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-11-06T00:00:00Z';
const controls: SessionControls = { revision: '3', settings: [
  { id: 'model', category: 'model', label: 'Model selection', description: null, value: 'native-a', mutable: true, scope: 'session', options: [{ value: 'native-a', label: 'A long native model name for layout verification' }, { value: 'native-b', label: 'Native B' }] },
  { id: 'permissions', category: 'permission', label: 'Approval policy', description: 'Native policy', value: 'ask', mutable: true, scope: 'session', options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }] },
], commands: Array.from({ length: 18 }, (_, index) => ({ id: `skill:review-${index}`, name: `review-${index}`, description: 'Review changes with a longer English description and 中文命令说明', argumentHint: 'Review instructions', available: true })), settingsError: null, commandsError: null };
const states = { idle: 'Ready', working: 'Working', waiting_input: 'Waiting for an answer', archived: 'Completed · Read-only history' } as const;
type State = keyof typeof states;
type Entry = 'task' | 'test' | 'assistant';
type Content = 'short' | 'long' | 'empty' | 'interaction' | 'interaction-two' | 'interaction-six' | 'tall-form';
async function open(page: Page, locale: string, state: State, entry: Entry = 'task', content: Content = 'short', errors = false, options: { timelineGate?: Promise<void>; timelineStarted?: () => void; failResponse?: boolean } = {}) {
  const provider = 'codex';
  const archived = state === 'archived';
  const taskSnapshot: TaskSessionSnapshot = { ...source, controls: errors ? { ...controls, commandsError: 'Native commands could not be refreshed. 原生命令刷新失败，已有命令仍可查看。', settingsError: 'Native settings could not be refreshed. 原生设置刷新失败。' } : controls, identity: { ...source.identity, provider }, lastEventSeq: '0', lastTimelineSeq: content === 'long' ? '30' : content === 'empty' ? '0' : '1',
    lifecycle: archived ? 'archived' : 'active', activity: archived ? 'idle' : state, connectionState: archived ? 'disconnected' : 'connected',
    currentTurnId: state === 'working' || state === 'waiting_input' ? 'column-fixture-turn' : null,
    operations: { canSend: state === 'idle' || state === 'working', canCancel: state === 'working' || state === 'waiting_input', canRespond: !archived && (content.startsWith('interaction') || content === 'tall-form') } };
  const { claimId: _claim, identity: _identity, ...base } = taskSnapshot;
  const snapshot: SessionSnapshot = entry === 'task' ? taskSnapshot : { ...base, testExecutionId: '00000003-1111-4111-8111-111111111112',
    identity: { ownerUserId: TEST_VIEWER_ID, controllerId: source.identity.controllerId, controllerInstanceId: source.identity.controllerInstanceId, provider, agentControlMode: 'web', nativeSessionId: 'column-fixture' } };
  const root = entry === 'task' ? `${taskRoot}/sessions/${source.sessionId}` : `/api/v1/test-sessions/${source.sessionId}`;
  const entries = content === 'empty' ? [] : content === 'tall-form' ? [{
    entryId: '00000009-1111-4111-8111-000000000001', entrySeq: '1', revision: '1', kind: 'interaction',
    interaction: { interactionId: '00000010-1111-4111-8111-000000000001', revision: '1', state: 'pending', title: 'Choose session options', kind: 'form', canDismiss: false, fields: [
      { fieldId: 'name', label: 'Workspace profile name', type: 'text', required: true, sensitive: false },
      { fieldId: 'region', label: 'Destination region', type: 'select', required: true, options: [{ id: 'eu', label: 'Europe' }, { id: 'us', label: 'United States' }] },
      { fieldId: 'profile', label: 'Workspace profile', type: 'multiselect', required: false, options: [{ id: 'standard', label: 'Standard' }, { id: 'development', label: 'Development configuration with validation and local diagnostics enabled' }] },
    ] },
  }] : content.startsWith('interaction') ? [{
    entryId: '00000009-1111-4111-8111-000000000001', entrySeq: '1', revision: '1', kind: 'interaction',
    interaction: { interactionId: '00000010-1111-4111-8111-000000000001', revision: '1', state: archived ? 'expired' : 'pending', title: 'Choose session options', kind: 'form', canDismiss: false, fields: [
      { fieldId: 'region', label: 'Destination region', type: 'select', required: true, options: [{ id: 'eu', label: 'Europe' }, { id: 'us', label: 'United States' }] },
      { fieldId: 'features', label: 'Enabled features', type: 'multiselect', required: true, options: content === 'interaction' ? Array.from({ length: 10 }, (_, index) => ({ id: `feature-${index}`, label: `Feature ${index}` })) : (locale === 'en' ? ['Standard', 'Development configuration with validation and local diagnostics enabled', 'path/with/a/very/long/unbroken/segment/abcdefghijklmnopqrstuvwxyz0123456789', 'Validation profile alpha', 'Validation profile beta', 'Read-only preview'] : ['标准配置', '使用包含验证及本地诊断的标准开发配置', '路径/包含很长的连续片段/abcdefghijklmnopqrstuvwxyz0123456789', '验证配置甲', '验证配置乙', '只读预览']).slice(0, content === 'interaction-two' ? 2 : 6).map((label, index) => ({ id: `feature-${index}`, label })) },
      { fieldId: 'enabled', label: 'Enabled flag', type: 'boolean', required: true },
    ] },
  }] : Array.from({ length: content === 'long' ? 30 : 1 }, (_, index) => ({ entryId: `00000009-1111-4111-8111-${String(index + 1).padStart(12, '0')}`, entrySeq: String(index + 1), revision: '1', kind: 'assistant_message', content: [{ type: 'text', text: content === 'long' ? `### Message ${index + 1}\n\nSession column acceptance conversation. Long content wraps within the reading column. 中文正文与输入框保持一致。\n\n\`\`\`text\n${'long_code_without_spaces_'.repeat(60)}\n\`\`\`` : 'Session column acceptance conversation' }] }));
  const bot = { ...botDefinition(), ownerUserId: TEST_VIEWER_ID, name: 'Column assistant', sessionId: snapshot.sessionId, testExecutionId: snapshot.testExecutionId!, roleConfiguration: { instructions: 'Fixture only.', revision: '1', digest: 'a'.repeat(64) }, startupResult: { state: 'ready', code: null } };
  const worker = { claimId: source.claimId, state: archived ? 'completed' : 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Column fixture' }, platform: 'macos', agent: provider, agentControlMode: 'web',
    worktreeId: source.identity.worktreeId, phase: archived ? 'completing' : 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Session column layout', status: archived ? 'done' : 'in_progress', ready: false,
    completedAt: archived ? time : null, properties: { worker } });
  const graph = graphFixture([detail]);
  const observations = { currentReads: 0, writes: [] as string[], pageErrors: [] as string[] };
  const settingUpdate = Promise.withResolvers<SessionCommand>(), settingReceipt = Promise.withResolvers<void>();
  let publishSnapshot: ((next: SessionSnapshot) => void) | undefined;
  page.on('pageerror', error => observations.pageErrors.push(error.message));
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.routeWebSocket('**/channel*', socket => {
    publishSnapshot = next => socket.send(JSON.stringify({ protocol: next.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot: next, cursor: 'updated' }));
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) observations.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...botAttentionHeaders(route.request().headers(), status), ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: [bot], nextCursor: null });
    if (path === `/api/v1/me/bots/${bot.id}`) return send(bot);
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/members`) return send({ items: [{ userId: TEST_VIEWER_ID, profile: { name: 'Reader', email: null, avatarUrl: null }, effectiveRole: 'member', directGrant: directAccessFixture(projectId).directGrant, inheritedFrom: null }], actorAccess: directAccessFixture(projectId) });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === taskRoot) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${taskRoot}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${root}/commands` && request.method() === 'POST') {
      const command = request.postDataJSON() as SessionCommand;
      settingUpdate.resolve(command);
      if (options.failResponse && command.kind === 'interaction_response') return send({ error: { code: 'invalid_request', message: 'Response unavailable', requestId: source.sessionId } }, 400);
      await settingReceipt.promise;
      return send({ operation: { protocol: snapshot.protocol, ...sessionFence(snapshot), operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null }, operationUrl: `${root}/operations/${command.operationId}` }, 202);
    }
    if (path === (entry === 'task' ? `${taskRoot}/sessions/current` : root)) {
      observations.currentReads++; return send(entry === 'task' ? { status: 'registered', session: snapshot } : { session: snapshot });
    }
    if (path === `${root}/timeline`) {
      options.timelineStarted?.();
      await options.timelineGate;
      return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    }
    if (path === `${root}/archive`) return send({ archive: { state: 'ready', sha256: 'a'.repeat(64), byteLength: '100', errorCode: null } });
    if (path === `${root}/archive/content`) return send({ archive: { schemaVersion: 1, ...sessionFence(snapshot), controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, provider, nativeSessionId: snapshot.identity.nativeSessionId, entries, resources: [] } });
    if (path.endsWith('/attachments') || path.endsWith('/steps')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: source.sessionId } }, 404);
  });
  await page.goto(entry === 'assistant' ? `/bots/${bot.id}` : entry === 'task' ? `/projects/${projectId}/tasks/${taskId}?tab=session` : `/test-sessions/${source.sessionId}`);
  const header = page.locator('.session-header');
  if (entry !== 'assistant') await expect(header.locator('.session-status')).toHaveText(states[state]);
  await expect(page.locator('.session-timeline-content')).toBeAttached();
  if (!archived) await expect(page.locator('.session-composer textarea')).toBeVisible();
  if (content !== 'empty') await expect(page.locator('.session-entry')).toHaveCount(entries.length);
  return { header, observations, settingUpdate: settingUpdate.promise, confirmSetting: () => settingReceipt.resolve(), publishConfirmedModel: () => {
    if (!publishSnapshot) throw new Error('The Session channel must be connected before publishing a confirmed setting.');
    publishSnapshot({ ...snapshot, sessionRevision: String(BigInt(snapshot.sessionRevision) + 1n), controls: { ...controls, revision: '4', settings: controls.settings.map(setting => setting.id === 'model' ? { ...setting, value: 'native-b' } : setting) } });
  } };
}

async function columnGeometry(page: Page) {
  return page.locator('.task-agent-session').evaluate(root => {
    const timeline = root.querySelector<HTMLElement>('.session-timeline')!;
    const content = root.querySelector<HTMLElement>('.session-timeline-content')!;
    const surface = root.querySelector<HTMLElement>('.session-composer-surface')!;
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    return { root: rect(root), content: rect(content), surface: rect(surface), scrollbar: timeline.offsetWidth - timeline.clientWidth,
      verticalOverflow: timeline.scrollHeight > timeline.clientHeight, horizontalOverflow: root.scrollWidth > root.clientWidth,
      timelineHeight: timeline.clientHeight, contentOverflow: content.scrollWidth > content.clientWidth,
      surfaceOverflow: surface.scrollWidth > surface.clientWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function assertColumn(page: Page) {
  await expect.poll(async () => {
    const measured = await columnGeometry(page);
    return Math.max(Math.abs(measured.content.left - measured.surface.left), Math.abs(measured.content.right - measured.surface.right));
  }).toBeLessThanOrEqual(1);
  const measured = await columnGeometry(page);
  expect(measured.horizontalOverflow).toBe(false);
  expect(measured.surfaceOverflow).toBe(false);
  expect(measured.contentOverflow).toBe(false);
  expect(measured.documentOverflow).toBe(false);
  expect(measured.timelineHeight).toBeGreaterThan(40);
  return measured;
}
async function scrollbarMode(page: Page, mode: 'native' | 'classic' | 'stable') {
  if (mode === 'native') return;
  await page.addStyleTag({ content: `.session-timeline::-webkit-scrollbar { width: 17px; height: 17px; } .session-timeline { scrollbar-gutter: ${mode === 'stable' ? 'stable both-edges' : 'auto'}; }` });
}

for (const entry of ['task', 'test'] as const) for (const locale of ['en', 'zh-CN'] as const) {
  test(`${entry} ${locale} locates a clipped tall form using the actual timeline`, async ({ browser }, info) => {
    const evidence = [];
    for (const [width, height] of [[320, 640], [375, 667], [390, 844], [768, 900], [1360, 900]] as const) {
      const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4303', viewport: { width, height }, hasTouch: width < 400 });
      try {
        const page = await context.newPage();
        const { observations } = await open(page, locale, 'waiting_input', entry, 'tall-form');
        const timeline = page.locator('.session-timeline'), card = page.locator('.session-interaction');
        const heading = card.locator('h4'), first = page.getByLabel('Workspace profile name', { exact: true });
        const jump = page.locator('.session-pending-request');
        if (entry === 'task' && width <= 375) {
          await expect(jump).toContainText('↑');
          const nav = await jump.evaluate(node => ({ button: node.getBoundingClientRect().toJSON(), shell: node.closest('.session-timeline-shell')!.getBoundingClientRect().toJSON() }));
          expect(nav.button.top).toBeGreaterThanOrEqual(nav.shell.top);
          expect(nav.button.bottom).toBeLessThanOrEqual(nav.shell.bottom);
          await page.getByRole('button', { name: locale === 'en' ? 'Submit' : '提交', exact: true }).click({ timeout: 5000 });
          await expect(page.getByRole('alert')).toBeVisible();
          await jump.click(); await expect(card).toBeFocused();
          await timeline.evaluate(node => { node.scrollTop += 45; node.dispatchEvent(new Event('scroll')); });
          await expect(jump).toBeVisible(); await expect(page.locator('.session-latest')).toBeVisible();
          expect(await jump.locator('.session-pending-label').evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThan(40);
          await expect(page.locator('.session-latest-label')).toBeVisible();
          await expect(jump).toHaveAccessibleName('Pending request · Choose session options'.replace('Pending request', locale === 'en' ? 'Pending request' : '待处理请求'));
          await first.click({ position: { x: 10, y: 10 }, timeout: 5000 });
          await first.fill('Embedded draft');
          await page.locator('.session-fullscreen-toggle').click();
          await expect(first).toHaveValue('Embedded draft');
        }
        const geometry = await card.evaluate(node => {
          const box = node.closest('.session-timeline')!.getBoundingClientRect(), card = node.getBoundingClientRect(), title = node.querySelector('h4')!.getBoundingClientRect();
          return { viewport: box.toJSON(), card: card.toJSON(), title: title.toJSON() };
        });
        const clipped = geometry.card.height > geometry.viewport.height - 24 && (geometry.title.top < geometry.viewport.top || geometry.title.bottom > geometry.viewport.bottom);
        if (entry === 'test' && width <= 375) expect(clipped).toBe(true);
        if (clipped) {
          await expect(jump).toContainText('↑');
          if (width === 320) await jump.tap(); else { await jump.focus(); await page.keyboard.press('Enter'); }
          await expect(card).toBeFocused(); await expect(jump).toHaveCount(0);
          const after = await heading.evaluate(node => ({ title: node.getBoundingClientRect().toJSON(), first: node.closest('.session-interaction')!.querySelector('input')!.getBoundingClientRect().toJSON(), viewport: node.closest('.session-timeline')!.getBoundingClientRect().toJSON() }));
          expect(after.title.top).toBeGreaterThanOrEqual(after.viewport.top);
          expect(after.title.bottom).toBeLessThanOrEqual(after.viewport.bottom);
          expect(after.first.top).toBeGreaterThanOrEqual(after.viewport.top);
          if (entry === 'test' || width !== 390) expect(after.first.bottom).toBeLessThanOrEqual(after.viewport.bottom);
          await first.fill('Retained profile');
          await page.locator('.session-latest').click();
          await expect(first).toHaveValue('Retained profile');
          await expect(jump).toBeVisible();
          await page.getByRole('checkbox', { name: 'Standard', exact: true }).check();
          await page.getByRole('button', { name: locale === 'en' ? 'Submit' : '提交', exact: true }).click();
          await expect(page.getByRole('alert')).toBeVisible();
        } else if (entry === 'task' && width <= 375) {
          const visible = await first.evaluate(node => ({ input: node.getBoundingClientRect().toJSON(), viewport: node.closest('.session-timeline')!.getBoundingClientRect().toJSON() }));
          expect(visible.input.top).toBeGreaterThanOrEqual(visible.viewport.top);
          expect(visible.input.bottom).toBeLessThanOrEqual(visible.viewport.bottom);
        } else {
          expect(clipped).toBe(false);
          await expect(jump).toHaveCount(0);
        }
        expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
        evidence.push({ width, height, clipped, ...geometry });
      } finally { await context.close(); }
    }
    await info.attach('pending-form-geometry', { body: JSON.stringify(evidence), contentType: 'application/json' });
  });
}

test('a located form retains values through a real response command', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4303', viewport: { width: 320, height: 640 }, hasTouch: true });
  try {
    const page = await context.newPage();
    const fixture = await open(page, 'en', 'waiting_input', 'test', 'tall-form');
    await page.locator('.session-pending-request').tap();
    await page.getByLabel('Workspace profile name', { exact: true }).fill('Retained profile');
    await page.getByLabel('Destination region', { exact: true }).selectOption('eu');
    await page.getByRole('checkbox', { name: 'Standard', exact: true }).check();
    expect(fixture.observations.writes).toEqual([]);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    const command = await fixture.settingUpdate;
    expect(command.kind).toBe('interaction_response');
    if (command.kind !== 'interaction_response') throw new Error('Expected an interaction response');
    expect(command.payload.response).toEqual({ kind: 'form', values: [
      { fieldId: 'name', value: 'Retained profile' }, { fieldId: 'region', value: 'eu' }, { fieldId: 'profile', value: ['standard'] },
    ] });
    fixture.confirmSetting();
    await expect(page.locator('.session-pending-request')).toHaveCount(0);
    expect(fixture.observations.pageErrors).toEqual([]);
  } finally { await context.close(); }
});

for (const entry of ['task', 'test'] as const) test(`${entry} uses its narrow desktop container height for the locator`, async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const { observations } = await open(page, 'en', 'waiting_input', entry, 'tall-form');
  const root = page.locator('.task-agent-session'), timeline = page.locator('.session-timeline');
  await root.evaluate(node => { node.style.width = '375px'; node.style.height = '400px'; node.style.flex = 'none'; });
  const jump = page.locator('.session-pending-request');
  await expect(jump).toContainText('↑');
  await jump.click();
  await expect(page.locator('.session-interaction')).toBeFocused();
  const dimensions = await timeline.evaluate(node => ({ width: innerWidth, height: node.getBoundingClientRect().height, heading: node.querySelector('h4')!.getBoundingClientRect().toJSON(), bounds: node.getBoundingClientRect().toJSON() }));
  expect(dimensions.width).toBe(1360);
  expect(dimensions.heading.top).toBeGreaterThanOrEqual(dimensions.bounds.top);
  expect(dimensions.heading.bottom).toBeLessThanOrEqual(dimensions.bounds.bottom);
  expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
});
test('switches pending navigation at the timeline shell height threshold', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const { observations } = await open(page, 'en', 'waiting_input', 'test', 'tall-form');
  const shell = page.locator('.session-timeline-shell').last();
  const jump = page.locator('.session-pending-request');
  for (const [height, position] of [[120, 'absolute'], [121, 'static'], [119, 'absolute']] as const) {
    await shell.evaluate((node, value) => { node.style.flex = 'none'; node.style.height = `${value}px`; }, height);
    await expect(jump).toBeVisible();
    await expect.poll(() => jump.evaluate(node => getComputedStyle(node.parentElement!).position)).toBe(position);
    await expect(jump).toHaveAccessibleName('Pending request · Choose session options');
  }
  expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
});
async function imageFooterGeometry(page: Page) {
  return page.locator('.session-composer-footer-default').evaluate(footer => {
    const surface = footer.closest<HTMLElement>('.session-composer-surface')!;
    const nodes = [...footer.querySelectorAll<HTMLElement>('.session-controls-toolbar button, .session-actions button')];
    const rect = (node: Element) => node.getBoundingClientRect().toJSON();
    const style = getComputedStyle(surface);
    return { contentWidth: surface.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      footer: rect(footer), surface: rect(surface), controls: nodes.map(rect),
      overflow: footer.scrollWidth > footer.clientWidth || surface.scrollWidth > surface.clientWidth };
  });
}

for (const entry of ['task', 'test'] as const) for (const locale of ['en', 'zh-CN']) {
  test(`${entry} ${locale} aligns image and send actions at narrow content widths`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      const { observations, publishConfirmedModel } = await open(page, locale, 'idle', entry);
      const image = page.locator('.session-add-images'), input = page.locator('.session-composer textarea');
      const send = page.locator('.session-primary-actions button[type=submit]');
      await expect(image).toBeEnabled(); await expect(send).toBeDisabled();
      const empty = await imageFooterGeometry(page);
      await input.fill('Draft for the image toolbar'); await expect(send).toBeEnabled();
      const filled = await imageFooterGeometry(page);
      expect(empty.contentWidth).toBe(278); expect(filled.footer.height).toBe(44);
      expect(empty.footer.height).toBe(filled.footer.height);
      const evidence: Array<Record<string, unknown>> = [{ viewport: 320, ...filled }];
      for (const measured of [empty, filled]) {
        expect(measured.controls).toHaveLength(5); expect(measured.overflow).toBe(false);
        const centers = measured.controls.map(rect => rect.top + rect.height / 2);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
        expect(measured.controls[3]!.width).toBe(44); expect(measured.controls[3]!.height).toBe(44);
        for (const control of measured.controls) expect(control.height).toBeGreaterThanOrEqual(36);
      }
      const originalInput = await input.elementHandle();
      for (const width of [375, 390, 768, 1360]) {
        await page.setViewportSize({ width, height: 844 });
        const measured = await imageFooterGeometry(page);
        expect(measured.overflow).toBe(false);
        expect(measured.controls[4]!.right).toBeLessThanOrEqual(measured.footer.right + 1);
        const centers = measured.controls.map(rect => rect.top + rect.height / 2);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
        expect(await input.evaluate((node, original) => node === original, originalInput)).toBe(true);
        await expect(input).toHaveValue('Draft for the image toolbar');
        evidence.push({ viewport: width, ...measured });
      }
      // Exercise the query against the real surface content width in a narrow embedded panel.
      await page.setViewportSize({ width: 1360, height: 844 });
      for (const width of [235, 256, 275, 276, 277]) {
        await page.locator('.session-composer-surface').evaluate((node, width) => {
          node.style.boxSizing = 'content-box'; node.style.width = `${width}px`;
        }, width);
        const measured = await imageFooterGeometry(page);
        expect(measured.contentWidth).toBe(width); expect(measured.overflow).toBe(false);
        const settings = measured.controls.slice(0, 4), action = measured.controls[4]!;
        expect(action.right).toBeLessThanOrEqual(measured.footer.right + 1);
        expect(measured.footer.right - action.right).toBeLessThanOrEqual(1);
        if (width < 276) expect(action.top).toBeGreaterThanOrEqual(Math.max(...settings.map(rect => rect.bottom)) - 1);
        else {
          const centers = measured.controls.map(rect => rect.top + rect.height / 2);
          expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
        }
        evidence.push({ viewport: width, ...measured });
      }
      await page.locator('.session-composer-surface').evaluate(node => { node.style.removeProperty('width'); node.style.removeProperty('box-sizing'); });
      await page.setViewportSize({ width: 320, height: 640 });
      await page.locator('.session-fullscreen-toggle').click();
      const fullscreen = await imageFooterGeometry(page);
      expect(fullscreen.overflow).toBe(false);
      expect(fullscreen.controls[4]!.right).toBeLessThanOrEqual(fullscreen.footer.right + 1);
      evidence.push({ viewport: 320, fullscreen: true, ...fullscreen });
      await page.keyboard.press('Escape');
      for (const size of [12, 20, 24]) for (const width of [235, 256, 278]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, size);
        await page.locator('.session-composer-surface').evaluate((node, width) => {
          node.style.boxSizing = 'content-box'; node.style.width = `${width}px`;
        }, width);
        const measured = await imageFooterGeometry(page);
        expect(measured.overflow).toBe(false);
        for (const [index, control] of measured.controls.entries()) {
          expect(control.left).toBeGreaterThanOrEqual(measured.footer.left - 1);
          expect(control.right).toBeLessThanOrEqual(measured.footer.right + 1);
          for (const other of measured.controls.slice(index + 1)) {
            const overlapX = Math.min(control.right, other.right) - Math.max(control.left, other.left);
            const overlapY = Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top);
            expect(overlapX <= 1 || overlapY <= 1).toBe(true);
          }
        }
        expect(measured.footer.right - measured.controls[4]!.right).toBeLessThanOrEqual(1);
        evidence.push({ viewport: 320, rootFontSize: size, ...measured });
      }
      await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });
      await page.locator('.session-composer-surface').evaluate(node => { node.style.removeProperty('width'); node.style.removeProperty('box-sizing'); });
      const model = page.locator('.session-model-trigger');
      const modelParts = await model.evaluate(node => {
        const label = node.querySelector<HTMLElement>('.session-model-label')!, caret = node.querySelector<HTMLElement>('.session-control-caret')!;
        const button = node.getBoundingClientRect(), arrow = caret.getBoundingClientRect();
        return { truncated: label.scrollWidth > label.clientWidth, arrowLeft: arrow.left, arrowRight: arrow.right, buttonLeft: button.left, buttonRight: button.right };
      });
      expect(modelParts.truncated).toBe(true);
      expect(modelParts.arrowLeft).toBeGreaterThanOrEqual(modelParts.buttonLeft);
      expect(modelParts.arrowRight).toBeLessThanOrEqual(modelParts.buttonRight);
      await model.click();
      await expect(page.locator('.session-controls-panel')).toContainText('A long native model name for layout verification');
      await page.keyboard.press('Escape');
      await expect(page.locator('.session-controls-panel')).toHaveCount(0);
      await model.focus(); await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Permissions', exact: true })).toBeFocused();
      await page.keyboard.press('Tab'); await expect(page.locator('.session-command-trigger')).toBeFocused();
      await page.keyboard.press('Tab'); await expect(image).toBeFocused();
      await page.keyboard.press('Tab'); await expect(send).toBeFocused();
      publishConfirmedModel();
      await expect(model).toContainText('Native B');
      const shortModel = await imageFooterGeometry(page);
      const shortCenters = shortModel.controls.map(rect => rect.top + rect.height / 2);
      expect(shortModel.overflow).toBe(false);
      expect(Math.max(...shortCenters) - Math.min(...shortCenters)).toBeLessThanOrEqual(1);
      evidence.push({ viewport: 320, model: 'Native B', ...shortModel });
      const chooser = page.waitForEvent('filechooser'); await image.tap();
      expect((await chooser).isMultiple()).toBe(true);
      await expect(input).toHaveValue('Draft for the image toolbar');
      await send.tap();
      await expect.poll(() => observations.writes.some(write => write.endsWith('/commands'))).toBe(true);
      expect(observations.pageErrors).toEqual([]);
      await info.attach('image-footer-geometry', { body: JSON.stringify({ entry, locale, evidence, boundary: 'Production Web page with Session transport fixtures, touch emulation and Chromium; no native provider or physical device.' }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

test('preserves the no-image footer width policy', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
  try {
    const page = await context.newPage(); await open(page, 'en', 'idle', 'test');
    await page.locator('.session-add-images').waitFor({ state: 'visible' });
    // The production Session always supplies an image binding; remove its button
    // only to exercise the CSS policy for a composer without that entry.
    await page.locator('.session-add-images').evaluate(node => node.remove());
    const evidence = [];
    for (const width of [233, 234, 256]) {
      await page.locator('.session-composer-surface').evaluate((node, width) => {
        node.style.boxSizing = 'content-box'; node.style.width = `${width}px`;
      }, width);
      const measured = await imageFooterGeometry(page);
      expect(measured.contentWidth).toBe(width); expect(measured.controls).toHaveLength(4);
      expect(measured.overflow).toBe(false);
      const settings = measured.controls.slice(0, 3), send = measured.controls[3]!;
      if (width < 234) expect(send.top).toBeGreaterThanOrEqual(Math.max(...settings.map(rect => rect.bottom)) - 1);
      else {
        const centers = measured.controls.map(rect => rect.top + rect.height / 2);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      }
      evidence.push({ width, ...measured });
    }
    await info.attach('no-image-footer-geometry', { body: JSON.stringify({ evidence, boundary: 'Production CSS and markup with the image button removed as a layout fixture; not a product capability state.' }), contentType: 'application/json' });
  } finally { await context.close(); }
});

for (const state of ['working', 'waiting_input'] as const) {
  test(`image footer keeps ${state} groups distinct at desktop breakpoints and larger fonts`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
    try {
      const page = await context.newPage(); await open(page, 'en', state, 'test');
      const evidence = [];
      for (const size of [16, 20, 24]) for (const width of [516, 599, 600]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, size);
        await page.locator('.session-composer-surface').evaluate((node, width) => {
          node.style.boxSizing = 'content-box'; node.style.width = `${width}px`;
        }, width);
        const measured = await page.locator('.session-composer-footer-default').evaluate(footer => {
          const nodes = [...footer.querySelectorAll<HTMLElement>(':scope > .session-controls-toolbar, :scope > .session-composer-activity, :scope > .session-primary-actions')];
          return { footer: footer.getBoundingClientRect().toJSON(), groups: nodes.map(node => node.getBoundingClientRect().toJSON()),
            buttons: [...footer.querySelectorAll<HTMLElement>('button')].map(node => node.getBoundingClientRect().toJSON()),
            overflow: footer.scrollWidth > footer.clientWidth };
        });
        expect(measured.groups).toHaveLength(3); expect(measured.overflow).toBe(false);
        for (const [index, control] of measured.groups.entries()) {
          expect(control.left).toBeGreaterThanOrEqual(measured.footer.left - 1);
          expect(control.right).toBeLessThanOrEqual(measured.footer.right + 1);
          for (const other of measured.groups.slice(index + 1)) {
            const overlapX = Math.min(control.right, other.right) - Math.max(control.left, other.left);
            const overlapY = Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top);
            expect(overlapX <= 1 || overlapY <= 1).toBe(true);
          }
        }
        for (const button of measured.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(measured.footer.left - 1);
          expect(button.right).toBeLessThanOrEqual(measured.footer.right + 1);
        }
        for (const button of measured.buttons.slice(0, 4)) {
          expect(button.left).toBeGreaterThanOrEqual(measured.groups[0]!.left - 1);
          expect(button.right).toBeLessThanOrEqual(measured.groups[0]!.right + 1);
        }
        evidence.push({ size, width, ...measured });
      }
      await info.attach('image-footer-activity-geometry', { body: JSON.stringify({ state, evidence }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

for (const entry of ['task', 'test', 'assistant'] as const) for (const content of ['short', 'long', 'empty'] as const) {
  test(`${entry} ${content} aligns the production reading and input columns`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const { observations } = await open(page, 'en', 'idle', entry, content);
    const evidence = [];
    for (const mode of ['native', 'classic', 'stable'] as const) {
      await scrollbarMode(page, mode);
      for (const width of [1920, 1360, 960, 390, 320]) {
        await page.setViewportSize({ width, height: 1080 });
        const measured = await assertColumn(page);
        evidence.push({ mode, width, ...measured });
        if (content === 'long' && mode === 'classic' && (width === 1920 || width === 390)) await page.screenshot({ path: info.outputPath(`column-${width}.png`) });
        if (mode === 'stable') expect(measured.scrollbar).toBeGreaterThanOrEqual(17);
        if (mode === 'classic' && content === 'long') expect(measured.scrollbar).toBeGreaterThanOrEqual(17);
        if (width === 1920) expect(measured.content.width).toBeLessThanOrEqual(entry === 'assistant' ? 760 : 960);
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    for (const width of [960, 390, 320]) {
      await page.locator('.task-agent-session').evaluate((root, width) => { (root as HTMLElement).style.width = `${width}px`; }, width);
      const measured = await assertColumn(page);
      expect(measured.root.width).toBe(width);
      evidence.push({ mode: 'desktop-panel', width, ...measured });
    }
    await page.screenshot({ path: info.outputPath('column-320.png') });
    await info.attach('geometry', { body: JSON.stringify({ boundary: 'Production application, Session HTTP/WebSocket transport fixtures, local Chrome. No real Provider or physical device.', evidence, writes: observations.writes }), contentType: 'application/json' });
    expect(observations.writes).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });
}

for (const entry of ['task', 'test', 'assistant'] as const) for (const locale of ['en', 'zh-CN']) {
  test(`${entry} ${locale} preserves drafts and reading through width and fullscreen changes`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1360, height: 1000 });
    const { observations } = await open(page, locale, 'working', entry, 'long');
    await scrollbarMode(page, 'classic');
    const input = page.locator('.session-composer textarea'), timeline = page.locator('.session-timeline');
    const originalInput = await input.elementHandle(), originalTimeline = await timeline.elementHandle();
    const draft = 'Draft selection 中文输入\n'.repeat(12);
    await input.fill(draft);
    await input.evaluate(node => { (node as HTMLTextAreaElement).setSelectionRange(3, 11); node.focus(); });
    const evidence = [];
    for (const width of [1920, 960, 390, 320, 1360]) {
      await page.setViewportSize({ width, height: 1000 });
      evidence.push(await assertColumn(page));
      expect(await input.evaluate((node, original) => node === original, originalInput)).toBe(true);
      await expect(input).toHaveValue(draft);
      await expect(input).toBeFocused();
      expect(await input.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([3, 11]);
    }
    await timeline.hover(); await page.mouse.wheel(0, -1200);
    await expect(page.locator('.session-latest')).toBeVisible();
    const reading = await timeline.evaluate(node => node.scrollTop);
    const fullscreen = page.locator('.session-fullscreen-toggle');
    await fullscreen.click(); await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    evidence.push(await assertColumn(page));
    await page.keyboard.press('Escape'); await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    evidence.push(await assertColumn(page));
    expect(await timeline.evaluate((node, original) => node === original, originalTimeline)).toBe(true);
    await expect(input).toHaveValue(draft);
    expect(await input.evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd])).toEqual([3, 11]);
    expect(Math.abs(await timeline.evaluate(node => node.scrollTop) - reading)).toBeLessThanOrEqual(3);
    await page.locator('.session-latest').click();
    await expect.poll(() => timeline.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(3);
    await info.attach('resize-and-fullscreen', { body: JSON.stringify({ entry, locale, evidence, writes: observations.writes }), contentType: 'application/json' });
    expect(observations.writes).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });
}

for (const entry of ['task', 'test'] as const) test(`${entry} readonly history has no composer placeholder`, async ({ page }) => {
  await open(page, 'en', 'archived', entry, 'long');
  await expect(page.locator('.session-composer')).toHaveCount(0);
  await expect(page.locator('.session-timeline')).toBeVisible();
});

for (const entry of ['task', 'test', 'assistant'] as const) for (const locale of ['en', 'zh-CN']) {
  test(`${entry} ${locale} keeps panels and errors on the input column`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    const { observations } = await open(page, locale, locale === 'en' ? 'idle' : 'waiting_input', entry, 'long', true);
    await scrollbarMode(page, 'stable');
    const input = page.locator('.session-composer textarea');
    const evidence = [];
    for (const width of [1920, 960, 390, 320]) {
      await page.setViewportSize({ width, height: 1200 });
      await input.fill('A multiline draft remains available.\n中文草稿与菜单同时保留。\nThird line.');
      await page.locator('.session-model-trigger').click();
      const settings = page.locator('.session-controls-panel');
      await expect(settings).toBeVisible();
      await expect(settings.locator('[role="alert"]')).toBeVisible();
      const column = await assertColumn(page);
      const panel = await settings.boundingBox();
      expect(Math.abs(panel!.x - column.surface.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(panel!.x + panel!.width - column.surface.right)).toBeLessThanOrEqual(1);
      await settings.locator('.session-controls-heading button').click();
      await expect(settings).toHaveCount(0);
      await page.locator('.session-command-trigger').click();
      const commands = page.locator('.session-command-menu'), body = page.locator('.session-command-body');
      await expect(commands).toBeVisible();
      await expect(body.locator('[role="alert"]')).toBeAttached();
      const withCommands = await assertColumn(page), commandBox = await commands.boundingBox();
      expect(Math.abs(commandBox!.x - withCommands.surface.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(commandBox!.x + commandBox!.width - withCommands.surface.right)).toBeLessThanOrEqual(1);
      expect(await body.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await body.hover(); await page.mouse.wheel(0, 600);
      await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const visibleControls = await page.locator('.session-composer').evaluate(form => {
        const nodes = [...form.querySelectorAll<HTMLElement>('.session-composer-footer button, textarea, .session-command-close')];
        return nodes.map(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }; });
      });
      for (const control of visibleControls) {
        expect(control.width).toBeGreaterThan(0); expect(control.height).toBeGreaterThan(0);
        expect(control.left).toBeGreaterThanOrEqual(withCommands.surface.left - 1);
        expect(control.right).toBeLessThanOrEqual(withCommands.surface.right + 1);
        expect(control.top).toBeGreaterThanOrEqual(0); expect(control.bottom).toBeLessThanOrEqual(1201);
      }
      evidence.push({ width, column, panel, withCommands, commandBox, visibleControls });
      await page.locator('.session-command-close').click();
      await expect(commands).toHaveCount(0);
      await expect(input).toHaveValue('A multiline draft remains available.\n中文草稿与菜单同时保留。\nThird line.');
    }
    await info.attach('panels', { body: JSON.stringify({ entry, locale, evidence, writes: observations.writes }), contentType: 'application/json' });
    expect(observations.writes).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
  });
}

for (const entry of ['task', 'test', 'assistant'] as const) test(`${entry} short fullscreen keeps command scrolling and input usable`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 1000 });
  const { observations } = await open(page, 'en', 'working', entry, 'long');
  await page.locator('.session-fullscreen-toggle').click();
  await scrollbarMode(page, 'classic');
  const input = page.locator('.session-composer textarea');
  await input.fill('Draft in a short window');
  const evidence = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 500 });
    await page.locator('.session-command-trigger').click();
    await expect(page.locator('.session-command-menu')).toBeVisible();
    const measured = await assertColumn(page);
    const samples = await page.locator('.task-agent-session').evaluate(async root => {
      const content = root.querySelector('.session-timeline-content')!;
      const surface = root.querySelector('.session-composer-surface')!;
      const values = [];
      for (let frame = 0; frame < 10; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const a = content.getBoundingClientRect(), b = surface.getBoundingClientRect();
        values.push([a.left, a.right, b.left, b.right]);
      }
      return values;
    });
    for (const [left, right, inputLeft, inputRight] of samples) {
      expect(Math.abs(left! - inputLeft!)).toBeLessThanOrEqual(1);
      expect(Math.abs(right! - inputRight!)).toBeLessThanOrEqual(1);
    }
    const compact = await page.locator('.session-composer').evaluate(node => node.classList.contains('session-composer-compact-menus'));
    const scroller = page.locator(compact ? '.session-command-menu' : '.session-command-body');
    expect(await scroller.evaluate(node => node.clientHeight)).toBeGreaterThanOrEqual(36);
    expect(await scroller.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    const inputBox = await input.boundingBox(), sendBox = await page.locator('.session-actions button').boundingBox();
    expect(inputBox!.height).toBeGreaterThanOrEqual(44);
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(501);
    await scroller.hover(); await page.mouse.wheel(0, 500);
    await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await page.locator('.session-command-close').click();
    await expect(page.locator('.session-command-menu')).toHaveCount(0);
    await expect(input).toHaveValue('Draft in a short window');
    evidence.push({ width, measured, inputBox, sendBox });
  }
  await info.attach('short-fullscreen', { body: JSON.stringify(evidence), contentType: 'application/json' });
  expect(observations.writes).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
});


test('assistant real navigation remeasures a retained hidden Session after resize', async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 1000 });
  const { observations } = await open(page, 'en', 'idle', 'assistant', 'long');
  await scrollbarMode(page, 'classic');
  const input = page.locator('.session-composer textarea');
  const original = await input.elementHandle();
  await input.fill('Retained assistant draft');
  await closeBotConversation(page);
  await expect(input).toBeHidden();
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.locator(`.bot-list a[href="/bots/${botId()}"]`).click();
  await expect(input).toBeVisible();
  expect(await input.evaluate((node, original) => node === original, original)).toBe(true);
  await expect(input).toHaveValue('Retained assistant draft');
  const measured = await assertColumn(page);
  await info.attach('hidden-resize', { body: JSON.stringify({ measured, writes: observations.writes }), contentType: 'application/json' });
  expect(observations.writes).toEqual([]);
    expect(observations.pageErrors).toEqual([]);
});

for (const entry of ['task', 'test', 'assistant'] as const) test(`${entry} native settings Escape preserves the panel, draft and fullscreen`, async ({ page }, info) => {
  const { observations } = await open(page, 'en', 'idle', entry);
  const input = page.locator('.session-composer textarea');
  await input.fill('Retain this unsent draft 中文草稿');
  const toggle = page.locator('.session-fullscreen-toggle');
  await toggle.click();
  await page.locator('.session-model-trigger').click();
  const panel = page.locator('.session-controls-panel'), select = panel.locator('select').first();
  await expect(select).toHaveValue('native-a');
  await select.evaluate(node => node.setAttribute('data-native-node', 'retained'));
  await select.click();
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
  await expect(panel).toBeVisible(); await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveValue('native-a'); await expect(select).toHaveAttribute('data-native-node', 'retained');
  await expect(input).toHaveValue('Retain this unsent draft 中文草稿');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0); await expect(input).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await expect(toggle).toBeFocused();
  expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
  await info.attach('native-settings-cancel', { body: JSON.stringify({ entry, nativePopup: 'Observed :open before real Escape and closed afterward', panelRetained: true, draftRetained: true, fullscreenRetained: true, writes: observations.writes }), contentType: 'application/json' });
});

test('native Provider setting retains the confirmed value while its request is pending', async ({ page }, info) => {
  const fixture = await open(page, 'en', 'idle');
  const input = page.locator('.session-composer textarea');
  await input.fill('Retain draft during Provider confirmation');
  await page.locator('.session-model-trigger').click();
  const select = page.locator('.session-controls-panel select').first(), wrapper = select.locator('..');
  await select.evaluate(node => node.setAttribute('data-native-node', 'retained'));
  await select.click();
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  const command = await fixture.settingUpdate;
  expect(command.kind).toBe('update_setting');
  expect(command.payload).toEqual({ settingId: 'model', value: 'native-b', expectedControlsRevision: '3' });
  await expect(wrapper).toHaveAttribute('data-pending', 'true');
  await expect(select).toHaveValue('native-a'); await expect(select).toBeDisabled();
  await expect(input).toHaveValue('Retain draft during Provider confirmation');
  fixture.confirmSetting();
  await expect(wrapper).toHaveAttribute('data-pending', 'false');
  await expect(select).toHaveValue('native-a');
  fixture.publishConfirmedModel();
  await expect(select).toHaveValue('native-b'); await expect(select).toBeEnabled();
  await expect(select).toHaveAttribute('data-native-node', 'retained');
  await expect(input).toHaveValue('Retain draft during Provider confirmation');
  expect(fixture.observations.writes).toEqual([expect.stringMatching(/^POST .*\/commands$/)]);
  expect(fixture.observations.pageErrors).toEqual([]);
  await info.attach('provider-confirmation', { body: JSON.stringify({ command, pendingValue: 'native-a', receiptValue: 'native-a', confirmedSnapshotValue: 'native-b', sameNativeNode: true, draftRetained: true }), contentType: 'application/json' });
});

for (const entry of ['task', 'assistant'] as const) test(`${entry} select dimensions follow the actual named Bot container`, async ({ page }, info) => {
  const { observations } = await open(page, 'en', 'idle', entry);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.locator('.session-model-trigger').click();
  const root = page.locator('.task-agent-session'), select = page.locator('.session-controls-panel select').first();
  const evidence = [];
  for (const width of [700, 560]) {
    await root.evaluate((node, width) => { (node as HTMLElement).style.width = `${width}px`; }, width);
    await expect.poll(() => select.evaluate(node => node.getBoundingClientRect().height)).toBe(entry === 'assistant' && width <= 600 ? 44 : 38);
    const measured = await select.evaluate(node => ({
      height: node.getBoundingClientRect().height, font: getComputedStyle(node).fontSize,
      wrapperMode: node.parentElement!.getAttribute('data-touch-mode'),
      readingContainer: getComputedStyle(node.closest('.task-agent-session')!).containerName,
      composerContainer: getComputedStyle(node.closest('.session-composer')!).containerName,
      timelinePadding: getComputedStyle(node.closest('.task-agent-session')!.querySelector('.session-timeline')!).paddingLeft,
    }));
    expect(measured.wrapperMode).toBe(entry === 'assistant' ? 'container' : 'none');
    expect(measured.font).toBe('14px');
    if (entry === 'assistant') {
      expect(measured.readingContainer).toBe('bot-reading native-select-region');
      expect(measured.composerContainer).not.toContain('native-select-region');
      expect(measured.timelinePadding).toBe(width <= 600 ? '18px' : '36px');
    }
    evidence.push({ width, ...measured });
  }
  await page.screenshot({ path: info.outputPath(`${entry}-native-select-560.png`) });
  await info.attach('native-container-dimensions', { body: JSON.stringify(evidence), contentType: 'application/json' });
  expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
});

test('coarse-pointer Bot session uses touch typography', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4303', viewport: { width: 1360, height: 1000 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await open(page, 'en', 'idle', 'assistant');
    await page.locator('.session-model-trigger').click();
    const select = page.locator('.session-controls-panel select').first();
    expect(await page.evaluate(() => matchMedia('(pointer:coarse)').matches)).toBe(true);
    await expect.poll(() => select.evaluate(node => getComputedStyle(node).fontSize)).toBe('16px');
    expect(await select.evaluate(node => node.getBoundingClientRect().height)).toBe(44);
    await info.attach('coarse-native-select', { body: JSON.stringify({ pointer: 'coarse', height: 44, font: '16px', boundary: 'Chromium touch emulation, no physical device evidence' }), contentType: 'application/json' });
  } finally { await context.close(); }
});

for (const entry of ['task', 'assistant'] as const) test(`${entry} timeline native selection cancels before fullscreen and preserves form values`, async ({ page }, info) => {
  const { observations } = await open(page, 'en', 'waiting_input', entry, 'interaction');
  const toggle = page.locator('.session-fullscreen-toggle');
  await toggle.click();
  const select = page.getByLabel('Destination region', { exact: true });
  await select.selectOption('eu');
  const first = page.getByRole('checkbox', { name: 'Feature 1', exact: true });
  const third = page.getByRole('checkbox', { name: 'Feature 3', exact: true });
  await first.check();
  await third.check();
  await page.getByLabel('Enabled flag', { exact: true }).selectOption('false');
  await select.click();
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveValue('eu'); await expect(first).toBeChecked(); await expect(third).toBeChecked();
  await expect(page.getByLabel('Enabled flag', { exact: true })).toHaveValue('false');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await expect(toggle).toBeFocused();
  expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
  await info.attach('native-interaction-cancel', { body: JSON.stringify({ entry, nativePopupObserved: true, firstEscapeRetainsFullscreen: true, secondEscapeRestoresFocus: true, multiple: ['feature-1', 'feature-3'], flag: false }), contentType: 'application/json' });
});

for (const entry of ['task', 'test'] as const) for (const locale of ['en', 'zh-CN'] as const) for (const content of ['interaction-two', 'interaction-six'] as const) {
  test(`${entry} ${locale} ${content} wraps and submits form choices`, async ({ browser }, info) => {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4303', viewport: { width: 320, height: 640 }, hasTouch: true });
    try {
      const page = await context.newPage();
      const fixture = await open(page, locale, 'waiting_input', entry, content);
      const rows = page.locator('.session-multiselect-choice');
      const checks = rows.locator('input');
      await expect(rows).toHaveCount(content === 'interaction-two' ? 2 : 6);
      for (const [width, height] of [[320, 640], [375, 667], [390, 844], [768, 900], [1360, 900]] as const) {
        await page.setViewportSize({ width, height });
        const geometry = await rows.evaluateAll(nodes => nodes.map(node => {
          const label = node as HTMLElement, text = label.querySelector('span')!;
          return { width: label.clientWidth, scrollWidth: label.scrollWidth, textWidth: text.clientWidth, textScrollWidth: text.scrollWidth, height: label.getBoundingClientRect().height, font: getComputedStyle(label).fontSize };
        }));
        for (const row of geometry) {
          expect(row.scrollWidth).toBeLessThanOrEqual(row.width);
          expect(row.textScrollWidth).toBeLessThanOrEqual(row.textWidth);
          expect(row.height).toBeGreaterThanOrEqual(44);
          expect(row.font).toBe('16px');
        }
      }
      await page.setViewportSize({ width: 320, height: 640 });
      await rows.nth(1).tap();
      await page.getByLabel('Destination region', { exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(checks.nth(0)).toBeFocused();
      await page.keyboard.press('Space');
      await expect(checks.nth(0)).toBeChecked(); await expect(checks.nth(1)).toBeChecked();
      await rows.nth(1).evaluate(node => node.scrollIntoView({ block: 'center' }));
      await rows.nth(1).click({ position: { x: 12, y: 10 } }); await expect(checks.nth(1)).not.toBeChecked();
      await rows.nth(1).tap({ position: { x: 12, y: 10 } });
      await page.setViewportSize({ width: 1360, height: 900 });
      await page.setViewportSize({ width: 320, height: 640 });
      await expect(checks.nth(0)).toBeChecked(); await expect(checks.nth(1)).toBeChecked();
      await page.getByLabel('Destination region', { exact: true }).selectOption('eu');
      await page.getByLabel('Enabled flag', { exact: true }).selectOption('false');
      await page.locator('.session-interaction button[type=submit]').evaluate(node => node.scrollIntoView({ block: 'center' }));
      await page.locator('.session-interaction button[type=submit]').click();
      const command = await fixture.settingUpdate;
      expect(command.kind).toBe('interaction_response');
      if (command.kind !== 'interaction_response') throw new Error('Expected interaction response');
      expect(command.payload.response).toEqual({ kind: 'form', values: [
        { fieldId: 'region', value: 'eu' }, { fieldId: 'features', value: ['feature-0', 'feature-1'] }, { fieldId: 'enabled', value: false },
      ] });
      await expect(checks.nth(0)).toBeDisabled();
      fixture.confirmSetting();
      expect(fixture.observations.pageErrors).toEqual([]);
      await info.attach('form-choices', { body: JSON.stringify({ entry, locale, content, widths: [320, 375, 390, 768, 1360], response: command.payload.response }), contentType: 'application/json' });
    } finally { await context.close(); }
  });
}

test('desktop form choices use interface typography and compact rows', async ({ page }) => {
  await open(page, 'en', 'waiting_input', 'task', 'interaction-two');
  const row = page.locator('.session-multiselect-choice').first();
  await expect(row).toHaveCSS('font-size', '14px');
  expect(await row.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(36);
});

test('form loading and failed response preserve the selected choices', async ({ page }) => {
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
  const opening = open(page, 'en', 'waiting_input', 'test', 'interaction-two', false, { timelineGate: gate.promise, timelineStarted: started.resolve, failResponse: true });
  await started.promise;
  await expect(page.locator('.session-multiselect-choice')).toHaveCount(0);
  gate.resolve();
  const fixture = await opening;
  const checks = page.locator('.session-multiselect-choice input');
  await checks.nth(1).check();
  await page.getByLabel('Destination region', { exact: true }).selectOption('eu');
  await page.getByLabel('Enabled flag', { exact: true }).selectOption('false');
  await page.locator('.session-interaction button[type=submit]').click();
  await expect(page.locator('.session-error')).toBeVisible();
  await expect(checks.nth(1)).toBeChecked();
  await expect(checks.nth(1)).toBeEnabled();
  expect(fixture.observations.writes).toHaveLength(1);
});

test('archived form requests remain readable without response controls', async ({ page }) => {
  const fixture = await open(page, 'en', 'archived', 'test', 'interaction-two');
  await expect(page.locator('.session-multiselect-choice')).toHaveCount(0);
  await page.getByText('Show request').click();
  await expect(page.getByRole('region', { name: 'Request content' })).toContainText('Enabled features');
  await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  expect(fixture.observations.writes).toEqual([]);
});

for (const entry of ['task', 'assistant'] as const) test(`${entry} composer follows interface and touch typography without losing its draft`, async ({ browser }) => {
  for (const touch of [false, true]) {
    const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4303', viewport: { width: 320, height: 900 }, hasTouch: touch });
    try {
      const page = await context.newPage();
      const { observations } = await open(page, 'zh-CN', 'working', entry, 'long');
      const input = page.locator('.session-composer textarea');
      await input.fill('保留草稿 Retained draft');
      await expect(input).toHaveCSS('font-size', touch ? '16px' : '14px');
      await expect(page.locator('.session-control-trigger').first()).toHaveCSS('font-size', '14px');
      await page.locator('.session-model-trigger').click();
      await expect(page.locator('.session-control-setting label').first()).toHaveCSS('font-size', '14px');
      await expect(page.locator('.session-controls-foot small')).toHaveCSS('font-size', '14px');
      await page.evaluate(() => document.documentElement.style.fontSize = '20px');
      await expect(input).toHaveCSS('font-size', touch ? '20px' : '17.5px');
      await expect(page.locator('.session-control-trigger').first()).toHaveCSS('font-size', '17.5px');
      await expect(input).toHaveValue('保留草稿 Retained draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
    } finally { await context.close(); }
  }
});


test('Task and Bot composers remain usable at 200% browser zoom', async ({ playwright }) => {
  const temporary = fileURLToPath(new URL('../../../../.tmp/session-column/', import.meta.url));
  await mkdir(temporary, { recursive: true });
  const profile = await mkdtemp(`${temporary}/zoom-profile-`);
  try {
    await mkdir(`${profile}/Default`);
    await writeFile(`${profile}/Default/Preferences`, JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
    const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
    const context = await playwright.chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, baseURL: 'http://127.0.0.1:4303', viewport: null,
      args: ['--window-size=1280,900', '--force-device-scale-factor=1'],
      ...(executable === undefined ? {} : { executablePath: executable }),
    });
    try {
      for (const entry of ['task', 'assistant'] as const) {
        const page = await context.newPage();
        const { observations } = await open(page, 'en', 'working', entry, 'long');
        expect(await page.evaluate(() => devicePixelRatio)).toBeCloseTo(2, 1);
        const input = page.locator('.session-composer textarea');
        await input.fill('Draft at browser zoom');
        await page.locator('.session-model-trigger').click();
        await expect(page.locator('.session-control-setting label').first()).toHaveCSS('font-size', '14px');
        await page.keyboard.press('Escape');
        await expect(input).toHaveValue('Draft at browser zoom');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
        await page.close();
      }
    } finally { await context.close(); }
  } finally { await rm(profile, { recursive: true, force: true }); }
});
