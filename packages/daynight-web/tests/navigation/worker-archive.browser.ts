import { expect, test, type Page } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const worker = workerId(1), personal = { id: workerId(90), kind: 'personal', name: null };
const setup = async (page: Page) => {
  const state = { value: true, revision: 1, applied: true };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, archive = false) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2', ...(archive ? { 'Daynight-Worker-Archive-Sessions': '1' } : {}) } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects' || path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${worker}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${worker}/configuration`) {
      if (route.request().method() === 'PUT') { state.value = route.request().postDataJSON().value.archiveSessions; state.revision++; }
      const value = { ...configurationValue(), archiveSessions: state.value };
      return send({ ...configurationResource(String(state.revision), value), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', reportedAt: WORKER_TIME, items: [{ key: { kind: 'archiveSessions' }, targetRevision: '1', appliedValue: state.applied, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null }] } }, true);
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'archive' } }, headers: { 'Daynight-User-ID': WORKER_USER } });
  });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
  await page.goto(`/workers/${worker}`);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  return state;
};

for (const width of [320, 390, 1360]) {
  test(`archive checkbox works with keyboard and fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await setup(page);
    const checkbox = page.getByRole('checkbox', { name: '归档 Session' });
    await expect(checkbox).toBeChecked();
    await page.locator('#config-platformTaskMode').focus();
    await page.keyboard.press('Tab'); await expect(checkbox).toBeFocused();
    expect(await checkbox.evaluate(element => getComputedStyle(element).outlineStyle !== 'none' || getComputedStyle(element).boxShadow !== 'none')).toBe(true);
    await page.keyboard.press('Space'); await expect(checkbox).not.toBeChecked();
    await expect(page.locator('#archive-sessions-detail')).toContainText('历史录制');
    await expect(checkbox).toHaveAttribute('aria-describedby', /archive-sessions-detail/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => state.value).toBe(false);
    await expect(page.locator('#feedback-archiveSessions')).toContainText('等待生效');
    await page.reload(); await page.locator('[data-worker-tab="configuration"]:visible').click();
    await expect(page.getByRole('checkbox', { name: '归档 Session' })).not.toBeChecked();
  });
}
