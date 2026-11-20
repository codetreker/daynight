import { expect, test, type Locator, type Page } from '@playwright/test';
import { usageMetricKeys } from '../../src/api/usage';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { deferredRead, installTools, pathChoice, reportedDetail, targetWorker, toolActual, toolObservation, toolReport } from './worker-tool-paths-fixture';
import { WORKER_TIME } from '../helpers/workers';

const projectId = '00000000-0000-4000-8000-000000000101';
const taskId = '00000000-0000-4000-8000-000000000201';
const teamId = '00000000-0000-4000-8000-000000000701';
const projectName = '项目设置 LongProjectName'.repeat(8);
const longPath = `C:\\Tools\\${'long directory name-工具路径\\'.repeat(12)}codex.exe`;
const noOverflow = async (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
const font = async (locator: Locator, size: number) => expect(locator.first()).toHaveCSS('font-size', `${size}px`);
const fit = async (locator: Locator) => {
  await locator.scrollIntoViewIfNeeded();
  expect(await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
  })).toBe(true);
};
const rootFont = async (page: Page, size: number) => page.evaluate(value => { document.documentElement.style.fontSize = `${value}px`; }, size);
const minimumHeight = async (locator: Locator, height: number) => expect.poll(() => locator.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(height);
const retainsSelection = async (input: Locator, value: string) => {
  await expect(input).toBeFocused(); await expect(input).toHaveValue(value);
  expect(await input.evaluate((element: HTMLInputElement | HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 28]);
};

const installProject = async (page: Page, locale: 'en' | 'zh-CN', goal = false) => {
  const task = detailFixture(projectId, taskId, { title: 'Dense usage fixture', ...(goal ? { type: 'goal', ready: false } : {}) });
  const graph = graphFixture([task]);
  let project = { ...graph.project, name: projectName };
  const writes: unknown[] = [];
  const summary = {
    metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: '9007199254740993', contributingRecords: '1', unknownRecords: '2' }])),
    scope: 'registered_executions', completeness: 'partial', reasonCodes: ['native_recovery_gap'],
    coverage: { executions: '5', supportedExecutions: '4', collectingExecutions: '1', completeExecutions: '1', partialExecutions: '1', unsupportedExecutions: '1', unavailableExecutions: '0', unregisteredExecutions: '1' },
    measurementRecords: '12345', lastMeasuredAt: WORKER_TIME, observedAt: WORKER_TIME, etag: 'dense-usage',
  };
  const personal = { id: teamId, kind: 'personal', name: null };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: personal, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...personal, version: 1n, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId, userId: TEST_VIEWER_ID, role: 'admin', version: 1n, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } });
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(project);
    if (path === `/api/v1/projects/${projectId}/access`) return send({ ...directAccessFixture(projectId, TEST_VIEWER_ID, 'admin'), teamRole: 'admin', canTransfer: true });
    if (path === `/api/v1/projects/${projectId}/settings`) {
      const body = request.postDataJSON() as { executionWarningMinutes: number };
      writes.push(body); project = { ...project, settings: { ...project.settings, version: project.settings.version + 1n, executionWarningMinutes: body.executionWarningMinutes } };
      return send(project);
    }
    if (path === `/api/v1/me/projects/${projectId}/worker-prompt`) return send({ scope: 'project', scopeId: projectId, revision: '1', text: 'Original prompt', updatedAt: WORKER_TIME });
    if (path === '/api/v1/me/worker-prompt') return send({ scope: 'user', scopeId: TEST_VIEWER_ID, revision: '1', text: 'Original prompt', updatedAt: WORKER_TIME });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 1n }));
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}`) return send(task, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/sessions`) return send({ items: [], nextCursor: null });
    if (path === '/api/usage/v1/capabilities') return send({ protocol: 'daynight.usage.v1' });
    if (path.endsWith(`/usage/v1/aggregates/goal/${taskId}`)) return send({
      scope: 'goal', scopeId: taskId, membershipPolicy: 'current_members_excludes_deleted', membershipRevision: 'dense-members', summary,
      members: { total: '3', withKnownUsage: '2', complete: '0', collecting: '1', partial: '1', unsupported: '0', unavailable: '0', noData: '1', restricted: '0' },
      missingMembers: [0, 1, 2].map(index => ({ taskId: `0000000${index}-0000-4000-8000-000000000401`, title: 'Long member title 用量未知 '.repeat(15), completeness: 'partial', reasonCodes: ['native_recovery_gap'] })),
      nextMembersCursor: null, observedAt: WORKER_TIME,
    });
    if (path.endsWith('/usage/v1/task-summaries')) return send({ items: [{ taskId, summary }] });
    if (path.endsWith('/usage/v1/summary')) return send(summary);
    if (path.endsWith('/usage/v1/records')) return send({
      items: Array.from({ length: 5 }, (_, index) => ({
        id: `0000000${index}-0000-4000-8000-000000000301`, recordKind: 'measurement', sessionId: taskId, stateId: null,
        executionGeneration: '123', provider: 'codex', model: 'model-with-long-name-模型'.repeat(8), sourceKey: longPath,
        profileId: 'native-profile', providerVersion: '1.2.3', aggregationRole: 'primary', finality: 'final', disposition: 'included',
        collectionState: null, effectiveCollectionState: null,
        metrics: Object.fromEntries([...usageMetricKeys, 'providerTotalTokens'].map(key => [key, '9007199254740993'])),
        reasonCodes: ['native_recovery_gap'], observedAt: WORKER_TIME, updatedAt: WORKER_TIME,
      })), nextCursor: null, snapshotToken: 'dense', observedAt: WORKER_TIME,
    });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'typography' } }, 404);
  });
  return writes;
};

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test.describe(`${locale} ${width}px typography`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 320 });

    test('Worker roles, long paths and configuration states retain readable controls', async ({ page }, info) => {
      const state = await installTools(page, { locale });
      const detail = reportedDetail(toolReport([toolObservation('codex', 'web', { target: pathChoice(longPath), actual: toolActual('codex', 'web', { selection: pathChoice(longPath), source: 'explicit', entryPath: longPath, executablePath: longPath }) })]));
      detail.worker.platform = 'windows'; detail.worker.telemetry.platform = 'windows';
      detail.worker.machine.name = 'Worker 长名称-'.repeat(15); detail.worker.tasks[0]!.title = '任务长标题 Long task title '.repeat(20);
      detail.worker.telemetry.machine.name = detail.worker.machine.name;
      state.detail = detail;
      await page.goto(`/workers/${targetWorker}`);
      await font(page.locator('.worker-status-badge'), 14);
      await font(page.locator('.worker-task-table'), 14);
      await font(page.locator('.worker-panel-heading'), 18);
      await font(page.locator('.worker-id'), 12); await noOverflow(page);
      await page.locator('[data-worker-tab="system"]:visible').click();
      await font(page.locator('.worker-metric-value'), 22);
      await page.locator('.worker-tool-software-details > summary').first().click();
      await page.locator('.worker-tool-path-value > summary').first().click();
      await font(page.locator('.worker-tool-path-content > code'), 14);
      await fit(page.locator('.worker-tool-path-content > code').first()); await noOverflow(page);
      const gate = deferredRead(); state.configurationGate = gate;
      await page.locator('[data-worker-tab="configuration"]:visible').click(); await gate.observed;
      try { await expect(page.locator('[data-worker-panel="configuration"] .state-box')).toBeVisible(); await noOverflow(page); }
      finally { state.configurationGate = null; gate.release(); }
      const field = page.locator('#config-recoveryLimit'); await expect(field).toHaveValue('3');
      await font(field, width === 320 ? 16 : 14);
      await field.fill('7');
      const bar = page.locator('.config-save-bar'), save = bar.getByRole('button', { name: locale === 'en' ? 'Save configuration' : '保存配置', exact: true });
      await expect(save).toBeEnabled(); await fit(save); await noOverflow(page);
      await bar.getByRole('button', { name: locale === 'en' ? 'Discard changes' : '取消修改', exact: true }).click();
      await expect(field).toHaveValue('3'); expect(state.writes).toEqual([]);
      await field.fill('11'); await expect(save).toBeDisabled();
      await font(page.locator('#config-recoveryLimit-error'), 14);
      await field.fill('7'); await save.click(); await expect.poll(() => state.writes.length).toBe(1);
      expect(state.writes[0]!.value.recoveryLimit).toBe(7);
      await noOverflow(page);
      if (width === 1280) {
        // A 1280x900 desktop at 200% zoom exposes a 640x450 CSS-pixel viewport.
        await page.setViewportSize({ width: 640, height: 450 });
        await expect(field).toHaveValue('7'); await font(field, 16);
        await fit(save); await noOverflow(page);
      }
      await info.attach('worker-configuration', { body: await page.screenshot(), contentType: 'image/png' });
    });

    test('project settings and prompt drafts keep roles, focus and values through reflow', async ({ page }, info) => {
      const writes = await installProject(page, locale);
      await page.goto(`/projects/${projectId}/settings`);
      const input = page.locator('#execution-warning-minutes'), panel = page.locator('.project-settings-panel');
      await expect(input).toHaveValue('60'); await font(input, width === 320 ? 16 : 14);
      await font(panel.locator('h2'), 18); await font(panel.locator('label'), 14);
      await input.fill('0'); await panel.getByRole('button', { name: locale === 'en' ? 'Save settings' : '保存设置', exact: true }).click();
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await font(panel.locator('[role="alert"]'), 14); await noOverflow(page);
      await input.fill('75'); await panel.getByRole('button', { name: locale === 'en' ? 'Save settings' : '保存设置', exact: true }).click();
      await expect.poll(() => writes.length).toBe(1); await expect(input).toHaveValue('75');
      await page.goto(`/projects/${projectId}/settings?tab=prompts`);
      const prompt = page.locator('.worker-prompt-text'); await expect(prompt).toHaveValue('Original prompt');
      const text = 'Keep this instruction readable 保留草稿和选择。'.repeat(40);
      await prompt.fill(text); await prompt.focus();
      await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 28));
      const original = await prompt.elementHandle();
      await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
      await expect(prompt).toBeFocused(); await expect(prompt).toHaveValue(text);
      expect(await prompt.evaluate((element, node) => element === node, original)).toBe(true);
      expect(await prompt.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 28]);
      await font(page.locator('.worker-prompt .panel-heading h2'), 22.5);
      await noOverflow(page); await fit(prompt);
      await info.attach('project-prompt-font-preference', { body: await page.screenshot(), contentType: 'image/png' });
      await original?.dispose();
    });
  });
}

for (const width of [1280, 320]) for (const hasTouch of [false, true]) test.describe(`font preferences ${width}px touch=${hasTouch}`, () => {
  test.use({ viewport: { width, height: 900 }, hasTouch });
  const responsive = width <= 800 || hasTouch;
  const fieldFont = (root: number) => responsive ? Math.max(root, 16) : root * 0.875;

  test('Worker configuration keeps long path drafts, errors and focus in a narrow desktop container', async ({ page }, info) => {
    const state = await installTools(page, { locale: 'en' });
    state.detail = reportedDetail(toolReport([toolObservation('codex', 'web', { target: pathChoice(longPath), actual: toolActual('codex', 'web', { selection: pathChoice(longPath), source: 'explicit', entryPath: longPath, executablePath: longPath }) })]));
    state.detail.worker.platform = 'windows'; state.detail.worker.telemetry.platform = 'windows';
    await page.goto(`/workers/${targetWorker}`);
    await page.locator('[data-worker-tab="configuration"]:visible').click();
    const configuration = page.locator('.worker-configuration');
    await expect(page.locator('#config-recoveryLimit')).toHaveValue('3');
    if (width === 1280) await configuration.evaluate(element => { element.style.width = '640px'; element.style.maxWidth = '100%'; });
    await configuration.locator('.configuration-tool-paths > summary').click();
    const path = page.locator('#config-toolPaths-codex'), recovery = page.locator('#config-recoveryLimit');
    await path.fill(longPath); await recovery.fill('11');
    const save = page.locator('.config-save-bar').getByRole('button', { name: 'Save configuration', exact: true });
    await expect(save).toBeDisabled();
    await path.focus(); await path.evaluate((element: HTMLInputElement) => element.setSelectionRange(5, 28));
    for (const root of [12, 24]) {
      await rootFont(page, root);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(hasTouch);
      await font(path, fieldFont(root)); await font(recovery, fieldFont(root));
      await font(page.locator('#config-recoveryLimit-error'), root * 0.875);
      await font(configuration.locator('.configuration-tool-paths > summary'), root * 1.125);
      await retainsSelection(path, longPath);
      await fit(path); await noOverflow(page);
      if (responsive) { await minimumHeight(path, 44); await minimumHeight(recovery, 44); }
      expect(await configuration.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await recovery.fill('7'); await expect(save).toBeEnabled(); await fit(save);
    expect(state.writes).toEqual([]);
    await info.attach('worker-preference-and-container', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('project fields and personal Prompt retain readable input sizes, selection and touch geometry', async ({ page }, info) => {
    const writes = await installProject(page, 'en');
    await page.goto(`/projects/${projectId}/settings`);
    const input = page.locator('#execution-warning-minutes'), panel = page.locator('.project-settings-panel');
    await expect(input).toHaveValue('60'); await input.fill('0');
    await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    for (const root of [12, 24]) {
      await rootFont(page, root); await font(input, fieldFont(root));
      await font(panel.locator('[role="alert"]'), root * 0.875);
      if (responsive) await minimumHeight(input, 44);
      await fit(input); await noOverflow(page);
    }
    await page.goto('/account?tab=prompt');
    const prompt = page.locator('.worker-prompt-text'); await expect(prompt).toHaveValue('Original prompt');
    const text = 'Keep this personal instruction readable 保留个人草稿。'.repeat(40);
    await prompt.fill(text); await prompt.focus();
    await prompt.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 28));
    if (width === 1280) await page.locator('.worker-prompt').evaluate(element => { element.style.width = '620px'; element.style.maxWidth = '100%'; });
    for (const root of [12, 24]) {
      await rootFont(page, root); await font(prompt, fieldFont(root));
      await font(page.locator('.worker-prompt .panel-heading h2'), root * 1.125);
      await retainsSelection(prompt, text); await minimumHeight(prompt, 196);
      await fit(prompt); await noOverflow(page);
    }
    expect(writes).toEqual([]);
    await info.attach('personal-prompt-font-preferences', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('repository editor and confirmation preserve long addresses through font changes', async ({ page }, info) => {
    const writes = await installProject(page, 'en');
    const address = `https://git.example.com/platform/${'long-repository-name-'.repeat(14)}project.git`;
    const previews: unknown[] = [];
    await page.route(`**/api/v1/projects/${projectId}/repository/preview`, route => {
      previews.push(route.request().postDataJSON());
      return route.fulfill({ json: { projectId, projectName, currentRepoUrl: 'https://github.com/example/project', repoUrl: address, repositoryVersion: '1', ownershipVersion: '1', classification: 'unverified', targetGitHubRepositoryId: null, unverifiedReason: 'unsupported_host', bindingsInvalidated: true }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    });
    await page.goto(`/projects/${projectId}/settings?tab=management`);
    await page.getByRole('region', { name: 'Repository address', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit repository address', exact: true });
    const input = editor.getByLabel('New repository address', { exact: true });
    await input.fill(address); await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(5, 28));
    for (const root of [12, 24]) {
      await rootFont(page, root); await font(input, fieldFont(root));
      await font(editor.locator('h2'), root * 1.125);
      await retainsSelection(input, address); await fit(input); await noOverflow(page);
      if (responsive) await minimumHeight(input, 44);
    }
    await input.press('Enter');
    const confirmation = page.getByRole('dialog', { name: 'Confirm repository address change', exact: true });
    const back = confirmation.getByRole('button', { name: 'Back', exact: true });
    await expect(back).toBeFocused();
    for (const root of [12, 24]) {
      await rootFont(page, root); await font(confirmation.locator('h2'), root * 1.125);
      await font(confirmation.locator('.dialog-body'), root * 0.875);
      await expect(back).toBeFocused(); await fit(back); await noOverflow(page);
      expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await back.click(); await expect(input).toHaveValue(address); await expect(input).toBeFocused();
    expect(previews).toHaveLength(1); expect(writes).toEqual([]);
    await info.attach('repository-font-preferences', { body: await page.screenshot(), contentType: 'image/png' });
  });
});

for (const locale of ['en', 'zh-CN'] as const) test(`dense usage ${locale} retains readable numbers, filters and local scrolling`, async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installProject(page, locale);
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=usage`);
  await page.getByRole('tab', { name: locale === 'en' ? 'Usage' : '用量', exact: true }).click();
  const panel = page.locator('.usage-panel');
  await expect(panel.locator('.usage-record')).toHaveCount(5);
  await font(panel.locator('.usage-completeness'), 14);
  await font(panel.locator('.usage-metrics dt'), 14);
  await font(panel.locator('.usage-filters input'), 16);
  await font(panel.locator('.usage-record code'), 14);
  await noOverflow(page); await fit(panel.locator('.usage-record').first());
  const provider = panel.getByLabel('Provider'); await provider.fill('codex');
  await provider.press('Enter'); await expect(provider).toHaveValue('codex');
  await expect(panel.locator('.usage-record')).toHaveCount(5);
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await font(panel.locator('.usage-completeness'), 28);
  await noOverflow(page);
  await info.attach('dense-usage-double-font-size', { body: await page.screenshot(), contentType: 'image/png' });
});

test('aggregate usage reflows exact counters and long member actions at 320px', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installProject(page, 'en', true);
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  await page.getByRole('tab', { name: 'Usage', exact: true }).click();
  const aggregate = page.locator('.usage-aggregate');
  await expect(aggregate.locator('.usage-aggregate-member')).toHaveCount(3);
  await font(aggregate.locator('h3'), 18);
  await font(aggregate.locator('.usage-aggregate-member'), 14);
  await expect(aggregate.locator('.usage-aggregate-counts dd').first()).toHaveText('3');
  await noOverflow(page); await fit(aggregate.locator('.usage-aggregate-member').first());
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await font(aggregate.locator('h3'), 36); await noOverflow(page);
  await info.attach('aggregate-usage-double-font-size', { body: await page.screenshot(), contentType: 'image/png' });
});

test('project portal typography keeps deletion loading, errors and confirmation fields readable', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installProject(page, 'en');
  const gate = deferredRead();
  await page.route(`**/api/v1/projects/${projectId}/deletion-preview`, async route => {
    gate.started(); await gate.promise;
    return route.fulfill({ json: { observedAt: WORKER_TIME, project: { id: projectId, name: projectName, repoUrl: 'https://github.com/example/project', ownerTeam: { id: teamId, kind: 'personal', name: null } }, summary: { taskCount: 12345, unfinishedTaskCount: 234, attachmentCount: 45678 }, activeClaims: [], nextCursor: null }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
  });
  await page.route(`**/api/v1/projects/${projectId}`, route => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const requestId = route.request().headers()['x-request-id']!;
    return route.fulfill({ status: 400, json: { error: { code: 'invalid_input', message: 'Rejected', requestId } }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID, 'X-Request-ID': requestId } });
  });
  await page.goto(`/projects/${projectId}/settings?tab=management`);
  await font(page.locator('.repository-card .team-settings-details dt'), 14);
  await page.getByRole('button', { name: 'Delete project', exact: true }).click(); await gate.observed;
  const dialog = page.getByRole('dialog', { name: 'Delete this project?', exact: true });
  try { await font(dialog.locator('[role="status"]'), 14); await noOverflow(page); }
  finally { gate.release(); }
  const input = dialog.locator('#project-deletion-name');
  await expect(input).toBeVisible(); await font(input, 16); await font(dialog.locator('label'), 14);
  await input.fill(projectName); await dialog.getByRole('button', { name: 'Confirm deletion', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Deletion was not committed');
  await font(dialog.getByRole('alert'), 14);
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
  await font(input, 20); await font(dialog.locator('label'), 17.5); await font(dialog.locator('h2'), 22.5);
  await noOverflow(page); await fit(input);
  await info.attach('project-deletion-portal-font-preference', { body: await page.screenshot(), contentType: 'image/png' });
});
