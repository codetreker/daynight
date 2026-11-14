import { expect, test, type Page, type Route } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000101';
const actorId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const team = { id: teamId, kind: 'personal', name: null };
const profile = { id: actorId, personalTeam: team, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const project = { id: projectId, name: 'Example project', repoUrl: 'https://github.com/example/project', ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const candidate = { installation: { id: '9007199254740993', accountLogin: 'different-account' }, repository: { id: '42', fullName: 'example/project', private: true } };
const baseStatus = () => ({ projectId, version: '1', revision: '0', serviceAvailable: true, syncEnabled: false, connection: 'not_connected', repository: null as typeof candidate.repository | null, installation: null as typeof candidate.installation | null,
  pollIntervalMinutes: 5, initializing: false,
  poll: { running: false, lastAttemptAt: null as string | null, lastSuccessAt: null as string | null, nextAttemptAt: null as string | null, error: null as {code: string; message: string; at: string} | null },
  webhook: { running: false, lastReceivedAt: null as string | null, lastAttemptAt: null as string | null, lastSuccessAt: null as string | null, error: null as {code: string; message: string; at: string} | null },
});
type State = { status: ReturnType<typeof baseStatus>; role: 'admin' | 'member'; holdMe: Promise<void> | null; holdAccess: Promise<void> | null; holdPatch: Promise<void> | null; conflict: boolean; unknown: boolean; failReconcile: boolean; failRead: boolean; requests: string[]; writes: { path: string; method: string; body: string; principal: string | null }[] };
const install = async (page: Page): Promise<State> => {
  const state: State = { status: baseStatus(), role: 'admin', holdMe: null, holdAccess: null, holdPatch: null, conflict: false, unknown: false, failReconcile: false, failRead: false, requests: [], writes: [] };
  const access = () => ({ projectId, ownerTeam: team, ownership: { teamId, version: 1n }, effectiveRole: state.role, teamRole: state.role === 'admin' ? 'admin' : null, canTransfer: state.role === 'admin',
    directGrant: { projectId, userId: actorId, role: state.role, version: 1n, createdAt: time, updatedAt: time } });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    state.requests.push(`${method} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId } });
    const error = (code: string) => ({ error: { code, message: code, requestId: 'test' } });
    if (path === '/api/v1/me') { if (state.holdMe) await state.holdMe; return send(profile); }
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(project);
    if (path === `/api/v1/projects/${projectId}/access`) { if (state.holdAccess) await state.holdAccess; return send(access()); }
    if (path === `/api/v1/me/projects/${projectId}/worker-prompt`) return send({ scope: 'project', scopeId: projectId, revision: '0', text: '', updatedAt: null });
    if (path === `/api/v1/projects/${projectId}/github`) return state.failRead ? send(error('internal_error'), 500) : send(state.status);
    if (path === `/api/v1/projects/${projectId}/pull-requests`) return send({ projectId, revision: state.status.revision, items: [], total: '0', counts: { active: '0', closed: '0', merged: '0', all: '0' }, nextCursor: null, previousCursor: null });
    if (path === `/api/v1/projects/${projectId}/github/installation`) return send(candidate);
    if (path.startsWith(`/api/v1/projects/${projectId}/github/`) && method !== 'GET') {
      const body = request.postData()!; state.writes.push({ path, method, body, principal: request.headers()['daynight-user-id'] ?? null });
      if (path.endsWith('/settings')) {
        if (state.holdPatch) await state.holdPatch;
        if (state.unknown) { state.failRead = state.failReconcile; state.status = { ...state.status, version: '2', revision: '1', pollIntervalMinutes: 12 }; return send(error('github_write_outcome_unknown'), 503); }
        if (state.conflict) { state.status = { ...state.status, version: '2', revision: '1', pollIntervalMinutes: 9 }; return send(error('version_conflict'), 409); }
        state.status = { ...state.status, version: String(BigInt(state.status.version) + 1n), revision: String(BigInt(state.status.revision) + 1n), pollIntervalMinutes: (JSON.parse(body) as {pollIntervalMinutes: number}).pollIntervalMinutes };
      } else if (path.endsWith('/sync')) {
        if (state.holdPatch) await state.holdPatch;
        if (state.unknown) { state.failRead = state.failReconcile; state.status = { ...state.status, version: '2', revision: '1', syncEnabled: true }; return send(error('github_write_outcome_unknown'), 503); }
        if (state.conflict) { state.status = { ...state.status, version: '2', revision: '1' }; return send(error('version_conflict'), 409); }
        state.status = { ...state.status, version: String(BigInt(state.status.version) + 1n), revision: String(BigInt(state.status.revision) + 1n), syncEnabled: (JSON.parse(body) as {syncEnabled: boolean}).syncEnabled };
      } else if (path.endsWith('/connect')) {
        state.status = { ...state.status, version: String(BigInt(state.status.version) + 1n), revision: String(BigInt(state.status.revision) + 1n), connection: 'connected', installation: candidate.installation, repository: candidate.repository, initializing: false };
      } else if (path.endsWith('/disconnect')) state.status = { ...state.status, version: String(BigInt(state.status.version) + 1n), revision: String(BigInt(state.status.revision) + 1n), connection: 'disconnected', syncEnabled: false, initializing: false };
      return send(state.status);
    }
    return send(error('not_found'), 404);
  });
  return state;
};
const open = async (page: Page) => {
  await page.goto(`/projects/${projectId}/settings?tab=github`);
  await expect(page.getByRole('heading', { name: 'GitHub PR sync' })).toBeVisible();
  await expect(page.getByLabel('Poll interval')).toHaveValue('5');
};
const background = async (page: Page): Promise<Page> => {
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
  await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await page.bringToFront(); return other;
};

test('connects the verified installation from a different account and retains the private sharing explanation', async ({ page }) => {
  const state = await install(page); await open(page);
  await page.getByRole('button', { name: 'Connect GitHub App' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub App' });
  await expect(dialog.getByLabel('Available App installation')).toHaveValue(candidate.installation.id);
  await expect(dialog.getByLabel('Available App installation')).toContainText('different-account');
  await expect(dialog).toContainText('shared under this Project’s permissions');
  await dialog.getByRole('button', { name: 'Connect GitHub App' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'PR sync' })).not.toBeChecked();
  await expect(page.getByText('Sync off', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toMatch(/Disconnect|GitHub PR sync/);
  expect(state.writes).toEqual([{ path: `/api/v1/projects/${projectId}/github/connect`, method: 'POST', body: '{"version":"1","installationId":"9007199254740993"}', principal: null }]);
  expect(state.requests.filter(value => value.endsWith('/github/installation'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const disconnect = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
  await disconnect.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(disconnect).toHaveCount(0);
  await expect(page.getByText('Saved data remains readable and will not be updated.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toMatch(/Reconnect|GitHub PR sync/);
  expect(state.writes[1]?.body).toBe('{"version":"2"}');
});

test('mobile background identity checks preserve focus and draft, and a pending save blocks connection management', async ({ page }) => {
  const state = await install(page); await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  const field = page.getByLabel('Poll interval'); await field.fill('12'); await field.focus();
  const access = Promise.withResolvers<void>(); state.holdAccess = access.promise;
  const before = state.requests.filter(x => x === `GET /api/v1/projects/${projectId}/access`).length;
  const other = await background(page);
  await expect.poll(() => state.requests.filter(x => x === `GET /api/v1/projects/${projectId}/access`).length).toBeGreaterThan(before);
  await expect(field).toBeFocused(); await expect(field).toHaveValue('12'); await expect(field).toBeEditable();
  access.resolve(); state.holdAccess = null;
  await expect(field).toBeFocused(); await expect(field).toHaveValue('12');
  const gate = Promise.withResolvers<void>(); state.holdPatch = gate.promise;
  await page.getByRole('button', { name: 'Save interval' }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Connect GitHub App' })).toBeDisabled();
  expect(state.writes[0]?.body).toBe('{"version":"1","pollIntervalMinutes":12}');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  gate.resolve(); state.holdPatch = null;
  await expect(page.getByText('Poll interval saved.')).toBeVisible();
  await expect(field).toBeFocused();
  await expect(page.getByRole('button', { name: 'Connect GitHub App' })).toBeEnabled();
  await other.close();
});

test('rejects invalid intervals, preserves conflicts, and responds to permission and sync status changes', async ({ page }) => {
  const state = await install(page); await open(page);
  const field = page.getByLabel('Poll interval');
  await field.fill(''); await expect(page.getByRole('button', { name: 'Save interval' })).toBeDisabled(); expect(state.writes).toHaveLength(0);
  await field.fill('0'); await expect(page.getByText('Enter a whole number from 1 to 2147483647 minutes.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save interval' })).toBeDisabled(); expect(state.writes).toHaveLength(0);
  state.conflict = true; await field.fill('14'); await page.getByRole('button', { name: 'Save interval' }).click();
  await expect(page.getByText('The configuration changed. Check the reread status; your draft is retained.')).toBeVisible();
  await expect(field).toHaveValue('14'); await expect(page.getByText(/Currently saved: 9 minutes/).first()).toBeVisible();
  state.conflict = false; state.role = 'member';
  const other = await background(page);
  await expect(page.getByText('You can view sync status. Project administrators manage the connection, sync switch and interval.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save interval' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect GitHub App' })).toHaveCount(0);
  await other.close();
});

test('distinguishes poll and webhook failures, unavailable access, disconnection, and an unconfigured service', async ({ page }) => {
  const state = await install(page);
  state.status = { ...baseStatus(), syncEnabled: true, connection: 'connected', installation: candidate.installation, repository: candidate.repository, version: '2', revision: '2',
    poll: { ...baseStatus().poll, error: { code: 'poll_failed', message: 'Polling failed', at: time } },
    webhook: { ...baseStatus().webhook, error: { code: 'hook_failed', message: 'Webhook failed', at: time } } };
  await open(page);
  await expect(page.getByText('Polling failed (poll_failed)')).toBeVisible();
  await expect(page.getByText('Webhook failed (hook_failed)')).toBeVisible();
  state.status = { ...state.status, connection: 'unavailable', revision: '3', poll: baseStatus().poll, webhook: baseStatus().webhook };
  await page.reload();
  await expect(page.getByText('The GitHub App cannot read this repository. Restore access or reconnect.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  state.status = { ...state.status, connection: 'disconnected', syncEnabled: false, version: '3', revision: '4' };
  await page.reload();
  await expect(page.getByText('Saved data remains readable and will not be updated.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  state.status = { ...baseStatus(), serviceAvailable: false };
  await page.reload();
  await expect(page.getByText('GitHub App is not configured on this service.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect GitHub App' })).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: 'GitHub PR 同步' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('background changes preserve a draft and require a decision before overwriting a newer version', async ({ page }) => {
  const state = await install(page); await open(page);
  const field = page.getByLabel('Poll interval'); await field.fill('14'); await field.focus();
  state.status = { ...state.status, version: '2', revision: '1', pollIntervalMinutes: 9 };
  const reads = state.requests.filter(x => x === `GET /api/v1/projects/${projectId}/github`).length;
  const other = await background(page);
  await expect.poll(() => state.requests.filter(x => x === `GET /api/v1/projects/${projectId}/github`).length).toBeGreaterThan(reads);
  await expect(field).toBeFocused(); await expect(field).toHaveValue('14');
  await expect(page.getByText(/Currently saved: 9 minutes/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save interval' })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await other.close();
});


test('an unknown write outcome rereads without replaying and keeps the submitted draft', async ({ page }) => {
  const state = await install(page); await open(page); state.unknown = true;
  const field = page.getByLabel('Poll interval'); await field.fill('12');
  const reads = state.requests.filter(x => x === `GET /api/v1/projects/${projectId}/github`).length;
  await page.getByRole('button', { name: 'Save interval' }).click();
  await expect(page.getByText('The write outcome is unknown. Check the reread status before deciding whether to retry.')).toBeVisible();
  await expect.poll(() => state.requests.filter(x => x === `GET /api/v1/projects/${projectId}/github`).length).toBeGreaterThan(reads);
  await expect(field).toHaveValue('12');
  expect(state.writes).toHaveLength(1);
});


for (const { name, connection, serviceAvailable } of [
  { name: 'revoked repository access', connection: 'unavailable', serviceAvailable: true },
  { name: 'unconfigured service', connection: 'connected', serviceAvailable: false },
] as const) {
  test(`disconnects with ${name} without discovering an installation`, async ({ page }) => {
    const state = await install(page);
    state.status = { ...baseStatus(), connection, serviceAvailable, installation: candidate.installation, repository: candidate.repository, version: '2', revision: '2' };
    await open(page);
    if (!serviceAvailable) await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved data remains readable and will not be updated.')).toBeVisible();
    expect(state.writes.map(({path, body}) => ({path, body}))).toEqual([{path: `/api/v1/projects/${projectId}/github/disconnect`, body: '{"version":"2"}'}]);
    expect(state.requests.filter(value => value.endsWith('/github/installation'))).toHaveLength(0);
    if (!serviceAvailable) await expect(page.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
  });
}

test('failed reconciliation retains the management lock until a successful reread', async ({ page }) => {
  const state = await install(page); await open(page);
  await page.getByRole('link', { name: 'Execution & alerts' }).click();
  const projectField = page.getByLabel('Alert threshold'); await projectField.fill('75');
  const projectSave = page.getByRole('button', { name: 'Save settings' });
  await expect(projectSave).toBeEnabled();
  await page.getByRole('link', { name: 'Project management' }).click();
  const deletion = page.getByRole('button', { name: 'Delete project', exact: true });
  await expect(deletion).toBeEnabled();
  await page.getByRole('link', { name: 'GitHub integration' }).click();
  state.unknown = true; state.failReconcile = true;
  await page.getByLabel('Poll interval').fill('12'); await page.getByRole('button', { name: 'Save interval' }).click();
  await expect(page.getByText('Unable to read GitHub sync status.')).toBeVisible();
  await page.getByRole('link', { name: 'Execution & alerts' }).click(); await expect(projectSave).toBeDisabled();
  await page.getByRole('link', { name: 'Project management' }).click(); await expect(deletion).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.getByRole('link', { name: 'GitHub integration' }).click();
  await expect(page.getByText('Unable to read GitHub sync status.')).toBeVisible();
  state.failRead = false;
  await page.locator('.github-settings').getByRole('button', { name: 'Retry' }).first().click();
  await page.getByRole('link', { name: 'Execution & alerts' }).click(); await expect(projectSave).toBeEnabled();
  await page.getByRole('link', { name: 'Project management' }).click(); await expect(deletion).toBeEnabled();
  expect(state.writes).toHaveLength(1);
});


test('switch writes independently of the interval draft and retains server confirmation during the request', async ({ page }) => {
  const state = await install(page);
  state.status = { ...baseStatus(), connection: 'connected', installation: candidate.installation, repository: candidate.repository };
  await page.setViewportSize({ width: 320, height: 720 }); await open(page);
  const field = page.getByLabel('Poll interval'), toggle = page.getByRole('switch', { name: 'PR sync' });
  await field.fill('12'); const gate = Promise.withResolvers<void>(); state.holdPatch = gate.promise;
  await toggle.click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]?.body).toBe('{"version":"1","syncEnabled":true}');
  await expect(toggle).not.toBeChecked(); await expect(toggle).toHaveAttribute('aria-disabled', 'true'); await expect(toggle).toHaveAttribute('aria-busy', 'true'); await expect(toggle).toBeFocused();
  gate.resolve(); state.holdPatch = null; await expect(toggle).toBeChecked(); await expect(toggle).toBeFocused(); await expect(field).toHaveValue('12');
  await expect(page.getByRole('button', { name: 'Save interval' })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await expect(page.getByRole('switch', { name: 'PR 同步' })).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an unknown switch write retains the guard until reread and is not replayed', async ({ page }) => {
  const state = await install(page); state.status = { ...baseStatus(), connection: 'connected', installation: candidate.installation, repository: candidate.repository };
  await open(page); state.unknown = true; state.failReconcile = true;
  await page.getByLabel('Poll interval').fill('12'); await page.getByRole('switch', { name: 'PR sync' }).click();
  await expect(page.getByText('Unable to read GitHub sync status.')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'PR sync' })).toBeDisabled();
  await expect(page.getByLabel('Poll interval')).toHaveValue('12'); expect(state.writes).toHaveLength(1);
  state.failRead = false; await page.locator('.github-settings').getByRole('button', { name: 'Retry' }).first().click();
  await expect(page.getByRole('switch', { name: 'PR sync' })).toBeChecked(); expect(state.writes).toHaveLength(1);
});
