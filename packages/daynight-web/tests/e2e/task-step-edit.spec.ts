import type { Locator, Page } from '@playwright/test';
import { attachmentDownloadUrl } from '../../src/api/client';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseTaskSteps } from '../../src/api/task-steps';
import { authenticatedAPI, fulfillAuthenticatedResponse } from './authentication';
import { createTask, expect, test } from './fixtures';

test.use({ preparationFamily: 'status' });
const root = (page: Page): Locator => page.locator('.task-detail-page, .task-detail-dialog');
const row = (page: Page, id: string): Locator => root(page).locator(`.step-row[data-step-id="${id}"]`);
const form = (page: Page): Locator => root(page).locator('.step-edit-form');
const target = '00000000';
const other = '00000001';

test('edit step content with draft protection and recovery through the real service', { annotation: { type: 'scenario', description: 'task-step-edit' } }, async ({ page, api, baseURL, allowBrowserWrites, statusPreparation }, info) => {
  if (baseURL === undefined) throw new Error('Step editing acceptance requires the actual service origin.');
  const project = statusPreparation.projectId;
  const task = await createTask(api, project, { title: 'Step editing acceptance', description: 'Parent description retained' });
  const path = `/api/v1/projects/${project}/tasks/${task.id}/steps`;
  const attachment = attachmentDownloadUrl(project, task.id, 'reference.md');
  expect((await api.put(attachment, { headers: { 'Content-Type': 'text/markdown' }, data: '# Reference\n' })).status()).toBe(201);
  let version = BigInt(task.version);
  for (let index = 0; index < 101; index++) {
    const response = await api.post(path, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version, id: index.toString(16).padStart(8, '0'), title: index < 2 ? 'Same\nname' : `Step ${index}`, description: index === 0 ? 'Original description' : '', status: index === 0 ? 'in_progress' : 'todo' }) });
    expect(response.status()).toBe(201);
    version = parseTaskSteps(parseApiJson(await response.text()), project, task.id).version;
  }
  const read = async () => {
    const response = await api.get(path); expect(response.status()).toBe(200);
    return parseTaskSteps(parseApiJson(await response.text()), project, task.id);
  };
  const url = new URL(`${path}/${target}`, baseURL).href;
  const statusUrl = new URL(`${path}/${target}/status`, baseURL).href;
  allowBrowserWrites([{ method: 'PATCH', url, count: 6 }, { method: 'PUT', url: statusUrl, count: 1 }]);
  let mode: 'normal' | 'conflict' | 'lost' | 'late' = 'normal';
  let readsBlocked = false;
  let releaseLate = () => {}; let enterLate = () => {};
  const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
  const lateEntered = new Promise<void>(resolve => { enterLate = resolve; });
  const writes: { status: number; body: Record<string, unknown> }[] = [];
  await page.route(new URL(path, baseURL).href, async route => {
    if (route.request().method() === 'GET' && readsBlocked) await route.abort('connectionfailed');
    else await route.continue();
  });
  await page.route(url, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    const currentMode = mode; mode = 'normal';
    if (currentMode === 'conflict') {
      const current = await read();
      const concurrent = await api.patch(`${path}/${target}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: current.version, title: 'Concurrent title', description: 'Concurrent description' }) });
      expect(concurrent.status()).toBe(200);
    }
    const request = route.request();
    const response = await authenticatedAPI(page.context().request).fetch(request, { timeout: 15_000, maxRetries: 0 });
    writes.push({ status: response.status(), body: request.postDataJSON() as Record<string, unknown> });
    if (currentMode === 'lost') { readsBlocked = true; await route.abort('connectionfailed'); return; }
    if (currentMode === 'late') { enterLate(); await lateGate; }
    await fulfillAuthenticatedResponse(route, response);
  });
  const edit = async (id: string) => {
    const item = row(page, id);
    if (await item.locator('.step-disclosure').getAttribute('aria-expanded') !== 'true') await item.locator('.step-disclosure').click();
    await item.getByRole('button', { name: '编辑步骤', exact: true }).click();
  };
  const title = () => form(page).getByRole('textbox', { name: '标题', exact: true });
  const description = () => form(page).getByRole('textbox', { name: '说明（Markdown，可选）', exact: true });
  const save = () => form(page).getByRole('button', { name: '保存', exact: true }).click();
  try {
    await page.goto(`/projects/${project}/tasks/${task.id}?tab=steps`);
    await edit(target);
    await expect(title()).toHaveValue('Same\nname');
    await description().fill('Only description changed');
    const original = await read();
    await save(); await expect(form(page)).toHaveCount(0);
    expect(writes[0]).toMatchObject({ status: 200, body: { title: 'Same\nname', description: 'Only description changed' } });
    const descriptionOnly = await read();
    expect(descriptionOnly.version).toBe(original.version + 1n);
    expect(descriptionOnly.steps[0]).toMatchObject({ id: target, title: 'Same\nname', description: 'Only description changed', status: 'in_progress', createdAt: original.steps[0]!.createdAt });
    expect(descriptionOnly.steps.slice(1)).toEqual(original.steps.slice(1));
    await edit(target);
    await title().fill('Edited title'); await description().fill('');
    await edit(other);
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
    await expect(title()).toHaveValue('Edited title');
    await root(page).getByRole('tab', { name: '概览', exact: true }).click();
    await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await expect(title()).toHaveValue('Edited title');
    const pageNumber = root(page).getByRole('spinbutton', { name: '页码' });
    await pageNumber.fill('2'); await pageNumber.press('Enter');
    await pageNumber.fill('1'); await pageNumber.press('Enter');
    await expect(title()).toHaveValue('Edited title');
    await expect(description()).toHaveValue('');
    await page.locator('.task-detail-page-back').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
    await expect(title()).toHaveValue('Edited title');
    for (const locale of ['zh-CN', 'en']) {
      await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const editorTitle = form(page).getByRole('textbox', { name: locale === 'en' ? 'Title' : '标题', exact: true });
        await editorTitle.focus(); await page.keyboard.press('Tab');
        await expect(form(page).locator(':focus')).toHaveCount(1);
        const screenshot = info.outputPath(`step-edit-${locale}-${width}.png`);
        await page.screenshot({ path: screenshot, animations: 'disabled' });
        await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
      }
    }
    await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
    await page.setViewportSize({ width: 1440, height: 800 });
    const before = await read();
    await save(); await expect(form(page)).toHaveCount(0);
    expect(writes[1]).toMatchObject({ status: 200, body: { title: 'Edited title', description: '' } });
    const saved = await read();
    expect(saved.version).toBe(before.version + 1n);
    expect(saved.steps[0]).toMatchObject({ id: target, title: 'Edited title', description: '', status: 'in_progress', createdAt: before.steps[0]!.createdAt });
    expect(saved.steps.slice(1)).toEqual(before.steps.slice(1));
    expect(await (await api.get(attachment)).text()).toBe('# Reference\n');
    const cli = await statusPreparation.cli.run(['task', 'step', 'show', task.id, target, '--project', project, '--json']);
    expect(cli.exitCode).toBe(0); expect(cli.stderr).toBe('');
    expect(JSON.parse(cli.stdout).step).toMatchObject({ id: target, title: 'Edited title', description: '', status: 'in_progress' });
    const statusButton = row(page, target).locator('.step-status-picker button');
    await expect(statusButton).toHaveAttribute('aria-disabled', 'false'); await statusButton.click();
    await page.getByRole('menuitemradio', { name: '已完成', exact: true }).click();
    await expect(statusButton).toHaveAttribute('aria-disabled', 'false');
    expect((await read()).steps[0]).toMatchObject({ id: target, title: 'Edited title', description: '', status: 'done' });

    await edit(target); await title().fill('Conflict draft'); mode = 'conflict'; await save();
    await expect(form(page).getByRole('alert')).toBeVisible();
    await expect(title()).toHaveValue('Conflict draft');
    expect(writes[2]?.status).toBe(409);
    await expect(form(page)).toContainText('Concurrent title');
    await expect(form(page)).toContainText('Concurrent description');
    await expect(form(page).getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await save(); await expect(form(page)).toHaveCount(0); expect(writes[3]?.status).toBe(200);

    await edit(target); await title().fill('Unknown draft'); mode = 'lost'; await save();
    await expect(title()).toBeDisabled();
    await expect(form(page).getByRole('alert')).toBeVisible();
    readsBlocked = false;
    await form(page).getByRole('button', { name: '读取当前步骤' }).click();
    await expect(form(page).getByRole('alert')).toBeVisible();
    expect((await read()).steps[0]?.title).toBe('Unknown draft'); expect(writes).toHaveLength(5);
    await form(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click();

    await edit(target); await title().fill('Late receipt'); mode = 'late'; await save(); await lateEntered;
    await form(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click();
    await edit(other); await title().fill('New draft'); releaseLate();
    await expect(title()).toHaveValue('New draft');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' })).toBeFocused();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
    await expect(title()).toHaveValue('New draft');
    expect(writes).toHaveLength(6);
    expect((await read()).steps[1]).toEqual(before.steps[1]);
    await expect(form(page).getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    const current = await read();
    const deleted = await api.delete(`${path}/${other}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: current.version }) });
    expect(deleted.status()).toBe(200);
    await root(page).getByRole('button', { name: '刷新步骤' }).click();
    await expect(form(page).getByRole('alert')).toBeVisible();
    await expect(title()).toHaveValue('New draft');
    await expect(form(page).getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    expect(writes).toHaveLength(6);
  } finally { releaseLate(); await page.unroute(url); await page.unroute(new URL(path, baseURL).href); }
});
