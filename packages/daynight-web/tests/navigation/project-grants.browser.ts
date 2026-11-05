import { expect, test, type Page, type Route } from '@playwright/test';

const projectId = '00000000-0000-4000-8000-000000000101';
const actorId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
const initialVersion = 9007199254740993n;
const personal = { id: personalId, kind: 'personal', name: null };
const owner = { id: teamId, kind: 'ordinary', name: 'Owner Team' };
const profile = { id: actorId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const grant = (userId: string, role: 'admin' | 'member', version: bigint) => ({ projectId, userId, role, version, createdAt: time, updatedAt: time });
const actorGrant = grant(actorId, 'admin', 1n);
const actorAccess = { projectId, ownerTeam: owner, ownership: { teamId, version: 1n }, effectiveRole: 'admin', teamRole: null, canTransfer: false, directGrant: actorGrant };
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
const rawJson = JSON as unknown as { rawJSON: (text: string) => unknown };
type State = { targetGrant: ReturnType<typeof grant> | null; actorLost: boolean; writes: { method: string; path: string; body: string }[]; requests: string[] };

const install = async (page: Page): Promise<State> => {
  const state: State = { targetGrant: null, actorLost: false, writes: [], requests: [] };
  const members = () => ({ actorAccess, items: [
    { userId: actorId, profile: { name: 'Alice', email: null, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: null, directGrant: actorGrant },
    { userId: targetId, profile: { name: 'Bob', email: null, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: { team: owner, role: 'admin' }, directGrant: state.targetGrant },
  ] });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    state.requests.push(`${method} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Daynight-User-ID': actorId }, body: JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? rawJson.rawJSON(value.toString()) : value) });
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ ...personal, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: actorId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/access`) return state.actorLost ? send(error('not_found'), 404) : send(actorAccess);
    if (path === `/api/v1/projects/${projectId}/members`) return send(members());
    if (path === `/api/v1/projects/${projectId}/invitations`) return send({ items: [] });
    if (path.startsWith(`/api/v1/projects/${projectId}/grants/`)) {
      const body = request.postData()!; state.writes.push({ method, path, body });
      if (path.endsWith(actorId) && method === 'DELETE') { state.actorLost = true; return send({ projectId, userId: actorId, deleted: true, actorAccess: null }); }
      if (method === 'PUT') {
        const role = (JSON.parse(body) as { role: 'admin' | 'member' }).role;
        state.targetGrant = grant(targetId, role, state.targetGrant === null ? initialVersion : initialVersion + 1n);
        return send({ grant: state.targetGrant, actorAccess });
      }
      state.targetGrant = null;
      return send({ projectId, userId: targetId, deleted: true, actorAccess });
    }
    return send(error('not_found'), 404);
  });
  return state;
};

const start = async (page: Page) => {
  await page.goto(`/projects/${projectId}/members`);
  await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible();
  await expect(page.getByLabel('Direct grant for Bob', { exact: true })).toBeEnabled();
};

test('external project admin creates, replaces and removes a direct grant with source roles and exact versions', async ({ page }) => {
  const state = await install(page); await start(page);
  const bob = page.locator('.grant-row').filter({ hasText: 'Bob' });
  await expect(bob).toContainText('Administrator'); await expect(bob).toContainText('Owner Team');
  await expect(bob.getByLabel('Direct grant for Bob', { exact: true })).toHaveValue('');
  await bob.getByLabel('Direct grant for Bob', { exact: true }).selectOption('member');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('No direct grant → Member'); await expect(dialog).toContainText('Resulting project role: Administrator');
  await dialog.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Direct grant for Bob saved as Member' })).toBeVisible();
  await expect(bob.getByLabel('Direct grant for Bob', { exact: true })).toHaveValue('member');
  await expect(bob).toContainText('Administrator');
  await bob.getByLabel('Direct grant for Bob', { exact: true }).selectOption('admin');
  await dialog.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Direct grant for Bob saved as Administrator' })).toBeVisible();
  await expect(bob.getByLabel('Direct grant for Bob', { exact: true })).toHaveValue('admin');
  await bob.getByRole('button', { name: 'Remove direct grant for Bob' }).click();
  await expect(dialog).toContainText('Resulting project role: Administrator');
  await dialog.getByRole('button', { name: 'Remove grant' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Direct grant for Bob removed' })).toBeVisible();
  await expect(bob.getByLabel('Direct grant for Bob', { exact: true })).toHaveValue('');
  await expect(bob).toContainText('Administrator');
  expect(state.writes.map(({ method, body }) => ({ method, body }))).toEqual([
    { method: 'PUT', body: `{"version":null,"role":"member","expectedUserId":"${actorId}"}` },
    { method: 'PUT', body: `{"version":9007199254740993,"role":"admin","expectedUserId":"${actorId}"}` },
    { method: 'DELETE', body: `{"version":9007199254740994,"expectedUserId":"${actorId}"}` },
  ]);
  expect(state.requests.filter((request) => request.includes(`/teams/${teamId}`))).toEqual([]);
});

test('narrow screen cancellation makes no write and self removal shows the null-access receipt', async ({ page }) => {
  const state = await install(page); await page.setViewportSize({ width: 375, height: 667 }); await start(page);
  const select = page.getByLabel('Direct grant for Bob', { exact: true }); await select.selectOption('member');
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(state.writes).toHaveLength(0);
  await select.selectOption('member'); await dialog.getByRole('button', { name: 'Cancel' }).click(); expect(state.writes).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Remove direct grant for Alice' }).click();
  await dialog.getByRole('button', { name: 'Remove grant' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Direct grant for Alice removed' })).toContainText('This change left you without access to the project');
  await expect(page.getByRole('button', { name: 'Return to projects' })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]?.body).toBe(`{"version":1,"expectedUserId":"${actorId}"}`);
  expect(state.requests.filter((request) => request.includes(`/teams/${teamId}`))).toEqual([]);
});

for (const width of [700, 768, 800, 1280]) {
  test(`grant removal remains reachable inside the member table at ${width}px`, async ({ page }, testInfo) => {
    const externalRequests: string[] = [];
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === 'http://127.0.0.1:4198') return route.continue();
      externalRequests.push(route.request().resourceType());
      return route.abort();
    });
    const state = await install(page);
    state.targetGrant = grant(targetId, 'member', initialVersion);
    await page.setViewportSize({ width, height: 900 });
    await start(page);
    const shell = page.locator('.auth-shell');
    await expect(shell).not.toHaveClass(/sidebar-collapsed/);
    if (width > 740) await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    const table = page.locator('.grant-table');
    const remove = page.getByRole('button', { name: 'Remove direct grant for Bob' });
    const before = await table.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft }));
    await table.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const hit = await remove.evaluate((element) => {
      const button = element.getBoundingClientRect();
      const container = element.closest('.grant-table')!.getBoundingClientRect();
      const x = button.x + button.width / 2, y = button.y + button.height / 2;
      return { x, y, contained: button.left >= container.left && button.right <= container.right, reachable: document.elementFromPoint(x, y)?.closest('button') === element };
    });
    await testInfo.attach('table-reachability', { contentType: 'application/json', body: JSON.stringify({ width, before, hit }) });
    expect(hit.contained).toBe(true);
    expect(hit.reachable).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1280) expect(before.scrollWidth).toBe(before.clientWidth);
    await page.screenshot({ path: testInfo.outputPath(`members-${width}.png`) });
    await page.mouse.click(hit.x, hit.y);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Member → No direct grant');
    await dialog.getByRole('button', { name: 'Remove grant' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Direct grant for Bob removed' })).toBeVisible();
    await expect(page.getByLabel('Direct grant for Bob', { exact: true })).toHaveValue('');
    expect(state.writes).toEqual([{ method: 'DELETE', path: `/api/v1/projects/${projectId}/grants/${targetId}`, body: `{"version":9007199254740993,"expectedUserId":"${actorId}"}` }]);
    expect(externalRequests).toEqual([]);
  });
}
