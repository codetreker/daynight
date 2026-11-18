import { expect, test, type Page } from '@playwright/test';
import type { WorkerConfigurationValue } from '../../src/api/worker-configuration';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const target = workerId(1), personalId = workerId(90);
const personal = { id: personalId, kind: 'personal', name: null };
const rejection = `pollIntervalMs: <img src=x onerror=alert(1)> ${'validation-detail-'.repeat(30)} value exceeds maximum 30000`;
const install = async (page: Page, locale: 'zh-CN' | 'en') => {
  const state = { resource: configurationResource('1', { ...configurationValue(), pollIntervalMs: 100_000 }), reject: false, writes: [] as WorkerConfigurationValue[] };
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
    if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${target}`) return send(workerDetail());
    if (path === '/api/v1/me/workers/monitoring/query') return send({ observedAt: WORKER_TIME, items: [{ workerId: target, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null }] });
    if (path === `/api/v1/me/workers/${target}/configuration`) {
      if (request.method() === 'PUT') {
        const value = request.postDataJSON().value as WorkerConfigurationValue;
        state.writes.push(value);
        if (state.reject) return send({ error: { code: 'invalid_input', message: rejection, requestId: 'validation-request' } }, 400);
        state.resource = configurationResource('2', value);
      }
      return send(state.resource);
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  await page.goto(`/workers/${target}`);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  await expect(page.locator('#config-pollIntervalMs')).toHaveValue('100000');
  return state;
};

for (const width of [1360, 390, 320]) for (const locale of ['zh-CN', 'en'] as const) {
  test(`${width}px ${locale} corrects historical numeric values and displays rejected saves as readable text`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await install(page, locale);
    const panel = page.locator('[data-worker-panel="configuration"]:visible');
    const poll = panel.locator('#config-pollIntervalMs'), error = panel.locator('#config-pollIntervalMs-error');
    const save = panel.locator('button[type="submit"]');
    await expect(poll).toHaveAttribute('aria-invalid', 'true');
    await expect(poll).toHaveAttribute('aria-describedby', /config-pollIntervalMs-error/);
    await expect(error).toContainText('1,000–60,000');
    await expect(save).toBeDisabled();
    await poll.fill('100000');
    await poll.press('Enter');
    expect(state.writes).toHaveLength(0);
    await expect(poll).toHaveValue('100000');
    await page.screenshot({ path: info.outputPath('invalid-historical-value.png'), fullPage: true });

    await poll.fill('50000');
    await expect(poll).toHaveAttribute('aria-invalid', 'false');
    await expect(error).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(panel.locator('.notice.success')).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]?.pollIntervalMs).toBe(50_000);
    await expect(poll).toHaveValue('50000');
    await expect(save).toBeDisabled();

    state.reject = true;
    await poll.fill('45000');
    await save.click();
    const notice = panel.locator('.configuration-notice.error');
    await expect(notice).toContainText(rejection);
    await expect(notice).toContainText('validation-request');
    await expect(notice).toContainText(locale === 'zh-CN' ? '当前草稿已保留' : 'Your draft has been kept');
    await expect(notice.locator('img')).toHaveCount(0);
    await expect(poll).toHaveValue('45000');
    await expect(poll).toHaveAttribute('aria-invalid', 'false');
    await notice.evaluate(element => element.scrollIntoView({ block: 'start' }));
    expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await notice.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const requestId = notice.locator('.request-id');
    await expect(requestId).toBeInViewport();
    await expect.poll(async () => {
      const requestBox = await requestId.boundingBox(), saveBox = await panel.locator('.config-save-bar').boundingBox();
      return requestBox!.y + requestBox!.height <= saveBox!.y;
    }).toBe(true);
    await page.screenshot({ path: info.outputPath('invalid-input-response.png') });
    await panel.getByRole('button', { name: locale === 'zh-CN' ? '刷新' : 'Refresh', exact: true }).click();
    await expect(panel.getByRole('button', { name: locale === 'zh-CN' ? '刷新' : 'Refresh', exact: true })).toBeEnabled();
    await expect(notice).toContainText(rejection);
    await expect(poll).toHaveValue('45000');
    expect(state.writes).toHaveLength(2);
  });
}
