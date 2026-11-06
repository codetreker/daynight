import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const previousId = '00000000-0000-4000-8000-000000000042';
const personalId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const step = { id: '00000001', title: 'Review', description: 'Read this', status: 'todo', createdAt: time, updatedAt: time };
const longName = 'Alexandra Person With A Very Long Name For Narrow Assignment Layout';

async function install(page: Page, running = false, linked = false, large = false, rich = false, paused = false, moveGate?: { started: () => void; wait: Promise<void> }) {
  let task = detailFixture(projectId, taskId, { title: 'Target task', version: 5n, ...(running ? { status: 'in_progress' as const, ready: false, startedAt: time } : {}), ...(rich ? { assignedTo: TEST_VIEWER_ID } : {}), ...(paused ? { properties: { pullRequests: [], paused: true } } : {}) });
  const previous = detailFixture(projectId, previousId, { title: 'History origin', ...(linked ? { dependsOn: [taskId], blockedBy: [taskId], ready: false } : {}), version: 5n });
  const graph = () => graphFixture([task, previous]);
  let steps = large ? [step, ...Array.from({ length: 100 }, (_, index) => ({ ...step, id: (index + 2).toString(16).padStart(8, '0'), title: `Other ${index + 1}` }))] : [step];
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph().project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph(), { query: taskSyncQuery(url), versionForTask: row => row.id === taskId ? task.version : previous.version, propertiesForTask: row => row.id === taskId ? task.properties : previous.properties }));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) {
      const requested = url.searchParams.getAll('userId');
      const person = { version: 'a'.repeat(64), userId: TEST_VIEWER_ID, name: longName, avatarUrl: '/missing-assignee-avatar.png', hasProjectAccess: true };
      return send({ items: requested.length === 0 || requested.includes(TEST_VIEWER_ID) ? [person] : [], unresolvedUserIds: requested.filter(id => id !== TEST_VIEWER_ID) });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${step.id}/position` && request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({ version: 5, position: 'last' });
      task = { ...task, version: 6n }; steps = [...steps.slice(1), steps[0]!];
      if (moveGate) { moveGate.started(); await moveGate.wait; }
      return send({ projectId, taskId, version: task.version, steps });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps` && request.method() === 'POST') {
      const input = request.postDataJSON() as { id: string; version: number; title: string; description: string; status: string; after: string };
      expect(input).toMatchObject({ version: 5, title: 'Inserted after anchor', description: '', status: 'todo', after: '00000064' });
      expect(input.id).toMatch(/^[0-9a-f]{8}$/);
      const anchor = steps.findIndex(value => value.id === input.after);
      expect(anchor).toBe(99);
      const added = { ...step, id: input.id, title: input.title, description: input.description, status: input.status };
      steps = [...steps.slice(0, anchor + 1), added, ...steps.slice(anchor + 1)]; task = { ...task, version: 6n };
      return route.fulfill({ status: 201, body: stringifyWireJson({ projectId, taskId, version: task.version, steps }), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, Location: `${path}/${input.id}` } });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps/00000065` && request.method() === 'DELETE') {
      expect(request.postDataJSON()).toEqual({ version: 5 });
      task = { ...task, version: 6n }; steps = steps.filter(value => value.id !== '00000065');
      return send({ projectId, taskId, version: task.version, steps });
    }
    for (const detail of [task, previous]) {
      const base = `/api/v1/projects/${projectId}/tasks/${detail.id}`;
      if (path === base) return send(detail);
      if (path === `${base}/steps`) return send({ projectId, taskId: detail.id, version: detail.version, steps: detail.id === taskId ? steps : [] });
      if (path === `${base}/sessions` || path === `${base}/attachments`) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return writes;
}

async function openDialog(page: Page) {
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog).toHaveAccessibleName('Target task');
  return dialog;
}

test('Step status and position menus stay in a short viewport and return keyboard focus', async ({ page }) => {
  const writes = await install(page);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 240 });
  const row = dialog.locator('.step-row[data-step-id="00000001"]');
  const status = row.locator('.step-status');
  await expect(status).toBeEnabled(); await status.scrollIntoViewIfNeeded(); await status.focus(); await page.keyboard.press('Enter');
  const options = page.getByRole('menuitemradio'); await expect(options).toHaveCount(4);
  for (const option of await options.all()) {
    await expect(option).toBeVisible(); const box = await option.boundingBox(); expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(240);
  }
  await page.keyboard.press('Escape'); await expect(status).toBeFocused();
  await page.setViewportSize({ width: 320, height: 390 });
  await status.scrollIntoViewIfNeeded(); await status.click();
  const statusMenu = page.getByRole('menu'); await expect(statusMenu).toBeVisible();
  await dialog.locator('.task-detail-panel-steps').evaluate(element => { element.scrollTop += 30; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));
  const statusBox = await statusMenu.boundingBox(); expect(statusBox).not.toBeNull();
  expect(statusBox!.x).toBeGreaterThanOrEqual(0); expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(320);
  expect(statusBox!.y).toBeGreaterThanOrEqual(0); expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape'); await expect(status).toBeFocused();
  const more = row.locator('.step-more'); await more.scrollIntoViewIfNeeded(); await more.focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  const box = await menu.boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape'); await expect(more).toBeFocused();
  expect(writes).toEqual([]);
});

test('a confirmed move follows the Step to its new page and restores focus and expansion', async ({ page }) => {
  const writes = await install(page, false, false, true);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  const row = dialog.locator('.step-row[data-step-id="00000001"]');
  const disclosure = row.locator('.step-disclosure');
  await disclosure.click(); await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const more = row.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
  await more.click(); await page.getByRole('menuitem', { name: 'Move to end', exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('2');
  await expect(row.locator('.step-disclosure')).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.step-more')).toBeFocused();
  expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/steps/${step.id}/position`]);
});

test('a confirmed relative insertion follows the new Step to the next page and focuses it', async ({ page }) => {
  const writes = await install(page, false, false, true);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  const anchor = dialog.locator('.step-row[data-step-id="00000064"]');
  const more = anchor.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
  await more.click(); await page.getByRole('menuitem', { name: 'Add after', exact: true }).click();
  const form = dialog.locator('.step-add-form');
  await form.getByRole('textbox', { name: 'Title' }).fill('Inserted after anchor');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('2');
  const added = dialog.locator('.step-row').filter({ hasText: 'Inserted after anchor' });
  await expect(added).toBeVisible(); await expect(added.locator('.step-disclosure')).toBeFocused();
  expect(writes).toEqual([`POST /api/v1/projects/${projectId}/tasks/${taskId}/steps`]);
});

test('a late move receipt does not steal focus or change the page of a new draft', async ({ page }) => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const writes = await install(page, false, false, true, false, false, { started: entered.resolve, wait: gate.promise });
  try {
    const dialog = await openDialog(page); await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
    const row = dialog.locator('.step-row[data-step-id="00000001"]');
    const more = row.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
    await more.click(); await page.getByRole('menuitem', { name: 'Move to end', exact: true }).click();
    await entered.promise;
    await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
    const pageNumber = dialog.getByRole('spinbutton', { name: 'Page' });
    await expect(pageNumber).toHaveValue('2'); await expect(row).toHaveCount(0);
    await pageNumber.fill('1'); await pageNumber.press('Enter');
    await expect(pageNumber).toHaveValue('1'); await expect(row).toBeVisible();
    const form = dialog.locator('.step-add-form'), title = form.getByRole('textbox', { name: 'Title' });
    await title.fill('Draft during move'); await expect(title).toBeFocused();
    await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('1');
    gate.resolve(); await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(title).toHaveValue('Draft during move'); await expect(title).toBeFocused();
    await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('1');
    expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/steps/${step.id}/position`]);
  } finally { gate.resolve(); }
});

test('Back protects a dirty Step draft and a second Back may discard it', async ({ page }) => {
  const writes = await install(page, false, true, true);
  await page.goto(`/projects/${projectId}/tasks/${previousId}`);
  const root = page.locator('.task-detail-page');
  await root.getByRole('region', { name: 'Prerequisites', exact: true }).getByRole('button', { name: /Target task/ }).click();
  await root.getByRole('tab', { name: 'Steps', exact: true }).click();
  await root.getByRole('button', { name: 'Add step', exact: true }).click();
  const title = root.locator('.step-add-form').getByRole('textbox', { name: 'Title' }); await title.fill('Unsaved draft');
  const openMove = async () => {
    const pageNumber = root.getByRole('spinbutton', { name: 'Page' }); await pageNumber.fill('1'); await pageNumber.press('Enter');
    await root.locator('.step-row[data-step-id="00000001"] .step-more').click();
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Move step', exact: true })).toBeVisible();
  };
  await openMove();
  await page.evaluate(() => history.go(-2));
  const leave = page.getByRole('alertdialog'); await expect(leave).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Move step', exact: true })).toHaveCount(0);
  await expect(root).toHaveAttribute('inert', '');
  await expect(leave.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(leave.getByRole('button', { name: 'Discard and leave' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(leave.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(root).not.toHaveAttribute('inert');
  await expect(title).toHaveValue('Unsaved draft'); await expect(title).toBeFocused();
  await openMove();
  await page.evaluate(() => history.go(-2)); await expect(leave).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Move step', exact: true })).toHaveCount(0);
  await leave.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${previousId}$`));
  await expect(root.locator('.task-detail-title')).toHaveText('History origin');
  expect(writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1440]) {
  test(`Step deletion confirms safely and restores focus at ${width}px in ${locale}`, async ({ page }) => {
    const writes = await install(page, false, false, true); await page.setViewportSize({ width, height: 800 });
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const root = page.locator('.task-detail-page');
    const pageNumber = root.getByRole('spinbutton', { name: locale === 'en' ? 'Page' : '页码' });
    await pageNumber.fill('2'); await pageNumber.press('Enter');
    const row = root.locator('.step-row[data-step-id="00000065"]'); await row.locator('.step-disclosure').click();
    await row.getByRole('button', { name: locale === 'en' ? 'Edit step' : '编辑步骤' }).click();
    const form = root.locator('.step-add-form'), title = form.getByRole('textbox', { name: locale === 'en' ? 'Title' : '标题', exact: true });
    await title.fill('Unpublished draft');
    await title.focus(); await page.keyboard.press('Tab'); await expect(form.locator(':focus')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const openDelete = async () => {
      const more = row.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
      await more.focus(); await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: locale === 'en' ? 'Delete step' : '删除步骤', exact: true }).click();
    };
    await openDelete(); const confirmation = page.getByRole('alertdialog');
    const cancel = confirmation.locator('.dialog-footer').getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
    await expect(cancel).toBeFocused(); await expect(confirmation).toContainText('00000065');
    await expect(confirmation).toContainText(locale === 'en' ? 'Attachments, pull requests and other references will remain' : '附件、拉取请求及其他引用会保留');
    await expect(confirmation).toContainText(locale === 'en' ? 'Unsaved changes' : '未保存修改');
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); await expect(confirmation.locator(':focus')).toHaveCount(1); }
    await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0); await expect(title).toHaveValue('Unpublished draft');
    await openDelete(); await page.getByRole('alertdialog').getByRole('button', { name: locale === 'en' ? 'Delete step' : '删除步骤', exact: true }).click();
    await expect(form).toHaveCount(0); await expect(root.locator('.steps-pagination')).toHaveCount(0);
    await expect(root.locator('.step-row[data-step-id="00000064"] .step-disclosure')).toBeFocused();
    expect(writes).toEqual([`DELETE /api/v1/projects/${projectId}/tasks/${taskId}/steps/00000065`]);
  });
}

test('touch can open and cancel the Step position target picker', async ({ browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('The task controls fixture requires a base URL.');
  const context = await browser.newContext({ baseURL, locale: 'en-US', hasTouch: true, viewport: { width: 320, height: 640 } });
  try {
    const page = await context.newPage(); const writes = await install(page, false, false, true);
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
    const row = page.locator('.step-row[data-step-id="00000001"]');
    await expect(row.locator('.step-more')).toHaveAttribute('aria-disabled', 'false'); await row.locator('.step-more').tap();
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).tap();
    const picker = page.getByRole('dialog', { name: 'Move step', exact: true });
    await picker.getByRole('radio').first().tap(); await picker.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(picker).toHaveCount(0); expect(writes).toEqual([]);
  } finally { await context.close(); }
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390]) {
  test(`Task status and platform controls fit and keep focus at ${width}px in ${locale}`, async ({ page }) => {
    const writes = await install(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    const dialog = page.locator('.task-detail-dialog');
    const status = dialog.locator('.task-status-trigger');
    const platform = dialog.getByRole('combobox', { name: locale === 'en' ? 'Execution platform' : '执行平台' });
    await expect(status).toBeEnabled(); await expect(platform).toBeEnabled();
    await expect.poll(() => dialog.locator('.task-detail-status-row').evaluate(row => {
      const bounds = row.getBoundingClientRect();
      const boxes = Array.from(row.querySelectorAll('.task-status-trigger, .task-assignee-field, .task-platform-select, .task-detail-ready, .task-detail-blocked, .task-detail-execution-mode, .task-automation-control')).map(element => element.getBoundingClientRect());
      return row.scrollWidth <= row.clientWidth && document.documentElement.scrollWidth <= innerWidth && boxes.every((box, index) => box.width > 0 && box.height > 0 && box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5 && boxes.slice(index + 1).every(other => box.right <= other.left + 0.5 || other.right <= box.left + 0.5 || box.bottom <= other.top + 0.5 || other.bottom <= box.top + 0.5));
    })).toBe(true);
    await status.focus(); await page.keyboard.press('Enter');
    const options = dialog.getByRole('menuitemradio'); await expect(options).toHaveCount(3);
    await page.keyboard.press('End'); await expect(options.last()).toBeFocused();
    await page.keyboard.press('Home'); await expect(options.first()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(status).toBeFocused();
    await status.click(); await options.last().click();
    const statusConfirmation = page.getByRole('alertdialog', { name: locale === 'en' ? 'Set task status' : '设置任务状态' });
    await expect(statusConfirmation).toBeVisible(); await page.keyboard.press('Escape');
    await expect(statusConfirmation).toHaveCount(0); await expect(status).toBeFocused();
    await platform.focus(); await expect(platform).toBeFocused();
    if (await page.evaluate(() => navigator.platform.startsWith('Mac'))) {
      const session = await page.context().newCDPSession(page);
      try { await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', text: 'w', unmodifiedText: 'w' }); await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); }
      finally { await session.detach(); }
    } else await page.keyboard.press('ArrowDown');
    const platformConfirmation = page.getByRole('alertdialog', { name: locale === 'en' ? 'Change execution platform?' : '修改执行平台？' });
    await expect(platformConfirmation).toBeVisible(); await expect(platform).toHaveValue('');
    await page.keyboard.press('Escape'); await expect(platformConfirmation).toHaveCount(0); await expect(platform).toBeFocused();
    expect(writes).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390]) {
  test(`assignment and pause remain usable at ${width}px in ${locale}`, async ({ page }) => {
    const writes = await install(page, false, false, false, true, true);
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    const filter = page.locator('.task-assignee-filter .assignee-trigger');
    const status = page.getByRole('combobox', { name: locale === 'en' ? 'Status' : '状态', exact: true });
    await expect.poll(() => status.evaluate(select => {
      const owner = document.querySelector('.task-assignee-filter')!.getBoundingClientRect(); const box = select.getBoundingClientRect();
      return (owner.right <= box.left + 1 || box.right <= owner.left + 1 || owner.bottom <= box.top + 1 || box.bottom <= owner.top + 1) && owner.left >= 0 && box.left >= 0 && owner.right <= innerWidth && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    await filter.click();
    const picker = page.locator('.assignee-menu'); await expect(picker.getByRole('listbox')).toBeVisible();
    await picker.getByRole('option', { name: locale === 'en' ? 'Assigned to me' : '分配给我', exact: true }).click();
    const row = page.locator(`#standalone-task-${taskId}`);
    await expect(row).toBeVisible(); await expect(page.locator(`#standalone-task-${previousId}`)).toHaveCount(0);
    const identity = row.locator('.task-assignee-identity');
    await expect(identity).toHaveAccessibleName(`${locale === 'en' ? 'Assignee: ' : '负责人：'}${longName}`);
    await expect(identity.locator('.assignee-avatar img')).toHaveCount(0); await expect(identity.locator('.assignee-avatar')).toHaveText('A');
    expect(await identity.locator('.assignee-name').evaluate(name => getComputedStyle(name).textOverflow === 'ellipsis' && name.scrollWidth > name.clientWidth)).toBe(true);
    await row.click(); const dialog = page.locator('.task-detail-dialog');
    const strip = dialog.locator('.task-pause-strip'); await expect(strip.locator('.task-pause-unpause')).toBeVisible();
    expect(await strip.evaluate(element => {
      const box = element.getBoundingClientRect(), label = element.querySelector('.task-pause-label')!.getBoundingClientRect(), button = element.querySelector('button')!.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && label.right <= button.left && button.right <= box.right && box.left >= 0 && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    const trigger = dialog.getByRole('button', { name: new RegExp(`^(Assignee: |负责人：)${longName}`) }); await trigger.click();
    const menu = dialog.locator('.assignee-menu'); await expect(menu.getByRole('listbox')).toBeVisible();
    await expect(menu.getByRole('textbox')).toBeFocused(); await expect(menu.getByRole('option', { name: longName })).toBeVisible();
    await expect.poll(() => menu.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 11.5 && box.top >= 11.5 && box.right <= innerWidth - 11.5 && box.bottom <= innerHeight - 11.5 && box.width <= 306.5 && box.height <= 370.5; })).toBe(true);
    await dialog.locator('.task-detail-panel-overview').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
    await expect.poll(() => menu.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 11.5 && box.top >= 11.5 && box.right <= innerWidth - 11.5 && box.bottom <= innerHeight - 11.5; })).toBe(true);
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(writes).toEqual([]);
  });
}

test('locked automatic execution explains its state on focus and Escape dismisses it', async ({ page }) => {
  const writes = await install(page, true);
  const dialog = await openDialog(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const control = dialog.getByRole('switch', { name: 'Automatic execution' });
  await expect(control).toBeDisabled(); await expect(control).not.toBeChecked();
  const group = dialog.getByRole('group', { name: 'Automatic execution', exact: true });
  await group.focus(); await expect(group.getByRole('tooltip')).toBeVisible();
  await expect(control).toHaveAccessibleDescription(/in progress/i);
  await page.keyboard.press('Escape'); await expect(group.locator('.task-control-tip-bubble')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const platform = dialog.getByRole('combobox', { name: 'Execution platform' });
  await expect(platform).toBeDisabled();
  const platformGroup = dialog.getByRole('group', { name: 'Execution platform', exact: true });
  await platformGroup.focus(); await expect(platformGroup.getByRole('tooltip')).toBeVisible();
  await expect(platform).toHaveAccessibleDescription(/in progress/i);
  await page.keyboard.press('Escape'); await expect(platformGroup.locator('.task-control-tip-bubble')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});
