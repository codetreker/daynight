import { readFileSync } from 'node:fs';
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
type Content = 'short' | 'long' | 'empty' | 'interaction';
async function open(page: Page, locale: string, state: State, entry: Entry = 'task', content: Content = 'short', errors = false) {
  const provider = 'codex';
  const archived = state === 'archived';
  const taskSnapshot: TaskSessionSnapshot = { ...source, controls: errors ? { ...controls, commandsError: 'Native commands could not be refreshed. 原生命令刷新失败，已有命令仍可查看。', settingsError: 'Native settings could not be refreshed. 原生设置刷新失败。' } : controls, identity: { ...source.identity, provider }, lastEventSeq: '0', lastTimelineSeq: content === 'long' ? '30' : content === 'empty' ? '0' : '1',
    lifecycle: archived ? 'archived' : 'active', activity: archived ? 'idle' : state, connectionState: archived ? 'disconnected' : 'connected',
    currentTurnId: state === 'working' || state === 'waiting_input' ? 'column-fixture-turn' : null,
    operations: { canSend: state === 'idle' || state === 'working', canCancel: state === 'working' || state === 'waiting_input', canRespond: content === 'interaction' } };
  const { claimId: _claim, identity: _identity, ...base } = taskSnapshot;
  const snapshot: SessionSnapshot = entry === 'task' ? taskSnapshot : { ...base, testExecutionId: '00000003-1111-4111-8111-111111111112',
    identity: { ownerUserId: TEST_VIEWER_ID, controllerId: source.identity.controllerId, controllerInstanceId: source.identity.controllerInstanceId, provider, agentControlMode: 'web', nativeSessionId: 'column-fixture' } };
  const root = entry === 'task' ? `${taskRoot}/sessions/${source.sessionId}` : `/api/v1/test-sessions/${source.sessionId}`;
  const entries = content === 'empty' ? [] : content === 'interaction' ? [{
    entryId: '00000009-1111-4111-8111-000000000001', entrySeq: '1', revision: '1', kind: 'interaction',
    interaction: { interactionId: '00000010-1111-4111-8111-000000000001', revision: '1', state: 'pending', title: 'Choose session options', kind: 'form', canDismiss: false, fields: [
      { fieldId: 'region', label: 'Destination region', type: 'select', required: true, options: [{ id: 'eu', label: 'Europe' }, { id: 'us', label: 'United States' }] },
      { fieldId: 'features', label: 'Enabled features', type: 'multiselect', required: true, options: Array.from({ length: 10 }, (_, index) => ({ id: `feature-${index}`, label: `Feature ${index}` })) },
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
      await settingReceipt.promise;
      return send({ operation: { protocol: snapshot.protocol, ...sessionFence(snapshot), operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null }, operationUrl: `${root}/operations/${command.operationId}` }, 202);
    }
    if (path === (entry === 'task' ? `${taskRoot}/sessions/current` : root)) {
      observations.currentReads++; return send(entry === 'task' ? { status: 'registered', session: snapshot } : { session: snapshot });
    }
    if (path === `${root}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
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
    expect(measured.font).toBe('12px');
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
  const multiple = page.getByLabel('Enabled features', { exact: true });
  await multiple.selectOption(['feature-1', 'feature-3']);
  await expect(multiple).toHaveValues(['feature-1', 'feature-3']);
  await expect(multiple.locator('..').locator('svg')).toHaveCount(0);
  expect(await multiple.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await page.getByLabel('Enabled flag', { exact: true }).selectOption('false');
  await select.click();
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(select).toHaveValue('eu'); await expect(multiple).toHaveValues(['feature-1', 'feature-3']);
  await expect(page.getByLabel('Enabled flag', { exact: true })).toHaveValue('false');
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); await expect(toggle).toBeFocused();
  expect(observations.writes).toEqual([]); expect(observations.pageErrors).toEqual([]);
  await info.attach('native-interaction-cancel', { body: JSON.stringify({ entry, nativePopupObserved: true, firstEscapeRetainsFullscreen: true, secondEscapeRestoresFocus: true, multiple: ['feature-1', 'feature-3'], flag: false }), contentType: 'application/json' });
});
