import { randomUUID } from 'node:crypto';
import type { APIRequest, BrowserContext, Page, Route } from '@playwright/test';
import { expect, createProject, type BrowserWriteExpectation } from './fixtures';
import { bearerContext, browserAuthentication, type AuthenticatedAPI } from './authentication';

// The caller disables traces and screenshots while invitation secrets are visible.
export const verifyScopedInvitationManagement = async (page: Page, context: BrowserContext, apiRequest: APIRequest, request: AuthenticatedAPI, baseURL: string, allowWrites: (entries: readonly BrowserWriteExpectation[]) => void) => {
  const identityResponse = await request.get('/api/v1/me');
  expect(identityResponse.status()).toBe(200);
  const identity = await identityResponse.json() as { id: string; personalTeam: { id: string } };
  const createdTeam = await request.post('/api/v1/teams', { data: { name: `Invitation management ${randomUUID()}`, expectedUserId: identity.id } });
  expect(createdTeam.status()).toBe(201);
  const team = await createdTeam.json() as { id: string };
  const project = await createProject(request, { name: `Invitation management ${randomUUID()}` });
  const teamUrl = `${baseURL}/api/v1/teams/${team.id}/invitations`;
  const projectUrl = `${baseURL}/api/v1/projects/${project.id}/invitations`;
  allowWrites([{ method: 'POST', url: teamUrl, count: 4 }, { method: 'POST', url: projectUrl, count: 3 }]);

  // Personal membership never exposes the Team invitation controls.
  await page.goto(`/teams/${identity.personalTeam.id}/members`);
  await expect(page.getByRole('heading', { name: 'Team 成员', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '有效邀请', exact: true })).toHaveCount(0);

  await page.goto(`/teams/${team.id}/members`);
  const invite = page.getByRole('button', { name: '邀请成员', exact: true });
  await expect(invite).toBeEnabled();
  await page.locator(`a.nav-button[href="/teams/${team.id}"]`).click();
  await page.locator(`a.nav-button[href="/teams/${team.id}/members"]`).click();
  await expect(invite).toBeEnabled();
  await invite.click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '创建 Team 邀请链接' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(invite).toBeFocused();
  await invite.click();
  const responsePromise = page.waitForResponse((response) => response.url() === teamUrl && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: '创建邀请链接', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const created = await response.json() as { id: string; link: string };
  expect(await page.getByLabel('一次性邀请链接').inputValue() === created.link, 'The issued link appears only in the result').toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}/teams/${team.id}`);
  await expect(page.getByLabel('一次性邀请链接')).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(`${baseURL}/teams/${team.id}/members`);
  await expect(page.getByLabel('一次性邀请链接')).toBeVisible();
  expect(await page.getByLabel('一次性邀请链接').inputValue() === created.link, 'The confirmed link survives history navigation').toBe(true);
  await dialog.getByRole('button', { name: '我已保存，关闭', exact: true }).click();
  await expect(page.getByLabel('一次性邀请链接')).toHaveCount(0);
  await expect(page.getByText(created.id, { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText().then((text) => !text.includes(created.link))).toBe(true);
  const teamList = await request.get(`/api/v1/teams/${team.id}/invitations`);
  const teamItems = await teamList.json() as { items: Array<Record<string, unknown>> };
  expect(teamItems.items.some((item) => item.id === created.id && !Object.hasOwn(item, 'link'))).toBe(true);
  const teamRevoke = page.getByRole('button', { name: `撤销邀请 ${created.id}` });
  await teamRevoke.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(teamRevoke).toBeFocused();
  await teamRevoke.click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(teamRevoke).toBeFocused();
  allowWrites([{ method: 'DELETE', url: `${teamUrl}/${created.id}`, count: 1 }]);
  await teamRevoke.click();
  const revoked = page.waitForResponse((value) => value.url() === `${teamUrl}/${created.id}` && value.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: '撤销邀请', exact: true }).click();
  expect((await revoked).status()).toBe(200);
  await expect(page.getByText(created.id, { exact: true })).toHaveCount(0);

  // A browser history change must not discard an already dispatched result.
  await page.locator(`a.nav-button[href="/teams/${team.id}"]`).click();
  await page.locator(`a.nav-button[href="/teams/${team.id}/members"]`).click();
  const held = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  let retainedLink = '';
  let retainedStatus = 0;
  const holdResponse = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const result = await route.fetch();
    retainedStatus = result.status();
    retainedLink = (await result.json() as { link: string }).link;
    reached.resolve();
    await held.promise;
    await route.fulfill({ response: result });
  };
  await page.route(teamUrl, holdResponse);
  try {
    await invite.click();
    await dialog.getByRole('button', { name: '创建邀请链接', exact: true }).click();
    await reached.promise;
    expect(retainedStatus).toBe(201);
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/teams/${team.id}`);
    held.resolve();
    await expect(page.getByLabel('一次性邀请链接')).toBeHidden();
    await page.goForward();
    await expect(page).toHaveURL(`${baseURL}/teams/${team.id}/members`);
    await expect(page.getByLabel('一次性邀请链接')).toBeVisible();
    expect(await page.getByLabel('一次性邀请链接').inputValue() === retainedLink).toBe(true);
    await dialog.getByRole('button', { name: '我已保存，关闭', exact: true }).click();
  } finally { held.resolve(); await page.unroute(teamUrl, holdResponse); }

  // Drop the successful response after the real server commits; the browser must not replay it.
  let committed = 0;
  const loseResponse = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const result = await route.fetch(); committed = result.status(); await route.abort();
  };
  await page.route(teamUrl, loseResponse);
  try {
    await invite.click();
    await dialog.getByRole('button', { name: '创建邀请链接', exact: true }).click();
    await expect(dialog.getByText('邀请变更结果尚未确认。请先读取当前邀请；丢失的链接无法恢复。')).toBeVisible();
    expect(committed).toBe(201);
    await expect(dialog.getByRole('button', { name: '创建邀请链接', exact: true })).toHaveCount(0);
  } finally { await page.unroute(teamUrl, loseResponse); }
  await dialog.getByRole('button', { name: '读取当前邀请', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('已读取当前邀请；原操作结果仍未确认。请审阅后再操作。')).toBeVisible();

  await page.goto(`/projects/${project.id}/members`);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  const projectInvite = page.getByRole('button', { name: 'Invite member', exact: true });
  await expect(projectInvite).toBeEnabled();
  await page.locator(`.project-management-nav a[href="/projects/${project.id}"]`).click();
  await page.locator(`a[href="/projects/${project.id}/members"]:visible`).first().click();
  await expect(projectInvite).toBeEnabled();
  await projectInvite.click();
  dialog = page.getByRole('dialog');
  const projectCreatedPromise = page.waitForResponse((value) => value.url() === projectUrl && value.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  const projectResponse = await projectCreatedPromise;
  expect(projectResponse.status()).toBe(201);
  const projectCreated = await projectResponse.json() as { id: string; link: string };
  expect(await page.getByLabel('One-time invitation link').inputValue() === projectCreated.link).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL(`${baseURL}/projects/${project.id}`);
  await expect(page.getByLabel('One-time invitation link')).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(`${baseURL}/projects/${project.id}/members`);
  await expect(page.getByLabel('One-time invitation link')).toBeVisible();
  expect(await page.getByLabel('One-time invitation link').inputValue() === projectCreated.link).toBe(true);
  await dialog.getByRole('button', { name: 'I have saved it, close', exact: true }).click();
  await expect(page.getByLabel('One-time invitation link')).toHaveCount(0);
  await expect(page.getByText(projectCreated.id, { exact: true })).toBeVisible();
  expect(await page.locator('body').innerText().then((text) => !text.includes(projectCreated.link))).toBe(true);
  const projectList = await request.get(`/api/v1/projects/${project.id}/invitations`);
  const projectItems = await projectList.json() as { items: Array<Record<string, unknown>> };
  expect(projectItems.items.some((item) => item.id === projectCreated.id && !Object.hasOwn(item, 'link'))).toBe(true);
  const projectRevoke = page.getByRole('button', { name: `Revoke invitation ${projectCreated.id}` });
  await projectRevoke.click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(projectRevoke).toBeFocused();
  allowWrites([{ method: 'DELETE', url: `${projectUrl}/${projectCreated.id}`, count: 1 }]);
  await projectRevoke.click();
  const projectRevoked = page.waitForResponse((value) => value.url() === `${projectUrl}/${projectCreated.id}` && value.request().method() === 'DELETE');
  await dialog.getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  expect((await projectRevoked).status()).toBe(204);
  await expect(page.getByText(projectCreated.id, { exact: true })).toHaveCount(0);

  await page.locator(`.project-management-nav a[href="/projects/${project.id}"]`).click();
  await page.locator(`a[href="/projects/${project.id}/members"]:visible`).first().click();
  const projectHeld = Promise.withResolvers<void>();
  const projectReached = Promise.withResolvers<void>();
  let projectRetainedLink = '';
  let projectRetainedStatus = 0;
  const holdProject = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const result = await route.fetch();
    projectRetainedStatus = result.status();
    projectRetainedLink = (await result.json() as { link: string }).link;
    projectReached.resolve();
    await projectHeld.promise;
    await route.fulfill({ response: result });
  };
  await page.route(projectUrl, holdProject);
  try {
    await projectInvite.click();
    await dialog.getByRole('button', { name: 'Create invitation link', exact: true }).click();
    await projectReached.promise;
    expect(projectRetainedStatus).toBe(201);
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/projects/${project.id}`);
    projectHeld.resolve();
    await expect(page.getByLabel('One-time invitation link')).toBeHidden();
    await page.goForward();
    await expect(page).toHaveURL(`${baseURL}/projects/${project.id}/members`);
    await expect(page.getByLabel('One-time invitation link')).toBeVisible();
    expect(await page.getByLabel('One-time invitation link').inputValue() === projectRetainedLink).toBe(true);
    await dialog.getByRole('button', { name: 'I have saved it, close', exact: true }).click();
  } finally { projectHeld.resolve(); await page.unroute(projectUrl, holdProject); }

  const unknownHeld = Promise.withResolvers<void>();
  const unknownReached = Promise.withResolvers<void>();
  let projectUnknownStatus = 0;
  const loseProject = async (route: Route) => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const result = await route.fetch();
    projectUnknownStatus = result.status();
    unknownReached.resolve();
    await unknownHeld.promise;
    await route.abort();
  };
  await page.route(projectUrl, loseProject);
  try {
    await projectInvite.click();
    await dialog.getByRole('button', { name: 'Create invitation link', exact: true }).click();
    await unknownReached.promise;
    expect(projectUnknownStatus).toBe(201);
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/projects/${project.id}`);
    unknownHeld.resolve();
    await page.goForward();
    await expect(page.getByText('The invitation change was not confirmed. Read current invitations before making another change. A lost link cannot be recovered.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite member', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Read current invitations', exact: true }).click();
    await expect(page.getByText('Current invitations are shown; the original result is still unknown. Review before changing them.')).toBeVisible();
  } finally { unknownHeld.resolve(); await page.unroute(projectUrl, loseProject); }
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');

  // An existing direct grant is preserved and does not consume the same invitation.
  const teamProjectResponse = await request.post('/api/v1/projects', { data: { name: `Inherited invite ${randomUUID()}`, repoUrl: `https://example.com/${randomUUID()}`, teamId: team.id, expectedUserId: identity.id } });
  expect(teamProjectResponse.status()).toBe(201);
  const teamProject = await teamProjectResponse.json() as { id: string; name: string };
  const scopedInviteResponse = await request.post(`/api/v1/projects/${teamProject.id}/invitations`, { data: { expectedUserId: identity.id } });
  expect(scopedInviteResponse.status()).toBe(201);
  const scopedInvite = await scopedInviteResponse.json() as { id: string; link: string };
  const token = new URL(scopedInvite.link).hash.slice(1);
  const existing = await request.post('/api/v1/invitations/accept', { data: { token, expectedUserId: identity.id } });
  expect(existing.status()).toBe(200);
  expect(await existing.json()).toMatchObject({ projectId: teamProject.id, directGrant: { role: 'admin', userId: identity.id }, joined: false, consumed: false });
  const stillAvailable = await request.get(`/api/v1/projects/${teamProject.id}/invitations`);
  expect((await stillAvailable.json() as { items: { id: string }[] }).items.some((item) => item.id === scopedInvite.id)).toBe(true);

  const bob = await bearerContext(apiRequest, baseURL, 'bob');
  try {
    const bobIdentity = await (await bob.get('/api/v1/me')).json() as { id: string };
    const teamInviteResponse = await request.post(`/api/v1/teams/${team.id}/invitations`, { data: { expectedUserId: identity.id } });
    expect(teamInviteResponse.status()).toBe(201);
    const teamInvite = await teamInviteResponse.json() as { link: string };
    const joined = await bob.post('/api/v1/team-invitations/accept', { data: { token: new URL(teamInvite.link).hash.slice(1), expectedUserId: bobIdentity.id } });
    expect(joined.status()).toBe(200);
    const joinedMember = await joined.json() as { membership: { version: number } };
    const promote = await request.patch(`/api/v1/teams/${team.id}/members/${bobIdentity.id}`, { data: { role: 'admin', version: joinedMember.membership.version, expectedUserId: identity.id } });
    expect(promote.status()).toBe(200);
    const before = await bob.get(`/api/v1/projects/${teamProject.id}/access`);
    expect(before.status()).toBe(200);
    expect(await before.json()).toMatchObject({ effectiveRole: 'admin', teamRole: 'admin', directGrant: null });
    await browserAuthentication(context, baseURL, 'bob');
    try { await page.goto(scopedInvite.link); } catch { throw new Error('The project invitation document could not be opened.'); }
    await expect(page.getByRole('heading', { name: '你受邀加入一个项目' })).toBeVisible();
    await page.getByRole('button', { name: '接受邀请并加入', exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/projects/${teamProject.id}`);
    await expect(page.getByRole('heading', { name: teamProject.name, exact: true })).toBeVisible();
    const after = await bob.get(`/api/v1/projects/${teamProject.id}/access`);
    expect(after.status()).toBe(200);
    expect(await after.json()).toMatchObject({ effectiveRole: 'admin', teamRole: 'admin', directGrant: { userId: bobIdentity.id, role: 'member' } });

    // A lost invitation result remains visible when another admin demotes its actor.
    const roster = await bob.get(`/api/v1/teams/${team.id}/members`);
    expect(roster.status()).toBe(200);
    const alice = (await roster.json() as { items: { userId: string; version: number }[] }).items.find((member) => member.userId === identity.id);
    expect(alice).toBeDefined();
    await browserAuthentication(context, baseURL, 'alice');
    await page.goto(`/teams/${team.id}`);
    await page.locator(`a.nav-button[href="/teams/${team.id}/members"]`).click();
    const teamHeld = Promise.withResolvers<void>();
    const teamReached = Promise.withResolvers<void>();
    let demotionWriteStatus = 0;
    const loseDuringDemotion = async (route: Route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const result = await route.fetch();
      demotionWriteStatus = result.status();
      teamReached.resolve();
      await teamHeld.promise;
      await route.abort();
    };
    await page.route(teamUrl, loseDuringDemotion);
    try {
      await page.getByRole('button', { name: '邀请成员', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '创建邀请链接', exact: true }).click();
      await teamReached.promise;
      expect(demotionWriteStatus).toBe(201);
      await page.goBack();
      await expect(page).toHaveURL(`${baseURL}/teams/${team.id}`);
      const demotion = await bob.patch(`/api/v1/teams/${team.id}/members/${identity.id}`, { data: { role: 'member', version: alice!.version, expectedUserId: bobIdentity.id } });
      expect(demotion.status()).toBe(200);
      const failed = page.waitForEvent('requestfailed', (event) => event.url() === teamUrl && event.method() === 'POST');
      teamHeld.resolve();
      await failed;
      await page.goForward();
      await expect(page.getByText('邀请变更结果仍未确认；你已无权读取此 Team 的邀请。')).toBeVisible();
      if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0);
      const leave = page.getByRole('button', { name: '退出 Team', exact: true });
      await expect(leave).toBeEnabled();
      allowWrites([{ method: 'DELETE', url: `${baseURL}/api/v1/teams/${team.id}/members/${identity.id}`, count: 1 }]);
      await leave.click();
      await page.getByRole('dialog').getByRole('button', { name: '退出 Team', exact: true }).click();
      await expect(page).toHaveURL(`${baseURL}/teams/${identity.personalTeam.id}`);
      const remaining = await bob.get(`/api/v1/teams/${team.id}/members`);
      expect(remaining.status()).toBe(200);
      expect((await remaining.json() as { items: { userId: string }[] }).items.some((member) => member.userId === identity.id)).toBe(false);
    } finally { teamHeld.resolve(); await page.unroute(teamUrl, loseDuringDemotion); }

    // Losing membership after demotion must retain the same unknown result.
    const lostTeamResponse = await request.post('/api/v1/teams', { data: { name: `Lost access ${randomUUID()}`, expectedUserId: identity.id } });
    expect(lostTeamResponse.status()).toBe(201);
    const lostTeam = await lostTeamResponse.json() as { id: string; membership: { version: number } };
    const lostInvite = await request.post(`/api/v1/teams/${lostTeam.id}/invitations`, { data: { expectedUserId: identity.id } });
    expect(lostInvite.status()).toBe(201);
    const lostLink = await lostInvite.json() as { link: string };
    const bobJoined = await bob.post('/api/v1/team-invitations/accept', { data: { token: new URL(lostLink.link).hash.slice(1), expectedUserId: bobIdentity.id } });
    expect(bobJoined.status()).toBe(200);
    const bobMembership = await bobJoined.json() as { membership: { version: number } };
    const bobPromoted = await request.patch(`/api/v1/teams/${lostTeam.id}/members/${bobIdentity.id}`, { data: { role: 'admin', version: bobMembership.membership.version, expectedUserId: identity.id } });
    expect(bobPromoted.status()).toBe(200);
    const lostUrl = `${baseURL}/api/v1/teams/${lostTeam.id}/invitations`;
    allowWrites([{ method: 'POST', url: lostUrl, count: 1 }]);
    await page.goto(`/teams/${lostTeam.id}`);
    await page.locator(`a.nav-button[href="/teams/${lostTeam.id}/members"]`).click();
    const lostHeld = Promise.withResolvers<void>();
    const lostReached = Promise.withResolvers<void>();
    let lostStatus = 0;
    const loseBeforeRemoval = async (route: Route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const result = await route.fetch();
      lostStatus = result.status();
      lostReached.resolve();
      await lostHeld.promise;
      await route.abort();
    };
    await page.route(lostUrl, loseBeforeRemoval);
    try {
      await page.getByRole('button', { name: '邀请成员', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '创建邀请链接', exact: true }).click();
      await lostReached.promise;
      expect(lostStatus).toBe(201);
      await page.goBack();
      await expect(page).toHaveURL(`${baseURL}/teams/${lostTeam.id}`);
      const demotion = await bob.patch(`/api/v1/teams/${lostTeam.id}/members/${identity.id}`, { data: { role: 'member', version: lostTeam.membership.version, expectedUserId: bobIdentity.id } });
      expect(demotion.status()).toBe(200);
      const demoted = await demotion.json() as { membership: { version: number } };
      const failed = page.waitForEvent('requestfailed', (event) => event.url() === lostUrl && event.method() === 'POST');
      lostHeld.resolve();
      await failed;
      await page.goForward();
      await expect(page.getByText('邀请变更结果仍未确认；你已无权读取此 Team 的邀请。')).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(`${baseURL}/teams/${lostTeam.id}`);
      const removed = await bob.delete(`/api/v1/teams/${lostTeam.id}/members/${identity.id}`, { data: { version: demoted.membership.version, expectedUserId: bobIdentity.id } });
      expect(removed.status()).toBe(200);
      await page.goForward();
      await expect(page.getByText('邀请变更结果仍未确认；此 Team 不可用或你已无权访问。')).toBeVisible();
      await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0);
    } finally { lostHeld.resolve(); await page.unroute(lostUrl, loseBeforeRemoval); }
  } finally {
    await bob.dispose();
    await browserAuthentication(context, baseURL, 'alice');
    await page.goto('/projects');
  }
};
