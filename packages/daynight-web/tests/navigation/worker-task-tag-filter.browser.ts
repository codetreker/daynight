import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationResource, configurationValue } from '../helpers/worker-configuration';

const worker = workerId(1), personal = { id: workerId(90), kind: 'personal', name: null };
const setup = async (page: Page, locale: string) => {
  const state = { filter: { names: ['Backend'], match: 'any' as 'any' | 'all', future: { number: 42 } }, revision: 1, supported: true, writes: [] as any[] };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown) => route.fulfill({ json, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Tool-Paths': '2' } });
    if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects' || path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/me/workers/${worker}`) return send(workerDetail());
    if (path === `/api/v1/me/workers/${worker}/configuration`) {
      if (request.method() === 'PUT') { const body = request.postDataJSON(); state.writes.push(body); state.filter = body.value.taskTagFilter; state.revision++; }
      const revision = String(state.revision), filter = state.filter;
      const key = createHash('sha256').update(JSON.stringify([filter.match, filter.names.map(name => name.replace(/[A-Z]/g, c => c.toLowerCase())).sort()])).digest('hex');
      return send({ ...configurationResource(revision, { ...configurationValue(), taskTagFilter: filter }), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: revision, reportedAt: WORKER_TIME, items: state.supported ? [{ key: { kind: 'taskTagFilter' }, targetRevision: revision, appliedValue: key, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null }] : [] } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found', requestId: 'tag' } }, headers: { 'Daynight-User-ID': WORKER_USER } });
  });
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
  await page.goto(`/workers/${worker}`);
  await page.locator('[data-worker-tab="configuration"]:visible').click();
  return state;
};

for (const [width, locale] of [[320, 'zh-CN'], [1440, 'en']] as const) {
  test(`edits complete names and validates pending input at ${width}px ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await setup(page, locale), field = page.locator('.task-tag-filter');
    const input = page.locator('#config-taskTagFilter');
    await expect(input).toBeEnabled();
    await input.fill('red, blue'); await input.press('Enter');
    await expect(field).toContainText('red, blue');
    await page.locator('#config-taskTagMatch').selectOption('all');
    await input.fill('x'.repeat(65));
    const save = page.locator('.config-save-bar button[type="submit"]');
    await save.click(); await expect(input).toBeFocused(); await expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(state.writes).toHaveLength(0);
    await input.fill('x'.repeat(64)); await save.click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.filter.names).toEqual(expect.arrayContaining(['Backend', 'red, blue', 'x'.repeat(64)]));
    expect(state.filter.match).toBe('all'); expect(state.filter.future).toEqual({ number: 42 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}
