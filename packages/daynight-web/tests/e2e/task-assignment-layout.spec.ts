import { decodeMembersJson, parseMembers } from "../../src/api/auth-parse";
import { stringifyApiJson } from "../../src/api/json";
import type { Locator, Page, Response, TestInfo } from '@playwright/test';
import { bearerContext, type AuthenticatedAPI } from './authentication';
import { createProject, createTask, expect, seedUserProfile, test } from './fixtures';
import { closeChain, openChain } from './chain-dialog';
import { selectOverview, selectTaskList } from './project-view';

const scenario = { annotation: { type: 'scenario', description: 'task-assignment-layout' } };
const longName = 'Alexandra 长姓名负责人 María del Carmen — complete accessible identity across task views';
type Profile = { readonly id: string; readonly name: string | null; readonly avatarUrl: string | null };
const profile = async (api: AuthenticatedAPI): Promise<Profile> => {
  const response = await api.get('/api/v1/me'); expect(response.status()).toBe(200); return await response.json() as Profile;
};
const detail = (page: Page): Locator => page.locator('.task-detail-dialog');
const assignee = (page: Page): Locator => detail(page).locator('.task-assignee-field .assignee-trigger');
const menu = (page: Page): Locator => page.locator('.assignee-menu');
const closeDetail = async (page: Page): Promise<void> => {
  await detail(page).locator('.task-detail-close').click(); await expect(detail(page)).toHaveCount(0);
};
const standalone = async (page: Page): Promise<void> => {
  await selectTaskList(page); await page.getByRole('tab', { name: /^(独立任务|Standalone tasks)$/, exact: true }).click();
};
const openTask = async (page: Page, taskId: string): Promise<void> => {
  await standalone(page); await page.locator(`#standalone-task-${taskId}`).click(); await expect(assignee(page)).toBeEnabled();
};
const chooseFilter = async (page: Page, option: string | RegExp): Promise<void> => {
  await page.locator('.task-assignee-filter .assignee-trigger').click();
  await expect(menu(page).getByRole('listbox')).toBeVisible(); await menu(page).getByRole('option', { name: option, exact: true }).click();
  await expect(menu(page)).toHaveCount(0);
};
const picture = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`); await page.screenshot({ path, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};
const expectRowGeometry = async (page: Page): Promise<void> => {
  await expect.poll(() => detail(page).evaluate((surface) => {
    const row = surface.querySelector<HTMLElement>('.task-detail-status-row')!;
    const pair = row.querySelector<HTMLElement>('.task-detail-status-assignee')!;
    const status = pair.querySelector<HTMLElement>('.task-status-trigger')!.getBoundingClientRect();
    const trigger = pair.querySelector<HTMLElement>('.assignee-trigger')!.getBoundingClientRect();
    const avatar = pair.querySelector<HTMLElement>('.assignee-avatar')!.getBoundingClientRect();
    const platform = row.querySelector<HTMLSelectElement>('select')!.getBoundingClientRect();
    const bounds = pair.getBoundingClientRect();
    const ordered = status.right <= trigger.left + .5 && Math.abs(status.top + status.height / 2 - trigger.top - trigger.height / 2) <= 1;
    const platformFollows = trigger.right <= platform.left + .5 || trigger.bottom <= platform.top + .5;
    return ordered && platformFollows && Math.abs(trigger.height - 24) <= .5 && Math.abs(avatar.height - 16) <= .5
      && status.left >= bounds.left - .5 && trigger.right <= bounds.right + .5
      && row.scrollWidth <= row.clientWidth && surface.scrollWidth <= surface.clientWidth
      && document.documentElement.scrollWidth <= window.innerWidth;
  }), { message: 'Status and the 24px assignee stay paired before platform without horizontal overflow' }).toBe(true);
};
const expectMenuGeometry = async (page: Page): Promise<void> => {
  await expect.poll(() => menu(page).evaluate((popup) => {
    const bounds = popup.getBoundingClientRect();
    return bounds.left >= 11.5 && bounds.top >= 11.5 && bounds.right <= innerWidth - 11.5 && bounds.bottom <= innerHeight - 11.5
      && bounds.width <= 306.5 && bounds.width <= innerWidth - 23.5 && bounds.height <= 370.5
      && popup.closest('.task-detail-dialog') !== null;
  }), { message: 'Assignee popup remains within the viewport and its detail focus owner' }).toBe(true);
};
const layouts = [
  { locale: 'zh-CN', width: 1366 }, { locale: 'en', width: 1366 },
  { locale: 'zh-CN', width: 390 }, { locale: 'en', width: 390 },
  { locale: 'zh-CN', width: 320 }, { locale: 'en', width: 320 },
] as const;

const verifyPeopleReuse = async (page: Page, api: AuthenticatedAPI, missing: AuthenticatedAPI, alice: Profile, missingProfile: Profile, info: TestInfo): Promise<void> => {
  // The padding models an inline profile photo's transfer cost while keeping the image fixture deterministic.
  const inlineAvatar = (color: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><!--${'x'.repeat(176_600)}--><rect width="16" height="16" fill="${color}"/></svg>`).toString('base64')}`;
  const avatar = inlineAvatar('#6256c5');
  await seedUserProfile(alice.id, { name: longName, avatarUrl: avatar });
  const project = await createProject(api, { name: 'Persistent assignee and current-account cache acceptance' });
  const first = await createTask(api, project.id, { title: 'First task sharing an inline avatar', assignedTo: alice.id });
  const second = await createTask(api, project.id, { title: 'Second task sharing an inline avatar', assignedTo: alice.id });
  const peoplePath = `/api/v1/projects/${project.id}/task-assignees`;
  const syncPath = `/api/v1/projects/${project.id}/task-sync`;
  const requests: string[][] = [];
  const payloads: { readonly userIds: readonly string[]; readonly bytes: number }[] = [];
  const payloadReads: Promise<void>[] = [];
  type WireReceipt = { readonly path: string; validator: boolean; wireStatus: number | null; wireBytes: number | null };
  const wire = new Map<string, WireReceipt>();
  const validators = new Map<string, boolean>();
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  // Routing disables Chromium's HTTP cache, so this phase observes the real network without intercepting requests.
  network.on('Network.requestWillBeSent', (event) => {
    const path = new URL(event.request.url).pathname;
    if (path === '/api/v1/me' || path === peoplePath) wire.set(event.requestId, {
      path, validator: validators.get(event.requestId) ?? Object.keys(event.request.headers).some((name) => name.toLowerCase() === 'if-none-match'), wireStatus: null, wireBytes: null,
    });
  });
  network.on('Network.requestWillBeSentExtraInfo', (event) => {
    const validator = Object.keys(event.headers).some((name) => name.toLowerCase() === 'if-none-match');
    validators.set(event.requestId, validator);
    const receipt = wire.get(event.requestId); if (receipt !== undefined) receipt.validator = validator;
  });
  network.on('Network.responseReceivedExtraInfo', (event) => { const receipt = wire.get(event.requestId); if (receipt !== undefined) receipt.wireStatus = event.statusCode; });
  network.on('Network.loadingFinished', (event) => { const receipt = wire.get(event.requestId); if (receipt !== undefined) receipt.wireBytes = event.encodedDataLength; });
  const meReceipts = () => [...wire.values()].filter((receipt) => receipt.path === '/api/v1/me');
  const expectMe = async (index: number, status: number) => {
    await expect.poll(() => meReceipts()[index]?.wireStatus).toBe(status);
    // Session expiry aborts the active identity fetch after the 401 headers arrive.
    if (status === 401) return meReceipts()[index]!;
    await expect.poll(() => meReceipts()[index]?.wireBytes).not.toBeNull();
    const receipt = meReceipts()[index]!;
    expect(receipt.wireBytes).toBeGreaterThanOrEqual(0);
    if (status === 304) {
      expect(receipt.validator, 'The browser validates its cached current-account response').toBe(true);
      expect(receipt.wireBytes, 'Authenticated 304 validation carries headers without retransmitting profile bytes').toBeLessThan(4096);
    }
    return receipt;
  };
  const observeRequest = (request: { url(): string }) => {
    const url = new URL(request.url());
    if (url.pathname === peoplePath) requests.push(url.searchParams.getAll('userId'));
  };
  const observeResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.pathname === peoplePath && response.status() === 200) payloadReads.push((async () => {
      payloads.push({ userIds: url.searchParams.getAll('userId'), bytes: (await response.body()).byteLength });
    })());
  };
  const expectAvatar = async (image: Locator) => {
    await expect(image).toHaveCount(1);
    await expect.poll(() => image.evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth === 16 && image.naturalHeight === 16;
    })).toBe(true);
  };
  const nextSync = async () => {
    const receipt = await page.locator('.snapshot-time time').getAttribute('datetime');
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === syncPath);
    await page.clock.fastForward(15_000); expect((await response).status()).toBe(200);
    await expect(page.locator('.snapshot-time time')).not.toHaveAttribute('datetime', receipt!);
  };
  page.on('request', observeRequest); page.on('response', observeResponse);
  try {
    await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
    await page.goto(`/projects/${project.id}`); await standalone(page);
    await expectAvatar(page.locator(`#standalone-task-${first.id} .assignee-avatar img`));
    await expectMe(0, 200);
    expect(requests, 'Shared visible assignees are resolved once').toEqual([[alice.id]]);
    await Promise.all(payloadReads);
    expect(payloads[0]!.bytes, 'The fixture carries a production-sized inline avatar').toBeGreaterThan(235_000);
    for (const task of [first, second, first]) {
      await openTask(page, task.id); await expectAvatar(assignee(page).locator('.assignee-avatar img')); await closeDetail(page);
    }
    expect(requests, 'Opening tasks reuses the loaded profile and avatar').toEqual([[alice.id]]);

    await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'));
    await expect(page.locator('.snapshot-time time')).toHaveAttribute('datetime', /^2030-/);
    await nextSync();
    expect(requests, 'A successful empty task-sync response does not retransmit known profiles').toEqual([[alice.id]]);
    await page.reload(); await standalone(page);
    await expectAvatar(page.locator(`#standalone-task-${first.id} .assignee-avatar img`));
    await expectMe(1, 304);
    expect(requests, 'Fresh admission reuses the persisted profile after reloading the document').toEqual([[alice.id]]);

    const invitation = await api.post(`/api/v1/projects/${project.id}/invitations`, { data: {} }); expect(invitation.status()).toBe(201);
    const invitationBody = await invitation.json() as { link: string };
    expect((await missing.post('/api/v1/invitations/accept', { data: { token: new URL(invitationBody.link).hash.slice(1) } })).status()).toBe(200);
    const added = await createTask(api, project.id, { title: 'New assignee needs only one missing profile', assignedTo: missingProfile.id });
    await nextSync();
    const addedRow = page.locator(`#standalone-task-${added.id}`);
    await expect(addedRow.locator('.assignee-name')).toHaveText(missingProfile.id.slice(0, 8));
    expect(requests, 'Only the newly displayed uncached assignee is requested').toEqual([[alice.id], [missingProfile.id]]);

    const changedName = 'Changed profile without retransmitting another avatar';
    await seedUserProfile(missingProfile.id, { name: changedName, avatarUrl: null });
    await nextSync();
    await expect(addedRow.locator('.assignee-name')).toHaveText(changedName);
    expect(requests, 'A profile version change fetches only that person').toEqual([[alice.id], [missingProfile.id], [missingProfile.id]]);
    const membersResponse = await api.get(`/api/v1/projects/${project.id}/members`); expect(membersResponse.status()).toBe(200);
    const member = parseMembers(await decodeMembersJson(new Response(await membersResponse.text())), project.id).items.find((member) => member.userId === missingProfile.id);
    if (member === undefined) throw new Error('Access-only cache validation requires the current direct membership.');
    expect((await api.delete(`/api/v1/projects/${project.id}/members/${missingProfile.id}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: member.directGrant!.version, expectedUserId: alice.id }) })).status()).toBe(204);
    await nextSync();
    await expect(addedRow.locator('.assignee-former')).toBeVisible();
    expect(requests, 'An access-only manifest change reuses the profile bytes').toEqual([[alice.id], [missingProfile.id], [missingProfile.id]]);

    await Promise.all(payloadReads);
    const bytesBeforeCatalogue = payloads.reduce((sum, payload) => sum + payload.bytes, 0);
    for (const task of [second, first]) {
      await openTask(page, task.id); await assignee(page).click(); await expect(menu(page).getByRole('listbox')).toBeVisible();
      await expectAvatar(menu(page).getByRole('option', { name: longName, exact: true }).locator('.assignee-avatar img'));
      await expect(menu(page).getByRole('option', { name: new RegExp(`^${changedName}`) })).toHaveCount(0);
      await page.keyboard.press('Escape'); await closeDetail(page);
    }
    await Promise.all(payloadReads);
    expect(requests, 'The manifest and known profiles supply candidate catalogues without another people read').toEqual([[alice.id], [missingProfile.id], [missingProfile.id]]);
    expect(payloads.reduce((sum, payload) => sum + payload.bytes, 0), 'Unchanged inline avatars transfer no further bytes').toBe(bytesBeforeCatalogue);

    const changedAvatar = inlineAvatar('#2a936b');
    await seedUserProfile(alice.id, { name: longName, avatarUrl: changedAvatar });
    await page.reload(); await standalone(page);
    const updatedImage = page.locator(`#standalone-task-${first.id} .assignee-avatar img`);
    await expectAvatar(updatedImage);
    await expect.poll(async () => await updatedImage.getAttribute('src') === changedAvatar, { message: 'The changed inline avatar is rendered' }).toBe(true);
    await expectMe(2, 200);
    expect(requests, 'Reload transfers only the profile whose avatar changed').toEqual([[alice.id], [missingProfile.id], [missingProfile.id], [alice.id]]);
    await page.reload(); await standalone(page); await expectAvatar(updatedImage);
    await expectMe(3, 304);
    expect(requests, 'The replacement avatar is persisted and reused on the next reload').toEqual([[alice.id], [missingProfile.id], [missingProfile.id], [alice.id]]);

    await page.context().clearCookies();
    await page.reload(); await expectMe(4, 401);
    await expect(page.locator('.auth-shell,.task-detail-dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^(登录你的工作空间|Sign in to your workspace)$/, exact: true })).toBeVisible();
    await expect(page.getByText(first.title, { exact: true })).toHaveCount(0);
    await Promise.all(payloadReads);
    await info.attach('assignment-people-cache', { body: JSON.stringify({ projectId: project.id, avatarBytes: Buffer.byteLength(avatar), requests, payloads, wire: [...wire.values()] }), contentType: 'application/json' });
  } finally {
    page.off('request', observeRequest); page.off('response', observeResponse);
    await page.clock.resume(); await network.detach();
    await Promise.all(payloadReads);
    await seedUserProfile(missingProfile.id, { name: missingProfile.name, avatarUrl: missingProfile.avatarUrl });
  }
};

test('task-assignment-layout', scenario, async ({ page, api, playwright }, info) => {
  const baseURL = info.project.use.baseURL;
  if (typeof baseURL !== 'string') throw new Error('Assignment layout acceptance requires the actual service origin.');
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  const aliceProfile = await profile(api), bobProfile = await profile(bob);
  try {
    const project = await createProject(api, { name: 'Assignee layout and full graph acceptance' });
    const invitation = await api.post(`/api/v1/projects/${project.id}/invitations`, { data: {} }); expect(invitation.status()).toBe(201);
    const invitationBody = await invitation.json() as { link: string };
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: new URL(invitationBody.link).hash.slice(1) } })).status()).toBe(200);
    await seedUserProfile(aliceProfile.id, { name: longName, avatarUrl: new URL('/missing-assignee-avatar.png', baseURL).href });
    await seedUserProfile(bobProfile.id, { name: null, avatarUrl: null });
    const assigned = await createTask(api, project.id, { title: 'Current long-name assignee', assignedTo: aliceProfile.id, requiredPlatform: 'windows', description: Array.from({ length: 60 }, (_, index) => `## Reading ${index + 1}\n\nLong task material keeps the shared detail scrollable.`).join('\n\n') });
    const nullable = await createTask(api, project.id, { title: 'Null-name assignee', assignedTo: bobProfile.id });
    const unassigned = await createTask(api, project.id, { title: 'Unassigned task', assignedTo: null });
    const goal = await createTask(api, project.id, { title: 'Goal context assigned to another person', assignedTo: bobProfile.id });
    const child = await createTask(api, project.id, { title: 'Matching blocked successor', assignedTo: aliceProfile.id, dependsOn: [goal.id] });
    const hiddenSibling = await createTask(api, project.id, { title: 'Hidden sibling remains in the full graph', assignedTo: bobProfile.id, dependsOn: [goal.id] });
    const shortBob = bobProfile.id.slice(0, 8);
    const peopleRequests: { readonly bounded: boolean; readonly status: number }[] = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname === `/api/v1/projects/${project.id}/task-assignees`) peopleRequests.push({ bounded: url.searchParams.has('userId'), status: response.status() });
    });
    await page.goto(`/projects/${project.id}`);
    for (const { locale, width } of layouts) {
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await page.setViewportSize({ width, height: 900 }); await standalone(page);
      const row = page.locator(`#standalone-task-${assigned.id}`);
      await expect(row.locator('.task-assignee-identity')).toHaveAccessibleName(`${locale === 'en' ? 'Assignee: ' : '负责人：'}${longName}`);
      await expect(row.locator('.assignee-avatar')).toHaveText('A'); await expect(row.locator('.assignee-avatar img')).toHaveCount(0);
      await expect(page.locator(`#standalone-task-${nullable.id} .assignee-name`)).toHaveText(shortBob);
      await expect(page.locator(`#standalone-task-${nullable.id} .assignee-former`)).toHaveCount(0);
      await expect(page.locator(`#standalone-task-${unassigned.id} .assignee-name`)).toHaveText(locale === 'en' ? 'Unassigned' : '未分配');
      expect(await row.locator('.assignee-name').evaluate((name) => getComputedStyle(name).textOverflow === 'ellipsis' && name.scrollWidth > name.clientWidth)).toBe(true);
      expect(await row.locator('.assignee-avatar').evaluate((avatar) => avatar.getBoundingClientRect().width)).toBe(17);
      await openTask(page, assigned.id); await expectRowGeometry(page);
      await assignee(page).click(); await expect(menu(page).getByRole('listbox')).toBeVisible();
      await expect(menu(page).getByRole('textbox')).toBeFocused();
      await expect(menu(page).getByRole('option', { name: longName, exact: true })).toBeVisible();
      await expect(menu(page).getByRole('option', { name: shortBob, exact: true })).toBeVisible();
      await expect(menu(page).locator('.assignee-menu-state')).toHaveCount(0);
      await expect.poll(() => detail(page).evaluate((surface) => surface.getAnimations().every((animation) => animation.playState === 'finished'))).toBe(true);
      await expectMenuGeometry(page);
      await detail(page).locator('.task-detail-panel-overview').evaluate((panel) => { panel.scrollTop = panel.scrollHeight; });
      await expectMenuGeometry(page); await picture(page, info, `assignment-current-${locale}-${width}`);
      const search = menu(page).getByRole('textbox'); await search.fill('Alexandra'); await search.press('Home');
      expect(await search.evaluate((input) => (input as HTMLInputElement).selectionStart)).toBe(0);
      await search.press('End'); await search.press('ArrowDown'); await expect(menu(page).getByRole('option', { name: longName, exact: true })).toBeFocused();
      await page.keyboard.press('Space'); await expect(menu(page)).toHaveCount(0); await expect(assignee(page)).toBeFocused();
      await assignee(page).click(); await expect(menu(page).getByRole('listbox')).toBeVisible(); await page.keyboard.press('Tab');
      await expect(menu(page)).toHaveCount(0); await expect(detail(page).getByRole('combobox', { name: /^(执行平台|Execution platform)$/, exact: true })).toBeFocused();
      await assignee(page).click(); await expect(menu(page).getByRole('listbox')).toBeVisible(); await page.keyboard.press('Escape');
      await expect(menu(page)).toHaveCount(0); await expect(assignee(page)).toBeFocused(); await expect(detail(page)).toBeVisible();
      await detail(page).locator('.task-detail-fullscreen-toggle').click(); await expect(detail(page)).toHaveClass(/task-detail-fullscreen/);
      await assignee(page).click(); await expect(menu(page).getByRole('listbox')).toBeVisible(); await expectMenuGeometry(page); await page.keyboard.press('Escape');
      await expect(detail(page)).toHaveClass(/task-detail-fullscreen/); await expect(assignee(page)).toBeFocused();
      await page.keyboard.press('Escape'); await expect(detail(page)).not.toHaveClass(/task-detail-fullscreen/);
      await closeDetail(page);
    }

    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    await chooseFilter(page, 'Assigned to me'); await page.getByRole('tab', { name: 'Task chains', exact: true }).click();
    const goalRow = page.locator(`[data-chain-id="${goal.id}"]`); await expect(goalRow).toBeVisible();
    await expect(goalRow.locator('.root-progress-label')).toHaveText('0/3 completed'); await goalRow.locator('.goal-toggle').click();
    await expect(goalRow.getByText('1 matching child tasks', { exact: true })).toBeVisible();
    await expect(page.locator(`#chain-task-${goal.id}-${child.id}`)).toBeVisible();
    await expect(page.locator(`#chain-task-${goal.id}-${child.id}`).locator('..').locator('.graph-blocked-badge')).toBeVisible();
    await expect(page.locator(`#chain-task-${goal.id}-${hiddenSibling.id}`)).toHaveCount(0);
    await page.locator(`#chain-task-${goal.id}-${child.id}`).click();
    await expect(detail(page).locator('.task-detail-blocked')).toBeVisible();
    await expect(detail(page).getByRole('button', { name: /Goal context assigned to another person/ })).toHaveCount(2); await closeDetail(page);
    await openChain(page, goal.id); await expect(page.locator('.task-chain-meta')).toContainText('0/3 completed');
    await expect(page.locator('.task-chain-dialog .task-node-title', { hasText: goal.title })).toBeVisible();
    await expect(page.locator('.task-chain-dialog .task-node-title', { hasText: hiddenSibling.title })).toBeVisible(); await closeChain(page);
    await chooseFilter(page, 'Unassigned'); await expect(page.getByRole('heading', { name: 'No tasks match this assignee', exact: true })).toBeVisible();
    await selectOverview(page); await page.locator('.overview-progress-row').filter({ hasText: goal.title }).click();
    await expect(page.locator('.task-assignee-filter .assignee-trigger')).toHaveText('Everyone'); await expect(goalRow).toBeVisible();

    const membersResponse = await api.get(`/api/v1/projects/${project.id}/members`); expect(membersResponse.status()).toBe(200);
    const former = parseMembers(await decodeMembersJson(new Response(await membersResponse.text())), project.id).items.find((member) => member.userId === bobProfile.id);
    if (former === undefined) throw new Error('Former-assignee acceptance requires the exact current Bob membership.');
    expect((await api.delete(`/api/v1/projects/${project.id}/members/${bobProfile.id}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: former.directGrant!.version, expectedUserId: aliceProfile.id }) })).status()).toBe(204);
    await page.reload();
    for (const { locale, width } of layouts) {
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale); await page.setViewportSize({ width, height: 900 }); await standalone(page);
      const formerRow = page.locator(`#standalone-task-${nullable.id}`);
      await expect(formerRow.locator('.assignee-former')).toHaveText(locale === 'en' ? 'No project access' : '已失去项目权限');
      await openTask(page, nullable.id); await expectRowGeometry(page);
      await expect(assignee(page)).toHaveAccessibleName(`${locale === 'en' ? 'Assignee: ' : '负责人：'}${shortBob} · ${locale === 'en' ? 'No project access' : '已失去项目权限'}`);
      const compactFormer = assignee(page).locator('.assignee-former');
      await expect(compactFormer).toHaveText(locale === 'en' ? 'No project access' : '已失去项目权限');
      await expect(compactFormer).toBeVisible();
      expect(await compactFormer.evaluate((badge) => {
        const visible = badge.getBoundingClientRect(), trigger = badge.closest('.assignee-trigger')!.getBoundingClientRect();
        return visible.width > 0 && visible.height > 0 && visible.left >= trigger.left && visible.right <= trigger.right
          && visible.top >= trigger.top && visible.bottom <= trigger.bottom;
      }), 'The compact lost-access badge stays visibly inside the 24px detail selector').toBe(true);
      await assignee(page).click(); await expect(menu(page).getByRole('listbox')).toBeVisible(); await expect(menu(page).getByRole('option', { name: new RegExp(shortBob) })).toHaveCount(0);
      await expectMenuGeometry(page); await picture(page, info, `assignment-former-${locale}-${width}`); await page.keyboard.press('Escape'); await closeDetail(page);
      await chooseFilter(page, new RegExp(`${shortBob}.*${locale === 'en' ? 'No project access' : '已失去项目权限'}`));
      await expect(formerRow).toBeVisible(); await expect(page.locator(`#standalone-task-${assigned.id}`)).toHaveCount(0);
      await chooseFilter(page, locale === 'en' ? 'Everyone' : '所有负责人');
    }
    expect(peopleRequests.some((entry) => entry.bounded && entry.status === 200)).toBe(true);
    expect(peopleRequests.every((entry) => entry.bounded), 'Candidate catalogues reuse the task-sync manifest').toBe(true);
    await info.attach('assignment-people-receipts', { body: JSON.stringify({ projectId: project.id, peopleRequests, formerUserId: bobProfile.id }), contentType: 'application/json' });
    await test.step('Persists versioned profiles and validates cached current-account responses', async () => {
      const missing = await bearerContext(playwright.request, baseURL, 'nullable');
      try { await verifyPeopleReuse(page, api, missing, aliceProfile, await profile(missing), info); } finally { await missing.dispose(); }
    });
  } finally {
    try {
      await seedUserProfile(aliceProfile.id, { name: aliceProfile.name, avatarUrl: aliceProfile.avatarUrl });
      await seedUserProfile(bobProfile.id, { name: bobProfile.name, avatarUrl: bobProfile.avatarUrl });
    } finally { await bob.dispose(); }
  }
});
