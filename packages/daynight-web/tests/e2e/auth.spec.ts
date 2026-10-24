import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { attachmentDownloadUrl, attachmentPreviewUrl } from '../../src/api/client';
import { authenticatedAPI, bearerContext, browserAuthentication, tokenContext, type AuthenticatedAPI } from './authentication';
import { executeTask, createProject, createTask, expect, test } from './fixtures';

const scenario = (description: string) => ({ annotation: { type: 'scenario', description } });
const origin = (info: TestInfo): string => {
  const value = info.project.use.baseURL;
  if (typeof value !== 'string') throw new Error('Authentication acceptance requires the exact product origin.');
  return value;
};
const picture = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
};
const openInvitation = async (page: Page, link: string): Promise<void> => {
  try { await page.goto(link); }
  catch { throw new Error('The invitation document could not be opened.'); }
};
const user = async (request: AuthenticatedAPI): Promise<{ id: string; name: string; email: string }> => {
  const response = await request.get('/api/v1/me');
  expect(response.status()).toBe(200);
  return await response.json() as { id: string; name: string; email: string };
};
const invitation = async (request: AuthenticatedAPI, projectId: string): Promise<{ id: string; token: string }> => {
  const response = await request.post(`/api/v1/projects/${projectId}/invitations`, { data: {} });
  expect(response.status()).toBe(201);
  const value = await response.json() as { id: string; link: string };
  return { id: value.id, token: new URL(value.link).hash.slice(1) };
};
const memberList = async (request: AuthenticatedAPI, projectId: string): Promise<{ userId: string; role: string; version: number }[]> => {
  const response = await request.get(`/api/v1/projects/${projectId}/members`);
  expect(response.status()).toBe(200);
  return (await response.json() as { items: { userId: string; role: string; version: number }[] }).items;
};

test.use({ trace: 'off', screenshot: 'off' });
test.afterEach(async ({ context }, info) => {
  if (info.status !== info.expectedStatus) await Promise.all(context.pages().map((page) => page.close()));
});

test.describe('visible authentication protocol', () => {
  test.use({ authentication: 'visible' });
  test('auth-login-session', scenario('auth-login-session'), async ({ page, context, api: request, allowBrowserWrites }, info) => {
    const baseURL = origin(info);
    const project = await createProject(request, { name: `Visible login ${randomUUID()}` });
    allowBrowserWrites([{ method: 'POST', url: `${baseURL}/api/v1/auth/logout`, count: 1 }]);
    const providerSession = await context.newCDPSession(page);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const controlledProvider = new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('The controlled external provider request was not reached.')), 15_000);
      providerSession.once('Fetch.requestPaused', (event) => {
        void (async () => {
          const upstream = new URL(event.request.url);
          if (upstream.origin !== 'https://github.com' || upstream.pathname !== '/login/oauth/authorize'
            || upstream.searchParams.get('code_challenge_method') !== 'S256') throw new Error('The external provider authorization or PKCE request changed.');
          const challenge = upstream.searchParams.get('code_challenge');
          const state = upstream.searchParams.get('state');
          const callback = upstream.searchParams.get('redirect_uri');
          if (challenge === null || state === null || callback === null) throw new Error('External provider request omitted required PKCE or callback fields.');
          const target = new URL(callback);
          target.search = new URLSearchParams({ state, code: `alice:${challenge}` }).toString();
          await providerSession.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 302,
            responseHeaders: [{ name: 'Location', value: target.href }], body: '' });
        })().then(resolve, reject);
      });
    });
    // The external provider is controlled; application and gateway redirects use their real handlers.
    try {
      await providerSession.send('Fetch.enable', { patterns: [{ urlPattern: 'https://github.com/login/oauth/authorize*', requestStage: 'Request' }] });
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole('heading', { name: '登录你的工作空间' })).toBeVisible();
      await Promise.all([page.getByRole('button', { name: '使用 GitHub 登录', exact: true }).click(), controlledProvider]);
      await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
      await expect(page).toHaveURL(`${baseURL}/projects/${project.id}`);
      expect((await authenticatedAPI(context.request).get('/api/v1/me')).status()).toBe(200);
      await page.reload();
      await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
      const signedOut = page.waitForResponse((response) => response.url() === `${baseURL}/api/v1/auth/logout` && response.request().method() === 'POST');
      await page.getByRole('button', { name: '退出登录', exact: true }).click();
      await expect(page.getByRole('heading', { name: '登录你的工作空间' })).toBeVisible();
      expect((await signedOut).status()).toBe(204);
      expect((await authenticatedAPI(context.request).get('/api/v1/me')).status()).toBe(401);
      await picture(page, info, 'auth-login-session');
    } finally {
      clearTimeout(deadline);
      await providerSession.send('Fetch.disable');
      await providerSession.detach();
    }
  });
});

test('auth-project-isolation', scenario('auth-project-isolation'), async ({ page, context, api: request, playwright }, info) => {
  const baseURL = origin(info);
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  const anonymous = await playwright.request.newContext({ baseURL });
  let otherTab: Page | undefined;
  const heldChecks: { readonly identity: string; readonly release: () => void; readonly completed: Promise<void> }[] = [];
  try {
    const own = await createProject(request, { name: `Alice private ${randomUUID()}` });
    const other = await createProject(bob, { name: `Bob private ${randomUUID()}` });
    const aliceUser = await user(request);
    const bobUser = await user(bob);
    expect(aliceUser.email).toBe(bobUser.email);
    expect(aliceUser.id).not.toBe(bobUser.id);
    const task = await createTask(request, own.id, { title: 'Private resource boundary', description: 'Visible only to project members.' });
    const file = attachmentDownloadUrl(own.id, task.id, 'site/index.html');
    const preview = attachmentPreviewUrl(own.id, task.id, 'site/index.html');
    expect((await request.put(file, { headers: { 'Content-Type': 'text/html' }, data: '<!doctype html><button>Private file</button>' })).status()).toBe(201);
    const paths = [`/api/v1/projects/${own.id}`, `/api/v1/projects/${own.id}/task-graph`, `/api/v1/projects/${own.id}/tasks`,
      `/api/v1/projects/${own.id}/tasks/${task.id}`, `/api/v1/projects/${own.id}/tasks/${task.id}/attachments`, file, preview,
      `/api/v1/projects/${own.id}/members`, `/api/v1/projects/${own.id}/invitations`];
    for (const path of paths) {
      expect((await bob.get(path)).status(), 'Non-members cannot read another project resource').toBe(404);
      const response = await anonymous.get(path);
      expect(response.status(), 'Anonymous resource requests require authentication').toBe(401);
      expect(response.headers()['content-type']).toMatch(/^application\/json/);
    }
    expect((await bob.head(preview)).status()).toBe(404);
    expect((await anonymous.head(preview)).status()).toBe(401);
    for (const status of ['todo', 'in_progress', 'done']) {
      const transition = `/api/v1/projects/${own.id}/tasks/${task.id}/status`;
      expect((await bob.put(transition, { data: { version: task.version, status } })).status()).toBe(404);
      expect((await anonymous.put(transition, { data: { version: task.version, status } })).status()).toBe(401);
    }
    const list = async (actor: AuthenticatedAPI): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await actor.get(`/api/v1/projects?limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        expect(response.status()).toBe(200);
        const result = await response.json() as { items: { id: string }[]; nextCursor: string | null };
        ids.push(...result.items.map((item) => item.id));
        cursor = result.nextCursor;
      } while (cursor !== null);
      return ids;
    };
    expect(await list(request)).toContain(own.id);
    expect(await list(request)).not.toContain(other.id);
    expect(await list(bob)).toContain(other.id);
    expect(await list(bob)).not.toContain(own.id);
    await page.goto(`/projects/${other.id}`);
    await expect(page.getByRole('heading', { name: '项目不存在或你没有访问权限' })).toBeVisible();
    expect((await request.get('/api/v1/me')).status()).toBe(200);
    await picture(page, info, 'auth-project-isolation');
    await page.goto(`/projects/${own.id}`);
    await expect(page.getByRole('heading', { name: own.name, exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '独立任务', exact: true }).click();
    await page.locator(`#standalone-task-${task.id}`).click();
    const detail = page.locator('.task-detail-dialog');
    await expect(detail.locator('.task-detail-title')).toHaveText(task.title);
    await detail.getByRole('tab', { name: '附件', exact: true }).click();
    await detail.locator('button.attachment-file').filter({ hasText: /index\.html/ }).click();
    await expect(detail.frameLocator('iframe').getByRole('button', { name: 'Private file' })).toBeVisible();
    await detail.locator('.attachment-upload-disclosure>summary').click();
    const fileInput = detail.getByLabel('选择一个文件', { exact: true });
    await fileInput.setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsubmitted foreground draft') });
    const attachmentPath = detail.getByRole('textbox', { name: '目标相对路径', exact: true });
    await attachmentPath.fill('draft/retained.txt');
    const originalShell = await page.locator('.auth-shell').elementHandle();
    const originalDetail = await detail.elementHandle();
    const originalFrame = await detail.locator('iframe').elementHandle();
    expect(originalShell).not.toBeNull();
    expect(originalDetail).not.toBeNull();
    expect(originalFrame).not.toBeNull();
    const identityRequests: string[] = [];
    const graphRequests: string[] = [];
    const requestOrder: string[] = [];
    const identityRequestNumbers = new WeakMap<object, number>();
    const graphRequestNumbers = new WeakMap<object, number>();
    const pendingGraphWindows: { readonly identity: 'same-user' | 'changed-user'; readonly baseline: number; readonly beforeRelease: number }[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/v1/me') {
        identityRequests.push(request.method());
        identityRequestNumbers.set(request, identityRequests.length);
        requestOrder.push(`identity-request:${identityRequests.length}`);
      } else if (pathname === `/api/v1/projects/${own.id}/task-sync`) {
        graphRequests.push(request.method());
        graphRequestNumbers.set(request, graphRequests.length);
        requestOrder.push(`graph-request:${graphRequests.length}`);
      }
    });
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/v1/me') requestOrder.push(`identity-response:${identityRequestNumbers.get(response.request())!}`);
    });
    const queueGraphWhileAway = async (): Promise<void> => {
      expect(await page.evaluate(() => document.hasFocus())).toBe(false);
      const refresh = page.locator('.project-title-actions>button');
      // Invoke the existing refresh handler without bringing the document back into focus.
      await refresh.evaluate((button: HTMLButtonElement) => {
        button.click();
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      await expect(refresh).toBeDisabled();
    };
    await page.evaluate(() => {
      const state = window as unknown as { authContinuity: boolean[]; stopAuthContinuity: () => void };
      const shell = document.querySelector('.auth-shell')!;
      const detail = document.querySelector('.task-detail-dialog')!;
      const frame = detail.querySelector('iframe')!;
      const sample = () => state.authContinuity.push(shell.isConnected && detail.isConnected && frame.isConnected
        && getComputedStyle(shell).visibility === 'visible' && getComputedStyle(detail).visibility === 'visible'
        && !shell.hasAttribute('inert') && shell.getAttribute('aria-hidden') !== 'true'
        && !document.body.classList.contains('auth-session-checking') && document.querySelector('.auth-revalidation-overlay') === null);
      state.authContinuity = [];
      const observer = new MutationObserver(sample);
      observer.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'aria-hidden', 'inert'] });
      state.stopAuthContinuity = () => { sample(); observer.disconnect(); };
      sample();
    });
    const primaryFocus = await context.newCDPSession(page);
    await primaryFocus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await primaryFocus.detach();
    otherTab = await context.newPage();
    await otherTab.goto('/');
    const secondaryFocus = await context.newCDPSession(otherTab);
    await secondaryFocus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await secondaryFocus.detach();
    await otherTab.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    const sameUserGraphBaseline = graphRequests.length;
    requestOrder.push('external-departure:1');
    await queueGraphWhileAway();
    expect(graphRequests).toHaveLength(sameUserGraphBaseline);
    await page.route(`${baseURL}/api/v1/me`, async (route) => {
      const response = await authenticatedAPI(context.request).get('/api/v1/me');
      expect(response.status()).toBe(200);
      const body = await response.body();
      const release = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      heldChecks.push({ identity: (JSON.parse(body.toString()) as { id: string }).id, release: release.resolve, completed: completed.promise });
      try {
        await release.promise;
        await route.fulfill({ status: response.status(), headers: response.headers(), body });
      } finally { completed.resolve(); }
    });
    await page.bringToFront();
    await expect.poll(() => heldChecks.length).toBe(1);
    expect(heldChecks[0]!.identity).toBe(aliceUser.id);
    await expect(page.locator('body')).not.toHaveClass(/auth-session-checking/);
    await expect(page.locator('.auth-revalidation-overlay')).toHaveCount(0);
    await expect(detail).toBeVisible();
    await expect(attachmentPath).toBeFocused();
    await attachmentPath.press('End');
    await attachmentPath.pressSequentially('.pending');
    await expect(attachmentPath).toHaveValue('draft/retained.txt.pending');
    expect(graphRequests).toHaveLength(sameUserGraphBaseline);
    pendingGraphWindows.push({ identity: 'same-user', baseline: sameUserGraphBaseline, beforeRelease: graphRequests.length });
    const sameUserResponse = page.waitForResponse(`${baseURL}/api/v1/me`);
    const sameUserGraph = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${own.id}/task-sync`
      && graphRequestNumbers.get(response.request())! > sameUserGraphBaseline);
    heldChecks[0]!.release();
    await heldChecks[0]!.completed;
    await (await sameUserResponse).finished();
    expect((await sameUserGraph).status()).toBe(200);
    expect(graphRequests.length).toBeGreaterThan(sameUserGraphBaseline);
    expect(requestOrder).toContain('identity-response:1');
    expect(requestOrder.indexOf(`graph-request:${sameUserGraphBaseline + 1}`)).toBeGreaterThan(requestOrder.indexOf('identity-response:1'));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await originalShell!.evaluate((element) => element === document.querySelector('.auth-shell'))).toBe(true);
    expect(await originalDetail!.evaluate((element) => element === document.querySelector('.task-detail-dialog'))).toBe(true);
    expect(await originalFrame!.evaluate((element) => element === document.querySelector('.task-detail-dialog iframe'))).toBe(true);
    await expect(attachmentPath).toBeFocused();
    await expect(attachmentPath).toHaveValue('draft/retained.txt.pending');
    expect(await fileInput.evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('retained.txt');
    const continuity = await page.evaluate(() => {
      const state = window as unknown as { authContinuity: boolean[]; stopAuthContinuity: () => void };
      state.stopAuthContinuity();
      return state.authContinuity;
    });
    expect(continuity.length).toBeGreaterThan(0);
    expect(continuity.every(Boolean)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await otherTab.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    const changedUserGraphBaseline = graphRequests.length;
    requestOrder.push('external-departure:2');
    await queueGraphWhileAway();
    expect(graphRequests).toHaveLength(changedUserGraphBaseline);
    await page.bringToFront();
    await expect.poll(() => heldChecks.length).toBe(2);
    expect(heldChecks[1]!.identity).toBe(aliceUser.id);
    expect(graphRequests).toHaveLength(changedUserGraphBaseline);
    await otherTab.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await browserAuthentication(context, baseURL, 'bob');
    await page.bringToFront();
    await expect.poll(() => heldChecks.length).toBe(3);
    expect(heldChecks[2]!.identity).toBe(bobUser.id);
    expect(graphRequests).toHaveLength(changedUserGraphBaseline);
    heldChecks[1]!.release();
    await heldChecks[1]!.completed;
    await expect(page.locator('body')).not.toHaveClass(/auth-session-checking/);
    await expect(page.getByRole('link', { name: '账户设置：Alice', exact: true })).toBeVisible();
    expect(graphRequests).toHaveLength(changedUserGraphBaseline);
    pendingGraphWindows.push({ identity: 'changed-user', baseline: changedUserGraphBaseline, beforeRelease: graphRequests.length });
    heldChecks[2]!.release();
    await heldChecks[2]!.completed;
    await expect(page.getByRole('link', { name: '账户设置：Bob', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: own.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '项目不存在或你没有访问权限' })).toBeVisible();
    expect(identityRequests).toEqual(['GET', 'GET', 'GET']);
    await expect.poll(() => graphRequests.length).toBeGreaterThan(changedUserGraphBaseline);
    expect(requestOrder).toContain('identity-response:3');
    expect(requestOrder.indexOf(`graph-request:${changedUserGraphBaseline + 1}`)).toBeGreaterThan(requestOrder.indexOf('identity-response:3'));
    await info.attach('auth-real-tab-return', { body: Buffer.from(JSON.stringify({ identityRequests, graphRequests, pendingGraphWindows, requestOrder, continuity })), contentType: 'application/json' });
    await picture(page, info, 'auth-account-return');
  } finally {
    for (const check of heldChecks) check.release();
    await page.unrouteAll({ behavior: 'wait' });
    await otherTab?.close(); await bob.dispose(); await anonymous.dispose();
  }
});

test('auth-project-members', scenario('auth-project-members'), async ({ page, context, api: request, playwright, allowBrowserWrites }, info) => {
  const baseURL = origin(info);
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  try {
    const project = await createProject(request, { name: `Membership ${randomUUID()}` });
    const bobUser = await user(bob);
    const alice = await user(request);
    const invite = await invitation(request, project.id);
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: invite.token } })).status()).toBe(200);
    const target = `/api/v1/projects/${project.id}/members/${bobUser.id}`;
    allowBrowserWrites([{ method: 'PATCH', url: `${baseURL}${target}`, count: 2 }]);
    await page.goto(`/projects/${project.id}/members`);
    const bobRole = page.getByRole('combobox', { name: `${bobUser.name} 的项目角色`, exact: true });
    await expect(bobRole).toHaveValue('member');
    await expect(page.getByRole('combobox', { name: `${alice.name} 的项目角色`, exact: true })).toBeDisabled();
    const observed = (await memberList(request, project.id)).find((member) => member.userId === bobUser.id)!;
    expect((await request.patch(target, { data: { version: observed.version, role: 'admin' } })).status()).toBe(200);
    await bobRole.selectOption('admin');
    await page.getByRole('dialog').getByRole('button', { name: '保存角色', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '成员状态已变化' })).toBeVisible();
    await expect(bobRole).toHaveValue('admin');
    await bobRole.selectOption('member');
    await page.getByRole('dialog').getByRole('button', { name: '保存角色', exact: true }).click();
    await expect(bobRole).toHaveValue('member');
    const current = (await memberList(request, project.id)).find((member) => member.userId === bobUser.id)!;
    expect(current.version).not.toBe(observed.version);
    expect((await bob.patch(target, { data: { version: current.version, role: 'admin' } })).status()).toBe(403);
    const collaborative = await createTask(bob, project.id, { title: 'Member can write project tasks' });
    await executeTask(bob, project.id, collaborative);
    const memberFile = attachmentDownloadUrl(project.id, collaborative.id, 'member.txt');
    expect((await bob.put(memberFile, { headers: { 'Content-Type': 'text/plain' }, data: 'Member attachment write' })).status()).toBe(201);
    expect((await bob.get(memberFile)).status()).toBe(200);
    const administrator = (await memberList(request, project.id)).find((member) => member.userId === alice.id)!;
    expect((await request.delete(`/api/v1/projects/${project.id}/members/${alice.id}`, { data: { version: administrator.version } })).status()).toBe(409);
    await browserAuthentication(context, baseURL, 'bob');
    await page.reload();
    await expect(page.getByRole('heading', { name: '项目成员', exact: true })).toBeVisible();
    await expect(page.getByText('你可以读写项目中的任务和附件。成员与邀请由项目管理员管理。')).toBeVisible();
    await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0);
    await picture(page, info, 'auth-project-members');
    expect((await request.delete(target, { data: { version: current.version } })).status()).toBe(204);
    expect((await bob.get(memberFile)).status()).toBe(404);
    expect((await bob.get(`/api/v1/projects/${project.id}/tasks/${collaborative.id}`)).status()).toBe(404);
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { name: '项目不存在或你没有访问权限' })).toBeVisible();
    expect((await authenticatedAPI(context.request).get('/api/v1/me')).status()).toBe(200);
    await picture(page, info, 'auth-member-removed');
  } finally { await bob.dispose(); }
});

test('auth-personal-tokens', scenario('auth-personal-tokens'), async ({ page, api: request, playwright, allowBrowserWrites }, info) => {
  const baseURL = origin(info);
  const project = await createProject(request, { name: `Token access ${randomUUID()}` });
  allowBrowserWrites([{ method: 'POST', url: `${baseURL}/api/v1/me/tokens`, count: 1 }]);
  await page.goto('/account');
  await page.getByRole('button', { name: '访问令牌', exact: true }).click();
  await page.getByRole('button', { name: '创建令牌', exact: true }).click();
  const name = `Browser token ${randomUUID()}`;
  await page.getByLabel('令牌名称', { exact: false }).fill(name);
  await page.getByLabel('有效期', { exact: true }).fill('1');
  const created = page.waitForResponse((response) => response.url() === `${baseURL}/api/v1/me/tokens` && response.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: '创建令牌', exact: true }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const metadata = await response.json() as { id: string; token: string };
  const secret = page.getByLabel('一次性访问令牌', { exact: true });
  expect(await secret.inputValue() === metadata.token, 'The one-time field displays the newly issued token').toBe(true);
  const tokenClient = await tokenContext(playwright.request, baseURL, metadata.token);
  try {
    expect((await tokenClient.get(`/api/v1/projects/${project.id}`)).status()).toBe(200);
    await page.getByRole('dialog').getByRole('button', { name: '我已保存，关闭', exact: true }).click();
    await expect(secret).toHaveCount(0);
    allowBrowserWrites([{ method: 'DELETE', url: `${baseURL}/api/v1/me/tokens/${metadata.id}`, count: 1 }]);
    await page.getByRole('button', { name: `撤销令牌 ${name}`, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '撤销令牌', exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    expect((await tokenClient.get(`/api/v1/projects/${project.id}`)).status()).toBe(401);
    expect((await request.get(`/api/v1/projects/${project.id}`)).status()).toBe(200);
    await picture(page, info, 'auth-personal-tokens');
  } finally { await tokenClient.dispose(); }
});

test('auth-invitations', scenario('auth-invitations'), async ({ page, context, api: request, playwright, allowBrowserWrites }, info) => {
  const baseURL = origin(info);
  const project = await createProject(request, { name: `Invitation ${randomUUID()}` });
  allowBrowserWrites([
    { method: 'POST', url: `${baseURL}/api/v1/projects/${project.id}/invitations`, count: 1 },
    { method: 'POST', url: `${baseURL}/api/v1/invitations/inspect`, count: 2 },
    { method: 'POST', url: `${baseURL}/api/v1/invitations/accept`, count: 1 },
  ]);
  await page.goto(`/projects/${project.id}/members`);
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  const created = page.waitForResponse((response) => response.url() === `${baseURL}/api/v1/projects/${project.id}/invitations` && response.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: '创建邀请链接', exact: true }).click();
  const metadata = await (await created).json() as { id: string; link: string };
  expect(await page.getByLabel('一次性邀请链接').inputValue() === metadata.link, 'The one-time field displays the newly issued invitation').toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: '我已保存，关闭', exact: true }).click();
  await openInvitation(page, metadata.link);
  await expect(page.getByRole('heading', { name: '你已经是项目成员' })).toBeVisible();
  expect(new URL(page.url()).hash === '', 'Invitation navigation removes the one-time fragment').toBe(true);
  const active = await request.get(`/api/v1/projects/${project.id}/invitations`);
  expect((await active.json() as { items: { id: string }[] }).items.map((item) => item.id)).toContain(metadata.id);
  await browserAuthentication(context, baseURL, 'bob');
  await page.goto('/');
  await expect(page.getByRole('link', { name: '账户设置：Bob', exact: true })).toBeVisible();
  await openInvitation(page, metadata.link);
  await expect(page.getByRole('heading', { name: '你受邀加入一个项目' })).toBeVisible();
  await expect(page.locator('.invite-account .person-name')).toHaveText('Bob');
  expect(new URL(page.url()).hash === '', 'Invitation navigation removes the one-time fragment').toBe(true);
  const inspectionOnly = await request.get(`/api/v1/projects/${project.id}/invitations`);
  expect((await inspectionOnly.json() as { items: { id: string }[] }).items.map((item) => item.id)).toContain(metadata.id);
  await page.getByRole('button', { name: '接受邀请并加入', exact: true }).click();
  // The invitation page already displays the project name before acceptance completes.
  await expect(page).toHaveURL(`${baseURL}/projects/${project.id}`);
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  try {
    const identity = await user(bob);
    expect((await memberList(request, project.id)).find((member) => member.userId === identity.id)?.role).toBe('member');
    expect((await bob.post('/api/v1/invitations/inspect', { data: { token: new URL(metadata.link).hash.slice(1) } })).status()).toBe(410);
    const revoked = await invitation(request, project.id);
    expect((await request.delete(`/api/v1/projects/${project.id}/invitations/${revoked.id}`)).status()).toBe(204);
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: revoked.token } })).status()).toBe(410);
    expect(await page.evaluate(() => sessionStorage.getItem('daynight.pendingInvitation') === null), 'Accepted invitation clears pending session storage').toBe(true);
    await picture(page, info, 'auth-invitations');
  } finally { await bob.dispose(); }
});

test('auth-resource-session', scenario('auth-resource-session'), async ({ page, context, api: request, allowBrowserWrites }, info) => {
  const baseURL = origin(info);
  const project = await createProject(request, { name: `Session resources ${randomUUID()}` });
  const task = await createTask(request, project.id, { title: 'Authenticated executable preview' });
  const path = 'site/index.html';
  const preview = attachmentPreviewUrl(project.id, task.id, path);
  const files = new Map([
    [path, ['text/html', '<!doctype html><link rel="stylesheet" href="style.css"><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><script type="module" src="app.js"></script>']],
    ['site/style.css', ['text/css', 'button{color:rgb(17,99,155)}']],
    ['site/app.js', ['text/javascript', 'const response=await fetch("data.json");document.body.dataset.value=(await response.json()).value;']],
    ['site/data.json', ['application/json', '{"value":"relative-authenticated"}']],
  ]);
  for (const [name, [type, content]] of files) expect((await request.put(attachmentDownloadUrl(project.id, task.id, name), { headers: { 'Content-Type': type! }, data: content! })).status()).toBe(201);
  allowBrowserWrites([{ method: 'POST', url: `${baseURL}/api/v1/auth/logout`, count: 1 }]);
  const identityRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/v1/me') identityRequests.push(request.method()); });
  await page.goto(`/projects/${project.id}`);
  await page.getByRole('tab', { name: '独立任务', exact: true }).click();
  await page.locator(`#standalone-task-${task.id}`).click();
  const detail = page.locator('.task-detail-dialog');
  await detail.getByRole('tab', { name: '附件', exact: true }).click();
  const attachments = detail.getByRole('region', { name: /附件/ });
  const uploadDisclosure = attachments.locator('.attachment-upload-disclosure');
  await uploadDisclosure.locator('summary').click();
  await expect(uploadDisclosure).toHaveAttribute('open', '');
  await expect(attachments.locator('input[type=text]')).toBeVisible();
  await attachments.locator('button.attachment-file').filter({ hasText: /index\.html/ }).click();
  const frame = detail.frameLocator('iframe');
  await expect(frame.locator('body')).toHaveAttribute('data-value', 'relative-authenticated');
  await expect(frame.locator('#counter')).toHaveCSS('color', 'rgb(17, 99, 155)');
  await frame.locator('#counter').click();
  await expect(frame.locator('#counter')).toHaveText('1');
  const checksBeforeGesture = identityRequests.length;
  const pathInput = attachments.locator('input[type=text]');
  await pathInput.fill('uploads/retained-after-frame.txt');
  await expect(pathInput).toHaveValue('uploads/retained-after-frame.txt');
  await frame.locator('#counter').click();
  await attachments.locator('button.attachment-file').filter({ hasText: /app\.js/ }).click();
  await expect(attachments.getByRole('heading', { name: 'site/app.js', exact: true })).toBeVisible();
  expect(identityRequests).toHaveLength(checksBeforeGesture);
  await attachments.locator('button.attachment-file').filter({ hasText: /index\.html/ }).click();
  await expect(frame.locator('body')).toHaveAttribute('data-value', 'relative-authenticated');
  expect((await authenticatedAPI(context.request).head(preview)).status()).toBe(200);
  expect((await authenticatedAPI(context.request).post('/api/v1/me/tokens', { headers: { Origin: 'https://wrong-origin.example' }, data: { name: 'Rejected browser origin', days: 1 } })).status()).toBe(403);
  await frame.locator('#counter').press('Escape');
  await expect(detail).toHaveCount(0);
  const signedOut = page.waitForResponse((response) => response.url() === `${baseURL}/api/v1/auth/logout` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录你的工作空间' })).toBeVisible();
  expect((await signedOut).status()).toBe(204);
  for (const resource of [preview, attachmentDownloadUrl(project.id, task.id, path), attachmentPreviewUrl(project.id, task.id, 'site/app.js')]) {
    const response = await authenticatedAPI(context.request).get(resource);
    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toMatch(/^application\/json/);
    expect((await response.body()).includes(Buffer.from('<!doctype html>'))).toBe(false);
  }
  expect((await authenticatedAPI(context.request).head(preview)).status()).toBe(401);
  expect((await request.get(preview)).status()).toBe(200);
  await picture(page, info, 'auth-resource-session');
});
