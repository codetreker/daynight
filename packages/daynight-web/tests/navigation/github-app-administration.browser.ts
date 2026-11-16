import { expect, test, type Page } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const actor = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const teamId = '00000000-0000-4000-8000-000000000011';
const appId = '00000000-0000-4000-8000-000000000021';
const secondAppId = '00000000-0000-4000-8000-000000000022';
const inviteId = '00000000-0000-4000-8000-000000000031';
const token = `dn_gai_${'A'.repeat(43)}`;
const time = '2026-10-20T09:00:00Z', expires = '2036-10-27T09:00:00Z';
const team = { id: teamId, kind: 'personal', name: null };
const user = { id: actor, personalTeam: team, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const app = { id: appId, githubAppId: '42', name: 'Platform App', githubName: 'Platform', githubSlug: 'platform', version: '4', administrators: '2', authorizedTeams: '1', connectedProjects: '3', webhookUrl: `https://daynight.example/api/v1/github/apps/${appId}/webhook`, createdAt: time, updatedAt: time };
const member = (userId: string, version: string, name: string) => ({ appId, userId, membershipVersion: version, createdAt: time, updatedAt: time, profile: { name, email: `${name.toLowerCase()}@example.test`, avatarUrl: null } });
const membership = { appId, userId: actor, membershipVersion: '7', createdAt: time, updatedAt: time };
const invitation = { id: inviteId, appId, createdBy: actor, issuerMembershipVersion: '7', createdAt: time, expiresAt: expires, revokedAt: null, consumedAt: null, consumedBy: null, available: true };
type State = { admins: ReturnType<typeof member>[]; invitations: typeof invitation[]; writes: { path: string; body: Record<string, unknown> }[]; mode: 'ok' | 'unknown' | 'last'; denied: boolean; anonymous: boolean; currentActor: string; holdCreate: Promise<void> | null; holdWrite: Promise<void> | null; holdAccept: Promise<void> | null; adminReads: number; inspectCount: number; refs: string[] };
const install = async (page: Page, anonymous = false): Promise<State> => {
  const state: State = { admins: [member(actor, '7', 'Alice'), member(other, '8', 'Bob')], invitations: [invitation], writes: [], mode: 'ok', denied: false, anonymous, currentActor: actor, holdCreate: null, holdWrite: null, holdAccept: null, adminReads: 0, inspectCount: 0, refs: [] };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const requestActor = state.currentActor;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': requestActor } });
    const error = (code: string, status: number) => send({ error: { code, message: code, requestId: 'test', ...(code === 'github_write_outcome_unknown' ? { details: { writeOutcome: 'unknown' } } : {}) } }, status);
    state.refs.push(request.headers().referer ?? '');
    if (path === '/api/v1/auth/providers') return send({ providers: ['github'] });
    if (path === '/api/v1/me') return state.anonymous ? error('unauthenticated', 401) : send({ ...user, id: requestActor, name: requestActor === actor ? 'Alice' : 'Bob' });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: requestActor, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    const secondApp = { ...app, id: secondAppId, name: 'Second App', webhookUrl: `https://daynight.example/api/v1/github/apps/${secondAppId}/webhook` };
    if (path === '/api/v1/github/apps') return send({ items: state.denied ? [secondApp] : [app, secondApp], nextCursor: null });
    if (path === `/api/v1/github/apps/${secondAppId}`) return send(secondApp);
    if (path === `/api/v1/github/apps/${secondAppId}/admins` && method === 'GET') return send({ items: state.admins.map(item => ({ ...item, appId: secondAppId })), nextCursor: null });
    if (path === `/api/v1/github/apps/${secondAppId}/admin-invitations` && method === 'GET') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/github/apps/${secondAppId}/admin-invitations` && method === 'POST') { state.writes.push({ path, body: request.postDataJSON() }); return error('github_write_outcome_unknown', 503); }
    if (path === `/api/v1/github/apps/${appId}`) return state.denied ? error('not_found', 404) : send(app);
    if (path === `/api/v1/github/apps/${appId}/admins` && method === 'GET') { state.adminReads++; return state.denied ? error('not_found', 404) : send({ items: state.admins, nextCursor: null }); }
    if (path === `/api/v1/github/apps/${appId}/admin-invitations` && method === 'GET') return state.denied ? error('not_found', 404) : send({ items: state.invitations, nextCursor: null });
    if (path === `/api/v1/github/apps/${appId}/admin-invitations` && method === 'POST') {
      state.writes.push({ path, body: request.postDataJSON() }); if (state.holdCreate) await state.holdCreate;
      if (state.mode === 'unknown') return error('github_write_outcome_unknown', 503);
      return send({ ...invitation, link: `http://127.0.0.1:4198/github-app-admin-invitations#${token}` }, 201);
    }
    if (path === `/api/v1/github/apps/${appId}/admin-invitations/${inviteId}/revoke`) { state.writes.push({ path, body: request.postDataJSON() }); if (state.holdWrite) await state.holdWrite; state.invitations = []; return send({ appId, invitationId: inviteId, changed: true }); }
    if (path === `/api/v1/github/apps/${appId}/admins/${actor}/remove` || path === `/api/v1/github/apps/${appId}/admins/${other}/remove`) {
      state.writes.push({ path, body: request.postDataJSON() }); if (state.holdWrite) await state.holdWrite; if (state.mode === 'last') return error('last_admin', 409);
      const target = path.includes(`/${actor}/`) ? actor : other; state.admins = state.admins.filter(item => item.userId !== target);
      if (target === actor) state.denied = true;
      return send({ appId, userId: target, removed: true, actorIsAdmin: target !== actor });
    }
    if (path === '/api/v1/github-app-admin-invitations/inspect') { state.inspectCount++; return send({ app: { id: appId, githubAppId: '42', name: 'Platform App', githubName: 'Platform', githubSlug: 'platform' }, expiresAt: expires, membership: null }); }
    if (path === '/api/v1/github-app-admin-invitations/accept') { state.writes.push({ path, body: request.postDataJSON() }); if (state.holdAccept) await state.holdAccept; return state.mode === 'unknown' ? error('github_write_outcome_unknown', 503) : send({ appId, membership, joined: true }); }
    return error('not_found', 404);
  });
  return state;
};

for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
  test(`direct administrator route and one-time invitation at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page); await page.setViewportSize({ width, height: 900 }); await page.goto(`/github-apps/${appId}/admins`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await expect(page.getByText('Bob', { exact: true })).toBeVisible(); await page.reload();
    await expect(page.locator('#main-content').getByText('Alice', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: locale === 'en' ? 'Invite administrator' : '邀请管理员' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: locale === 'en' ? 'Create invitation' : '创建邀请' }).click();
    await expect(dialog.getByRole('textbox', { name: locale === 'en' ? 'Copy invitation link' : '复制邀请链接' })).toHaveValue(`http://127.0.0.1:4198/github-app-admin-invitations#${token}`);
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth)).toBe(true);
    expect(state.writes[0]!.body).toEqual({ expectedUserId: actor });
    await dialog.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }).click();
    await expect(page.getByLabel(locale === 'en' ? 'Copy invitation link' : '复制邀请链接')).toHaveCount(0);
    await page.getByRole('button', { name: locale === 'en' ? 'Revoke' : '撤销', exact: true }).click();
    dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: locale === 'en' ? 'Revoke invitation' : '撤销邀请' }).click();
    await expect(page.getByText(locale === 'en' ? 'Invitation revoked.' : '邀请已撤销。')).toBeVisible();
    expect(state.writes[1]!.body).toEqual({ expectedUserId: actor });
  });
}

test('last administrator is protected and a server last-admin refusal is explicit', async ({ page }) => {
  const state = await install(page); state.admins = [member(actor, '7', 'Alice')]; await page.goto(`/github-apps/${appId}/admins`);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  let dialog = page.getByRole('dialog'); await expect(dialog).toContainText('must retain at least one administrator');
  await expect(dialog.getByRole('button', { name: 'Remove administrator' })).toHaveCount(0); expect(state.writes).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  state.admins.push(member(other, '8', 'Bob')); await page.reload();
  const row = page.getByText('Bob', { exact: true }).locator('..').locator('..');
  await row.getByRole('button', { name: 'Remove', exact: true }).click(); dialog = page.getByRole('dialog'); state.mode = 'last';
  await dialog.getByRole('button', { name: 'Remove administrator' }).click();
  await expect(dialog).toContainText('must retain at least one administrator'); expect(state.writes).toHaveLength(1);
});

test('confirmed self-removal remains visible after access is lost', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}/admins`);
  const row = page.getByText('Alice', { exact: true }).locator('..').locator('..');
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove administrator' }).click();
  await expect(page).toHaveURL(/\/github-apps$/); await expect(page.getByText('Your App administrator access was removed.')).toBeVisible();
  expect(state.writes[0]!.body).toEqual({ membershipVersion: '7', expectedUserId: actor });
  await expect(page.getByText('Platform App', { exact: true })).toHaveCount(0);
});

for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
  test(`invitation fragment stays in memory and acceptance works at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page); await page.setViewportSize({ width, height: 900 });
    await page.goto(`/github-app-admin-invitations#${token}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await expect(page.getByRole('heading', { name: locale === 'en' ? 'Become an App administrator' : '加入 App 管理员' })).toBeVisible();
    await expect(page.getByText('Platform App', { exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.evaluate(secret => !JSON.stringify({ history: history.state, local: { ...localStorage }, session: { ...sessionStorage } }).includes(secret), token)).toBe(true);
    expect(state.refs.every(ref => !ref.includes(token))).toBe(true);
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: locale === 'en' ? 'Accept invitation' : '接受邀请' }).click();
    await expect(page.getByText(locale === 'en' ? 'You are now an administrator of this App.' : '你已成为此 App 的管理员。')).toBeVisible();
    expect(state.writes[0]!.body).toEqual({ token, expectedUserId: actor });
    await page.getByRole('button', { name: locale === 'en' ? 'Open App management' : '打开 App 管理' }).click();
    await expect(page).toHaveURL(new RegExp(`/github-apps/${appId}$`));
  });
}

test('unauthenticated invitation scrubs the fragment before login and does not persist the token', async ({ page }) => {
  const state = await install(page, true); await page.goto(`/github-app-admin-invitations#${token}`);
  await expect(page.getByText('After signing in, reopen the App administrator invitation link.')).toBeVisible();
  await expect(page).toHaveURL(/\/login\?returnPath=/); expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(secret => !JSON.stringify({ url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage } }).includes(secret), token)).toBe(true);
  expect(state.inspectCount).toBe(0); expect(state.refs.every(ref => !ref.includes(token))).toBe(true);
});

test('unknown acceptance never replays automatically', async ({ page }) => {
  const state = await install(page); state.mode = 'unknown'; await page.goto(`/github-app-admin-invitations#${token}`);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('Acceptance has not been confirmed. Check current state before deciding what to do next.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check current state' }).click();
  await expect(page.getByText('The current state was read; it cannot confirm the original operation.')).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test('late invitation receipt cannot expose its link after administrator access is lost', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}/admins`);
  await page.getByRole('button', { name: 'Invite administrator' }).click();
  const gate = Promise.withResolvers<void>(); state.holdCreate = gate.promise;
  await page.getByRole('dialog').getByRole('button', { name: 'Create invitation' }).click(); await expect.poll(() => state.writes.length).toBe(1);
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const second = await page.context().newPage(); await second.goto('/projects');
  const secondary = await page.context().newCDPSession(second); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await second.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  state.denied = true; const reads = state.adminReads; await page.bringToFront(); await expect.poll(() => state.adminReads).toBeGreaterThan(reads);
  await expect(page.getByText('This App is unavailable or you do not have access.').first()).toBeVisible();
  gate.resolve(); state.holdCreate = null;
  await expect(page.getByText('Invitation created, but the link cannot be shown after access changed.')).toHaveCount(1);
  await expect(page.getByLabel('Copy invitation link')).toHaveCount(0);
  expect(await page.evaluate(secret => !document.body.innerText.includes(secret), token)).toBe(true); await second.close();
});

test('unknown administrator results remain attributed to each App across list refresh and access loss', async ({ page }) => {
  const state = await install(page); state.mode = 'unknown'; await page.goto('/github-apps');
  const openApp = async (name: string) => {
    await page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Manage' }).click();
    await page.getByRole('link', { name: 'Administrators' }).click();
    await page.getByRole('button', { name: 'Invite administrator' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create invitation' }).click();
    await expect(page.getByRole('dialog')).toContainText('The result is unknown.');
    await page.goBack(); await page.goBack(); await expect(page).toHaveURL(/\/github-apps$/);
  };
  await openApp('Platform App');
  const first = page.getByRole('alert').filter({ hasText: appId }); await expect(first).toContainText('administrator operation outcome is unknown');
  await openApp('Second App');
  const second = page.getByRole('alert').filter({ hasText: secondAppId });
  await expect(first).toBeVisible(); await expect(second).toBeVisible(); expect(state.writes).toHaveLength(2);
  await first.getByRole('button', { name: 'Check current state' }).click();
  await expect(page).toHaveURL(new RegExp(`/github-apps/${appId}/admins$`));
  await expect(page.getByRole('dialog')).toContainText('The result is unknown.');
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const otherPage = await page.context().newPage(); await otherPage.goto('/projects');
  const secondary = await page.context().newCDPSession(otherPage); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await otherPage.bringToFront();
  try {
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); state.denied = true;
    await page.bringToFront(); await expect(first).toContainText('This App is currently unavailable.');
    await expect(second).toBeVisible(); await expect(first.getByRole('button', { name: 'Finish review' })).toBeVisible();
    await first.getByRole('button', { name: 'Finish review' }).click(); await expect(first).toHaveCount(0); await expect(second).toBeVisible();
    expect(state.writes).toHaveLength(2);
  } finally { await otherPage.close(); }
});

for (const action of ['invite', 'remove', 'revoke'] as const) {
  test(`late ${action} receipt remains visible in the host after access is lost`, async ({ page }) => {
    const state = await install(page); await page.goto(`/github-apps/${appId}/admins`);
    if (action === 'invite') await page.getByRole('button', { name: 'Invite administrator' }).click();
    if (action === 'remove') await page.getByText('Bob', { exact: true }).locator('..').locator('..').getByRole('button', { name: 'Remove', exact: true }).click();
    if (action === 'revoke') await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    const gate = Promise.withResolvers<void>(); if (action === 'invite') state.holdCreate = gate.promise; else state.holdWrite = gate.promise;
    const confirm = action === 'invite' ? 'Create invitation' : action === 'remove' ? 'Remove administrator' : 'Revoke invitation';
    await page.getByRole('dialog').getByRole('button', { name: confirm }).click(); await expect.poll(() => state.writes.length).toBe(1);
    const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
    const otherPage = await page.context().newPage(); await otherPage.goto('/projects');
    const secondary = await page.context().newCDPSession(otherPage); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
    try {
      await otherPage.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
      state.denied = true; await page.bringToFront(); await expect(page.getByText('This App is unavailable or you do not have access.').first()).toBeVisible();
      gate.resolve(); state.holdCreate = null; state.holdWrite = null;
      const receipt = action === 'invite' ? 'Invitation created, but its link cannot be shown here.' : action === 'remove' ? 'Administrator removed.' : 'Invitation revoked.';
      const notice = page.getByRole('status').filter({ hasText: appId });
      await expect(notice).toContainText(receipt);
      await expect(page.getByLabel('Copy invitation link')).toHaveCount(0);
      expect(await page.evaluate(secret => !document.body.innerText.includes(secret), token)).toBe(true);
      expect(state.writes).toHaveLength(1);
    } finally { gate.resolve(); await otherPage.close(); }
  });
}

for (const outcome of ['ok', 'unknown'] as const) {
  test(`invitation acceptance ${outcome} survives leaving and returning during a pending write`, async ({ page }) => {
    const state = await install(page); state.mode = outcome; await page.goto('/projects');
    await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/github-app-admin-invitations#${token}`);
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible(); expect(new URL(page.url()).hash).toBe('');
    const gate = Promise.withResolvers<void>(); state.holdAccept = gate.promise;
    try {
      await page.getByRole('button', { name: 'Accept invitation' }).click(); await expect.poll(() => state.writes.length).toBe(1);
      await page.goBack(); await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByText('Accepting the App administrator invitation.')).toBeVisible();
      gate.resolve(); state.holdAccept = null;
      await expect(page.getByText(outcome === 'ok' ? 'The App administrator invitation was accepted.' : 'The invitation acceptance outcome is unknown. Return to review it before deciding again.')).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/github-app-admin-invitations$/);
      if (outcome === 'ok') {
        await expect(page.getByText('You are now an administrator of this App.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open App management' })).toBeVisible();
      } else {
        await expect(page.getByText('Acceptance has not been confirmed. Check current state before deciding what to do next.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
      }
      expect(state.writes).toHaveLength(1);
      expect(await page.evaluate(secret => !JSON.stringify({ url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage }, text: document.body.innerText }).includes(secret), token)).toBe(true);
      expect(state.refs.every(ref => !ref.includes(token))).toBe(true);
    } finally { gate.resolve(); }
  });
}

test('switching identity during a pending invitation acceptance discards the old owner and token', async ({ page }) => {
  const state = await install(page); await page.goto('/projects');
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/github-app-admin-invitations#${token}`);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  const gate = Promise.withResolvers<void>(); state.holdAccept = gate.promise;
  await page.getByRole('button', { name: 'Accept invitation' }).click(); await expect.poll(() => state.writes.length).toBe(1);
  await page.goBack(); await expect(page).toHaveURL(/\/projects$/);
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const otherPage = await page.context().newPage(); await otherPage.goto('/projects');
  const secondary = await page.context().newCDPSession(otherPage); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await otherPage.bringToFront();
  try {
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); state.currentActor = other;
    await page.bringToFront(); await expect(page.getByText('Account changed')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh page' }).click(); await expect(page.getByRole('button', { name: 'Account menu: Bob' })).toBeVisible();
    gate.resolve(); state.holdAccept = null; await page.goForward();
    await expect(page.getByText('You are now an administrator of this App.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
    await expect(page.getByText('Acceptance has not been confirmed.', { exact: false })).toHaveCount(0);
    expect(await page.evaluate(secret => !JSON.stringify({ url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage }, text: document.body.innerText }).includes(secret), token)).toBe(true);
    expect(state.refs.every(ref => !ref.includes(token))).toBe(true); expect(state.writes).toHaveLength(1);
  } finally { gate.resolve(); await otherPage.close(); }
});
