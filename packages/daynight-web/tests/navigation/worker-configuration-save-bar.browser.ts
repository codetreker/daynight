import { expect, test, type Page } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const target = workerId(1), personalId = workerId(90);
const personal = { id: personalId, kind: 'personal', name: null };
const projects = [3, 4].map(id => ({ id: workerId(id), name: `Project ${id}`, repoUrl: `https://example.test/project-${id}.git`, settings: { version: 1, executionWarningMinutes: 60 }, ownership: { teamId: personalId, version: 1 }, createdAt: WORKER_TIME, updatedAt: WORKER_TIME }));
const install = async (page: Page) => {
  const state = { resource: configurationResource('1', { ...configurationValue(), projects: projects.map(project => ({ projectId: project.id, nativeOverrides: {} })) }), mode: 'success', writes: 0, release: () => {} };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1' } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: projects, nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      if (route.request().method() === 'PUT') {
        state.writes++;
        if (state.mode === 'pending') await new Promise<void>(resolve => { state.release = resolve; });
        if (state.mode === 'failure') return send({ error: { code: 'invalid_request', message: 'Rejected', requestId: 'save-bar' } }, 400);
        if (state.mode === 'conflict') { state.resource = configurationResource('2', { ...state.resource.desired!.value, recoveryLimit: 5 }); return send({ error: { code: 'version_conflict', message: 'Changed', requestId: 'save-bar' } }, 409); }
        if (state.mode === 'unknown') return route.abort('failed');
        state.resource = configurationResource('2', route.request().postDataJSON().value);
      } else if (state.mode === 'unknown') return route.abort('failed');
      return send(state.resource);
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'save-bar' } }, 404);
  });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
  await page.goto(`/workers/${target}`);
  await page.locator('#worker-tab-configuration').click();
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('2');
  return state;
};
const visibleBar = async (page: Page) => {
  const bar = page.locator('.config-save-bar');
  await expect(bar.getByRole('status')).toHaveText('未保存的修改');
  await expect(bar).toBeInViewport({ ratio: 1 });
  const box = await bar.boundingBox();
  const slot = await page.locator('.config-save-slot').boundingBox();
  expect(Math.abs(box!.x - slot!.x)).toBeLessThan(1);
  expect(Math.abs(box!.width - slot!.width)).toBeLessThan(1);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
};
const clearField = async (page: Page) => {
  await expect.poll(() => page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const field = active.closest('.field') ?? active;
    const bar = document.querySelector('.config-save-bar')!.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= bar.top;
  })).toBe(true);
};

for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 1360, height: 900 }]) {
  test(`${viewport.width}x${viewport.height} keeps dirty save actions visible and focused fields unobscured`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const state = await install(page);
    const bar = page.locator('.config-save-bar'), first = page.locator('#config-maxConcurrent');
    await expect(bar).not.toBeInViewport();
    await first.fill('4');
    await visibleBar(page); await clearField(page);
    await page.screenshot({ path: info.outputPath('dirty.png') });
    await info.attach('dirty', { path: info.outputPath('dirty.png'), contentType: 'image/png' });
    if (viewport.width === 1360) {
      await page.setViewportSize({ width: 1920, height: 900 });
      await page.locator('.sidebar-toggle').click(); await visibleBar(page);
      await page.locator('.sidebar-toggle').click(); await visibleBar(page);
      await page.locator('#worker-tab-overview').click(); await expect(bar).toBeHidden();
      await page.setViewportSize(viewport);
      await page.locator('#worker-tab-configuration').click(); await visibleBar(page);
    }
    for (const fraction of [0, 0.3, 0.6, 1]) {
      await page.evaluate(fraction => { const form = document.querySelector('.configuration-main form')!; window.scrollTo(0, window.scrollY + form.getBoundingClientRect().top + (form.clientHeight - innerHeight) * fraction); }, fraction);
      await visibleBar(page);
    }
    // Tab can focus a field below the overlay even when it is already in the viewport.
    const agent = page.locator('#config-native-agent');
    await agent.focus(); await clearField(page);
    await agent.selectOption('claude'); await visibleBar(page);
    const args = page.locator('#config-native-args');
    await args.focus(); await args.fill('invalid'); await clearField(page);
    await expect(bar.getByRole('button', { name: '保存配置', exact: true })).toBeDisabled();
    await args.fill('[]');
    // These controls are not .field descendants. Native Tab scrolling considers
    // them visible even when the fixed footer covers the bottom viewport strip.
    const choose = page.getByRole('button', { name: '＋ 选择项目' });
    const remove = page.getByRole('button', { name: '移除项目 Project 3' });
    const summary = page.locator('.project-native').first().locator('summary');
    for (const [previous, next] of [[args, choose], [choose, remove], [remove, summary]]) {
      await previous!.focus();
      await next!.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().bottom - innerHeight + 4));
      await page.keyboard.press('Tab');
      await expect(next!).toBeFocused(); await clearField(page);
    }
    const details = page.locator('.project-native').last();
    await details.locator('summary').click();
    const mode = page.locator(`#config-project-${workerId(4)}-args-mode`);
    await mode.selectOption('custom'); await mode.focus();
    await page.keyboard.press('Tab'); await clearField(page);
    const projectArgs = page.locator(`#config-project-${workerId(4)}-args`);
    await expect(projectArgs).toBeFocused(); await projectArgs.fill('["--flag"]');
    await page.keyboard.press('Tab'); await expect(bar.getByRole('button', { name: '取消修改' })).toBeFocused();
    await page.keyboard.press('Tab'); await expect(bar.getByRole('button', { name: '保存配置', exact: true })).toBeFocused();
    state.mode = 'pending';
    await page.keyboard.press('Enter');
    await expect(bar.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    await visibleBar(page); await expect(bar.getByRole('button', { name: '取消修改' })).toBeDisabled();
    state.release();
    await expect(bar.getByRole('status')).toHaveText('没有修改');
    await expect(bar).toHaveCSS('position', 'static');
    await first.fill('6'); await visibleBar(page);
    await bar.getByRole('button', { name: '取消修改' }).click();
    await expect(first).toHaveValue('4'); await expect(bar).toHaveCSS('position', 'static');
    // The first edit can activate the footer over a field that already has focus.
    await first.focus();
    await first.evaluate(element => window.scrollBy(0, element.getBoundingClientRect().bottom - innerHeight + 8));
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('7');
    await visibleBar(page); await clearField(page); await expect(first).toBeFocused();
    if (viewport.width === 1360) {
      await page.evaluate(() => window.scrollBy(0, 900));
      await expect(first).not.toBeInViewport();
      state.resource = configurationResource('3', { ...state.resource.desired!.value, recoveryLimit: 8 });
      await expect(page.getByText('云端配置已被其他页面修改。', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(first).toBeFocused(); await expect(first).not.toBeInViewport();
      await visibleBar(page);
    }
    await bar.getByRole('button', { name: '取消修改' }).click();
    expect(state.writes).toBe(1);
  });
}

for (const mode of ['failure', 'conflict', 'unknown']) {
  test(`${mode} retains dirty actions and existing save restrictions`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const state = await install(page); state.mode = mode;
    await page.locator('#config-maxConcurrent').fill('4');
    const bar = page.locator('.config-save-bar'), save = bar.getByRole('button', { name: '保存配置', exact: true });
    await save.click(); await expect.poll(() => state.writes).toBe(1);
    await expect(page.locator('.configuration-notice[role="alert"]').filter({ hasText: mode === 'conflict' ? '云端配置已被其他页面修改。' : mode === 'unknown' ? '保存结果尚未确认' : '保存配置失败。' })).toBeVisible();
    await visibleBar(page);
    if (mode === 'failure') await expect(save).toBeEnabled(); else await expect(save).toBeDisabled();
    if (mode === 'unknown') await expect(bar.getByRole('button', { name: '取消修改' })).toBeDisabled();
    else await expect(bar.getByRole('button', { name: '取消修改' })).toBeEnabled();
  });
}
