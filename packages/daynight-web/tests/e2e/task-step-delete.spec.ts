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
const id = (index: number): string => index.toString(16).padStart(8, '0');

test('delete step with draft protection, pagination and recovery through the real service', { annotation: { type: 'scenario', description: 'task-step-delete' } }, async ({ page, api, baseURL, allowBrowserWrites, statusPreparation }, info) => {
  if (baseURL === undefined) throw new Error('Step deletion acceptance requires the actual service origin.');
  const project = statusPreparation.projectId;
  const task = await createTask(api, project, { title: 'Step deletion acceptance', description: 'Parent description retained' });
  const path = `/api/v1/projects/${project}/tasks/${task.id}/steps`;
  const attachment = attachmentDownloadUrl(project, task.id, 'reference.md');
  expect((await api.put(attachment, { headers: { 'Content-Type': 'text/markdown' }, data: '# Reference\n' })).status()).toBe(201);
  let version = BigInt(task.version);
  for (let index = 0; index < 101; index++) {
    const response = await api.post(path, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version, id: id(index), title: `Step ${index}`, description: `Description ${index}`, status: index === 100 ? 'done' : index === 0 ? 'skipped' : 'todo' }) });
    expect(response.status()).toBe(201);
    version = parseTaskSteps(parseApiJson(await response.text()), project, task.id).version;
  }
  const smallTask = await createTask(api, project, { title: 'Step deletion focus acceptance' });
  const smallPath = `/api/v1/projects/${project}/tasks/${smallTask.id}/steps`;
  let smallVersion = BigInt(smallTask.version);
  for (const [index, status] of ['in_progress', 'todo'].entries()) {
    const response = await api.post(smallPath, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: smallVersion, id: id(index), title: `Focus ${index}`, status }) });
    expect(response.status()).toBe(201);
    smallVersion = parseTaskSteps(parseApiJson(await response.text()), project, smallTask.id).version;
  }
  allowBrowserWrites([0, 1].map(index => ({ method: 'DELETE', url: new URL(`${smallPath}/${id(index)}`, baseURL).href, count: 1 })));
  const read = async () => {
    const response = await api.get(path); expect(response.status()).toBe(200);
    return parseTaskSteps(parseApiJson(await response.text()), project, task.id);
  };
  const collectionUrl = new URL(path, baseURL).href;
  const urls = [100, 0].map(index => new URL(`${path}/${id(index)}`, baseURL).href);
  allowBrowserWrites(urls.map((url, index) => ({ method: 'DELETE', url, count: index === 0 ? 1 : 2 })));
  let mode: 'normal' | 'missing' | 'lost' = 'normal';
  let rejectReads = false;
  const receipts: { id: string; status: number }[] = [];
  await page.route(collectionUrl, async route => {
    if (rejectReads && route.request().method() === 'GET') await route.abort('connectionfailed');
    else await route.continue();
  });
  for (const [index, url] of urls.entries()) await page.route(url, async route => {
    if (route.request().method() !== 'DELETE') { await route.continue(); return; }
    const currentMode = mode; mode = 'normal';
    const response = currentMode === 'missing'
      ? await api.delete(`${path}/deadbeef`, { headers: { 'Content-Type': 'application/json' }, data: route.request().postDataJSON() })
      : await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    receipts.push({ id: [id(100), id(0)][index]!, status: response.status() });
    if (currentMode === 'lost') { rejectReads = true; await route.abort('connectionfailed'); return; }
    await fulfillAuthenticatedResponse(route, response);
  });
  const edit = async (target: string) => {
    await row(page, target).locator('.step-disclosure').click();
    await row(page, target).getByRole('button', { name: '编辑步骤', exact: true }).click();
  };
  const openDelete = async (target: string, locale: 'zh-CN' | 'en' = 'zh-CN') => {
    const more = row(page, target).locator('.step-more');
    await expect(more).toHaveAttribute('aria-disabled', 'false');
    await more.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: locale === 'en' ? 'Delete step' : '删除步骤', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
  };
  try {
    await page.goto(`/projects/${project}/tasks/${task.id}?tab=steps`);
    const pageNumber = root(page).getByRole('spinbutton', { name: '页码' });
    await pageNumber.fill('2'); await pageNumber.press('Enter');
    await edit(id(100));
    await form(page).getByRole('textbox', { name: '标题', exact: true }).fill('Unpublished draft');
    for (const locale of ['zh-CN', 'en'] as const) {
      await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await openDelete(id(100), locale);
        const dialog = page.getByRole('alertdialog');
        const cancel = dialog.locator('.dialog-footer').getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
        await expect(cancel).toBeFocused();
        await expect(dialog).toContainText('Step 100'); await expect(dialog).toContainText(id(100));
        await expect(dialog).toContainText(locale === 'en' ? 'Attachments, pull requests and other references will remain' : '附件、拉取请求及其他引用会保留');
        await expect(dialog).toContainText(locale === 'en' ? 'Unsaved changes' : '未保存修改');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const screenshot = info.outputPath(`step-delete-${locale}-${width}.png`);
        await page.screenshot({ path: screenshot, animations: 'disabled' });
        await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
        for (let key = 0; key < 5; key++) {
          await page.keyboard.press('Tab');
          await expect(dialog.locator(':focus')).toHaveCount(1);
        }
        if (width === 320) await cancel.click();
        else await page.keyboard.press('Escape');
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(form(page).getByRole('textbox', { name: locale === 'en' ? 'Title' : '标题', exact: true })).toHaveValue('Unpublished draft');
      }
    }
    await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
    await page.setViewportSize({ width: 1440, height: 800 });
    const before = await read();
    await openDelete(id(100));
    await page.getByRole('alertdialog').getByRole('button', { name: '删除步骤', exact: true }).click();
    await expect(form(page)).toHaveCount(0);
    await expect(row(page, id(99)).locator('.step-disclosure')).toBeFocused();
    const deleted = await read();
    expect(deleted.version).toBe(before.version + 1n);
    expect(deleted.steps).toEqual(before.steps.slice(0, 100));
    expect(await (await api.get(attachment)).text()).toBe('# Reference\n');
    expect(receipts).toEqual([{ id: id(100), status: 200 }]);

    await edit(id(0));
    await form(page).getByRole('textbox', { name: '标题', exact: true }).fill('Draft retained after refusal');
    mode = 'missing'; await openDelete(id(0));
    await page.getByRole('alertdialog').getByRole('button', { name: '删除步骤', exact: true }).click();
    await expect(root(page).getByRole('alert').filter({ hasText: '未找到此步骤' })).toBeVisible();
    await expect(form(page).getByRole('textbox', { name: '标题', exact: true })).toHaveValue('Draft retained after refusal');
    expect(await read()).toEqual(deleted);
    expect(receipts[1]).toEqual({ id: id(0), status: 404 });
    await root(page).getByRole('button', { name: '读取当前步骤', exact: true }).click();
    await expect(row(page, id(0)).locator('.step-more')).toHaveAttribute('aria-disabled', 'false');
    mode = 'lost'; await openDelete(id(0));
    await page.getByRole('alertdialog').getByRole('button', { name: '删除步骤', exact: true }).click();
    await expect(root(page).getByRole('button', { name: '读取当前步骤', exact: true })).toBeEnabled();
    await expect(root(page)).toContainText('无法核对当前步骤');
    await expect(form(page).getByRole('textbox', { name: '标题', exact: true })).toHaveValue('Draft retained after refusal');
    expect((await read()).steps.some(step => step.id === id(0))).toBe(false);
    expect(receipts).toHaveLength(3);
    rejectReads = false;
    await root(page).getByRole('button', { name: '读取当前步骤', exact: true }).click();
    await expect(root(page)).toContainText('先前请求的结果仍未知');
    await expect(form(page).getByRole('textbox', { name: '标题', exact: true })).toHaveValue('Draft retained after refusal');
    expect(receipts).toHaveLength(3);
    expect((await read()).steps).toEqual(deleted.steps.slice(1));
    await form(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click();
    await page.goto(`/projects/${project}/tasks/${smallTask.id}?tab=steps`);
    await openDelete(id(0));
    await page.getByRole('alertdialog').getByRole('button', { name: '删除步骤', exact: true }).click();
    await expect(row(page, id(1)).locator('.step-disclosure')).toBeFocused();
    await openDelete(id(1));
    await page.getByRole('alertdialog').getByRole('button', { name: '删除步骤', exact: true }).click();
    await expect(root(page).getByRole('button', { name: '添加步骤', exact: true })).toBeFocused();
    const empty = await api.get(smallPath); expect(empty.status()).toBe(200);
    expect(parseTaskSteps(parseApiJson(await empty.text()), project, smallTask.id).steps).toEqual([]);
  } finally {
    rejectReads = false;
    for (const url of urls) await page.unroute(url);
    await page.unroute(collectionUrl);
  }
});
