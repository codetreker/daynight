import { expect, test, type Page } from '@playwright/test';
import type { WorkerConfigurationValue } from '../../src/api/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId, workerPage } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const target = workerId(1), personalId = workerId(90), projectId = workerId(301);
const workerPath = `/workers/${target}`;
const personal = { id: personalId, kind: 'personal', name: null };
const project = { id: projectId, name: 'Alpha project', repoUrl: 'https://example.test/alpha.git', settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1 }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME };
const install = async (page: Page) => {
  const state = { resource: configurationResource(), unavailable: false, userId: WORKER_USER, writes: [] as string[] };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
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
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      if (state.unavailable) return missing();
      if (request.method() === 'PUT') state.resource = configurationResource(String(BigInt(state.resource.desired!.revision) + 1n), request.postDataJSON().value as WorkerConfigurationValue);
      return send(state.resource, 200, { 'Daynight-Worker-Configuration': '1' });
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
