import { expect, test, type Page, type Route } from '@playwright/test';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const personalA = '00000000-0000-4000-8000-000000000011';
const personalB = '00000000-0000-4000-8000-000000000012';
const alpha = '00000000-0000-4000-8000-000000000021';
const beta = '00000000-0000-4000-8000-000000000022';
const project = '00000000-0000-4000-8000-000000000031';
const task = '00000000-0000-4000-8000-000000000041';
const key = (user: string) => `daynight.selectedTeam:${user}`;
const time = '2026-10-20T09:00:00Z';
const personal = (user: string) => user === alice ? personalA : personalB;
const user = (id: string) => ({ id, personalTeam: { id: personal(id), kind: 'personal', name: null }, name: id === alice ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null });
const team = (id: string, userId: string) => ({ id, kind: 'ordinary', name: id === alpha ? 'Alpha' : 'Beta', version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
const error = { error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } };

type Fixture = { actor: string; detail: 'ok' | '404' | '500' | 'network'; detailReads: string[]; projectQueries: string[]; paginated: boolean; holdDetail: Promise<void> | null };
const install = async (page: Page): Promise<Fixture> => {
  const state: Fixture = { actor: alice, detail: 'ok', detailReads: [], projectQueries: [], paginated: false, holdDetail: null };
  await page.route('**/api/v1/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'Daynight-User-ID': state.actor };
    const send = async (body: unknown, status = 200) => route.fulfill({ json: body, status, headers });
    if (path === '/api/v1/me') return send(user(state.actor));
    if (path === '/api/v1/teams') {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      return send(state.paginated ? cursor === null ? { items: [team(beta, state.actor)], nextCursor: 'next' } : { items: [team(alpha, state.actor)], nextCursor: null } : { items: [team(alpha, state.actor), team(beta, state.actor)], nextCursor: null });
    }
    if (path === `/api/v1/teams/${alpha}` || path === `/api/v1/teams/${beta}` || path === `/api/v1/teams/${personal(state.actor)}`) {
      state.detailReads.push(path);
      await state.holdDetail;
      if (state.detail === 'network') return route.abort('failed');
      if (state.detail === '404') return send(error, 404);
      if (state.detail === '500') return send({ error: { code: 'internal_error', message: 'Unavailable', requestId: '00000000-0000-4000-8000-000000000099' } }, 500);
      const teamId = path.split('/').at(-1)!;
      return send(teamId === personal(state.actor) ? { ...team(teamId, state.actor), kind: 'personal', name: null } : team(teamId, state.actor));
    }
    const memberMatch = /^\/api\/v1\/teams\/([^/]+)\/members$/.exec(path);
    if (memberMatch) return send({ items: [{ ...team(memberMatch[1]!, state.actor).membership, profile: { name: 'Alice', email: null, avatarUrl: null } }] });
    if (path === '/api/v1/projects') {
      state.projectQueries.push(new URL(route.request().url()).search);
      return send({ items: [], nextCursor: null });
    }
    return send(error, 404);
  });
  return state;
};
const selected = (page: Page, id: string) => page.evaluate((k) => localStorage.getItem(k), key(id));
const put = (page: Page, id: string, value: string) => page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [key(id), value]);
const openPicker = (page: Page) => page.locator('details.team-selector summary').click();
const heading = (page: Page, name: string) => page.getByRole('main').getByRole('heading', { name, exact: true });

test('remembers confirmed Team selection on reload and keeps accounts isolated', async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects');
  await expect(heading(page, 'Personal')).toBeVisible();
  expect(await selected(page, alice)).toBeNull();
  await openPicker(page);
  await page.locator(`a[href="/teams/${alpha}"]`).click();
  await expect(heading(page, 'Alpha')).toBeVisible();
  await expect.poll(() => selected(page, alice)).toBe(alpha);
  await page.goto('/projects');
  await expect(heading(page, 'Alpha')).toBeVisible();
  expect(api.detailReads).toContain(`/api/v1/teams/${alpha}`);
  api.actor = bob;
  await page.goto('/projects');
  await expect(heading(page, 'Personal')).toBeVisible();
  expect(await selected(page, bob)).toBeNull();
  expect(await selected(page, alice)).toBe(alpha);
  await openPicker(page);
  await page.locator(`a[href="/teams/${beta}"]`).click();
  await expect(heading(page, 'Beta')).toBeVisible();
  await expect.poll(() => selected(page, bob)).toBe(beta);
  api.actor = alice;
  await page.goto('/projects');
  await expect(heading(page, 'Alpha')).toBeVisible();
  expect(await selected(page, bob)).toBe(beta);
});

for (const path of [`/projects/${project}`, `/projects/${project}/members`, `/projects/${project}/settings`, '/shared-projects', '/workers', '/account', '/bots', '/test-sessions']) {
  test(`restores the sidebar Team on cold entry and reload at ${path}`, async ({ page }) => {
    const api = await install(page);
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await openPicker(page); await page.locator(`a[href="/teams/${alpha}"]`).click();
    await expect(heading(page, 'Alpha')).toBeVisible();
    api.projectQueries.length = 0;
    await page.goto(path);
    await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
    await page.reload();
    await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
    await expect(page.locator('.sidebar a').filter({ hasText: 'Team members' })).toHaveAttribute('href', `/teams/${alpha}/members`);
    await expect(page.locator('.sidebar a').filter({ hasText: 'Team settings' })).toHaveAttribute('href', `/teams/${alpha}/settings`);
    expect(new URL(page.url()).pathname).toBe(path);
    expect(await selected(page, alice)).toBe(alpha);
    expect(api.projectQueries.some((query) => query.includes(`teamId=${personalA}`))).toBe(false);
  });
}

for (const suffix of ['members', 'settings']) {
  test(`explicit Team ${suffix} reload follows the URL ahead of the saved preference`, async ({ page }) => {
    await install(page);
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await put(page, alice, beta);
    await page.goto(`/teams/${alpha}/${suffix}`);
    await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
    await put(page, alice, beta);
    await page.reload();
    await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
    expect(await selected(page, alice)).toBe(alpha);
    await page.goto(`/teams/${personalA}/${suffix}`);
    await expect(page.locator('details.team-selector summary')).toContainText('Personal');
    expect(new URL(page.url()).pathname).toBe(`/teams/${personalA}/${suffix}`);
  });
}

test('sidebar restoration leaves shared content available during slow and failed Team reads', async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha);
  const gate = Promise.withResolvers<void>(); api.holdDetail = gate.promise;
  api.projectQueries.length = 0;
  try {
    await page.goto('/shared-projects');
    await expect(heading(page, 'Projects shared with me')).toBeVisible();
    await expect(page.locator('details.team-selector summary')).toContainText('Loading Teams');
    await expect.poll(() => api.projectQueries.some((query) => query.includes('shared=true'))).toBe(true);
    await expect(page.locator(`a[href="/teams/${personalA}/members"]`)).toHaveCount(0);
    api.detail = '500'; gate.resolve(); api.holdDetail = null;
    const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Retry', exact: true }) });
    await expect(alert).toBeVisible();
    expect(await selected(page, alice)).toBe(alpha);
    await expect(heading(page, 'Projects shared with me')).toBeVisible();
    api.detail = 'ok'; await alert.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
    expect(new URL(page.url()).pathname).toBe('/shared-projects');
  } finally { gate.resolve(); }
});

test('ordinary workspace navigation retains the current Team until explicit default re-entry', async ({ page }) => {
  await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha);
  await page.goto(`/projects/${project}`);
  await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
  await put(page, alice, beta);
  await page.getByRole('link', { name: 'Shared with me', exact: true }).click();
  await expect(heading(page, 'Projects shared with me')).toBeVisible();
  await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
  await page.locator('a.brand').click();
  await expect(heading(page, 'Beta')).toBeVisible();
});

test.describe('Chinese narrow sidebar', () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
  test('restores the Team and its links after reloading a project page', async ({ page }) => {
    await install(page);
    await page.goto('/projects'); await expect(heading(page, '个人')).toBeVisible();
    await put(page, alice, alpha);
    await page.goto(`/projects/${project}`); await page.reload();
    const control = page.getByRole('button', { name: '切换 Team: Alpha', exact: true });
    await expect(control).toBeVisible(); await control.click();
    await expect(page.locator('details.team-selector summary')).toContainText('Alpha');
    await expect(page.locator(`.sidebar a[href="/teams/${alpha}/members"]`)).toBeVisible();
    await expect(page.locator(`.sidebar a[href="/teams/${alpha}/settings"]`)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/projects/${project}`);
  });
});

test('confirmed 404 clears only the current account and restores Personal', async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha); await put(page, bob, beta);
  api.detail = '404';
  await page.goto('/projects');
  await expect(heading(page, 'Personal')).toBeVisible();
  await expect.poll(() => selected(page, alice)).toBeNull();
  expect(await selected(page, bob)).toBe(beta);
});

for (const failure of ['network', '500'] as const) test(`${failure} failure retains the preference and retry restores the exact Team`, async ({ page }) => {
  const api = await install(page);
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha); api.detail = failure;
  await page.goto('/projects');
  const alert = page.getByRole('alert'); await expect(alert).toBeVisible();
  expect(await selected(page, alice)).toBe(alpha);
  api.detail = 'ok';
  await alert.getByRole('button', { name: /retry/i }).click();
  await expect(heading(page, 'Alpha')).toBeVisible();
  expect(await selected(page, alice)).toBe(alpha);
});

test('a saved Team outside the first picker page still restores, and Personal is selectable', async ({ page }) => {
  const api = await install(page); api.paginated = true;
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, alice, alpha);
  await page.goto('/projects'); await expect(heading(page, 'Alpha')).toBeVisible();
  await openPicker(page);
  await expect(page.locator(`details.team-selector a[href="/teams/${alpha}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more Teams' }).click();
  await expect(page.locator(`details.team-selector a[href="/teams/${alpha}"]`)).toBeVisible();
  await page.locator(`a[href="/teams/${personalA}"]`).click();
  await expect(heading(page, 'Personal')).toBeVisible();
  await expect.poll(() => selected(page, alice)).toBe(personalA);
  await expect(page.locator('main')).toBeFocused();
  await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
  expect(await selected(page, alice)).toBe(personalA);
  expect(api.detailReads).toContain(`/api/v1/teams/${personalA}`);
});

test('storage read and write failures are visible and recover without changing other account data', async ({ page }) => {
  await install(page);
  await page.addInitScript(() => {
    const originalGet = Storage.prototype.getItem, originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key.startsWith('daynight.selectedTeam:') && (window as unknown as { failTeamRead?: boolean }).failTeamRead) throw new DOMException('read failed', 'SecurityError'); return originalGet.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('daynight.selectedTeam:') && (window as unknown as { failTeamWrite?: boolean }).failTeamWrite) throw new DOMException('write failed', 'QuotaExceededError'); return originalSet.call(this, key, value); };
    (window as unknown as { failTeamRead: boolean; failTeamWrite: boolean }).failTeamRead = true;
  });
  await page.goto('/projects');
  const readAlert = page.getByRole('alert'); await expect(readAlert).toBeVisible();
  await page.evaluate(() => { (window as unknown as { failTeamRead: boolean }).failTeamRead = false; });
  await readAlert.getByRole('button', { name: /retry/i }).click();
  await expect(heading(page, 'Personal')).toBeVisible();
  await put(page, bob, beta);
  await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = true; });
  await openPicker(page); await page.locator(`a[href="/teams/${alpha}"]`).click();
  await expect(heading(page, 'Alpha')).toBeVisible();
  const writeAlert = page.getByRole('alert'); await expect(writeAlert).toBeVisible();
  expect(await selected(page, alice)).toBeNull(); expect(await selected(page, bob)).toBe(beta);
  await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = false; });
  await writeAlert.getByRole('button', { name: /retry/i }).click();
  await expect.poll(() => selected(page, alice)).toBe(alpha);
  expect(await selected(page, bob)).toBe(beta);
});

for (const path of [`/projects/${project}/tasks/${task}`, `/projects/${project}/tasks/${task}/attachments/readme.md`]) {
  test(`explicit resource path ${path} bypasses default restoration`, async ({ page }) => {
    const api = await install(page);
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await put(page, alice, alpha); api.detailReads.length = 0;
    await page.goto(path);
    await expect.poll(() => new URL(page.url()).pathname).toBe(path);
    await expect(page.getByRole('main')).toBeVisible();
    expect(api.detailReads).not.toContain(`/api/v1/teams/${alpha}`);
    expect(await selected(page, alice)).toBe(alpha);
  });
}

for (const path of [`/projects/${project}/tasks/${task}`, `/projects/${project}/tasks/${task}/attachments/readme.md`]) {
  test(`retains an unsaved Team across same-page navigation to ${path}`, async ({ page }) => {
    await install(page);
    await page.addInitScript(() => {
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('daynight.selectedTeam:') && (window as unknown as { failTeamWrite?: boolean }).failTeamWrite) throw new DOMException('write failed', 'QuotaExceededError');
        return originalSet.call(this, key, value);
      };
      (window as unknown as { failTeamWrite: boolean; samePage: string }).failTeamWrite = false;
      (window as unknown as { failTeamWrite: boolean; samePage: string }).samePage = 'original';
    });
    await page.goto('/projects'); await expect(heading(page, 'Personal')).toBeVisible();
    await put(page, bob, beta);
    await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = true; });
    await openPicker(page); await page.locator(`a[href="/teams/${alpha}"]`).click();
    await expect(heading(page, 'Alpha')).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await selected(page, alice)).toBeNull();
    const traverse = async (target: string) => {
      await page.evaluate((url) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate', { state: null })); }, target);
      await expect.poll(() => new URL(page.url()).pathname).toBe(target);
    };
    await traverse(path);
    await expect(page.locator('main.task-detail-page')).toBeVisible();
    await traverse('/projects');
    await expect(heading(page, 'Alpha')).toBeVisible();
    const alert = page.getByRole('alert'); await expect(alert).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { samePage: string }).samePage)).toBe('original');
    expect(await selected(page, alice)).toBeNull(); expect(await selected(page, bob)).toBe(beta);
    await page.evaluate(() => { (window as unknown as { failTeamWrite: boolean }).failTeamWrite = false; });
    await alert.getByRole('button', { name: /retry/i }).click();
    await expect.poll(() => selected(page, alice)).toBe(alpha);
    expect(await selected(page, bob)).toBe(beta);
    await expect(alert).toHaveCount(0);
  });
}
