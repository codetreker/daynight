import { expect, test, type Page, type Route } from '@playwright/test';

const projectId = '00000000-0000-4000-8000-000000000101';
const actorId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const sourceId = '00000000-0000-4000-8000-000000000021';
const targetId = '00000000-0000-4000-8000-000000000031';
const time = '2026-10-20T09:00:00Z';
const personal = { id: personalId, kind: 'personal', name: null };
const source = { id: sourceId, kind: 'ordinary', name: 'Source Team' };
const target = { id: targetId, kind: 'ordinary', name: 'Destination Team' };
const profile = { id: actorId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
const rawJson = JSON as unknown as { rawJSON: (text: string) => unknown };
type State = {
  directOnly: boolean; actorLost: boolean; loseResponse: boolean; conflict: boolean;
  retainAccess: boolean; transferred: boolean; sourceRead: 'ok' | 'missing' | 'network';
  forbidden: boolean; hold: Promise<void> | null;
  targetVersion: bigint; requests: string[]; writes: string[]; previews: string[];
};

const install = async (page: Page): Promise<State> => {
  const state: State = { directOnly: false, actorLost: false, loseResponse: false, conflict: false, retainAccess: false, transferred: false, sourceRead: 'ok', forbidden: false, hold: null, targetVersion: 9007199254740993n, requests: [], writes: [], previews: [] };
  const ownership = { teamId: sourceId, version: 1n };
  const grant = { projectId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time };
  const access = () => state.transferred ? { projectId, ownerTeam: target, ownership: { teamId: targetId, version: 2n }, effectiveRole: 'admin', teamRole: null, canTransfer: false, directGrant: grant } : { projectId, ownerTeam: source, ownership, effectiveRole: 'admin', teamRole: state.directOnly ? null : 'admin', canTransfer: !state.directOnly, directGrant: state.directOnly || state.retainAccess ? grant : null };
  const team = (ref: typeof source | typeof personal) => ({ ...ref, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: ref.id, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
  const project = { id: projectId, name: 'Transfer project', repoUrl: 'https://github.com/example/repo', createdAt: time, updatedAt: time, ownership, settings: { version: 1n, executionWarningMinutes: 60 } };
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    state.requests.push(`${method} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Daynight-User-ID': actorId }, body: JSON.stringify(body, (_key, value: unknown) => typeof value === 'bigint' ? rawJson.rawJSON(value.toString()) : value) });
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [team(personal), team(source)], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team(personal));
    if (path === `/api/v1/teams/${sourceId}`) {
      if (state.sourceRead === 'network') return route.abort('failed');
      if (state.sourceRead === 'missing') return send(error('not_found'), 404);
      return send(team(source));
    }
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/access`) return state.actorLost ? send(error('not_found'), 404) : send(access());
    if (path === `/api/v1/projects/${projectId}`) return state.actorLost ? send(error('not_found'), 404) : send(project);
    if (path === `/api/v1/projects/${projectId}/transfer-preview`) {
      state.previews.push(request.postData()!);
      if (state.actorLost) return send(error('not_found'), 404);
      return send({ sourceTeam: source, targetTeam: { ...target, version: state.targetVersion }, ownership, actorRole: state.retainAccess ? 'admin' : null });
    }
    if (path === `/api/v1/projects/${projectId}/transfer`) {
      state.writes.push(request.postData()!);
      if (state.hold !== null) await state.hold;
      if (state.forbidden) { state.directOnly = true; return send(error('forbidden'), 403); }
      if (state.conflict) { state.targetVersion++; return send(error('version_conflict'), 409); }
      state.actorLost = !state.retainAccess; state.transferred = true;
      if (state.loseResponse) return route.abort('failed');
      return send({ projectId, changed: true, sourceTeam: source, ownerTeam: target, ownership: { teamId: targetId, version: 2n }, actorAccess: state.retainAccess ? access() : null });
    }
    return send(error('not_found'), 404);
  });
  return state;
};

const start = async (page: Page) => {
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByRole('button', { name: 'Transfer project', exact: true })).toBeVisible();
};

const open = async (page: Page) => {
  const button = page.getByRole('button', { name: 'Transfer project', exact: true });
  await expect(button).toBeEnabled(); await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Team ID or link')).toBeFocused();
  return dialog;
};
const preview = async (page: Page, targetValue = targetId) => {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Team ID or link').fill(targetValue);
  await expect(dialog.getByRole('button', { name: 'Preview', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByText('Destination Team', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm transfer' })).toBeEnabled();
  return dialog;
};

test('project-only admin cannot transfer and the existing alert setting remains usable', async ({ page }) => {
  const state = await install(page); state.directOnly = true;
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByText('Only an admin of the owner Team can transfer this project.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Transfer project', exact: true })).toHaveCount(0);
  await expect(page.getByRole('spinbutton')).toBeEnabled();
  await expect(page.locator('.project-settings-panel')).toHaveCount(1);
  await expect(page.locator('.project-settings-panel').getByRole('spinbutton')).toBeVisible();
  await expect(page.locator('.project-ownership-panel')).toHaveCount(1);
  await expect(page.locator('.project-ownership-panel').getByRole('heading', { name: 'Project ownership' })).toBeVisible();
  expect(state.previews).toHaveLength(0); expect(state.writes).toHaveLength(0);
});

test('rejects foreign links, cancels without a write, and uses the loss-of-access receipt to return to the source Team', async ({ page }) => {
  const state = await install(page); await start(page);
  const opener = page.getByRole('button', { name: 'Transfer project', exact: true });
  let dialog = await open(page);
  await dialog.getByLabel('Team ID or link').fill(`https://foreign.example/teams/${targetId}`);
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('valid Team ID');
  expect(state.previews).toHaveLength(0);
  dialog = await preview(page, `${new URL(page.url()).origin}/teams/${targetId}`);
  await expect(dialog).toContainText('Direct project grants and existing project invitations remain unchanged');
  await expect(dialog).toContainText('lose access');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused(); expect(state.writes).toHaveLength(0);
  await open(page); dialog = await preview(page);
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Project transferred to Destination Team.' })).toContainText('no longer have access');
  await expect(page).toHaveURL(new RegExp(`/teams/${sourceId}$`));
  expect(state.writes).toEqual([`{"ownership":{"teamId":"${sourceId}","version":1},"targetTeam":{"id":"${targetId}","version":9007199254740993},"expectedUserId":"${actorId}"}`]);
});

test('conflict requires a new preview and a lost response followed by 404 stays unknown', async ({ page }) => {
  const state = await install(page); await start(page); await open(page);
  let dialog = await preview(page);
  state.conflict = true;
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(dialog.getByText(/ownership or target Team changed/i).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm transfer' })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  state.conflict = false; state.loseResponse = true;
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Confirm transfer' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(dialog.getByRole('alert').first()).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Check current state' }).click();
  await expect(dialog.getByText('The project is currently unavailable. The original transfer result remains unknown.')).toBeVisible();
  await expect(dialog.getByRole('alert').first()).toContainText('result is unknown');
  expect(state.writes).toHaveLength(2); expect(state.previews).toHaveLength(2);
});

test('narrow dialog supports bilingual labels, focus trapping and cancellation', async ({ page }) => {
  const state = await install(page); await page.setViewportSize({ width: 375, height: 667 }); await start(page);
  const dialog = await open(page);
  await dialog.getByRole('combobox').first().selectOption('zh-CN');
  await expect(dialog.getByRole('heading', { name: '转移项目' })).toBeVisible();
  await expect(dialog.getByLabel('目标 Team ID 或链接')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0); expect(state.writes).toHaveLength(0);
});

test('retained direct access keeps the project open with the receipt owner', async ({ page }) => {
  const state = await install(page); state.retainAccess = true;
  await start(page); await open(page); const dialog = await preview(page);
  await expect(dialog).toContainText('Your project access after transfer');
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Project transferred to Destination Team.' })).toContainText('Administrator');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`));
  await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Project ownership' }) })).toContainText('Destination Team');
  expect(state.writes).toHaveLength(1);
});

test('network failure checking source preserves success and retries; confirmed source loss returns to Personal', async ({ page }) => {
  const state = await install(page); await start(page); await open(page); const dialog = await preview(page);
  state.sourceRead = 'network';
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  const notice = page.getByRole('status').filter({ hasText: 'Project transferred to Destination Team.' });
  await expect(notice).toContainText('no longer have access');
  await expect(notice.getByRole('alert')).toContainText('transfer succeeded');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`));
  state.sourceRead = 'missing'; await notice.getByRole('button', { name: 'Retry' }).click();
  await expect(page).toHaveURL(new RegExp(`/teams/${personalId}$`));
  await expect(notice).toContainText('Project transferred to Destination Team.');
  expect(state.writes).toHaveLength(1);
});

test('a 403 after source admin loss refreshes access and invalidates the old confirmation', async ({ page }) => {
  const state = await install(page); await start(page); await open(page); const dialog = await preview(page);
  const previousReads = state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/access`).length;
  state.forbidden = true; await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect(dialog.getByRole('alert').last()).toContainText('no longer an admin of the source Team');
  await expect.poll(() => state.requests.filter((value) => value === `GET /api/v1/projects/${projectId}/access`).length).toBeGreaterThan(previousReads);
  await expect(dialog.getByRole('button', { name: 'Confirm transfer' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(1);
});

test('leaving during a submitted transfer and returning retains an unknown result without replay', async ({ page }) => {
  const state = await install(page);
  await page.goto('/projects');
  await page.evaluate((path) => { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/projects/${projectId}/settings`);
  await expect(page.getByRole('button', { name: 'Transfer project', exact: true })).toBeVisible();
  await open(page); const dialog = await preview(page);
  const gate = Promise.withResolvers<void>(); state.hold = gate.promise; state.loseResponse = true;
  await dialog.getByRole('button', { name: 'Confirm transfer' }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await page.goBack(); await expect(page).toHaveURL(/\/projects$/);
  gate.resolve(); await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`));
  const resumed = page.getByRole('dialog');
  await expect(resumed.getByRole('alert').first()).toContainText('result is unknown');
  await resumed.getByRole('button', { name: 'Check current state' }).click();
  await expect(resumed.getByText('The project is currently unavailable. The original transfer result remains unknown.')).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
