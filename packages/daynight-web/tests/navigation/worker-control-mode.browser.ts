import { expect, test, type Page } from '@playwright/test';
import type { WorkerConfigurationOutcome, WorkerConfigurationResource, WorkerConfigurationValue } from '../../src/api/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const target = workerId(1), personal = { id: workerId(90), kind: 'personal', name: null };
const item = (kind: WorkerConfigurationOutcome['key']['kind'], appliedValue: WorkerConfigurationOutcome['appliedValue'], revision: string): WorkerConfigurationOutcome => ({ key: { kind } as WorkerConfigurationOutcome['key'], appliedValue, targetRevision: revision, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null });
const observed = (resource: WorkerConfigurationResource, mode: 'herdr' | 'web' | null, failed = false): WorkerConfigurationResource => {
  const desired = resource.desired!, value = desired.value, revision = desired.revision;
  const failure = { code: 'invalid_configuration' as const, category: 'agent' as const, phase: 'validate' as const, occurredAt: WORKER_TIME };
  const items = (['maxConcurrent', 'pollIntervalMs', 'recoveryLimit', 'preferPlatformSpecificTasks', 'native'] as const).map(kind => item(kind, value[kind], revision));
  items.push({ ...item('agentControlMode', mode, revision), state: failed ? 'error' : mode === null ? 'pending' : 'applied', error: failed ? failure : null });
  const observationRevision = String(BigInt(resource.observationRevision) + 1n);
  return { ...resource, observationRevision, observation: { baseRevision: resource.observationRevision, desiredRevision: revision, reportedAt: WORKER_TIME, items } };
};
const install = async (page: Page, supported = true) => {
  const state = { resource: configurationResource('1', { ...configurationValue(), ...(supported ? { agentControlMode: null } : {}) }), writes: [] as { revision: string; value: WorkerConfigurationValue }[], unknown: false };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, ...headers } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects' || path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${target}/prompt`) return send({ scope: 'worker', scopeId: target, revision: '0', text: '', updatedAt: null });
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      if (request.method() === 'PUT') {
        state.writes.push(request.postDataJSON());
        if (state.unknown) return route.abort('failed');
        state.resource = { ...state.resource, desired: { revision: String(BigInt(state.resource.desired!.revision) + 1n), value: request.postDataJSON().value, updatedAt: WORKER_TIME } };
      } else if (state.unknown) return route.abort('failed');
      return send(state.resource, 200, { 'Daynight-Worker-Configuration': '1', ...(supported ? { 'Daynight-Worker-Control-Mode': '1' } : {}) });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'control-mode' } }, 404);
  });
  await page.goto(`/workers/${target}`);
  await page.locator('#worker-tab-configuration').click();
  await expect(page.getByRole('combobox', { name: '托管模式' })).toBeVisible();
  return state;
};
const unobscured = (page: Page) => expect.poll(() => page.evaluate(() => {
  const active = document.activeElement as HTMLElement, field = active.closest('.field') ?? active;
  const rect = field.getBoundingClientRect(), footer = document.querySelector('.config-save-bar')!.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= footer.top;
})).toBe(true);
const noOverflow = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const width of [1440, 390, 320]) {
  test(`${width}px mode selection preserves drafts, keyboard access and fixed save actions`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page), mode = page.getByRole('combobox', { name: '托管模式' });
    const feedback = page.locator('#feedback-agentControlMode'), bar = page.locator('.config-save-bar');
    await expect(mode.locator('option')).toHaveText(['herdr', 'web']);
    expect(await mode.evaluate(element => (element as HTMLSelectElement).selectedIndex)).toBe(-1);
    await expect(feedback).toContainText('实际: 尚未确认');
    const recovery = page.locator('#config-recoveryLimit');
    const [recoveryBox, modeBox] = await Promise.all([recovery.boundingBox(), mode.boundingBox()]);
    if (width === 1440) { expect(modeBox!.x).toBeGreaterThan(recoveryBox!.x); expect(Math.abs(modeBox!.y - recoveryBox!.y)).toBeLessThan(2); }
    else expect(modeBox!.y).toBeGreaterThan(recoveryBox!.y);
    await recovery.focus(); await page.keyboard.press('Tab'); await expect(mode).toBeFocused();
    // Type-ahead selects an option without depending on the OS popup menu.
    await page.keyboard.press('h');
    await expect(mode).toHaveValue('herdr'); await expect(bar).toHaveCSS('position', 'fixed'); await expect(bar).toBeInViewport({ ratio: 1 });
    await unobscured(page); await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`mode-${width}.png`), fullPage: true });
    await mode.selectOption('web'); await mode.focus();
    // A report may update actual values while the user's local choice stays put.
    state.resource = observed(state.resource, null);
    await page.locator('.configuration-toolbar button').click();
    await expect(mode).toHaveValue('web');
    await page.locator('a.worker-back-link').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '继续编辑' }).click(); await expect(mode).toHaveValue('web');
    await expect(mode).toBeFocused(); await unobscured(page);
    await bar.getByRole('button', { name: '取消修改' }).click();
    expect(await mode.evaluate(element => (element as HTMLSelectElement).selectedIndex)).toBe(-1);
    await mode.selectOption('web'); await bar.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => state.writes.length).toBe(1); expect(state.writes[0]!.value.agentControlMode).toBe('web');
    await expect(bar.getByRole('status')).toHaveText('没有修改'); await expect(feedback).toContainText('等待生效');
    state.resource = observed(state.resource, 'herdr', true);
    await page.locator('.configuration-toolbar button').click(); await expect(feedback).toContainText('实际: herdr'); await expect(feedback).toContainText('失败');
    await noOverflow(page);
    state.resource = observed(state.resource, 'web');
    await page.locator('.configuration-toolbar button').click(); await expect(feedback).toContainText('实际: web'); await expect(feedback).toContainText('已生效');
    await page.screenshot({ path: info.outputPath(`applied-${width}.png`), fullPage: true });
  });
}

test('old service keeps other settings editable and excludes mode from writes', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const state = await install(page, false);
  await expect(page.getByRole('combobox', { name: '托管模式' })).toBeDisabled();
  await expect(page.getByText('升级服务后可配置托管模式。')).toBeVisible();
  await page.locator('#config-recoveryLimit').fill('7');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1); expect(state.writes[0]!.value).not.toHaveProperty('agentControlMode');
  await noOverflow(page);
});

test('unknown mode saves reconcile by reading without a second write', async ({ page }) => {
  const state = await install(page); state.unknown = true;
  await page.getByRole('combobox', { name: '托管模式' }).selectOption('web');
  const save = page.getByRole('button', { name: '保存配置', exact: true });
  await save.click(); await expect(page.getByText('保存结果尚未确认，当前草稿已保留。')).toBeVisible(); await expect(save).toBeDisabled();
  state.resource = configurationResource('2', { ...configurationValue(), agentControlMode: 'web' }); state.unknown = false;
  await page.getByRole('button', { name: '核对保存结果' }).click();
  await expect(page.locator('.config-save-bar').getByRole('status')).toHaveText('没有修改');
  await expect(page.getByRole('combobox', { name: '托管模式' })).toHaveValue('web'); expect(state.writes).toHaveLength(1);
});
