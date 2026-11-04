import { randomUUID } from 'node:crypto';
import type { Page, Route } from '@playwright/test';
import { expect, createProject, type BrowserWriteExpectation } from './fixtures';
import type { AuthenticatedAPI } from './authentication';

// The caller disables traces and screenshots while invitation secrets are visible.
export const verifyScopedInvitationManagement = async (page: Page, request: AuthenticatedAPI, baseURL: string, allowWrites: (entries: readonly BrowserWriteExpectation[]) => void) => {
  const identityResponse = await request.get('/api/v1/me');
  expect(identityResponse.status()).toBe(200);
  const identity = await identityResponse.json() as { id: string; personalTeam: { id: string } };
  const createdTeam = await request.post('/api/v1/teams', { data: { name: `Invitation management ${randomUUID()}`, expectedUserId: identity.id } });
  expect(createdTeam.status()).toBe(201);
  const team = await createdTeam.json() as { id: string };
  const project = await createProject(request, { name: `Invitation management ${randomUUID()}` });
  const teamUrl = `${baseURL}/api/v1/teams/${team.id}/invitations`;
  const projectUrl = `${baseURL}/api/v1/projects/${project.id}/invitations`;
  allowWrites([{ method: 'POST', url: teamUrl, count: 3 }, { method: 'POST', url: projectUrl, count: 3 }]);

  // Personal membership never exposes the Team invitation controls.
  await page.goto(`/teams/${identity.personalTeam.id}/members`);
  await expect(page.getByRole('heading', { name: 'Team 成员', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '有效邀请', exact: true })).toHaveCount(0);

  await page.goto(`/teams/${team.id}/members`);
  const invite = page.getByRole('button', { name: '邀请成员', exact: true });
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
  await projectInvite.click();
  dialog = page.getByRole('dialog');
  const projectCreatedPromise = page.waitForResponse((value) => value.url() === projectUrl && value.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create invitation link', exact: true }).click();
  const projectResponse = await projectCreatedPromise;
  expect(projectResponse.status()).toBe(201);
  const projectCreated = await projectResponse.json() as { id: string; link: string };
  expect(await page.getByLabel('One-time invitation link').inputValue() === projectCreated.link).toBe(true);
  await dialog.getByRole('button', { name: 'I have saved it, close', exact: true }).click();
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
};
