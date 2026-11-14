import { expect, test, type Page, type Route } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const charlie = '00000000-0000-4000-8000-000000000003';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const betaId = '00000000-0000-4000-8000-000000000022';
const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const time = '2026-10-20T09:00:00Z';
const key = `daynight.selectedTeam:${alice}`;
type Role = 'admin' | 'member';
type Member = { role: Role; version: number; name: string | null; email: string | null };
type Gate = { started: () => void; wait: Promise<void> };
type State = { members: Map<string, Member>; betaMember: Member; writeEvents: string[]; writes: { method: string; path: string; body: Record<string, unknown> }[]; lost: boolean; refusal: string | null; failReadsAfterWrite: boolean; holdWrite: Gate | null; meReads: number; holdTeamRead: Gate | null; holdRosterRead: Gate | null; holdProjectsRead: Gate | null; holdInvitation: Gate | null; holdInvitationRead: Gate | null; invitationWrites: number; invitationSuccess: boolean; teamReadNetworkFailure: boolean; rosterReadNetworkFailure: boolean; grant: { userId: string; role: Role; version: number } };
const task = detailFixture(projectId, taskId, { title: 'Retained Task', version: 9_223_372_036_854_775_807n });
const graph = graphFixture([task]);
const access = directAccessFixture(projectId, alice, 'admin');
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
const install = async (page: Page, actorRole: Role = 'admin'): Promise<State> => {
  const state: State = { members: new Map([[alice, { role: actorRole, version: 1, name: 'Alice', email: null }], [bob, { role: 'admin', version: 2, name: 'Bob', email: 'bob@example.com' }], [charlie, { role: 'member', version: 3, name: null, email: null }]]), betaMember: { role: 'member', version: 22, name: 'Bob', email: 'bob@example.com' }, writeEvents: [], writes: [], lost: false, refusal: null, failReadsAfterWrite: false, holdWrite: null, meReads: 0, holdTeamRead: null, holdRosterRead: null, holdProjectsRead: null, holdInvitation: null, holdInvitationRead: null, invitationWrites: 0, invitationSuccess: false, teamReadNetworkFailure: false, rosterReadNetworkFailure: false, grant: { userId: alice, role: 'admin', version: 7 } };
  const membership = (id: string, team = teamId) => { const m = team === personalId ? { role: 'admin' as const, version: 9, name: 'Alice', email: null } : state.members.get(id)!; return { teamId: team, userId: id, role: m.role, version: m.version, createdAt: time, updatedAt: time }; };
  const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : id === betaId ? 'Beta' : 'Alpha', version: 1, createdAt: time, updatedAt: time, membership: id === betaId ? { teamId: betaId, userId: alice, role: 'admin', version: 20, createdAt: time, updatedAt: time } : membership(alice, id) });
  const roster = (id: string) => id === personalId ? [{ ...membership(alice, id), profile: { name: 'Alice', email: null, avatarUrl: null } }] : [...state.members].map(([userId, m]) => ({ ...membership(userId), profile: { name: m.name, email: m.email, avatarUrl: null } }));
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ json: body, status, headers: { 'Daynight-User-ID': alice } });
    if (path === '/api/v1/me') { state.meReads++; return send({ id: alice, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null }); }
    if (path === '/api/v1/projects') { const gate = state.holdProjectsRead; state.holdProjectsRead = null; if (gate) { gate.started(); await gate.wait; } return send({ items: [], nextCursor: null }); }
    const sendWire = (body: unknown, extra: Record<string, string> = {}) => route.fulfill({ body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': alice, ...extra } });
    if (path === `/api/v1/projects/${projectId}/access`) return sendWire(access);
    if (path === `/api/v1/projects/${projectId}/task-sync`) return sendWire(taskSyncFixture(graph, { actorAccess: access, query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}`) return sendWire(task, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps`) return sendWire({ projectId, taskId, version: task.version, steps: [] });
    if (path.startsWith(`/api/v1/projects/${projectId}/tasks/${taskId}/`) && (path.endsWith('/sessions') || path.endsWith('/attachments'))) return send({ items: [], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: state.members.has(alice) ? [team(teamId)] : [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team(personalId));
    if (path === `/api/v1/teams/${betaId}`) return send(team(betaId));
    if (path === `/api/v1/teams/${betaId}/members`) return send({ items: [{ ...team(betaId).membership, profile: { name: 'Alice', email: null, avatarUrl: null } }, { teamId: betaId, userId: bob, role: state.betaMember.role, version: state.betaMember.version, createdAt: time, updatedAt: time, profile: { name: state.betaMember.name, email: state.betaMember.email, avatarUrl: null } }] });
    if (path === `/api/v1/teams/${betaId}/members/${bob}` && method === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>; state.writes.push({ method, path, body });
      if (body.expectedUserId !== alice) return send(error('identity_mismatch'), 409);
      if (body.version !== state.betaMember.version) return send(error('version_conflict'), 409);
      state.betaMember.role = body.role as Role; state.betaMember.version += 10;
      return send({ membership: { teamId: betaId, userId: bob, role: state.betaMember.role, version: state.betaMember.version, createdAt: time, updatedAt: time }, actorRole: 'admin' });
    }
    if (method === 'POST' && path === `/api/v1/teams/${teamId}/invitations`) {
      state.invitationWrites++;
      const gate = state.holdInvitation; state.holdInvitation = null; if (gate) { gate.started(); await gate.wait; }
      if (state.invitationSuccess) return send({ id: '00000000-0000-4000-8000-000000000051', teamId, createdBy: alice, createdAt: time, expiresAt: '2099-10-27T09:00:00Z', consumedBy: null, consumedAt: null, revokedAt: null, link: `${new URL(request.url()).origin}/team-invitations#dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` }, 201);
      return route.abort('failed');
    }
    if (method === 'GET' && path === `/api/v1/teams/${teamId}/invitations`) {
      const gate = state.holdInvitationRead; state.holdInvitationRead = null; if (gate) { gate.started(); await gate.wait; }
      return state.members.get(alice)?.role === 'admin' ? send({ items: [] }) : send(error('forbidden'), 403);
    }
    if (method === 'GET' && path === `/api/v1/teams/${betaId}/invitations`) return send({ items: [] });
    if (path === `/api/v1/teams/${personalId}/members`) return send({ items: roster(personalId) });
    if (path === `/api/v1/teams/${teamId}` && (state.teamReadNetworkFailure || state.failReadsAfterWrite && state.writes.length > 0)) return route.abort('failed');
    if (path === `/api/v1/teams/${teamId}`) {
      const gate = state.holdTeamRead; state.holdTeamRead = null; if (gate) { gate.started(); await gate.wait; }
      return state.members.has(alice) ? send(team(teamId)) : send(error('not_found'), 404);
    }
    if (path === `/api/v1/teams/${teamId}/members` && method === 'GET') {
      const gate = state.holdRosterRead; state.holdRosterRead = null; if (gate) { gate.started(); await gate.wait; }
      if (state.rosterReadNetworkFailure) return route.abort('failed');
      return state.members.has(alice) ? send({ items: roster(teamId) }) : send(error('not_found'), 404);
    }
    if (path.startsWith(`/api/v1/teams/${teamId}/members/`) && (method === 'PATCH' || method === 'DELETE')) {
      const target = path.split('/').at(-1)!, body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ method, path, body });
      const reject = (code: string) => { state.writeEvents.push(`rejected: ${code}`); return send(error(code), 409); };
      if (state.refusal) return reject(state.refusal);
      const member = state.members.get(target)!, actor = state.members.get(alice)!;
      if (body.expectedUserId !== alice) return reject('identity_mismatch');
      if (body.version !== member.version) return reject('version_conflict');
      if (actor.role !== 'admin' && (method === 'PATCH' || target !== alice)) { state.writeEvents.push('rejected: forbidden'); return send(error('forbidden'), 403); }
      if (member.role === 'admin' && (method === 'DELETE' || body.role === 'member') && [...state.members.values()].filter((m) => m.role === 'admin').length === 1) return reject('last_admin');
      if (method === 'PATCH') { member.role = body.role as Role; member.version += 10; }
      else state.members.delete(target);
      const gate = state.holdWrite; state.holdWrite = null; if (gate) { state.writeEvents.push('held'); gate.started(); await gate.wait; }
      if (state.lost) { state.writeEvents.push('response: network failure'); return route.abort('failed'); }
      const actorRole = state.members.get(alice)?.role ?? null;
      return method === 'PATCH' ? send({ membership: membership(target), actorRole }) : send({ teamId, userId: target, removed: true, actorRole });
    }
    return send(error('not_found'), 404);
  });
  return state;
};
const start = async (page: Page) => { await page.goto(`/teams/${teamId}/members`); await expect(page.getByRole('heading', { name: 'Team settings' })).toBeVisible(); await expect(page.getByLabel('Team role: Bob')).toBeVisible(); };

test('shares settings navigation and preserves the General editor through browser history', async ({ page }) => {
  await install(page); await start(page);
  const settings = page.locator('.sidebar nav').getByRole('link', { name: 'Team settings', exact: true });
  await expect(settings).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.sidebar nav').getByRole('link', { name: 'Team members', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Members & invitations', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'General', exact: true }).click();
  await expect(page).toHaveURL(`/teams/${teamId}/settings`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Team name' });
  await editor.getByLabel('Team name', { exact: true }).fill('Retained draft');
  const node = await editor.elementHandle();
  await page.goBack();
  await expect(page).toHaveURL(`/teams/${teamId}/members`);
  await expect(page.getByLabel('Team role: Bob')).toBeVisible();
  await expect(editor).toBeHidden();
  await page.goForward();
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Team name', { exact: true })).toHaveValue('Retained draft');
  expect(await editor.evaluate((current, original) => current === original, node)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Members & invitations', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Members & invitations', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle('Team settings · Daynight');
  await settings.click();
  await expect(page.getByRole('link', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('keeps both settings sections readable in both languages and narrow widths', async ({ page }) => {
  await install(page); await start(page);
  for (const width of [320, 390, 768, 1360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const locale of ['en', 'zh-CN']) {
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const generalLabel = locale === 'en' ? 'General' : '基本信息';
      const membersLabel = locale === 'en' ? 'Members & invitations' : '成员与邀请';
      for (const label of [generalLabel, membersLabel]) {
        await page.getByRole('link', { name: label, exact: true }).click();
        await expect(page.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByRole('heading', { name: locale === 'en' ? 'Team settings' : '团队设置', exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      }
    }
  }
});

const selected = (page: Page) => page.evaluate((k) => localStorage.getItem(k), key);
const traverse = (page: Page, path: string) => page.evaluate((url) => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }, path);
const foreground = async (page: Page, api: State) => {
  const meReads = api.meReads;
  await page.evaluate(() => {
    const original = document.hasFocus.bind(document);
    document.hasFocus = () => false; dispatchEvent(new Event('blur'));
    document.hasFocus = () => true; dispatchEvent(new Event('focus'));
    document.hasFocus = original;
  });
  expect(api.meReads).toBe(meReads);
};

test('Task Steps use the empty resource contract after Team navigation', async ({ page }) => {
  await install(page); await start(page);
  await traverse(page, `/projects/${projectId}/tasks/${taskId}`);
  await expect(page.getByRole('heading', { name: 'Retained Task', exact: true })).toBeVisible();
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tasks/${taskId}/steps`);
  await page.getByRole('tab', { name: 'Steps' }).click();
  const steps = await response;
  expect(steps.status()).toBe(200);
  expect(steps.headers()['daynight-user-id']).toBe(alice);
  expect(await steps.text()).toBe(`{"projectId":"${projectId}","taskId":"${taskId}","version":${task.version},"steps":[]}`);
  await expect(page.getByText('No steps yet')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const width of [1440, 601, 390, 320]) for (const locale of ['en', 'zh-CN']) {
  test(`member role columns align at ${width}px in ${locale}`, async ({ page }, testInfo) => {
    const api = await install(page);
    api.members.get(bob)!.role = 'member';
    api.members.get(bob)!.name = 'Bob — Platform Engineering and Infrastructure Collaboration';
    api.members.get(bob)!.email = 'very.long.member.address.for.layout.verification@example.enterprise.test';
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/teams/${teamId}/members`);
    await expect(page.getByLabel('Team role: Alice')).toBeVisible();
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const selects = page.locator('.team-member-row').getByRole('combobox');
    await expect(selects).toHaveCount(3);
    await expect(selects.nth(0)).toBeDisabled(); await expect(selects.nth(1)).toBeEnabled();
    const geometry = await page.locator('.team-member-row').evaluateAll((rows) => rows.map((row) => {
      const rect = (selector: string) => row.querySelector(selector)!.getBoundingClientRect();
      const role = rect('select'), arrow = rect('.native-select__arrow'), person = rect('.person'), action = rect('button');
      return { left: role.left, right: role.right, width: role.width, height: role.height, roleY: role.top + role.height / 2, personY: person.top + person.height / 2, actionY: action.top + action.height / 2, arrowY: arrow.top + arrow.height / 2, arrowInset: role.right - arrow.right };
    }));
    for (const item of geometry) {
      expect(item.width).toBe(120);
      expect(item.height).toBe(32);
      expect(Math.abs(item.arrowY - item.roleY)).toBeLessThanOrEqual(1);
      expect(Math.abs(item.arrowInset - 12)).toBeLessThanOrEqual(1);
      expect(Math.abs(item.left - geometry[0]!.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(item.right - geometry[0]!.right)).toBeLessThanOrEqual(1);
      expect(Math.abs(item.width - geometry[0]!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(item.actionY - item.roleY)).toBeLessThanOrEqual(1);
      if (width > 600) expect(Math.abs(item.personY - item.roleY)).toBeLessThanOrEqual(1);
    }
    await testInfo.attach('geometry', { body: JSON.stringify(geometry), contentType: 'application/json' });
    const textSpace = await selects.nth(0).evaluate((element: HTMLSelectElement) => {
      const style = getComputedStyle(element), canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return { available: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), required: Math.max(...Array.from(element.options, (option) => context.measureText(option.text).width)) };
    });
    expect(textSpace.available).toBeGreaterThanOrEqual(textSpace.required);
    if (width === 601 && locale === 'en') {
      const caption = await page.locator('.team-member-caption').evaluate((element) => ({ height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
      expect(caption.height).toBeGreaterThan(caption.lineHeight);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await selects.nth(1).focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(selects.nth(1)).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('members.png'), fullPage: true });
    await selects.nth(1).click(); await page.keyboard.press('Escape');
    await selects.nth(1).selectOption('admin');
    await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0); expect(api.writes).toHaveLength(0);
  });
}

test('member loading and read failure retain a working retry', async ({ page }) => {
  const api = await install(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const projectsStarted = Promise.withResolvers<void>(), finishProjects = Promise.withResolvers<void>();
  api.holdRosterRead = { started: started.resolve, wait: finish.promise };
  api.holdProjectsRead = { started: projectsStarted.resolve, wait: finishProjects.promise };
  try {
    await page.goto(`/teams/${teamId}/members`); await Promise.all([started.promise, projectsStarted.promise]);
    await expect(page.locator('#workspace-sidebar').getByRole('status').filter({ hasText: 'Loading projects' })).toBeVisible();
    await expect(page.locator('#main-content').getByRole('status').filter({ hasText: 'Loading' })).toBeVisible();
  } finally { finish.resolve(); finishProjects.resolve(); }
  await expect(page.getByLabel('Team role: Bob')).toBeVisible();
  api.rosterReadNetworkFailure = true; await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'Unable to read members.' })).toBeVisible();
  api.rosterReadNetworkFailure = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByLabel('Team role: Bob')).toBeVisible();
  expect(api.writes).toHaveLength(0);
});

test('admin promotes and removes members and can demote self while another admin remains', async ({ page }) => {
  const api = await install(page); await start(page);
  const charlieRole = page.getByLabel(`Team role: ${charlie}`);
  await charlieRole.selectOption('admin'); let dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Project grants remain'); await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByLabel(`Team role: ${charlie}`)).toHaveValue('admin');
  expect(api.writes[0]).toMatchObject({ method: 'PATCH', body: { expectedUserId: alice, version: 3, role: 'admin' } });
  const row = page.locator('.team-member-row').filter({ hasText: charlie });
  await row.getByRole('button', { name: 'Remove' }).click(); dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Remove member' }).click(); await expect(row).toHaveCount(0);
  expect(api.writes[1]).toMatchObject({ method: 'DELETE', body: { expectedUserId: alice, version: 13 } });
  await page.getByLabel('Team role: Alice').selectOption('member'); dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByLabel('Team role: Alice')).toHaveValue('member');
  await expect(page.getByLabel('Team role: Bob')).toBeDisabled();
  expect(api.grant).toEqual({ userId: alice, role: 'admin', version: 7 });
  expect(api.writes.every((write) => write.path.startsWith(`/api/v1/teams/${teamId}/members/`))).toBe(true);
});

test('a retained invitation result survives returning while the Team read is in flight', async ({ page }) => {
  await page.addInitScript((target) => {
    const tracked = window as unknown as Window & { teamReadSignals: { signal: AbortSignal | undefined; settled: boolean }[] };
    tracked.teamReadSignals = [];
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== `/api/v1/teams/${target}` || (init?.method ?? 'GET') !== 'GET') return fetch(input, init);
      const entry = { signal: init?.signal ?? undefined, settled: false };
      tracked.teamReadSignals.push(entry);
      return fetch(input, init).then((response) => { entry.settled = true; return response; }, (error: unknown) => { entry.settled = true; throw error; });
    };
  }, teamId);
  const api = await install(page); await start(page); api.invitationSuccess = true;
  const finishInvitation = Promise.withResolvers<void>(), finishTeamRead = Promise.withResolvers<void>();
  let invitationStarted = false, teamReadStarted = false;
  api.holdInvitation = { started: () => { invitationStarted = true; }, wait: finishInvitation.promise };
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create invitation link' }).click();
  await expect.poll(() => invitationStarted, { message: 'Invitation request must reach its response gate' }).toBe(true);
  try {
    await traverse(page, `/teams/${teamId}`);
    await expect(page.locator('.project-list-information').filter({ has: page.getByText('Alpha', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    const before = await page.evaluate(() => (window as unknown as Window & { teamReadSignals: unknown[] }).teamReadSignals.length);
    api.holdTeamRead = { started: () => { teamReadStarted = true; }, wait: finishTeamRead.promise };
    await foreground(page, api);
    await expect.poll(() => teamReadStarted, { message: 'Preference GET must reach its response gate' }).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { teamReadSignals: unknown[] }).teamReadSignals.length)).toBe(before + 1);
    const readState = () => page.evaluate((index) => {
      const entry = (window as unknown as Window & { teamReadSignals: { signal: AbortSignal | undefined; settled: boolean }[] }).teamReadSignals[index]!;
      return { aborted: entry.signal?.aborted, settled: entry.settled };
    }, before);
    expect(await readState()).toEqual({ aborted: false, settled: false });
    finishInvitation.resolve();
    await traverse(page, `/teams/${teamId}/members`);
    await expect(page.getByRole('dialog', { name: 'Invitation link created' }).getByLabel('One-time invitation link')).toBeVisible({ timeout: 5000 });
    expect(await readState()).toEqual({ aborted: false, settled: false });
    expect(api.invitationWrites).toBe(1);
    finishTeamRead.resolve();
    await expect.poll(readState).toEqual({ aborted: false, settled: true });
  } finally { finishInvitation.resolve(); finishTeamRead.resolve(); }
});

test('a demoted member can leave after an invitation result is lost during navigation', async ({ page }) => {
  const api = await install(page); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdInvitation = { started: started.resolve, wait: finish.promise };
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create invitation link' }).click(); await started.promise;
  await traverse(page, `/teams/${betaId}/members`); api.members.get(alice)!.role = 'member'; finish.resolve();
  await traverse(page, `/teams/${teamId}/members`);
  await expect(page.getByText('The invitation change is still unconfirmed; you no longer have permission to read this Team’s invitations.')).toBeVisible();
  const leave = page.getByRole('button', { name: 'Leave Team' }); await expect(leave).toBeEnabled(); await leave.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave Team' }).click();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Personal', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  expect(api.invitationWrites).toBe(1); expect(api.writes).toHaveLength(1);
});

for (const observed of [false, true]) test(`an ${observed ? 'observed' : 'unobserved'} unknown invitation remains visible after demotion and removal`, async ({ page }) => {
  const api = await install(page); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdInvitation = { started: started.resolve, wait: finish.promise };
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create invitation link' }).click(); await started.promise;
  if (observed) {
    finish.resolve();
    const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('alert')).toContainText('not confirmed');
    await dialog.getByRole('button', { name: 'Read current invitations' }).click();
    await expect(page.getByText('Current invitations are shown; the original result is still unknown. Review before changing them.')).toBeVisible();
    await traverse(page, `/teams/${betaId}/members`); api.members.get(alice)!.role = 'member';
  } else {
    await traverse(page, `/teams/${betaId}/members`); api.members.get(alice)!.role = 'member'; finish.resolve();
  }
  await traverse(page, `/teams/${teamId}/members`);
  await expect(page.getByText('The invitation change is still unconfirmed; you no longer have permission to read this Team’s invitations.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave Team' })).toBeEnabled();
  await traverse(page, `/teams/${betaId}/members`); api.members.delete(alice);
  await traverse(page, `/teams/${teamId}/members`);
  await expect(page.getByText('The invitation change is still unconfirmed; this Team is unavailable or you no longer have access.')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/teams/${teamId}/members$`)); expect(api.invitationWrites).toBe(1);
});

const confirmInvitationAccess = async (page: Page, access: 'admin' | 'member' | 'unavailable' | 'network') => {
  if (access === 'admin' || access === 'member') await expect(page.locator(`[id="team-role-${teamId}-${alice}"]`)).toHaveValue(access);
  else if (access === 'unavailable') await expect(page.getByRole('alert').filter({ hasText: 'This Team is unavailable or you do not have access.' }).first()).toBeVisible();
  else await expect(page.getByRole('alert').filter({ hasText: 'Unable to read members.' }).first()).toBeVisible();
};

for (const access of ['admin', 'member', 'unavailable'] as const) test(`a displayed invitation remains available across navigation and ${access}`, async ({ page }) => {
  const api = await install(page); await start(page); api.invitationSuccess = true;
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create invitation link' }).click();
  const link = page.getByLabel('One-time invitation link'); await expect(link).toBeVisible(); const issued = await link.inputValue();
  await traverse(page, `/teams/${betaId}/members`); await expect(link).toBeHidden();
  if (access === 'member') api.members.get(alice)!.role = 'member'; else if (access === 'unavailable') api.members.delete(alice);
  await traverse(page, `/teams/${teamId}/members`); await confirmInvitationAccess(page, access);
  await expect(link).toBeVisible(); await expect(link).toHaveValue(issued);
  await page.getByRole('dialog', { name: 'Invitation link created' }).getByRole('button', { name: 'I have saved it, close' }).click();
  await expect(link).toHaveCount(0); expect(api.invitationWrites).toBe(1);
});

for (const access of ['member', 'unavailable', 'network'] as const) test(`a confirmed invitation remains visible after navigation and ${access}`, async ({ page }) => {
  const api = await install(page); await start(page); api.invitationSuccess = true;
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdInvitation = { started: started.resolve, wait: finish.promise };
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create invitation link' }).click(); await started.promise;
  await traverse(page, `/teams/${betaId}/members`);
  if (access === 'member') api.members.get(alice)!.role = 'member'; else if (access === 'unavailable') api.members.delete(alice); else api.teamReadNetworkFailure = true;
  finish.resolve(); await traverse(page, `/teams/${teamId}/members`); await confirmInvitationAccess(page, access);
  const dialog = page.getByRole('dialog', { name: 'Invitation link created' });
  await expect(dialog.getByLabel('One-time invitation link')).toHaveValue(/#dnteam_/);
  await dialog.getByRole('button', { name: 'I have saved it, close' }).click();
  await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0); expect(api.invitationWrites).toBe(1);
  await traverse(page, `/teams/${betaId}/members`); await expect(page.locator(`[id="team-role-${betaId}-${bob}"]`)).toBeVisible();
});

test('member leaves and returns to Personal, keeping direct grant and browser preference', async ({ page }) => {
  const api = await install(page, 'member'); await start(page);
  await expect(page.getByLabel('Team role: Bob')).toBeDisabled();
  await expect(page.locator('.team-member-row').filter({ hasText: 'Bob' }).getByRole('button', { name: 'Remove' })).toBeDisabled();
  await expect.poll(() => selected(page)).toBe(teamId);
  await page.getByRole('button', { name: 'Leave Team' }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Project grants remain');
  await dialog.getByRole('button', { name: 'Leave Team' }).click();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Personal', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByText('You left the Team; direct Project grants remain.')).toBeVisible();
  await expect.poll(() => selected(page)).toBe(personalId);
  expect(api.writes).toHaveLength(1); expect(api.grant).toEqual({ userId: alice, role: 'admin', version: 7 });
  await page.goto(`/teams/${personalId}/members`);
  await expect(page.getByText('Personal Team membership and role are fixed.')).toBeVisible();
  await expect(page.getByLabel('Team role: Alice')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leave Team' })).toBeDisabled();
});

test('an admin can leave with another admin, but a concurrent last-admin change is refused', async ({ page }) => {
  const api = await install(page); await start(page);
  await page.getByRole('button', { name: 'Leave Team' }).click();
  const dialog = page.getByRole('dialog');
  api.members.get(bob)!.role = 'member';
  await dialog.getByRole('button', { name: 'Leave Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('At least one admin must remain');
  expect(api.members.has(alice)).toBe(true); expect(api.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Leave Team' })).toBeDisabled();
  api.members.get(bob)!.role = 'admin'; api.members.get(bob)!.version++;
  await page.reload(); await expect(page.getByRole('button', { name: 'Leave Team' })).toBeEnabled();
  await page.getByRole('button', { name: 'Leave Team' }).click();
  await dialog.getByRole('button', { name: 'Leave Team' }).click();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Personal', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect.poll(() => selected(page)).toBe(personalId);
  expect(api.members.has(alice)).toBe(false); expect(api.writes).toHaveLength(2);
});

test('confirmed success remains visible when subsequent Team reads fail', async ({ page }) => {
  const api = await install(page); await start(page); api.failReadsAfterWrite = true;
  await page.getByLabel('Team role: Bob').selectOption('member');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByText('Team membership updated.')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Unable to connect');
  expect(api.members.get(bob)?.role).toBe('member'); expect(api.writes).toHaveLength(1);
});

test('cancellation and Escape do not write; unknown is retained without replay', async ({ page }) => {
  const api = await install(page); await start(page);
  await page.getByLabel('Team role: Bob').selectOption('member'); let dialog = page.getByRole('dialog');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(api.writes).toHaveLength(0);
  await page.getByLabel('Team role: Bob').selectOption('member'); dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click(); expect(api.writes).toHaveLength(0);
  api.lost = true; await page.getByLabel('Team role: Bob').selectOption('member');
  await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Check current state' }).click();
  await expect(dialog.getByRole('alert').first()).toContainText('result is unknown');
  await expect(dialog.getByRole('button', { name: 'Confirm change' })).toHaveCount(0);
  expect(api.writes).toHaveLength(1);
});

test('a later unknown replaces the previous success and shows observed role without claiming success', async ({ page }) => {
  const api = await install(page); await start(page);
  await page.getByLabel(`Team role: ${charlie}`).selectOption('admin');
  let dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByText('Team membership updated.')).toBeVisible();
  await expect(page.getByLabel('Team role: Bob')).toBeEnabled();
  api.lost = true; await page.getByLabel('Team role: Bob').selectOption('member');
  await expect(page.getByText('Team membership updated.')).toHaveCount(0);
  dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Confirm change' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Check current state' }).click();
  const observed = dialog.getByRole('heading', { name: 'Current membership' }).locator('..');
  await expect(observed).toContainText('Member');
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  expect(api.writes).toHaveLength(2);
});

test('unknown removal reports the observed absence while retaining unknown', async ({ page }) => {
  const api = await install(page); await start(page); api.lost = true;
  await page.locator('.team-member-row').filter({ hasText: charlie }).getByRole('button', { name: 'Remove' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Remove member' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Check current state' }).click();
  const observed = dialog.getByRole('heading', { name: 'Current membership' }).locator('..');
  await expect(observed).toContainText('Not currently a Team member.');
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  expect(api.writes).toHaveLength(1);
});

test('a pending self exit survives navigation to another Team and a Task, then exposes unknown after 404', async ({ page }) => {
  const api = await install(page, 'member'); await start(page);
  const finish = Promise.withResolvers<void>();
  api.holdWrite = { started: () => {}, wait: finish.promise }; api.lost = true;
  try {
    await test.step('dispatch the self exit and hold its response', async () => {
      await page.getByRole('button', { name: 'Leave Team' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Leave Team' }).click();
      await expect.poll(() => ({ writes: api.writes, events: api.writeEvents }), { timeout: 10000, message: 'Self exit must reach the mock and enter its response gate' }).toEqual({
        writes: [{ method: 'DELETE', path: `/api/v1/teams/${teamId}/members/${alice}`, body: { expectedUserId: alice, version: 1 } }], events: ['held'],
      });
    });
    await test.step('visit the other Team and mount the Task page', async () => {
      await traverse(page, `/teams/${betaId}/members`);
      const betaRole = page.locator(`#team-role-${betaId}-${bob}`);
      await expect(betaRole).toBeVisible(); await expect(betaRole).toHaveValue('member');
      await expect.poll(() => selected(page)).toBe(betaId);
      await traverse(page, `/projects/${projectId}/tasks/${taskId}`);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${projectId}/tasks/${taskId}`);
      await expect(page.locator('main.task-detail-page')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Retained Task', exact: true })).toBeVisible();
    });
    await test.step('lose the response and inspect the retained result after 404', async () => {
      finish.resolve();
      await expect.poll(() => api.writeEvents, { timeout: 10000, message: 'The held self-exit response must fail' }).toEqual(['held', 'response: network failure']);
      await traverse(page, `/teams/${teamId}/members`);
      await expect(page.getByRole('alert').filter({ hasText: 'result is unknown' })).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: 'This Team is unavailable or you do not have access.' }).first()).toBeVisible();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/teams/${teamId}/members`);
      await page.getByRole('button', { name: 'Check current state' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'result is unknown' })).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'result is unknown' })).toBeVisible();
      expect(api.writes).toHaveLength(1);
    });
  } finally { finish.resolve(); }
});

test('a late successful self exit updates preference without navigating away from a Task', async ({ page }) => {
  const api = await install(page, 'member'); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdWrite = { started: started.resolve, wait: finish.promise };
  await page.getByRole('button', { name: 'Leave Team' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave Team' }).click(); await started.promise;
  await traverse(page, `/projects/${projectId}/tasks/${taskId}`);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${projectId}/tasks/${taskId}`);
  finish.resolve(); await expect.poll(() => selected(page)).toBe(personalId);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${projectId}/tasks/${taskId}`);
  expect(api.writes).toHaveLength(1);
});

test('a late self exit does not overwrite a different confirmed Team choice', async ({ page }) => {
  const api = await install(page, 'member'); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdWrite = { started: started.resolve, wait: finish.promise };
  await page.getByRole('button', { name: 'Leave Team' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Leave Team' }).click(); await started.promise;
  await traverse(page, `/teams/${betaId}/members`); await expect.poll(() => selected(page)).toBe(betaId);
  finish.resolve(); await expect(page.getByText('You left the Team; direct Project grants remain.')).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/teams/${betaId}/members`);
  expect(await selected(page)).toBe(betaId); expect(api.writes).toHaveLength(1);
});

test('concurrent Team results remain distinct and a new candidate clears only its own Team', async ({ page }) => {
  const api = await install(page); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdWrite = { started: started.resolve, wait: finish.promise };
  await page.getByLabel('Team role: Bob').selectOption('member');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm change' }).click(); await started.promise;
  await traverse(page, `/teams/${betaId}/members`);
  const betaRole = page.getByRole('combobox', { name: 'Team role: Bob' });
  await expect(betaRole).toHaveValue('member');
  await betaRole.selectOption('admin');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm change' }).click();
  const result = (id: string) => page.locator('[role="status"]').filter({ hasText: id });
  await expect(result(betaId)).toContainText('Team membership updated.');
  finish.resolve(); await expect(result(teamId)).toContainText('Team membership updated.');
  await expect(result(betaId)).toBeVisible(); expect(api.writes).toHaveLength(2);
  await expect(betaRole).toHaveValue('admin');
  await betaRole.selectOption('member');
  await expect(result(betaId)).toHaveCount(0); await expect(result(teamId)).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await result(teamId).getByRole('button', { name: 'Dismiss' }).click();
  await expect(result(teamId)).toHaveCount(0); expect(api.writes).toHaveLength(2);
});

test('same-account checking retains a pending exit until a confirmed Team 404', async ({ page }) => {
  const api = await install(page, 'member'); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const teamStarted = Promise.withResolvers<void>(), teamFinish = Promise.withResolvers<void>();
  const rosterStarted = Promise.withResolvers<void>(), rosterFinish = Promise.withResolvers<void>();
  api.holdWrite = { started: started.resolve, wait: finish.promise }; api.lost = true;
  await page.getByRole('button', { name: 'Leave Team' }).click();
  const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Leave Team' }).click(); await started.promise;
  await page.route(`**/api/v1/teams/${teamId}`, async (route) => {
    teamStarted.resolve(); await teamFinish.promise; await route.fallback();
  });
  api.holdRosterRead = { started: rosterStarted.resolve, wait: rosterFinish.promise };
  await foreground(page, api);
  try {
    await expect(dialog).toBeVisible(); await expect(page.locator('.auth-modal-backdrop')).not.toHaveAttribute('hidden', '');
    await Promise.all([teamStarted.promise, rosterStarted.promise]); await expect(dialog).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/teams/${teamId}/members`);
    teamFinish.resolve(); rosterFinish.resolve();
    await expect(page.getByRole('alert').filter({ hasText: 'This Team is unavailable or you do not have access.' }).first()).toBeVisible();
    await expect(dialog).toBeHidden();
    finish.resolve();
    await expect(page.getByRole('alert').filter({ hasText: 'result is unknown' })).toBeVisible();
    await page.getByRole('button', { name: 'Check current state' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'result is unknown' })).toBeVisible();
    expect(api.writes).toHaveLength(1);
  } finally { teamFinish.resolve(); rosterFinish.resolve(); finish.resolve(); }
});

for (const [width, locale] of [[1280, 'en'], [390, 'zh-CN']] as const) test(`retains members and invitation confirmation through background reads at ${width}px`, async ({ page }, testInfo) => {
  const api = await install(page); await page.setViewportSize({ width, height: 844 });
  await start(page); await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
  const invite = page.getByRole('button', { name: locale === 'en' ? 'Invite member' : '邀请成员' });
  await expect(invite).toBeVisible(); await expect(invite).toBeEnabled();
  const panel = invite.locator('xpath=ancestor::section');
  const originalPanel = await panel.elementHandle(), panelBox = await panel.boundingBox();
  await invite.click();
  const dialog = page.getByRole('dialog'), originalDialog = await dialog.elementHandle(), dialogBox = await dialog.boundingBox();
  const rosterStarted = Promise.withResolvers<void>(), rosterFinish = Promise.withResolvers<void>();
  const inviteStarted = Promise.withResolvers<void>(), inviteFinish = Promise.withResolvers<void>();
  api.holdRosterRead = { started: rosterStarted.resolve, wait: rosterFinish.promise };
  api.holdInvitationRead = { started: inviteStarted.resolve, wait: inviteFinish.promise };
  await foreground(page, api);
  const verify = async () => {
    expect(await panel.evaluate((element, original) => element === original, originalPanel)).toBe(true);
    expect(await dialog.evaluate((element, original) => element === original, originalDialog)).toBe(true);
    expect(await panel.boundingBox()).toEqual(panelBox); expect(await dialog.boundingBox()).toEqual(dialogBox);
    await expect(dialog).toBeVisible();
    expect(api.writes).toHaveLength(0); expect(api.invitationWrites).toBe(0);
  };
  try {
    await verify(); await rosterStarted.promise; await verify();
    rosterFinish.resolve(); await inviteStarted.promise; await verify();
    inviteFinish.resolve(); await expect(invite).toBeEnabled(); await verify();
    await page.screenshot({ path: testInfo.outputPath(`background-${width}-${locale}.png`) });
  } finally { rosterFinish.resolve(); inviteFinish.resolve(); }
});

test('narrow viewport and Chinese dialog retain usable controls', async ({ page }) => {
  const api = await install(page); await page.setViewportSize({ width: 375, height: 667 }); await start(page);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await page.getByLabel('Team 角色: Bob').selectOption('member'); const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: '语言 / Language' })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: '修改 Team 角色' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认修改' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(api.writes).toHaveLength(0);
});
