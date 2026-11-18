import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const worker = workerId(1), personal = { id: workerId(90), kind: 'personal', name: null };
const setup = async (page: Page, locale: string) => {
  const name = 'x'.repeat(64), filter = { names: [name], match: 'all' as const };
  const key = createHash('sha256').update(JSON.stringify(['all', [name]])).digest('hex');
  const state = { key, filter };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects' || path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${worker}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${worker}/configuration`) {
      const value = { ...configurationValue(), taskTagFilter: state.filter };
      return send({ ...configurationResource('1', value), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', reportedAt: WORKER_TIME, items: [{ key: { kind: 'taskTagFilter' }, targetRevision: '1', appliedValue: state.key, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null }] } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'tag' } }, headers: { 'Daynight-User-ID': WORKER_USER } });
  });
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
  await page.goto(`/workers/${worker}`);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  return state;
};
for (const [width, locale] of [[320, 'zh-CN'], [1440, 'en']] as const) {
  test(`read-only tag application keeps draft and fits ${width}px ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await setup(page, locale);
    const field = page.locator('.task-tag-filter');
    await expect(field).toContainText(state.filter.names[0]!);
    await expect(field.locator('.status-chip')).toHaveClass(/applied/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const input = page.locator('#config-maxConcurrent');
    await input.fill('7'); await input.focus();
    state.key = '0'.repeat(64);
    await expect(field).toContainText(locale === 'en' ? 'Applied value differs from the current target' : '已应用值与当前目标不同');
    await expect(input).toHaveValue('7');
    await expect(input).toBeFocused();
    await expect(field).not.toContainText(state.key);
  });
}
