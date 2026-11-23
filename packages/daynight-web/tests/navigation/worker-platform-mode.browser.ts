import { expect, test } from '@playwright/test';
import { WORKER_TIME, WORKER_USER, workerDetail, workerId } from '../helpers/workers';
import { configurationValue } from '../helpers/worker-configuration';

for (const [platform, name] of [['macos', 'macOS'], ['windows', 'Windows'], ['linux', 'Linux']] as const) {
  test(`320px ${name} rule selection uses the keyboard and reports application`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const worker = workerId(1), personalId = workerId(90), personal = { id: personalId, kind: 'personal', name: null };
    const { preferPlatformSpecificTasks: _legacy, ...base } = configurationValue();
    type Mode = 'all' | 'prefer' | 'only';
    let target: Mode = 'all', applied: Mode = 'all', revision = '1', observedRevision = '1', observationVersion = 1;
    const writes: unknown[] = [];
    const item = (kind: string, value: unknown) => ({ key: { kind }, targetRevision: observedRevision, appliedValue: value, state: 'applied', error: null, lastFailure: null, nextAttemptAt: null });
    const resource = () => ({ desired: { revision, updatedAt: WORKER_TIME, value: { ...base, platformTaskMode: target } }, observationRevision: String(observationVersion), observation: { baseRevision: String(observationVersion - 1), desiredRevision: observedRevision, items: [item('maxConcurrent', 2), item('pollIntervalMs', 60000), item('recoveryLimit', 3), item('native', base.native), item('platformTaskMode', applied)], reportedAt: WORKER_TIME } });
    await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
    await page.route('**/api/v1/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const send = (json: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Tool-Paths': '2', ...extra } });
      if (path === '/api/v1/me') return send({ id: WORKER_USER, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
      const team = { ...personal, version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME, membership: { teamId: personalId, userId: WORKER_USER, role: 'admin', version: 1, createdAt: WORKER_TIME, updatedAt: WORKER_TIME } };
      if (path === '/api/v1/teams') return send({ items: [team], nextCursor: null });
      if (path === `/api/v1/teams/${personalId}`) return send(team);
      if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
      if (path === `/api/v1/me/workers/${worker}`) { const detail = workerDetail(); detail.worker.platform = platform; detail.worker.telemetry.platform = platform; return send(detail); }
      if (path === '/api/v1/me/workers/monitoring/query') return send({ observedAt: WORKER_TIME, items: [{ workerId: worker, state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null }] });
      if (path === `/api/v1/me/workers/${worker}/configuration`) {
        if (request.method() === 'PUT') { const body = request.postDataJSON(); writes.push(body); target = body.value.platformTaskMode; revision = '2'; }
        return send(resource(), 200, { 'Daynight-Worker-Configuration': '1', 'Daynight-Worker-Platform-Task-Mode': '1' });
      }
      return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
    });
    await page.goto(`/workers/${worker}`); await page.locator('[data-worker-tab="configuration"]:visible').click();
    const rule = page.getByRole('combobox', { name: 'Task claim rule' }), feedback = page.locator('#feedback-preferPlatformSpecificTasks');
    await expect(rule).toHaveValue('all'); await expect(rule.locator('option[value="prefer"]')).toHaveText(`Prefer ${name} tasks`); await expect(rule.locator('option[value="only"]')).toHaveText(`Only claim ${name} tasks`);
    await rule.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await expect(rule).toHaveValue('only'); await expect(page.locator('#platform-preference-detail')).toContainText(`Only claim tasks explicitly requiring ${name}`);
    await page.getByRole('button', { name: 'Discard changes' }).click(); await expect(rule).toHaveValue('all');
    await rule.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Save configuration' }).click(); await expect(feedback).toContainText('Awaiting application'); await expect(feedback).toContainText('Claim all compatible tasks');
    expect(writes).toHaveLength(1); applied = 'only'; observedRevision = '2'; observationVersion++;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await expect(feedback).toContainText('Applied'); await expect(feedback).toContainText(`Only claim ${name} tasks`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
