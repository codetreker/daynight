import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000101';
const actorId = '00000000-0000-4000-8000-000000000001';
const teamId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const appId = '00000000-0000-4000-8000-000000000021';
const grantId = '00000000-0000-4000-8000-000000000022';
const app = { id: appId, githubAppId: '13', name: 'Example App', githubSlug: 'example-app' };
const grant = { grantId, app: { ...app, version: '1' }, createdAt: time };
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
    if (path === `/api/v1/teams/${teamId}/github/apps`) return send({ items: [grant], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: actorId, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(project);
    if (path === `/api/v1/projects/${projectId}/access`) { if (state.holdAccess) await state.holdAccess; return send(access()); }
    if (path === `/api/v1/me/projects/${projectId}/worker-prompt`) return send({ scope: 'project', scopeId: projectId, revision: '0', text: '', updatedAt: null });
    const status = () => ({ ...state.status, canManageConnection: state.role === 'admin', app: state.status.connection === 'connected' || state.status.connection === 'unavailable' ? app : null, grantId: state.status.connection === 'connected' || state.status.connection === 'unavailable' ? grantId : null });
    if (path === `/api/v1/projects/${projectId}/github`) return state.failRead ? send(error('internal_error'), 500) : send(status());
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
      } else if (path.endsWith('/disconnect')) state.status = { ...state.status, version: String(BigInt(state.status.version) + 1n), revision: String(BigInt(state.status.revision) + 1n), connection: 'disconnected', installation: null, syncEnabled: false, initializing: false };
      return send(status());
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

const expectRepositoryActionsInsidePanel = async (page: Page) => {
  const row = page.locator('.github-repository');
  await expect(row).toBeVisible();
  const geometry = await row.evaluate(element => {
    const panel = element.closest('.panel-body')!;
    const bounds = panel.getBoundingClientRect(), style = getComputedStyle(panel);
    const left = bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const right = bounds.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const buttons = [...element.querySelectorAll('button')].map(button => {
      const box = button.getBoundingClientRect();
      let unclipped = box.left >= 0 && box.right <= innerWidth;
      for (let ancestor = button.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).overflowX !== 'visible') {
          const clip = ancestor.getBoundingClientRect();
          unclipped &&= box.left >= clip.left - 1 && box.right <= clip.right + 1;
        }
      }
      return { label: button.textContent, left: box.left, right: box.right, textFits: button.scrollWidth <= button.clientWidth, unclipped };
    });
    const name = element.querySelector('.github-repository-name strong')!;
    return { left, right, width: right - left, direction: getComputedStyle(element).flexDirection,
      repositoryFits: name.getBoundingClientRect().left >= left - 1 && name.getBoundingClientRect().right <= right + 1, buttons };
  });
  expect(geometry.repositoryFits).toBe(true);
  expect(geometry.buttons.length).toBeGreaterThan(0);
  for (const button of geometry.buttons) {
    expect(button.left, button.label ?? '').toBeGreaterThanOrEqual(geometry.left - 1);
    expect(button.right, button.label ?? '').toBeLessThanOrEqual(geometry.right + 1);
    expect(button.textFits, button.label ?? '').toBe(true);
    expect(button.unclipped, button.label ?? '').toBe(true);
  }
  return geometry;
};

const cancelConnectionDialog = async (page: Page, opener: Locator, keyboard: boolean) => {
  if (keyboard) { await opener.focus(); await page.keyboard.press('Enter'); }
  else await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (keyboard) await page.keyboard.press('Escape');
  else await dialog.locator('[data-dialog-cancel]').click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
};

for (const locale of ['en', 'zh-CN'] as const) {
  test(`repository layout follows its content width in ${locale}`, async ({ page }, testInfo) => {
    const state = await install(page);
    state.status = { ...baseStatus(), connection: 'connected', installation: candidate.installation,
      repository: { ...candidate.repository, fullName: `platform-engineering/${'long-name-'.repeat(12)}client` } };
    await page.setViewportSize({ width: 1360, height: 900 }); await open(page);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const container = page.locator('.github-settings > .panel-body');
    const observations = [];
    // Restrict the real component's available size without changing its layout rules.
    for (const width of [481, 480, 479, 640]) {
      await container.evaluate((element, contentWidth) => {
        (element as HTMLElement).style.boxSizing = 'content-box';
        (element as HTMLElement).style.width = `${contentWidth}px`;
      }, width);
      const geometry = await expectRepositoryActionsInsidePanel(page);
      expect(geometry.width).toBeCloseTo(width, 0);
      expect(geometry.direction).toBe(width <= 480 ? 'column' : 'row');
      observations.push(geometry);
      await cancelConnectionDialog(page, page.locator('#github-connection-action'), true);
    }
    expect(state.writes).toHaveLength(0);
    await testInfo.attach('repository-container-geometry', { contentType: 'application/json', body: JSON.stringify(observations) });
  });
  for (const width of [320, 375, 390, 768, 1360]) {
    test(`repository connection actions stay reachable at ${width}px in ${locale}`, async ({ page }, testInfo) => {
      const state = await install(page);
      const fullName = `platform-engineering/${'long-repository-name-'.repeat(8)}client`;
      await page.route(url => url.pathname === `/api/v1/projects/${projectId}`, route => route.fulfill({
        body: stringifyWireJson({ ...project, repoUrl: `https://github.com/${fullName}` }),
        headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId },
      }));
      await page.route(url => url.pathname === `/api/v1/teams/${teamId}/github/apps`, route => route.fulfill({
        body: stringifyWireJson({ items: state.status.connection === 'not_connected' ? [] : [grant], nextCursor: null }),
        headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': actorId },
      }));
      await page.setViewportSize({ width, height: 900 }); await open(page);
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const observations = [];
      for (const connection of ['not_connected', 'connected', 'unavailable'] as const) {
        state.status = { ...baseStatus(), connection, repository: connection === 'not_connected' ? null : { ...candidate.repository, fullName },
          installation: connection === 'not_connected' ? null : candidate.installation };
        await page.reload();
        const actions = page.locator('.github-repository-actions button');
        await expect(actions).toHaveCount(connection === 'not_connected' ? 1 : 2);
        observations.push({ connection, ...await expectRepositoryActionsInsidePanel(page) });
        const opener = actions.first();
        if (width === 768 && locale === 'en' && connection === 'not_connected') {
          await page.locator('#github-settings-title').focus();
          await page.keyboard.press('Tab');
          await expect(opener).toBeFocused();
        } else await opener.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        if (connection === 'not_connected') {
          await expect(dialog.locator('#github-app-grant')).toHaveCount(0);
          await expect(dialog.locator('.button.primary')).toBeDisabled();
          await expect(dialog.getByText(teamId, { exact: true })).toBeVisible();
        } else {
          await expect(dialog.locator('#github-app-grant')).toBeEnabled();
          await dialog.locator('#github-app-grant').selectOption(grantId);
          await expect(dialog.locator('#github-installation')).toHaveValue(candidate.installation.id);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
        await cancelConnectionDialog(page, opener, false);
        if (connection !== 'not_connected') await cancelConnectionDialog(page, actions.last(), false);
      }
      if (width <= 740) {
        const opener = page.getByRole('button', { name: locale === 'en' ? 'Open navigation' : '打开导航', exact: true });
        await opener.click();
        await expect(page.locator('#workspace-sidebar')).toBeVisible();
        await expect(page.locator('#workspace-sidebar')).toHaveAttribute('role', 'dialog');
        await expect(page.locator('#workspace-sidebar')).toHaveAttribute('aria-modal', 'true');
        await page.keyboard.press('Escape');
        await expect(page.locator('#workspace-sidebar')).toBeHidden();
        await expect(opener).toBeFocused();
      } else {
        const toggle = page.locator('.sidebar-toggle');
        const expanded = await toggle.getAttribute('aria-expanded');
        expect(['true', 'false']).toContain(expanded);
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
      }
      observations.push({ sidebarToggled: true, ...await expectRepositoryActionsInsidePanel(page) });
      await cancelConnectionDialog(page, page.locator('#github-connection-action'), true);
      expect(state.writes).toHaveLength(0);
      await testInfo.attach('repository-action-geometry', { contentType: 'application/json', body: JSON.stringify(observations) });
    });
  }
}

for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
  test(`native installation menu cancellation preserves confirmation at ${width}px in ${locale}`, async ({ page }, testInfo) => {
    const state = await install(page);
    const accountLogin = 'installation-' + 'platform-engineering-'.repeat(8);
    await page.route(url => url.pathname === `/api/v1/projects/${projectId}/github/installation`, route => route.fulfill({ json: { ...candidate, installation: { ...candidate.installation, accountLogin } }, headers: { 'Daynight-User-ID': actorId } }));
    await page.setViewportSize({ width, height: 900 }); await open(page);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const heading = page.getByRole('heading', { name: locale === 'en' ? 'GitHub PR sync' : 'GitHub PR 同步' });
    await expect(heading).toBeVisible();
    await expect(heading.locator('..').locator('p')).toHaveCount(0);
    await expect(page.getByText('Sync PR information and descriptions for this repository.', { exact: true })).toHaveCount(0);
    await expect(page.getByText('同步此仓库的 PR 基本信息与 description。', { exact: true })).toHaveCount(0);
    const opener = page.getByRole('button', { name: locale === 'en' ? 'Connect GitHub App' : '连接 GitHub App' });
    await opener.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(locale === 'en' ? 'Authorized App' : '获授权 App').selectOption(grantId);
    const select = dialog.locator('#github-installation');
    await expect(select).toHaveValue(candidate.installation.id); await expect(select.locator('option')).toHaveCount(1);
    await expect(select.locator('option')).toHaveText(accountLogin);
    const geometry = await select.evaluate(element => {
      const control = element.getBoundingClientRect(), wrapper = element.parentElement!, arrow = wrapper.querySelector('svg')!.getBoundingClientRect();
      return { width: control.width, fieldWidth: wrapper.parentElement!.clientWidth, height: control.height, arrowInset: control.right - arrow.right, arrowOffset: arrow.top + arrow.height / 2 - control.top - control.height / 2, textOverflow: getComputedStyle(element).textOverflow };
    });
    expect(geometry.height).toBe(38); expect(Math.abs(geometry.width - geometry.fieldWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry.arrowInset - 12)).toBeLessThanOrEqual(1); expect(Math.abs(geometry.arrowOffset)).toBeLessThanOrEqual(1);
    expect(geometry.textOverflow).toBe('ellipsis');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach('select-geometry', { contentType: 'application/json', body: JSON.stringify(geometry) });
    await page.screenshot({ path: testInfo.outputPath('installation-select.png') });
    const arrow = await select.locator('..').locator('svg').boundingBox();
    await page.mouse.click(arrow!.x + arrow!.width / 2, arrow!.y + arrow!.height / 2);
    await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(false);
    await expect(dialog).toBeVisible(); await expect(select).toBeFocused();
    await expect(select).toHaveValue(candidate.installation.id); expect(state.writes).toHaveLength(0);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    expect(state.writes).toHaveLength(0);
  });
}

test('connects the verified installation from a different account and retains the private sharing explanation', async ({ page }) => {
  const state = await install(page); await open(page);
  await page.getByRole('button', { name: 'Connect GitHub App' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub App' });
  await dialog.getByLabel('Authorized App').selectOption(grantId);
  await expect(dialog.getByLabel('Available App installation')).toHaveValue(candidate.installation.id);
  await expect(dialog.getByLabel('Available App installation')).toContainText('different-account');
  await expect(dialog).toContainText('shared under this Project’s permissions');
  await dialog.getByRole('button', { name: 'Connect GitHub App' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'PR sync' })).not.toBeChecked();
  await expect(page.getByText('Sync off', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toMatch(/Change connection|GitHub PR sync/);
  expect(state.writes).toEqual([{ path: `/api/v1/projects/${projectId}/github/connect`, method: 'POST', body: JSON.stringify({ version: '1', ownershipVersion: '1', appResourceId: appId, appVersion: '1', grantId, installationId: '9007199254740993' }), principal: null }]);
  expect(state.requests.filter(value => value.endsWith('/github/installation'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const disconnect = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
  await disconnect.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(disconnect).toHaveCount(0);
  await expect(page.getByText('Saved data remains readable and will not be updated.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toMatch(/Reconnect|GitHub PR sync/);
  expect(state.writes[1]?.body).toBe('{"version":"2","ownershipVersion":"1"}');
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
  await expect(page.locator('.github-sync-readonly')).toHaveText('Disabled');
  await expect(page.getByRole('switch', { name: 'PR sync' })).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: 'Connect GitHub App' })).toBeVisible();
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
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect GitHub?' });
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved data remains readable and will not be updated.')).toBeVisible();
    expect(state.writes.map(({path, body}) => ({path, body}))).toEqual([{path: `/api/v1/projects/${projectId}/github/disconnect`, body: '{"version":"2","ownershipVersion":"1"}'}]);
    expect(state.requests.filter(value => value.endsWith('/github/installation'))).toHaveLength(0);
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

for (const locale of ['en', 'zh-CN'] as const) {
  test(`connected sync controls omit redundant explanations in ${locale}`, async ({ page }) => {
    const state = await install(page);
    state.status = { ...baseStatus(), connection: 'connected', installation: candidate.installation, repository: candidate.repository };
    await open(page);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const panel = page.locator('.github-settings');
    const toggle = panel.getByRole('switch', { name: locale === 'en' ? 'PR sync' : 'PR 同步', exact: true });
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const text of [
        'Team administrators manage the connection; Project administrators manage sync and polling.',
        'Periodic polling and Webhook updates',
        'Team 管理员管理连接；项目管理员管理同步和轮询间隔。',
        '周期轮询与 Webhook 更新',
      ]) await expect(panel.getByText(text, { exact: true })).toHaveCount(0);
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: width === 1280 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(state.writes.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `/api/v1/projects/${projectId}/github/sync`, body: '{"version":"1","syncEnabled":true}' },
      { path: `/api/v1/projects/${projectId}/github/sync`, body: '{"version":"2","syncEnabled":false}' },
    ]);
  });
}

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

test('mounts the Team authorization projection and keeps Personal Team navigation reachable', async ({ page }) => {
  const state = await install(page);
  for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/projects');
    if (width <= 740) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('link', { name: 'GitHub Apps', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/teams/${teamId}/github-apps$`));
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await expect(page.getByRole('heading', { name: locale === 'en' ? 'Available GitHub Apps' : '可用的 GitHub Apps' })).toBeVisible();
    await expect(page.getByText('Example App', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByText('Example App', { exact: true })).toBeVisible();
  }
  expect(state.writes).toHaveLength(0);
});

test('GitHub settings input uses the shared responsive text at the real route', async ({ page }) => {
  await install(page); await open(page);
  const input = page.getByLabel('Poll interval');
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const root of [12, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
      await expect(input).toHaveCSS('font-size', `${width === 320 ? Math.max(root, 16) : root * 0.875}px`);
    }
  }
});

test.describe('coarse pointer GitHub settings', () => {
  test.use({ hasTouch: true });
  test('keeps the input at the shared responsive size on a wide viewport', async ({ page }) => {
    await install(page); await open(page);
    const input = page.getByLabel('Poll interval');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    for (const root of [12, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
      await expect(input).toHaveCSS('font-size', `${Math.max(root, 16)}px`);
    }
  });
});
