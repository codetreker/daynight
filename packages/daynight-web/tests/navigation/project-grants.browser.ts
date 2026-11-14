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
type State = { targetGrant: ReturnType<typeof grant> | null; actorLost: boolean; readOnly: boolean; longContent: boolean; holdMe: Promise<void> | null; holdAccess: Promise<void> | null; holdMembers: Promise<void> | null; holdInvitations: Promise<void> | null; withInvitation: boolean; writes: { method: string; path: string; body: string }[]; requests: string[] };

const install = async (page: Page): Promise<State> => {
  const state: State = { targetGrant: null, actorLost: false, readOnly: false, longContent: false, holdMe: null, holdAccess: null, holdMembers: null, holdInvitations: null, withInvitation: false, writes: [], requests: [] };
  const currentAccess = () => ({ ...actorAccess, ownerTeam: state.longContent ? { ...owner, name: 'Owner' + 'LongTeamName'.repeat(12) } : owner, ...(state.readOnly ? { effectiveRole: 'member', directGrant: grant(actorId, 'member', 1n) } : {}) });
  const members = () => ({ actorAccess: currentAccess(), items: [
    { userId: actorId, profile: { name: 'Alice', email: null, avatarUrl: null }, effectiveRole: state.readOnly ? 'member' : 'admin', inheritedFrom: null, directGrant: currentAccess().directGrant },
    { userId: targetId, profile: { name: state.longContent ? 'Bob' + 'LongName'.repeat(12) : 'Bob', email: state.longContent ? `${'longaddress'.repeat(12)}@example.com` : null, avatarUrl: null }, effectiveRole: 'admin', inheritedFrom: { team: currentAccess().ownerTeam, role: 'admin' }, directGrant: state.targetGrant },
  ] });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    state.requests.push(`${method} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Daynight-User-ID': actorId }, body: JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? rawJson.rawJSON(value.toString()) : value) });
    if (path === '/api/v1/me') { if (state.holdMe !== null) await state.holdMe; return send(profile); }
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ ...personal, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: actorId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send({ id: projectId, name: 'Grant project', repoUrl: 'https://github.com/example/project', ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time });
    if (path === `/api/v1/projects/${projectId}/access`) { if (state.holdAccess !== null) await state.holdAccess; return state.actorLost ? send(error('not_found'), 404) : send(currentAccess()); }
    if (path === `/api/v1/projects/${projectId}/members`) { if (state.holdMembers !== null) await state.holdMembers; return send(members()); }
    if (path === `/api/v1/projects/${projectId}/invitations`) {
      if (state.holdInvitations !== null) await state.holdInvitations;
      return send({ items: state.withInvitation ? [{ id: '00000000-0000-4000-8000-000000000051', projectId, createdBy: actorId, createdAt: time, expiresAt: '2099-10-20T09:00:00Z', consumedAt: null, consumedBy: null, revokedAt: null }] : [] });
    }
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

const leaveAndReturn = async (page: Page): Promise<Page> => {
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
  await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await page.bringToFront();
  return other;
};

for (const locale of ['en-US', 'zh-CN'] as const) {
  test(`background checks retain the member confirmation and roster (${locale})`, async ({ page }, testInfo) => {
    const state = await install(page); state.withInvitation = true;
    await page.setViewportSize(locale === 'en-US' ? { width: 1280, height: 900 } : { width: 390, height: 844 });
    await start(page);
    if (locale === 'zh-CN') await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const bob = page.locator('.grant-row').filter({ hasText: 'Bob' });
    const invitation = page.locator('.row').filter({ hasText: '00000000-0000-4000-8000-000000000051' });
    await expect(invitation).toBeVisible();
    const select = bob.locator('select');
    const openingMembers = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/members` && response.request().method() === 'GET');
    const openingInvitations = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/invitations` && response.request().method() === 'GET');
    await select.selectOption('member');
    await openingMembers; await openingInvitations;
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole('button', { name: locale === 'en-US' ? 'Cancel' : '取消' });
    await cancel.focus();
    await dialog.evaluate((element) => { (window as unknown as { retainedDialog: Element }).retainedDialog = element; });
    await bob.evaluate((element) => { (window as unknown as { retainedBob: Element }).retainedBob = element; });
    await invitation.evaluate((element) => { (window as unknown as { retainedInvitation: Element }).retainedInvitation = element; });
    const bounds = await dialog.boundingBox();
    const accessGate = Promise.withResolvers<void>(), membersGate = Promise.withResolvers<void>(), invitationsGate = Promise.withResolvers<void>();
    state.holdAccess = accessGate.promise; state.holdMembers = membersGate.promise; state.holdInvitations = invitationsGate.promise;
    const meCount = state.requests.filter((value) => value === 'GET /api/v1/me').length;
    const accessCount = state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/access`).length;
    const membersCount = state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/members`).length;
    const invitationsCount = state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/invitations`).length;
    const other = await leaveAndReturn(page);
    await expect.poll(() => state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/access`).length).toBeGreaterThan(accessCount);
    expect(state.requests.filter((value) => value === 'GET /api/v1/me')).toHaveLength(meCount);
    const check = async () => {
      await expect(dialog).toBeVisible(); await expect(cancel).toBeFocused();
      expect(await dialog.boundingBox()).toEqual(bounds);
      expect(await dialog.evaluate((element) => element === (window as unknown as { retainedDialog: Element }).retainedDialog)).toBe(true);
      expect(await bob.evaluate((element) => element === (window as unknown as { retainedBob: Element }).retainedBob)).toBe(true);
      expect(await invitation.evaluate((element) => element === (window as unknown as { retainedInvitation: Element }).retainedInvitation)).toBe(true);
    };
    await check();
    await page.screenshot({ path: testInfo.outputPath(`member-check-${locale}.png`) });
    accessGate.resolve(); state.holdAccess = null;
    await expect.poll(() => state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/members`).length).toBeGreaterThan(membersCount);
    await check();
    membersGate.resolve(); state.holdMembers = null;
    await expect.poll(() => state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/invitations`).length).toBeGreaterThan(invitationsCount);
    await check();
    const refreshedInvitations = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/invitations` && response.request().method() === 'GET');
    invitationsGate.resolve(); state.holdInvitations = null;
    await refreshedInvitations;
    await expect(dialog.getByRole('button', { name: locale === 'en-US' ? 'Save role' : '保存角色' })).toBeEnabled();
    await check();
    expect(state.writes).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await other.close();
  });
}

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

for (const { width, locale, readOnly } of [
  { width: 1440, locale: 'en-US', readOnly: false },
  { width: 800, locale: 'zh-CN', readOnly: false },
  { width: 768, locale: 'en-US', readOnly: true },
  { width: 700, locale: 'zh-CN', readOnly: true },
  { width: 390, locale: 'en-US', readOnly: false },
  { width: 320, locale: 'zh-CN', readOnly: false },
] as const) {
  test(`member columns align with long content in ${locale} at ${width}px (${readOnly ? 'read-only' : 'admin'})`, async ({ page }, testInfo) => {
    const state = await install(page);
    state.longContent = true; state.readOnly = readOnly; state.targetGrant = grant(targetId, 'member', initialVersion);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}/members`);
    await expect(page.getByRole('heading', { name: 'Project members' })).toBeVisible();
    if (locale === 'zh-CN') await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const table = page.locator('.grant-table');
    await expect(table.locator('.grant-row')).toHaveCount(3);
    const geometry = await table.evaluate(element => {
      const rows = [...element.querySelectorAll('.grant-row')].map(row => [...row.children].map(cell => {
        const { left, right, top, bottom } = cell.getBoundingClientRect();
        return { left, right, top, bottom };
      }));
      return { rows, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    });
    await testInfo.attach('member-geometry', { contentType: 'application/json', body: JSON.stringify({ width, locale, readOnly, ...geometry }) });
    expect(geometry.rows.map(row => row.length)).toEqual([5, 5, 5]);
    const [header, ...members] = geometry.rows;
    expect(Math.max(...header!.map(cell => cell.top)) - Math.min(...header!.map(cell => cell.top))).toBeLessThanOrEqual(1);
    for (const row of members) {
      const centers = row.map(cell => (cell.top + cell.bottom) / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
      for (let index = 0; index < 5; index++) {
        const edge = index === 4 ? 'right' : 'left';
        expect(Math.abs(row[index]![edge] - header![index]![edge])).toBeLessThanOrEqual(1);
        if (index > 0) expect(row[index - 1]!.right).toBeLessThanOrEqual(row[index]!.left + 1);
      }
    }
    for (const content of await table.locator('.person-name, .person-meta, .row-detail').all()) {
      expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width <= 700) expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    if (readOnly) await expect(table.locator('select, button')).toHaveCount(0);
    else {
      const select = table.locator('select').last();
      await select.focus(); await expect(select).toBeFocused(); await expect(select).toBeEnabled();
    }
    await page.screenshot({ path: testInfo.outputPath(`member-columns-${width}-${locale}.png`) });
    expect(state.writes).toHaveLength(0);
  });
}

for (const width of [320, 390, 700, 768, 800, 1280]) {
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
    const select = page.getByLabel('Direct grant for Bob', { exact: true });
    await select.click(); await expect(select).toBeFocused(); await page.keyboard.press('Escape');
    await select.selectOption('admin');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(state.writes).toHaveLength(0);
    await table.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
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

test('a conflicting grant requires a fresh confirmation and exact reread version', async ({ page }) => {
  const state = await install(page);
  state.targetGrant = grant(targetId, 'member', initialVersion);
  await page.route(`**/api/v1/projects/${projectId}/grants/${targetId}`, async route => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    state.writes.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData()! });
    if (state.writes.length === 1) {
      state.targetGrant = grant(targetId, 'admin', initialVersion + 1n);
      return route.fulfill({ status: 409, json: error('version_conflict'), headers: { 'Daynight-User-ID': actorId } });
    }
    state.targetGrant = grant(targetId, 'member', initialVersion + 2n);
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Daynight-User-ID': actorId }, body: JSON.stringify({ grant: state.targetGrant, actorAccess }, (_key, value: unknown) => typeof value === 'bigint' ? rawJson.rawJSON(value.toString()) : value) });
  });
  await start(page);
  const select = page.getByLabel('Direct grant for Bob', { exact: true });
  await expect(select).toHaveValue('member'); await select.selectOption('admin');
  await page.getByRole('dialog').getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Member details have changed' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(select).toHaveValue('admin');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]!.body).toBe(`{"version":${initialVersion},"role":"admin","expectedUserId":"${actorId}"}`);
  await select.selectOption('member');
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Administrator → Member');
  expect(state.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Save role' }).click();
  await expect(select).toHaveValue('member');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]!.body).toBe(`{"version":${initialVersion + 1n},"role":"member","expectedUserId":"${actorId}"}`);
});
