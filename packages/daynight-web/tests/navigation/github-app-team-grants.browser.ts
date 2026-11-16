import { expect, test, type Page } from '@playwright/test';
import { stringifyWireJson } from '../helpers/wireJson';

const actor = '00000000-0000-4000-8000-000000000001', otherActor = '00000000-0000-4000-8000-000000000002';
const teamId = '00000000-0000-4000-8000-000000000011', targetId = '00000000-0000-4000-8000-0000000000a2', otherTeamId = '00000000-0000-4000-8000-000000000013';
const appId = '00000000-0000-4000-8000-000000000021', secondAppId = '00000000-0000-4000-8000-000000000022', grantId = '00000000-0000-4000-8000-000000000031', projectId = '00000000-0000-4000-8000-000000000041';
const version = '9007199254740993', impactVersion = '9007199254740994', stamp = '2026-10-20T09:00:00Z';
const team = { id: teamId, kind: 'personal', name: null }, target = { id: targetId, kind: 'ordinary', name: 'Engineering', version };
const app = (id: string) => ({ id, githubAppId: '42', name: id === appId ? 'Platform App' : 'Second App', githubName: 'Platform', githubSlug: 'platform', version, administrators: '1', authorizedTeams: '1', connectedProjects: '2', webhookUrl: `https://daynight.example/api/v1/github/apps/${id}/webhook`, createdAt: stamp, updatedAt: stamp });
const grant = (id: string, appId: string) => ({ id, appId, team: target, createdAt: stamp });
const impact = (id: string, grantId: string, hidden: string) => ({ appId: id, grantId, version, impactVersion, totalProjects: '2', visibleProjects: hidden === '1' ? '1' : '0', hiddenProjects: hidden, teams: [{ team: { id: targetId, kind: 'ordinary', name: 'Engineering' }, projects: '2' }], nextCursor: null });
type State = { writes: { path: string; body: Record<string, unknown> }[]; mode: 'ok' | 'unknown' | 'conflict'; denied: boolean; actor: string; previewGate: Promise<void> | null; projectGate: Promise<void> | null; writeGate: Promise<void> | null; listGate: Promise<void> | null; listReads: number; grantReads: number; paginate: boolean; previewReads: number; projectReads: number; projectDenied: boolean; hidden: string; revoked: boolean };
const install = async (page: Page): Promise<State> => {
  const state: State = { writes: [], mode: 'ok', denied: false, actor, previewGate: null, projectGate: null, writeGate: null, listGate: null, listReads: 0, grantReads: 0, paginate: false, previewReads: 0, projectReads: 0, projectDenied: false, hidden: '1', revoked: false };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method(), principal = state.actor;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
    const error = (code: string, status: number) => send({ error: { code, message: code, requestId: 'test', ...(code === 'github_write_outcome_unknown' ? { details: { writeOutcome: 'unknown' } } : {}) } }, status);
    if (path === '/api/v1/me') return send({ id: principal, personalTeam: team, name: principal === actor ? 'Alice' : 'Bob', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1n, createdAt: stamp, updatedAt: stamp, membership: { teamId, userId: principal, role: 'admin', version: 1n, createdAt: stamp, updatedAt: stamp } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/access`) return state.projectDenied ? error('not_found', 404) : send({ projectId, ownerTeam: team, ownership: { teamId, version: 1n }, effectiveRole: 'admin', teamRole: 'admin', canTransfer: true, directGrant: null });
    if (path === '/api/v1/github/apps') return send({ items: state.denied ? [app(secondAppId)] : [app(appId), app(secondAppId)], nextCursor: null });
    const match = /^\/api\/v1\/github\/apps\/([^/]+)(.*)$/.exec(path); if (!match) return error('not_found', 404);
    const id = match[1]!, rest = match[2]!; if (state.denied && id === appId) return error('not_found', 404);
    if (rest === '' && method === 'GET') return send(app(id));
    if (rest === '/team-grants' && method === 'GET') { state.listReads++; if (state.listGate) await state.listGate; const next = url.searchParams.has('cursor'); return send({ items: state.revoked ? [] : next ? [{ ...grant('00000000-0000-4000-8000-000000000032', id), team: { id: otherTeamId, kind: 'ordinary', name: 'Operations', version } }] : [grant(grantId, id)], nextCursor: state.paginate && !next ? 'next' : null }); }
    if (rest === '/team-grant-preview' && method === 'POST') { const body = request.postDataJSON() as { teamId: string }; state.previewReads++; if (state.previewGate) await state.previewGate; const selected = body.teamId === targetId ? target : { id: otherTeamId, kind: 'ordinary', name: 'Operations', version }; return send({ appId: id, version, targetTeam: selected, grant: null }); }
    if (rest === '/team-grants' && method === 'POST') { const body = request.postDataJSON() as Record<string, unknown>; state.writes.push({ path, body }); if (state.writeGate) await state.writeGate; return state.mode === 'unknown' ? error('github_write_outcome_unknown', 503) : state.mode === 'conflict' ? error('version_conflict', 409) : send(grant(String(body.id), id), 201); }
    if (rest === `/team-grants/${grantId}/revocation-preview`) return send(impact(id, grantId, state.hidden));
    if (rest === `/team-grants/${grantId}/revocation-preview/projects`) { state.projectReads++; if (state.projectGate) await state.projectGate; return send({ items: [{ id: projectId, name: 'Visible project', repoUrl: 'https://github.com/example/visible' }], hiddenProjects: state.hidden, nextCursor: null }); }
    if (rest === `/team-grants/${grantId}/revoke`) { state.writes.push({ path, body: request.postDataJSON() }); if (state.writeGate) await state.writeGate; if (state.mode === 'unknown') return error('github_write_outcome_unknown', 503); state.revoked = true; return send({ appId: id, grantId, revoked: true }); }
    if (rest.startsWith('/team-grants/') && method === 'GET') { state.grantReads++; return error('not_found', 404); }
    return error('not_found', 404);
  });
  return state;
};
const route = (id: string) => `/github-apps/${id}/teams`;

for (const [width, locale] of [[1280, 'en'], [320, 'zh-CN']] as const) {
  test(`direct Team authorization route and reload at ${width}px in ${locale}`, async ({ page }) => {
    await install(page); await page.setViewportSize({ width, height: 900 }); await page.goto(route(appId));
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await expect(page.getByRole('heading', { name: locale === 'en' ? 'Team access' : 'Team 使用授权' })).toBeVisible();
    await page.reload(); await expect(page.getByText('Engineering', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: locale === 'en' ? 'Authorize Team' : '授权 Team' }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Team ID').fill(targetId);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Verify Team' : '核对 Team' }).click();
    await expect(dialog.getByText('Engineering', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth)).toBe(true);
  });
}

test('changing Team ID invalidates a delayed preview before it can enable a grant', async ({ page }) => {
  const state = await install(page); await page.goto(route(appId)); await page.getByRole('button', { name: 'Authorize Team' }).click();
  const dialog = page.getByRole('dialog'), field = dialog.getByLabel('Team ID'); const gate = Promise.withResolvers<void>(); state.previewGate = gate.promise;
  try {
    await field.fill(targetId); await dialog.getByRole('button', { name: 'Verify Team' }).click(); await expect.poll(() => state.previewReads).toBe(1);
    await field.fill(otherTeamId); gate.resolve(); state.previewGate = null;
    await expect(dialog.getByText('Engineering', { exact: true })).toHaveCount(0); await expect(dialog.getByRole('button', { name: 'Grant access' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Verify Team' }).click(); await expect(dialog.getByText('Operations', { exact: true })).toBeVisible();
  } finally { gate.resolve(); }
});

test('revocation shows only authorized project details and submits exact observed versions', async ({ page }) => {
  const state = await install(page); await page.goto(route(appId)); await page.getByRole('button', { name: 'Revoke access' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Affected connections: 2'); await expect(dialog).toContainText('1 projects whose details are hidden');
  await dialog.getByRole('button', { name: 'View accessible projects' }).click(); await expect(dialog.getByText(/Visible project/)).toBeVisible();
  await expect(dialog).not.toContainText('Hidden project');
  await dialog.getByRole('button', { name: 'Revoke access and disconnect' }).click(); await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]).toEqual({ path: `/api/v1/github/apps/${appId}/team-grants/${grantId}/revoke`, body: { version, impactVersion, expectedUserId: actor } });
  await expect(page.getByText('Team access revoked and affected connections stopped. Existing PRs are retained.')).toBeVisible();
});

test('a denied project check removes stale revocation details without removing App access', async ({ page }) => {
  const state = await install(page); await page.goto(route(appId)); await page.getByRole('button', { name: 'Revoke access' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'View accessible projects' }).click(); await expect(dialog.getByText(/Visible project/)).toBeVisible();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const otherPage = await page.context().newPage(); await otherPage.goto('/projects');
  const secondary = await page.context().newCDPSession(otherPage); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await otherPage.bringToFront();
  try {
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); state.projectDenied = true; await page.bringToFront();
    await expect(dialog.getByText(/Visible project/)).toHaveCount(0); await expect(dialog.getByText(/github.com\/example\/visible/)).toHaveCount(0);
    await expect(dialog.getByText(/Project access or impact changed/)).toBeVisible(); await expect(page.getByText('This App is unavailable or you do not have access.')).toHaveCount(0);
  } finally { await otherPage.close(); }
});

test('granting uses the verified Team and exact App and Team versions', async ({ page }) => {
  const state = await install(page); await page.goto(route(appId)); await page.getByRole('button', { name: 'Authorize Team' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Team ID').fill(targetId.toUpperCase()); await dialog.getByRole('button', { name: 'Verify Team' }).click();
  await expect(dialog.getByText('Engineering', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Grant access' }).click();
  await expect.poll(() => state.writes.length).toBe(1); expect(state.writes[0]!.body).toMatchObject({ version, teamId: targetId, teamVersion: version, expectedUserId: actor });
  expect(state.writes[0]!.body.id).toMatch(/^[a-f0-9-]{36}$/); await expect(page.getByText('Team access granted.').first()).toBeVisible();
});

test('unknown Team grants stay attached to their App across navigation and account replacement', async ({ page }) => {
  const state = await install(page); state.mode = 'unknown'; await page.goto('/github-apps');
  const createUnknown = async (name: string) => {
    await page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Manage' }).click();
    await page.getByRole('link', { name: 'Team access' }).click(); await page.getByRole('button', { name: 'Authorize Team' }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Team ID').fill(targetId); await dialog.getByRole('button', { name: 'Verify Team' }).click();
    await expect(dialog.getByText('Engineering', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Grant access' }).click();
    await expect(dialog).toContainText('The outcome is unknown.'); await page.goBack(); await page.goBack(); await expect(page).toHaveURL(/\/github-apps$/);
  };
  await createUnknown('Platform App'); const first = page.getByRole('alert').filter({ hasText: appId }); await expect(first).toContainText('Team access operation outcome is unknown');
  await createUnknown('Second App'); const second = page.getByRole('alert').filter({ hasText: secondAppId }); await expect(first).toBeVisible(); await expect(second).toBeVisible(); expect(state.writes).toHaveLength(2);
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const otherPage = await page.context().newPage(); await otherPage.goto('/projects');
  const secondary = await page.context().newCDPSession(otherPage); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await otherPage.bringToFront();
  try {
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); state.actor = otherActor;
    await page.bringToFront(); await expect(page.getByText('Account changed')).toBeVisible(); await page.getByRole('button', { name: 'Refresh page' }).click();
    await expect(page.getByRole('button', { name: 'Account menu: Bob' })).toBeVisible(); await expect(first).toHaveCount(0); await expect(second).toHaveCount(0); expect(state.writes).toHaveLength(2);
  } finally { await otherPage.close(); }
});

test('unknown revocation is reviewed against its original grant without replay', async ({ page }) => {
  const state = await install(page); state.mode = 'unknown'; await page.goto(route(appId)); await page.getByRole('button', { name: 'Revoke access' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Revoke access and disconnect' }).click();
  await expect(dialog).toContainText('The outcome is unknown.'); await expect(dialog.getByRole('button', { name: 'Revoke access and disconnect' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Check current state' }).click(); await expect(dialog).toContainText('does not establish the original operation');
  await expect(dialog).toContainText('The original grant is currently unavailable or absent.');
  await dialog.getByRole('button', { name: 'Finish review and decide again' }).click(); await expect(dialog).toHaveCount(0); expect(state.writes).toHaveLength(1);
});

test('foreground list revalidation preserves Load more focus and visible content', async ({ page }) => {
  const state = await install(page); state.paginate = true; await page.goto(route(appId));
  const more = page.getByRole('button', { name: 'Load more' }); await expect(more).toBeVisible(); await more.focus();
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const otherPage = await page.context().newPage(); await otherPage.goto('/projects');
  const secondary = await page.context().newCDPSession(otherPage); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach(); await otherPage.bringToFront();
  const gate = Promise.withResolvers<void>(); state.listGate = gate.promise;
  try {
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false); const before = state.listReads;
    await page.bringToFront(); await expect.poll(() => state.listReads).toBeGreaterThan(before);
    await expect(more).toBeFocused(); await expect(page.getByText('Engineering', { exact: true })).toBeVisible(); expect(state.writes).toHaveLength(0);
    gate.resolve(); state.listGate = null; await expect(more).toHaveAttribute('aria-disabled', 'false'); await expect(more).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.getByText('Operations', { exact: true })).toBeVisible();
  } finally { gate.resolve(); await otherPage.close(); }
});

test('temporary admission block keeps Load more focused and gates the request', async ({ page }) => {
  const state = await install(page); state.paginate = true; await page.goto('/tests/navigation/github-app-team-grants-focus.html');
  const more = page.getByRole('button', { name: 'Load more' }); await expect(more).toBeVisible(); await more.focus();
  const before = state.listReads; await page.evaluate(() => dispatchEvent(new CustomEvent('test-admission-blocked', { detail: true })));
  await expect(more).toHaveAttribute('aria-disabled', 'true'); await expect(more).toBeFocused(); await page.keyboard.press('Enter');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(state.listReads).toBe(before); expect(state.writes).toHaveLength(0);
  await page.evaluate(() => dispatchEvent(new CustomEvent('test-admission-blocked', { detail: false })));
  await expect(more).toHaveAttribute('aria-disabled', 'false'); await expect(more).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.getByText('Operations', { exact: true })).toBeVisible();
});

for (const mode of ['unknown', 'conflict'] as const) {
  test(`temporary admission block keeps ${mode} Review focused and gates operations`, async ({ page }) => {
    const state = await install(page); state.mode = mode; await page.goto('/tests/navigation/github-app-team-grants-focus.html');
    await page.getByRole('button', { name: 'Authorize Team' }).click(); const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Team ID').fill(targetId); await dialog.getByRole('button', { name: 'Verify Team' }).click();
    await expect(dialog.getByText('Engineering', { exact: true })).toBeVisible(); await dialog.getByRole('button', { name: 'Grant access' }).click();
    const review = dialog.getByRole('button', { name: 'Check current state' }); await expect(review).toBeVisible(); await review.focus();
    const reads = state.grantReads, writes = state.writes.length; await page.evaluate(() => dispatchEvent(new CustomEvent('test-admission-blocked', { detail: true })));
    await expect(review).toHaveAttribute('aria-disabled', 'true'); await expect(review).toBeFocused(); await page.keyboard.press('Enter');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(state.grantReads).toBe(reads); expect(state.writes).toHaveLength(writes); await expect(dialog.getByLabel('Team ID')).toHaveValue(targetId);
    await page.evaluate(() => dispatchEvent(new CustomEvent('test-admission-blocked', { detail: false })));
    await expect(review).toHaveAttribute('aria-disabled', 'false'); await expect(review).toBeFocused();
    await page.keyboard.press('Enter');
    if (mode === 'unknown') await expect(dialog).toContainText('does not establish the original operation');
    else await expect(dialog.getByRole('button', { name: 'Grant access' })).toBeDisabled();
    expect(state.writes).toHaveLength(writes);
  });
}

for (const action of ['grant', 'revoke'] as const) {
  test(`confirmed ${action} remains visible after closing while its receipt awaits identity admission`, async ({ page }) => {
    const state = await install(page); await page.goto('/tests/navigation/github-app-team-grants-focus.html');
    if (action === 'grant') {
      await page.getByRole('button', { name: 'Authorize Team' }).click(); const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Team ID').fill(targetId); await dialog.getByRole('button', { name: 'Verify Team' }).click(); await expect(dialog.getByText('Engineering', { exact: true })).toBeVisible();
    } else await page.getByRole('button', { name: 'Revoke access' }).click();
    const dialog = page.getByRole('dialog'), gate = Promise.withResolvers<void>(); state.writeGate = gate.promise;
    try {
      const confirm = dialog.getByRole('button', { name: action === 'grant' ? 'Grant access' : 'Revoke access and disconnect' });
      await confirm.click(); await expect.poll(() => state.writes.length).toBe(1);
      await page.evaluate(() => dispatchEvent(new CustomEvent('test-publication-blocked', { detail: true })));
      const response = page.waitForResponse(item => item.request().method() === 'POST' && (action === 'grant' ? new URL(item.url()).pathname.endsWith('/team-grants') : new URL(item.url()).pathname.endsWith('/revoke')));
      gate.resolve(); state.writeGate = null; await (await response).finished();
      await expect(confirm).toBeVisible(); await expect(confirm).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel' }).click(); await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Authorize Team' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Revoke access' })).toBeDisabled(); expect(state.writes).toHaveLength(1);
      await page.evaluate(() => dispatchEvent(new CustomEvent('test-publication-blocked', { detail: false })));
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText(action === 'grant' ? 'Team access granted.' : 'Team access revoked and affected connections stopped. Existing PRs are retained.')).toBeVisible();
      expect(state.writes).toHaveLength(1);
    } finally { gate.resolve(); await page.evaluate(() => dispatchEvent(new CustomEvent('test-publication-blocked', { detail: false }))); }
  });
}
