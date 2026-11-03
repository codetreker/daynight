import type { Locator, Page, TestInfo } from '@playwright/test';
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
    await expect(page.locator(`#chain-task-${goal.id}-${child.id} .graph-blocked-badge`)).toBeVisible();
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
    const former = (await membersResponse.json() as { items: { userId: string; version: number }[] }).items.find((member) => member.userId === bobProfile.id);
    if (former === undefined) throw new Error('Former-assignee acceptance requires the exact current Bob membership.');
    expect((await api.delete(`/api/v1/projects/${project.id}/members/${bobProfile.id}`, { data: { version: former.version } })).status()).toBe(204);
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
    expect(peopleRequests.some((entry) => !entry.bounded && entry.status === 200)).toBe(true);
    await info.attach('assignment-people-receipts', { body: JSON.stringify({ projectId: project.id, peopleRequests, formerUserId: bobProfile.id }), contentType: 'application/json' });
  } finally {
    try {
      await seedUserProfile(aliceProfile.id, { name: aliceProfile.name, avatarUrl: aliceProfile.avatarUrl });
      await seedUserProfile(bobProfile.id, { name: bobProfile.name, avatarUrl: bobProfile.avatarUrl });
    } finally { await bob.dispose(); }
  }
});
