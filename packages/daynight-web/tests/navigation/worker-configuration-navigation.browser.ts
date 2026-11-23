import { expect, test, type Page } from '@playwright/test';
import type { WorkerConfigurationValue } from '../../src/api/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const target = workerId(1), personalId = workerId(90), projectId = workerId(301);
const workerPath = `/workers/${target}`;
const personal = { id: personalId, kind: 'personal', name: null };
const project = { id: projectId, name: 'Alpha project', repoUrl: 'https://example.test/alpha.git', settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1 }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME };
const configurationGate = (method: 'GET' | 'PUT' = 'GET') => {
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  return { method, started: started.promise, finish: finish.resolve, wait: finish.promise, notify: started.resolve };
};
const install = async (page: Page, locale: 'zh-CN' | 'en' = 'zh-CN') => {
  const state = { resource: configurationResource(), unavailable: false, readFailure: false, userId: WORKER_USER, writes: [] as string[], reads: 0, gate: null as ReturnType<typeof configurationGate> | null };
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, json, headers: { 'Daynight-User-ID': state.userId, ...extra } });
    const missing = () => send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
    const monitoringQuery = request.method() === 'POST' && path === '/api/v1/me/workers/monitoring/query';
    if (request.method() !== 'GET' && !monitoringQuery) state.writes.push(`${request.method()} ${path}`);
    if (monitoringQuery) {
      const { workerIds } = request.postDataJSON() as { workerIds: string[] };
      return send({ observedAt: WORKER_TIME, items: workerIds.map(workerId => ({ workerId, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null })) });
    }
    if (path === '/api/v1/me') return send({ id: state.userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: state.userId, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === '/api/v1/me/workers') return send(workerPage());
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail(), 200, { 'Daynight-Worker-Tool-Paths': '2' });
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      const gate = state.gate;
      if (gate !== null && request.method() === gate.method) { state.gate = null; gate.notify(); await gate.wait; }
      if (request.method() === 'GET') {
        state.reads++;
        if (state.readFailure) return send({ error: { code: 'internal_error', message: 'Configuration read failed', requestId: 'fixture' } }, 500);
      }
      if (state.unavailable) return missing();
      if (request.method() === 'PUT') state.resource = configurationResource(String(BigInt(state.resource.desired!.revision) + 1n), request.postDataJSON().value as WorkerConfigurationValue);
      return send(state.resource, 200, { 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' });
    }
    return missing();
  });
  return state;
};
const open = async (page: Page) => {
  await page.goto('/workers');
  await page.locator(`a.worker-card[href="${workerPath}"]`).click();
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('2');
};
const back = (page: Page) => page.locator('a.worker-back-link').click();
const dialog = (page: Page) => page.getByRole('alertdialog');
const keep = (page: Page) => dialog(page).getByRole('button', { name: '继续编辑' });
const discard = (page: Page) => dialog(page).getByRole('button', { name: '放弃并离开' });
const configuration = (page: Page) => page.locator('[data-worker-panel="configuration"]:visible');
const refresh = (page: Page) => configuration(page).getByRole('button', { name: /^(刷新|正在刷新…|Refresh|Refreshing…)$/, exact: true });

const expectRefreshLayout = async (page: Page, settings: string) => {
  const panel = configuration(page).locator('.config-panel').first(), header = panel.locator(':scope > header');
  await expect(header.getByRole('heading', { name: settings, exact: true })).toBeVisible();
  await expect(header.getByRole('button')).toHaveCount(1);
  const layout = await header.evaluate(element => {
    const heading = element.querySelector('h2')!, button = element.querySelector('button')!;
    const title = heading.getBoundingClientRect(), action = button.getBoundingClientRect(), parent = element.getBoundingClientRect();
    return { separated: title.right <= action.left, sameRow: title.top < action.bottom && action.top < title.bottom,
      contained: action.left >= parent.left && action.right <= parent.right, readable: button.scrollWidth <= button.clientWidth && heading.scrollWidth <= heading.clientWidth };
  });
  expect(layout).toEqual({ separated: true, sameRow: true, contained: true, readable: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
};

for (const width of [1360, 390, 320]) for (const locale of ['zh-CN', 'en'] as const) {
  test(`${width}px ${locale} runtime header contains compact keyboard refresh and preserves the draft`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, locale); await open(page);
    const settings = locale === 'zh-CN' ? '运行设置' : 'Runtime settings';
    const source = configuration(page).locator('.configuration-source'), summary = source.locator(':scope > summary');
    const panel = configuration(page).locator('.config-panel').first();
    await expectRefreshLayout(page, settings);
    const compactGap = await panel.evaluate((element, source) => element.getBoundingClientRect().top - source!.getBoundingClientRect().bottom, await source.elementHandle());
    expect(compactGap).toBeGreaterThanOrEqual(0);
    await info.attach('compact-runtime-header', { body: await page.screenshot(), contentType: 'image/png' });
    await summary.focus(); await page.keyboard.press('Enter'); await expect(source).toHaveAttribute('open', '');
    await expect(source.locator('pre')).toHaveText(JSON.stringify(state.resource.desired!.value));
    const sourceWidth = await source.evaluate(element => element.getBoundingClientRect().width);
    expect(await source.locator('pre').evaluate(element => element.getBoundingClientRect().width)).toBe(sourceWidth);
    await page.locator('#config-maxConcurrent').fill('7');
    await page.locator('#config-native-args').fill('[unfinished raw input');
    const gate = configurationGate(); state.gate = gate;
    const reads = state.reads;
    await refresh(page).focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(refresh(page)).toBeFocused();
    expect(await refresh(page).evaluate(element => { const style = getComputedStyle(element); return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0; })).toBe(true);
    await page.keyboard.press('Enter'); await gate.started;
    try {
      await expect(refresh(page)).toHaveText(locale === 'zh-CN' ? '正在刷新…' : 'Refreshing…');
      await expect(refresh(page)).toBeDisabled(); await expectRefreshLayout(page, settings);
      await expect(source).toHaveAttribute('open', '');
      await expect(page.locator('#config-maxConcurrent')).toHaveValue('7');
      await expect(page.locator('#config-native-args')).toHaveValue('[unfinished raw input');
      expect(state.writes).toEqual([]);
      await info.attach('refresh-in-flight', { body: await panel.locator(':scope > header').screenshot(), contentType: 'image/png' });
    } finally { gate.finish(); }
    await expect(refresh(page)).toBeEnabled(); expect(state.reads).toBeGreaterThan(reads);
    await expect(page.locator('#config-maxConcurrent')).toHaveValue('7');
    await expect(page.locator('#config-native-args')).toHaveValue('[unfinished raw input');
    await expect(source).toHaveAttribute('open', ''); expect(state.writes).toEqual([]);
    await summary.focus(); await page.keyboard.press('Enter'); await expect(source).not.toHaveAttribute('open');
    expect(await panel.evaluate((element, source) => element.getBoundingClientRect().top - source!.getBoundingClientRect().bottom, await source.elementHandle())).toBe(compactGap);
  });
}

test('runtime refresh retains read failure recovery and stays disabled during saving and identity pause', async ({ page, context }) => {
  const state = await install(page); await open(page);
  await page.locator('#config-maxConcurrent').fill('4');
  state.readFailure = true; await refresh(page).click();
  await expect(configuration(page).getByRole('alert')).toContainText('读取配置失败');
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('4');
  state.readFailure = false; await configuration(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(configuration(page).getByRole('alert')).toHaveCount(0); await expect(refresh(page)).toBeEnabled();
  const gate = configurationGate('PUT'); state.gate = gate;
  await configuration(page).getByRole('button', { name: '保存配置', exact: true }).click(); await gate.started;
  try { await expect(refresh(page)).toBeDisabled(); } finally { gate.finish(); }
  await expect(refresh(page)).toBeEnabled(); expect(state.writes).toEqual([`PUT /api/v1/me/workers/${target}/configuration`]);
  const other = await context.newPage();
  try {
    await other.route('**/api/v1/me', route => route.fulfill({ json: { id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null }, headers: { 'Daynight-User-ID': WORKER_USER } }));
    await other.goto('/');
    await expect.poll(() => other.evaluate(() => localStorage.getItem('daynight.activeUser'))).toBe(JSON.stringify(WORKER_USER));
    await other.evaluate(user => localStorage.setItem('daynight.activeUser', JSON.stringify(user)), workerId(88));
    await expect(page.getByText('账户已变化', { exact: true })).toBeVisible();
    await expect(refresh(page)).toBeDisabled();
  } finally { await other.close(); }
});

test('initial loading, uninitialized and unavailable configuration keep their independent actions', async ({ page }) => {
  const state = await install(page), gate = configurationGate(); state.gate = gate;
  await page.goto(`/workers/${target}`); await page.locator('[data-worker-tab="configuration"]:visible').click(); await gate.started;
  try {
    await expect(configuration(page).getByRole('heading', { name: '正在读取配置', exact: true })).toBeVisible();
    await expect(refresh(page)).toHaveCount(0);
  } finally { state.resource = { ...configurationResource(), desired: null }; gate.finish(); }
  await expect(configuration(page).locator('.state-box')).toContainText('尚未接入配置管理');
  await expect(refresh(page)).toBeEnabled();
  state.unavailable = true; await refresh(page).click();
  await expect(configuration(page).getByRole('button', { name: '重试', exact: true })).toBeEnabled();
  await expect(configuration(page).locator('.config-panel')).toHaveCount(0);
  state.unavailable = false; state.resource = configurationResource();
  await configuration(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('2'); await expect(refresh(page)).toBeEnabled();
  expect(state.writes).toEqual([]);
});

for (const width of [1360, 390]) {
  test.describe(`${width}px configuration departure`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test('guards back links, restores editor focus and discards only after confirmation', async ({ page }, testInfo) => {
      const state = await install(page); await open(page);
      const input = page.locator('#config-maxConcurrent'); await input.fill('3');
      await back(page); await expect(dialog(page)).toBeVisible(); await expect(keep(page)).toBeFocused();
      await expect(dialog(page)).toContainText('离开此 Worker 的配置');
      await page.screenshot({ path: testInfo.outputPath('confirmation.png') });
      await keep(page).click(); await expect(input).toHaveValue('3'); await expect(input).toBeFocused();
      await back(page); await page.keyboard.press('Escape'); await expect(input).toBeFocused();
      await input.fill('-'); await back(page); await expect(dialog(page)).toBeVisible();
      await discard(page).click(); await expect(page).toHaveURL(/\/workers$/);
      await page.locator(`a.worker-card[href="${workerPath}"]`).click(); await page.locator('[data-worker-tab="configuration"]:visible').click();
      await expect(input).toHaveValue('2'); expect(state.writes).toEqual([]);
    });

    test('retains invalid raw input through tabs and guards indexed back and forward', async ({ page }) => {
      await install(page); await open(page);
      const args = page.locator('#config-native-args'); await args.fill('[invalid');
      await page.locator('[data-worker-tab="overview"]:visible').click(); await expect(dialog(page)).toHaveCount(0);
      await page.goBack(); await expect(args).toBeVisible(); await expect(dialog(page)).toHaveCount(0);
      await page.goBack(); await expect(page.locator('[data-worker-tab="overview"]:visible')).toHaveAttribute('aria-selected', 'true');
      await page.goBack(); await expect(dialog(page)).toBeVisible();
      await keep(page).click(); await expect(page).toHaveURL(workerPath); await expect(args).toBeVisible();
      await expect(args).toHaveValue('[invalid'); await expect(args).toBeFocused();
      await back(page); await discard(page).click(); await expect(page).toHaveURL(/\/workers$/);
      await page.goBack(); await page.locator('[data-worker-tab="configuration"]:visible').click(); await args.fill('[forward draft');
      await page.goForward(); await expect(dialog(page)).toBeVisible(); await page.keyboard.press('Escape');
      await expect(page).toHaveURL(workerPath); await expect(args).toHaveValue('[forward draft');
      await page.goForward(); await discard(page).click(); await expect(page).toHaveURL(/\/workers$/);
    });

    test('leaves clean, discarded and saved configurations without prompting', async ({ page }) => {
      const state = await install(page); await open(page);
      await back(page); await expect(dialog(page)).toHaveCount(0); await expect(page).toHaveURL(/\/workers$/);
      await page.locator('a.worker-card').click(); await page.locator('[data-worker-tab="configuration"]:visible').click();
      await page.locator('#config-maxConcurrent').fill('4');
      await page.getByRole('button', { name: '取消修改', exact: true }).click(); await back(page);
      await expect(dialog(page)).toHaveCount(0); await expect(page).toHaveURL(/\/workers$/);
      await page.locator('a.worker-card').click(); await page.locator('[data-worker-tab="configuration"]:visible').click();
      await page.locator('#config-maxConcurrent').fill('5');
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await expect(page.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
      await expect(page.locator('.draft-summary')).toContainText('没有修改');
      await back(page); await expect(dialog(page)).toHaveCount(0); await expect(page).toHaveURL(/\/workers$/);
      expect(state.writes).toEqual([`PUT /api/v1/me/workers/${target}/configuration`]);
    });

    test('native reload warns and dismissal retains raw input', async ({ page }) => {
      await install(page); await open(page); const input = page.locator('#config-maxConcurrent'); await input.fill('7');
      const native = page.waitForEvent('dialog');
      await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
      const prompt = await native; expect(prompt.type()).toBe('beforeunload'); await prompt.dismiss();
      await expect(input).toHaveValue('7');
    });

    test('confirmed unavailability retires a pending choice and allows recovery', async ({ page }) => {
      const state = await install(page); await open(page); await page.locator('#config-maxConcurrent').fill('8');
      await back(page); await expect(dialog(page)).toBeVisible(); state.unavailable = true;
      await expect(dialog(page)).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator('#config-maxConcurrent')).toHaveCount(0);
      state.unavailable = false; await page.getByRole('button', { name: '重试', exact: true }).click();
      await page.locator('#config-maxConcurrent').fill('9'); await back(page); await expect(dialog(page)).toBeVisible();
    });

    test('returns to a visible editor when the last edited project field is collapsed', async ({ page }) => {
      const state = await install(page);
      state.resource = configurationResource('1', { ...configurationValue(), projects: [{ projectId, nativeOverrides: {} }] });
      await open(page);
      const section = page.locator('.project-config-item'), summary = section.locator('summary');
      await summary.click(); const input = section.locator('input').first();
      // Selecting custom model exposes the project-specific text field.
      await section.locator('select').nth(1).selectOption('custom');
      await input.fill('project-model'); await summary.click();
      await back(page); await page.keyboard.press('Escape');
      await expect(page.locator('#config-maxConcurrent')).toBeFocused();
    });

    test('account replacement retains private input and pending confirmation', async ({ page, context }) => {
      const state = await install(page); await open(page); await page.locator('#config-native-args').fill('[private');
      await back(page); await expect(dialog(page)).toBeVisible(); await expect(keep(page)).toBeFocused();
      const original = await dialog(page).elementHandle();
      const other = await context.newPage();
      try {
        await other.route('**/api/v1/me', route => route.fulfill({ json: { id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null }, headers: { 'Daynight-User-ID': WORKER_USER } }));
        await other.goto('/');
        await expect.poll(() => other.evaluate(() => localStorage.getItem('daynight.activeUser'))).toBe(JSON.stringify(WORKER_USER));
        await other.evaluate(user => localStorage.setItem('daynight.activeUser', JSON.stringify(user)), workerId(88));
        await expect(dialog(page).getByText('账户已变化', { exact: true })).toBeVisible();
        expect(await original!.evaluate(node => node.isConnected)).toBe(true);
        await expect(keep(page)).toBeFocused();
        await expect(page.locator('#config-native-args')).toHaveValue('[private');
        expect(state.writes).toEqual([]);
      } finally { await original!.dispose(); await other.close(); }
    });

    test('removal links dismiss the management dialog before the leave confirmation', async ({ page }) => {
      const state = await install(page);
      state.resource = configurationResource('1', { ...configurationValue(), projects: [{ projectId, nativeOverrides: {} }] });
      await open(page); await page.getByRole('button', { name: /移除项目/ }).click();
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await page.getByRole('dialog').getByRole('link', { name: 'Snapshot task' }).click();
      await expect(dialog(page)).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(keep(page)).toBeFocused(); await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('#config-maxConcurrent')).toBeFocused(); expect(state.writes).toEqual([]);
    });
  });
}

test('desktop sidebar navigation protects edits', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 }); await install(page); await open(page);
  await page.locator('#config-maxConcurrent').fill('6');
  await page.getByRole('navigation').getByRole('link', { name: '项目', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#config-maxConcurrent')).toBeFocused();
});

for (const width of [1360, 320]) {
  test(`Worker tabs traverse while preserving the configuration owner at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page); await open(page);
    const args = page.locator('#config-native-args'); await args.fill('[private draft');
    await args.evaluate(element => { (window as unknown as { workerDraftNode: Element }).workerDraftNode = element; });
    const configuration = page.locator('[data-worker-tab="configuration"]:visible'), overview = page.locator('[data-worker-tab="overview"]:visible');
    const length = await page.evaluate(() => history.length);
    await configuration.click(); expect(await page.evaluate(() => history.length)).toBe(length);
    await configuration.focus(); await page.keyboard.press('Home');
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.worker-page:visible [data-worker-panel="configuration"]')).toHaveAttribute('inert', '');
    await page.goBack(); await expect(configuration).toHaveAttribute('aria-selected', 'true');
    await expect(args).toHaveValue('[private draft');
    expect(await args.evaluate(element => element === (window as unknown as { workerDraftNode: Element }).workerDraftNode)).toBe(true);
    expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain('[private draft');
    await page.goBack(); await expect(overview).toHaveAttribute('aria-selected', 'true');
    await page.goForward(); await expect(configuration).toHaveAttribute('aria-selected', 'true');
    await page.goForward(); await expect(overview).toHaveAttribute('aria-selected', 'true');
    expect(state.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('invalid Worker history exposes an error without destroying the retained owner', async ({ page }) => {
  await install(page); await open(page);
  const args = page.locator('#config-native-args'); await args.fill('[private');
  await args.evaluate(element => { (window as unknown as { workerErrorNode: Element }).workerErrorNode = element; });
  await page.evaluate(() => {
    const state = history.state as { __daynightNavigation: { view: Record<string, unknown> } };
    history.replaceState({ ...state, __daynightNavigation: { ...state.__daynightNavigation, view: { ...state.__daynightNavigation.view, selection: { workerId: '00000000-0000-4000-8000-000000000001', section: 'invalid' } } } }, '');
  });
  await page.goBack(); await page.goForward();
  await expect(page.getByRole('alert')).toHaveText('页面导航状态无效。');
  await expect(args).toBeHidden();
  await page.goBack(); await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(args).toHaveValue('[private');
  expect(await args.evaluate(element => element === (window as unknown as { workerErrorNode: Element }).workerErrorNode)).toBe(true);
});

test('320px keyboard save preserves unknown configuration and isolates the next account', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
  const bob = workerId(88), number = '9007199254740993123456789', fraction = '-1.2500e+42';
  let actor = WORKER_USER;
  const revisions = new Map([[WORKER_USER, '1'], [bob, '1']]);
  let value = `{"maxConcurrent":2,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[],"futureNative":{"amount":${number}}},"projects":[],"future":{"negative":${fraction},"nested":[null,{"large":${number}}]}}`;
  let bobValue = '{"maxConcurrent":8,"pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[]},"projects":[],"future":1234567890123456789012345}';
  const writes: { actor: string; body: string }[] = [];
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, current = actor;
    const send = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, json, headers: { 'Daynight-User-ID': current, ...extra } });
    if (path === '/api/v1/me') return send({ id: current, personalTeam: personal, name: current === WORKER_USER ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null });
    const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: current, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      if (request.method() === 'PUT') {
        const body = request.postData()!; writes.push({ actor: current, body });
        const prefix = body.match(/"value"\s*:\s*/);
        if (!prefix || prefix.index === undefined) throw new Error('Missing configuration value');
        const submitted = body.slice(prefix.index + prefix[0].length, -1);
        if (current === WORKER_USER) value = submitted; else bobValue = submitted;
        revisions.set(current, String(BigInt(revisions.get(current)!) + 1n));
      }
      const revision = revisions.get(current)!;
      const currentValue = current === WORKER_USER ? value : bobValue;
      const body = `{"desired":{"revision":"${revision}","updatedAt":"${WORKER_TIME}","value":${currentValue}},"observationRevision":"1","observation":{"baseRevision":"0","desiredRevision":"${revision}","reportedAt":"${WORKER_TIME}","items":[{"key":{"kind":"futureSetting"},"targetRevision":"${revision}","appliedValue":true,"state":"applied","error":null,"lastFailure":null,"nextAttemptAt":null}]}}`;
      return route.fulfill({ body, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': current, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' } });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  await page.goto(workerPath);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  const input = page.locator('#config-maxConcurrent'); await expect(input).toHaveValue('2');
  await expect(page.locator('#feedback-maxConcurrent')).toContainText('等待生效');
  await input.focus(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('4');
  const save = page.locator('.config-save-bar').getByRole('button', { name: '保存配置', exact: true });
  const bar = page.locator('.config-save-bar'); await expect(bar).toBeInViewport({ ratio: 1 });
  await expect.poll(() => page.evaluate(() => {
    const field = document.querySelector('#config-maxConcurrent')!.getBoundingClientRect();
    const footer = document.querySelector('.config-save-bar')!.getBoundingClientRect();
    return field.top >= 0 && field.bottom <= footer.top;
  })).toBe(true);
  await bar.getByRole('button', { name: '取消修改' }).focus(); await page.keyboard.press('Tab');
  await expect(save).toBeFocused(); await page.keyboard.press('Enter');
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.locator('.draft-summary')).toContainText('没有修改');
  expect(writes[0]!.actor).toBe(WORKER_USER);
  expect(writes[0]!.body).toContain(number); expect(writes[0]!.body).toContain(fraction);
  expect(writes[0]!.body).toContain('"futureNative"'); expect(writes[0]!.body).toContain('"future"');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await input.fill('7');
  const other = await context.newPage();
  try {
    actor = bob;
    await other.goto(`/auth/complete?returnPath=${encodeURIComponent('/?from=login')}&callbackPath=%2Fauth%2Fcallback`);
    await expect(page.getByText('账户已变化', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('7');
    await expect(save).toBeDisabled(); expect(writes).toHaveLength(1);
    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: '刷新页面' }).click()]);
    await page.locator('[data-worker-tab="configuration"]:visible').click();
    await expect(input).toHaveValue('8');
    await input.fill('9'); await save.click(); await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]!.actor).toBe(bob); expect(writes[1]!.body).toContain('1234567890123456789012345');
    expect(writes[1]!.body).not.toContain(number);
    await expect(page.locator('.draft-summary')).toContainText('没有修改');
  } finally { await other.close(); }
});
