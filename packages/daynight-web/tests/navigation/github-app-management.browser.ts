import { expect, test, type Page } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const actorId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const appId = '00000000-0000-4000-8000-000000000021';
const projectId = '00000000-0000-4000-8000-000000000101';
const time = '2026-10-20T09:00:00Z';
const team = { id: teamId, kind: 'personal', name: null };
const profile = { id: actorId, personalTeam: team, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const metadata = (id = appId) => ({ id, githubAppId: '9007199254740993', name: 'Platform App', githubName: 'Platform', githubSlug: 'platform', version: '4', administrators: '2', authorizedTeams: '1', connectedProjects: '3', webhookUrl: `https://daynight.example/api/v1/github/apps/${id}/webhook`, createdAt: time, updatedAt: time });
type State = { app: ReturnType<typeof metadata>; writes: { path: string; method: string; body: Record<string, unknown> }[]; mode: 'ok' | 'reject' | 'conflict' | 'unknown' | 'github_unavailable' | 'github_rate_limited'; removed: boolean; denied: boolean; holdPatch: Promise<void> | null; holdAppRead: Promise<void> | null; holdListRead: Promise<void> | null; holdProjectRead: Promise<void> | null; holdRemove: Promise<void> | null; holdImpactRecheck: Promise<void> | null; impactReads: number; impactReturned: number; impactDenied: boolean; metadataReturned: number; unknownRemoveCommitted: boolean; projectReads: number; projectPagination: boolean; projectRevoked: boolean; teamPagination: boolean; reads: number };

const install = async (page: Page): Promise<State> => {
  const state: State = { app: metadata(), writes: [], mode: 'ok', removed: false, denied: false, holdPatch: null, holdAppRead: null, holdListRead: null, holdProjectRead: null, holdRemove: null, holdImpactRecheck: null, impactReads: 0, impactReturned: 0, impactDenied: false, metadataReturned: 0, unknownRemoveCommitted: false, projectReads: 0, projectPagination: false, projectRevoked: false, teamPagination: false, reads: 0 };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } });
    const error = (code: string, status: number) => send({ error: { code, message: code, requestId: 'test', ...(code === 'github_write_outcome_unknown' ? { details: { writeOutcome: 'unknown' } } : {}) } }, status);
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    const projectAccess = /^\/api\/v1\/projects\/([^/]+)\/access$/.exec(path);
    if (projectAccess) {
      const target = projectAccess[1]!;
      if (state.projectRevoked && target === projectId) return error('not_found', 404);
      return send({ projectId: target, ownerTeam: team, ownership: { teamId, version: 1n }, effectiveRole: 'admin', teamRole: 'admin', canTransfer: true, directGrant: null });
    }
    if (path === '/api/v1/github/apps' && method === 'GET') { if (state.holdListRead) await state.holdListRead; return send({ items: state.removed || state.denied ? [] : [state.app], nextCursor: null }); }
    if (path === '/api/v1/github/apps' && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>; state.writes.push({ path, method, body });
      if (state.mode === 'reject') return error('github_app_already_registered', 409);
      if (state.mode === 'github_unavailable' || state.mode === 'github_rate_limited') return error(state.mode, 502);
      if (state.mode === 'unknown') return error('github_write_outcome_unknown', 503);
      state.app = { ...metadata(String(body.id)), name: String(body.name), githubAppId: String(body.githubAppId) }; return send(state.app, 201);
    }
    if (path === `/api/v1/github/apps/${state.app.id}` && method === 'GET') { state.reads++; if (state.holdAppRead) await state.holdAppRead; state.metadataReturned++; return state.denied || state.removed ? error('not_found', 404) : send(state.app); }
    if (path === `/api/v1/github/apps/${state.app.id}` && method === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>; state.writes.push({ path, method, body });
      if (state.holdPatch) await state.holdPatch;
      if (state.mode === 'github_unavailable' || state.mode === 'github_rate_limited') return error(state.mode, 502);
      if (state.mode === 'unknown') return error('github_write_outcome_unknown', 503);
      if (state.mode === 'conflict') return error('version_conflict', 409);
      state.app = { ...state.app, version: String(BigInt(state.app.version) + 1n), ...(body.name === undefined ? {} : { name: String(body.name) }) }; return send(state.app);
    }
    if (path === `/api/v1/github/apps/${state.app.id}/removal-preview`) {
      state.impactReads++; if (state.impactDenied) return error('not_found', 404); if (state.holdImpactRecheck && state.projectReads > 0) await state.holdImpactRecheck;
      state.impactReturned++;
      const second = { id: '00000000-0000-4000-8000-000000000012', kind: 'ordinary', name: 'Engineering' };
      return send({ appId: state.app.id, grantId: null, version: state.app.version, impactVersion: '7', totalProjects: '3', visibleProjects: state.projectPagination && !state.projectRevoked ? '2' : '1', hiddenProjects: state.projectPagination && !state.projectRevoked ? '1' : '2', teams: state.teamPagination && url.searchParams.has('cursor') ? [{ team: second, projects: '1' }] : [{ team, projects: state.teamPagination ? '2' : '3' }], nextCursor: state.teamPagination && !url.searchParams.has('cursor') ? 'team-next' : null });
    }
    if (path === `/api/v1/github/apps/${state.app.id}/removal-preview/projects`) {
      state.projectReads++; if (state.holdProjectRead) await state.holdProjectRead;
      const second = { id: '00000000-0000-4000-8000-000000000102', name: 'Other project', repoUrl: 'https://github.com/example/other' };
      if (state.projectPagination && (state.projectRevoked || url.searchParams.has('cursor'))) return send({ items: [second], hiddenProjects: state.projectRevoked ? '2' : '1', nextCursor: null });
      return send({ items: [{ id: projectId, name: 'Visible project', repoUrl: 'https://github.com/example/visible' }], hiddenProjects: state.projectPagination ? '1' : '2', nextCursor: state.projectPagination ? 'project-next' : null });
    }
    if (path === `/api/v1/github/apps/${state.app.id}/remove`) { state.writes.push({ path, method, body: request.postDataJSON() as Record<string, unknown> }); if (state.holdRemove) await state.holdRemove; if (state.mode === 'unknown') { if (state.unknownRemoveCommitted) state.removed = true; return error('github_write_outcome_unknown', 503); } state.removed = true; return send({ appId: state.app.id, removed: true }); }
    return error('not_found', 404);
  });
  return state;
};

for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
  test(`registration is usable at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page); await page.setViewportSize({ width, height: 900 }); await page.goto('/github-apps');
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.getByRole('button', { name: locale === 'en' ? 'Register GitHub App' : '登记 GitHub App' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('App ID').fill('9007199254740993');
    await dialog.getByLabel(locale === 'en' ? 'Registration name' : '登记名称').fill('New App');
    await dialog.getByLabel(locale === 'en' ? 'Private key' : '私钥').fill('private-key');
    await dialog.getByLabel('Webhook secret').fill('secret-value');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Verify and register' : '验证并登记' }).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0]!.body).toMatchObject({ name: 'New App', githubAppId: '9007199254740993', privateKeyPem: 'private-key', webhookSecret: 'secret-value', expectedUserId: actorId });
    expect(state.writes[0]!.body.id).toMatch(/^[a-f0-9-]{36}$/);
    await expect(page).toHaveURL(new RegExp(`/github-apps/${state.app.id}$`));
    await expect(page.getByText('secret-value')).toHaveCount(0);
  });
}

for (const width of [1280, 320]) for (const locale of ['en', 'zh-CN'] as const) {
  test(`separate credential editors at ${width}px in ${locale}`, async ({ page }) => {
    const state = await install(page); state.app.version = '9007199254740993';
    state.app.name = 'Long application name '.repeat(8);
    state.app.webhookUrl = `https://${'long-host-name.'.repeat(10)}example.test/api/v1/github/apps/${appId}/webhook`;
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/github-apps/${appId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const names = locale === 'en'
      ? { key: 'Change private key', secret: 'Change Webhook secret', saveKey: 'Save private key', saveSecret: 'Save Webhook secret', label: 'Private key', cancel: 'Cancel', editName: 'Edit name', name: 'Registration name', saveName: 'Save name' }
      : { key: '更换私钥', secret: '更换 Webhook secret', saveKey: '保存私钥', saveSecret: '保存 Webhook secret', label: '私钥', cancel: '取消', editName: '修改名称', name: '登记名称', saveName: '保存名称' };
    const keyOpener = page.getByRole('button', { name: names.key }); await keyOpener.click();
    let dialog = page.getByRole('dialog'), key = dialog.getByLabel(names.label);
    await expect(key).toBeFocused(); await expect(dialog.getByLabel('Webhook secret')).toHaveCount(0);
    await page.keyboard.press('Shift+Tab'); await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await key.fill(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(500)}\n-----END PRIVATE KEY-----`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(keyOpener).toBeFocused();
    await keyOpener.click(); dialog = page.getByRole('dialog'); key = dialog.getByLabel(names.label); await expect(key).toHaveValue('');
    await key.fill('new-key'); await dialog.getByRole('button', { name: names.saveKey }).click(); await expect(dialog).toHaveCount(0);
    expect(state.writes[0]!.body).toEqual({ version: '9007199254740993', expectedUserId: actorId, privateKeyPem: 'new-key' });
    const secretOpener = page.getByRole('button', { name: names.secret }); await secretOpener.click(); dialog = page.getByRole('dialog');
    const secret = dialog.getByLabel('Webhook secret'); await expect(secret).toBeFocused(); await expect(dialog.getByLabel(names.label)).toHaveCount(0);
    await expect(secret).toHaveAttribute('type', 'password'); await expect(secret).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await secret.fill(' new-secret '); await dialog.getByRole('button', { name: names.saveSecret }).click(); await expect(dialog).toHaveCount(0);
    expect(state.writes[1]!.body).toEqual({ version: '9007199254740994', expectedUserId: actorId, webhookSecret: ' new-secret ' });
    await secretOpener.click(); await expect(page.getByRole('dialog').getByLabel('Webhook secret')).toHaveValue('');
    await page.getByRole('dialog').getByRole('button', { name: names.cancel, exact: true }).click(); await expect(secretOpener).toBeFocused();
    await page.getByRole('button', { name: names.editName }).click(); dialog = page.getByRole('dialog');
    await dialog.getByLabel(names.name).fill('Renamed'); await dialog.getByRole('button', { name: names.saveName }).click(); await expect(dialog).toHaveCount(0);
    expect(state.writes[2]!.body).toEqual({ version: '9007199254740995', expectedUserId: actorId, name: 'Renamed' });
  });
}

test('direct configuration and removal preserve privacy and exact versions', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await expect(page.getByRole('heading', { name: 'Platform App' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'App configuration' })).toBeVisible();
  await page.getByRole('button', { name: 'Edit name' }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByLabel('Private key')).toHaveCount(0);
  await expect(edit.getByLabel('Webhook secret')).toHaveCount(0);
  await edit.getByLabel('Registration name').fill('Updated App');
  await edit.getByRole('button', { name: 'Save name' }).click();
  await expect(edit).toHaveCount(0);
  expect(state.writes[0]!.body).toEqual({ version: '4', expectedUserId: actorId, name: 'Updated App' });
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Personal Team')).toBeVisible();
  await expect(dialog).toContainText('3'); await expect(dialog).toContainText('2 projects whose details are hidden');
  await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  await expect(dialog.getByText('https://github.com/example/visible')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete App and stop connections' }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]!.body).toEqual({ version: '5', impactVersion: '7', expectedUserId: actorId });
  await expect(page).toHaveURL(/\/github-apps$/);
  expect(state.removed).toBe(true);
});

test('conflict keeps the draft and unknown creation is never replayed', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Edit name' }).click();
  const edit = page.getByRole('dialog'); await edit.getByLabel('Registration name').fill('Draft name');
  state.mode = 'conflict'; await edit.getByRole('button', { name: 'Save name' }).click();
  await expect(edit).toContainText('The configuration or impact changed');
  await expect(edit.getByLabel('Registration name')).toHaveValue('Draft name');
  expect(state.writes).toHaveLength(1);
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'All GitHub Apps' }).click();
  state.mode = 'unknown'; await page.getByRole('button', { name: 'Register GitHub App' }).click();
  const create = page.getByRole('dialog'); await create.getByLabel('App ID').fill('42'); await create.getByLabel('Registration name').fill('Uncertain');
  await create.getByLabel('Private key').fill('key'); await create.getByLabel('Webhook secret').fill('secret');
  await create.getByRole('button', { name: 'Verify and register' }).click();
  await expect(create).toContainText('The result is unknown');
  await expect(create.getByRole('button', { name: 'Verify and register' })).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
});

test('foreground refresh keeps the draft and permission loss clears pending secrets', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Change Webhook secret' }).click();
  const dialog = page.getByRole('dialog'), secret = dialog.getByLabel('Webhook secret');
  await secret.fill('sensitive-draft'); await secret.focus();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const reads = state.reads; await page.bringToFront();
  await expect.poll(() => state.reads).toBeGreaterThan(reads);
  await expect(secret).toHaveValue('sensitive-draft'); await expect(secret).toBeFocused();
  const gate = Promise.withResolvers<void>(); state.holdPatch = gate.promise;
  await dialog.getByRole('button', { name: 'Save Webhook secret' }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  state.denied = true; await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await page.bringToFront(); await expect(dialog).toHaveCount(0);
  await expect(page.getByText('This App is unavailable or you do not have access.')).toBeVisible();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/github/apps/${appId}` && response.request().method() === 'PATCH');
  gate.resolve(); state.holdPatch = null; await response;
  await expect(page.getByText('Webhook secret saved.')).toHaveCount(0);
  await expect(page.getByText('sensitive-draft')).toHaveCount(0);
  await other.close();
});

test('returning to an App retains its visible draft until access is confirmed lost', async ({ page }) => {
  const state = await install(page); await page.goto('/github-apps');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Change Webhook secret' }).click();
  await page.getByRole('dialog').getByLabel('Webhook secret').fill('retained-secret');
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Manage' })).toBeVisible();
  const gate = Promise.withResolvers<void>(); state.holdAppRead = gate.promise; state.denied = true;
  const reads = state.reads; await page.getByRole('button', { name: 'Manage' }).click();
  await expect.poll(() => state.reads).toBeGreaterThan(reads);
  await expect(page.getByRole('heading', { name: 'Platform App' })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Webhook secret')).toHaveValue('retained-secret');
  await expect(page.getByRole('dialog').getByLabel('Webhook secret')).toBeEditable();
  gate.resolve(); state.holdAppRead = null;
  await expect(page.getByText('This App is unavailable or you do not have access.')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Webhook secret')).toHaveCount(0);
});

test('loading another project page removes projects whose access was revoked', async ({ page }) => {
  const state = await install(page); state.projectPagination = true; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  state.projectRevoked = true;
  await dialog.getByRole('button', { name: 'Load more' }).click();
  await expect(dialog.getByText('Other project')).toBeVisible();
  await expect(dialog.getByText('Visible project')).toHaveCount(0);
});

test('removal requires all Team summaries while project details remain optional', async ({ page }) => {
  const state = await install(page); state.teamPagination = true; state.projectPagination = true; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog'), confirm = dialog.getByRole('button', { name: 'Delete App and stop connections' });
  await expect(dialog.getByText('Personal Team')).toBeVisible(); await expect(confirm).toBeDisabled();
  await dialog.getByRole('button', { name: 'Load more' }).click();
  await expect(dialog.getByText('Engineering')).toBeVisible(); await expect(confirm).toBeEnabled();
  await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible(); await expect(confirm).toBeEnabled();
  await dialog.getByRole('button', { name: 'Load more' }).click();
  await expect(dialog.getByText('Other project')).toBeVisible(); await expect(confirm).toBeEnabled();
  expect(state.writes).toHaveLength(0);
});

test('project details remain visible during a foreground check and change after permission is lost', async ({ page }) => {
  const state = await install(page); state.projectPagination = true; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const gate = Promise.withResolvers<void>(); state.holdProjectRead = gate.promise;
  const reads = state.projectReads; await page.bringToFront(); await expect.poll(() => state.projectReads).toBeGreaterThan(reads);
  await expect(dialog.getByText('Visible project')).toBeVisible();
  await expect(dialog.getByText('https://github.com/example/visible')).toBeVisible();
  state.projectRevoked = true; gate.resolve(); state.holdProjectRead = null;
  await expect(dialog.getByText('Other project')).toBeVisible();
  await expect(dialog.getByText('Visible project')).toHaveCount(0); await other.close();
});

test('unknown deletion followed by 404 can be acknowledged without claiming success', async ({ page }) => {
  const state = await install(page); state.mode = 'unknown'; state.unknownRemoveCommitted = true; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete App and stop connections' }).click();
  await expect(dialog).toContainText('The result is unknown');
  await dialog.getByRole('button', { name: 'Review current state' }).click();
  await expect(page.getByText('This App is unavailable or you do not have access.')).toBeVisible();
  await expect(page.getByText('The current state was read; it cannot confirm the original operation.')).toBeVisible();
  await expect(page.getByText('App deleted.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish review and decide again' }).click();
  await expect(page.getByText('The result is unknown', { exact: false })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('confirmed App permission loss removes its cached list entry before a delayed list read', async ({ page }) => {
  const state = await install(page); await page.goto('/github-apps');
  await page.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByRole('heading', { name: 'Platform App' })).toBeVisible();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const gate = Promise.withResolvers<void>(); state.denied = true; state.holdListRead = gate.promise;
  await page.bringToFront(); await expect(page.getByText('This App is unavailable or you do not have access.')).toBeVisible();
  await page.getByRole('button', { name: 'All GitHub Apps' }).click();
  await expect(page.getByText('Platform App', { exact: true })).toHaveCount(0);
  gate.resolve(); state.holdListRead = null; await other.close();
});

test('deletion receipt remains visible when leaving the App during the request', async ({ page }) => {
  const state = await install(page); await page.goto('/github-apps'); await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  const gate = Promise.withResolvers<void>(); state.holdRemove = gate.promise;
  await dialog.getByRole('button', { name: 'Delete App and stop connections' }).click(); await expect.poll(() => state.writes.length).toBe(1);
  await page.goBack(); await expect(page).toHaveURL(/\/github-apps$/);
  gate.resolve(); state.holdRemove = null;
  await expect(page.getByText('App deleted.')).toBeVisible();
  expect(state.writes).toHaveLength(1);
});

test('project access revoked between the page and impact recheck never exposes its stale details', async ({ page }) => {
  const state = await install(page); state.projectPagination = true; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog.getByText('Personal Team')).toBeVisible();
  const gate = Promise.withResolvers<void>(); state.holdImpactRecheck = gate.promise;
  const reads = state.impactReads; await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect.poll(() => state.impactReads).toBeGreaterThan(reads);
  state.projectRevoked = true; gate.resolve(); state.holdImpactRecheck = null;
  await expect(dialog.getByText('Visible project')).toHaveCount(0);
  await expect(dialog.getByText('https://github.com/example/visible')).toHaveCount(0);
  await expect(dialog.getByRole('alert')).toBeVisible();
});

for (const code of ['github_unavailable', 'github_rate_limited'] as const) {
  test(`registration ${code} is a definite refusal with a retained draft and explicit retry`, async ({ page }) => {
    const state = await install(page); state.mode = code; await page.goto('/github-apps');
    await page.getByRole('button', { name: 'Register GitHub App' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('App ID').fill('42'); await dialog.getByLabel('Registration name').fill('Retry App');
    await dialog.getByLabel('Private key').fill('retry-private-key'); await dialog.getByLabel('Webhook secret').fill('retry-secret');
    await dialog.getByRole('button', { name: 'Verify and register' }).click();
    await expect(dialog).toContainText('The operation failed.');
    await expect(dialog.getByLabel('Private key')).toHaveValue('retry-private-key');
    await expect(dialog.getByLabel('Webhook secret')).toHaveValue('retry-secret');
    await expect(dialog.getByRole('button', { name: 'Verify and register' })).toBeEnabled();
    await expect(dialog).not.toContainText('The result is unknown'); expect(state.writes).toHaveLength(1);
    state.mode = 'ok'; await dialog.getByRole('button', { name: 'Verify and register' }).click();
    await expect.poll(() => state.writes.length).toBe(2);
    expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
    await expect(page).toHaveURL(new RegExp(`/github-apps/${state.app.id}$`));
  });

  test(`credential replacement ${code} is a definite refusal with a retained draft and explicit retry`, async ({ page }) => {
    const state = await install(page); state.mode = code; await page.goto(`/github-apps/${appId}`);
    await page.getByRole('button', { name: 'Change private key' }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Private key').fill('new-private-key');
    await dialog.getByRole('button', { name: 'Save private key' }).click();
    await expect(dialog).toContainText('The operation failed.');
    await expect(dialog.getByLabel('Private key')).toHaveValue('new-private-key');
    await expect(dialog.getByRole('button', { name: 'Save private key' })).toBeEnabled();
    await expect(dialog).not.toContainText('The result is unknown'); expect(state.writes).toHaveLength(1);
    state.mode = 'ok'; await dialog.getByRole('button', { name: 'Save private key' }).click();
    await expect(dialog).toHaveCount(0); expect(state.writes).toHaveLength(2);
    expect(state.writes[1]!.body).toEqual(state.writes[0]!.body);
    await expect(page.getByText('Private key saved.')).toBeVisible();
  });
}

test('unknown credential replacement does not offer replay', async ({ page }) => {
  const state = await install(page); state.mode = 'unknown'; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Change Webhook secret' }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Webhook secret').fill('uncertain-secret'); await dialog.getByRole('button', { name: 'Save Webhook secret' }).click();
  await expect(dialog).toContainText('The result is unknown');
  await expect(dialog.getByRole('button', { name: 'Save Webhook secret' })).toHaveCount(0);
  await expect(dialog.getByLabel('Webhook secret')).toHaveValue('uncertain-secret');
  expect(state.writes).toHaveLength(1);
});

test('an old metadata response cannot restore access after removal preview denies it', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Personal Team')).toBeVisible();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const gate = Promise.withResolvers<void>(); state.holdAppRead = gate.promise; state.impactDenied = true;
  const reads = state.reads, impacts = state.impactReads, returned = state.metadataReturned;
  const pendingRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/v1/github/apps/${appId}` && request.method() === 'GET');
  await page.bringToFront(); const metadataRequest = await pendingRequest; await expect.poll(() => state.reads).toBeGreaterThan(reads); await expect.poll(() => state.impactReads).toBeGreaterThan(impacts);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Platform App' })).toHaveCount(0);
  gate.resolve(); state.holdAppRead = null;
  await expect.poll(() => state.metadataReturned).toBeGreaterThan(returned);
  const metadataResponse = await metadataRequest.response();
  if (metadataResponse !== null) await metadataResponse.finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole('heading', { name: 'Platform App' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change Webhook secret' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('This App is unavailable or you do not have access.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading' })).toHaveCount(0);
  state.impactDenied = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('heading', { name: 'Platform App' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change Webhook secret' })).toBeEnabled();
  await other.close();
});

test('foreground metadata checks preserve the open editor, focus and selection throughout the wait', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Change Webhook secret' }).click();
  const dialog = page.getByRole('dialog'), secret = dialog.getByLabel('Webhook secret');
  await secret.fill('editable-secret'); await secret.focus(); await secret.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 7));
  const original = await secret.elementHandle(), originalDialog = await dialog.elementHandle();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const gate = Promise.withResolvers<void>(); state.holdAppRead = gate.promise;
  try {
    const reads = state.reads; const pendingRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/v1/github/apps/${appId}` && request.method() === 'GET');
    await page.bringToFront(); const metadataRequest = await pendingRequest; await expect.poll(() => state.reads).toBeGreaterThan(reads);
    await expect(dialog).toBeVisible(); await expect(secret).toBeVisible(); await expect(secret).toBeFocused(); await expect(secret).toBeEditable();
    await expect(secret).toHaveValue('editable-secret');
    expect(await secret.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 7]);
    expect(await secret.evaluate((node, previous) => node === previous, original)).toBe(true);
    expect(await dialog.evaluate((node, previous) => node === previous, originalDialog)).toBe(true);
    gate.resolve(); state.holdAppRead = null; const response = await metadataRequest.response(); if (response !== null) await response.finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(secret).toBeFocused(); await expect(secret).toHaveValue('editable-secret');
    expect(await secret.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 7]);
    expect(await secret.evaluate((node, previous) => node === previous, original)).toBe(true);
  } finally { gate.resolve(); await other.close(); }
});

test('returning to an unchanged App retains its editor and focus while metadata is pending', async ({ page }) => {
  const state = await install(page); await page.goto('/github-apps');
  await page.getByRole('button', { name: 'Manage' }).click();
  const opener = page.getByRole('button', { name: 'Change Webhook secret' });
  const originalOpener = await opener.elementHandle(); await opener.click();
  const dialog = page.getByRole('dialog'), secret = dialog.getByLabel('Webhook secret');
  await secret.fill('retained-draft'); await secret.focus(); await secret.evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 6));
  const original = await secret.elementHandle(), originalDialog = await dialog.elementHandle();
  await page.goBack(); await expect(page.getByRole('button', { name: 'Manage' })).toBeVisible();
  const gate = Promise.withResolvers<void>(); state.holdAppRead = gate.promise;
  try {
    const reads = state.reads; const pendingRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/v1/github/apps/${appId}` && request.method() === 'GET');
    await page.getByRole('button', { name: 'Manage' }).click(); const metadataRequest = await pendingRequest; await expect.poll(() => state.reads).toBeGreaterThan(reads);
    await expect(dialog).toBeVisible(); await expect(secret).toBeVisible(); await expect(secret).toBeEditable(); await expect(secret).toHaveValue('retained-draft');
    await expect(secret).toBeFocused();
    expect(await secret.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 6]);
    expect(await secret.evaluate((node, previous) => node === previous, original)).toBe(true);
    expect(await dialog.evaluate((node, previous) => node === previous, originalDialog)).toBe(true);
    gate.resolve(); state.holdAppRead = null; const response = await metadataRequest.response(); if (response !== null) await response.finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(secret).toBeFocused(); await expect(secret).toHaveValue('retained-draft');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(opener).toBeVisible(); await expect(opener).toBeFocused();
    expect(await opener.evaluate((node, previous) => node === previous, originalOpener)).toBe(true);
  } finally { gate.resolve(); }
});

test('closing an editor during a foreground metadata check retains the resulting admission', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Change Webhook secret' }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Webhook secret').fill('draft-to-cancel');
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const gate = Promise.withResolvers<void>(); state.holdAppRead = gate.promise;
  try {
    const reads = state.reads; await page.bringToFront(); await expect.poll(() => state.reads).toBeGreaterThan(reads);
    await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
    gate.resolve(); state.holdAppRead = null;
    await expect(page.getByRole('button', { name: 'Change Webhook secret' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Delete App', exact: true })).toBeEnabled();
    expect(state.writes).toHaveLength(0);
  } finally { gate.resolve(); await other.close(); }
});

test('returning during a write keeps focus within the retained editor', async ({ page }) => {
  const state = await install(page); await page.goto('/github-apps');
  await page.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Change Webhook secret' }).click();
  const dialog = page.getByRole('dialog'), secret = dialog.getByLabel('Webhook secret');
  await secret.fill('pending-secret'); await secret.focus();
  const gate = Promise.withResolvers<void>(); state.holdPatch = gate.promise;
  try {
    await dialog.getByRole('button', { name: 'Save Webhook secret' }).click();
    await expect.poll(() => state.writes.length).toBe(1); await expect(secret).toBeDisabled();
    await page.goBack(); await expect(page.getByRole('button', { name: 'Manage' })).toBeVisible();
    await page.getByRole('button', { name: 'Manage' }).click();
    await expect(dialog).toBeVisible(); await expect(secret).toBeDisabled();
    await expect.poll(() => dialog.evaluate(element => {
      const focused = document.activeElement;
      return focused instanceof HTMLElement && element.contains(focused) &&
        !focused.matches(':disabled, [aria-disabled="true"]') && !focused.closest('[hidden], [inert]') &&
        focused.getClientRects().length > 0;
    })).toBe(true);
    gate.resolve(); state.holdPatch = null;
    await expect(page.getByText('Webhook secret saved.')).toBeVisible();
  } finally { gate.resolve(); }
});

test('closing a removal preview isolates its delayed refresh from the next dialog', async ({ page }) => {
  const state = await install(page); await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const oldGate = Promise.withResolvers<void>(), newGate = Promise.withResolvers<void>();
  state.holdImpactRecheck = oldGate.promise;
  try {
    const impacts = state.impactReads;
    await page.bringToFront(); await expect.poll(() => state.impactReads).toBeGreaterThan(impacts);
    const projects = state.projectReads, returned = state.impactReturned;
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(dialog).toHaveCount(0);
    state.holdImpactRecheck = newGate.promise;
    const pendingRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/v1/github/apps/${appId}/removal-preview`);
    await page.getByRole('button', { name: 'Delete App', exact: true }).click();
    const newRequest = await pendingRequest; await expect.poll(() => state.impactReads).toBeGreaterThan(impacts + 1);
    oldGate.resolve(); await expect.poll(() => state.impactReturned).toBeGreaterThan(returned);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(state.projectReads).toBe(projects);
    newGate.resolve(); state.holdImpactRecheck = null;
    const response = await newRequest.response(); expect(response).not.toBeNull();
    if (response !== null) expect(await response.finished()).toBeNull();
    await expect(dialog.getByText('Personal Team')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete App and stop connections' })).toBeEnabled();
    expect(state.projectReads).toBe(projects);
  } finally { oldGate.resolve(); newGate.resolve(); await other.close(); }
});

test('changed hidden project count removes stale details before a delayed project recheck', async ({ page }) => {
  const state = await install(page); state.projectPagination = true; await page.goto(`/github-apps/${appId}`);
  await page.getByRole('button', { name: 'Delete App', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'View accessible projects' }).click();
  await expect(dialog.getByText('Visible project')).toBeVisible();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const gate = Promise.withResolvers<void>(); state.holdProjectRead = gate.promise; state.projectRevoked = true;
  try {
    const projects = state.projectReads, impacts = state.impactReturned;
    await page.bringToFront();
    await expect.poll(() => state.impactReturned).toBeGreaterThan(impacts);
    await expect.poll(() => state.projectReads).toBeGreaterThan(projects);
    await expect(dialog.getByText('Visible project')).toHaveCount(0);
    await expect(dialog.getByText('https://github.com/example/visible')).toHaveCount(0);
    gate.resolve(); state.holdProjectRead = null;
    await expect(dialog.getByText('Other project')).toBeVisible();
  } finally { gate.resolve(); await other.close(); }
});
