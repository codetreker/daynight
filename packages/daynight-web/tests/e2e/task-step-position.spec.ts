import type { Locator, Page } from '@playwright/test';
import { parseApiJson, stringifyApiJson } from '../../src/api/json';
import { parseTaskSteps } from '../../src/api/task-steps';
import { authenticatedAPI, fulfillAuthenticatedResponse } from './authentication';
import { createProject, createTask, expect, test, updateTask } from './fixtures';

const root = (page: Page): Locator => page.locator('.task-detail-page, .task-detail-dialog');
const row = (page: Page, id: string): Locator => root(page).locator(`.step-row[data-step-id="${id}"]`);
const source = '00000001';
const menu = (page: Page): Locator => row(page, source).getByRole('button', { name: /更多操作|More actions/ });
const endpoint = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}/steps`;

test('step positions use the complete real collection', { annotation: { type: 'scenario', description: 'task-step-position' } }, async ({ page, browser, api, baseURL, allowBrowserWrites }, info) => {
  if (baseURL === undefined) throw new Error('Position acceptance requires the actual service origin.');
  const project = await createProject(api, { name: 'Step position browser acceptance' });
  const task = await createTask(api, project.id, { title: 'Step position acceptance' });
  const path = endpoint(project.id, task.id);
  let version = BigInt(task.version);
  for (let index = 1; index <= 201; index++) {
    const id = index.toString(16).padStart(8, '0');
    const response = await api.post(path, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version, id, title: `Step ${index}`, description: index === 1 ? 'Preserve expansion' : '' }) });
    expect(response.status()).toBe(201);
    version = parseTaskSteps(parseApiJson(await response.text()), project.id, task.id).version;
  }
  const read = async () => {
    const response = await api.get(path); expect(response.status()).toBe(200);
    return parseTaskSteps(parseApiJson(await response.text()), project.id, task.id);
  };
  const positionUrl = new URL(`${path}/${source}/position`, baseURL).href;
  allowBrowserWrites([{ method: 'PUT', url: positionUrl, count: 10 }]);
  let mode: 'normal' | 'conflict' | 'lost' | 'missing' = 'normal';
  let writes = 0;
  await page.route(positionUrl, async route => {
    writes++;
    const requestMode = mode; mode = 'normal';
    if (requestMode === 'conflict') {
      const current = await (await api.get(`/api/v1/projects/${project.id}/tasks/${task.id}`)).json();
      await updateTask(api, project.id, task.id, { version: current.version, description: 'Concurrent parent update' });
    }
    const response = requestMode === 'missing'
      ? await api.put(`${path}/${source}/position`, { headers: { 'Content-Type': 'application/json' }, data: { ...route.request().postDataJSON(), before: 'deadbeef' } })
      : await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    if (requestMode === 'lost') await route.abort('connectionfailed');
    else await fulfillAuthenticatedResponse(route, response);
  });
  const choose = async (label: string) => {
    // The menu also permits opening an add draft while a write is reconciling.
    // The status control shares the position write's admission state.
    await expect(row(page, source).locator('.step-status')).toHaveAttribute('aria-disabled', 'false');
    await expect(menu(page)).toHaveAttribute('aria-disabled', 'false'); await menu(page).click();
    const receipt = mode === 'lost' || label === '移动到…' || label === 'Move to…' ? null : page.waitForResponse(response => response.url() === positionUrl && response.request().method() === 'PUT');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    if (receipt !== null) await receipt;
  };
  try {
    await page.goto(`/projects/${project.id}/tasks/${task.id}?tab=steps`);
    await expect(menu(page)).toHaveAttribute('aria-disabled', 'false');
    await row(page, source).locator('.step-disclosure').click();
    await menu(page).click();
    await expect(page.getByRole('menuitem', { name: '上移', exact: true })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: '移到开头', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(menu(page)).toBeFocused();
    await choose('下移'); await expect(menu(page)).toHaveAttribute('aria-disabled', 'false');
    expect((await read()).steps.slice(0, 2).map(step => step.id)).toEqual(['00000002', source]);
    await choose('上移'); await expect(menu(page)).toHaveAttribute('aria-disabled', 'false');
    await choose('移到末尾'); await expect(root(page).locator('.steps-pagination input')).toHaveValue('3'); await expect(menu(page)).toBeFocused();
    await expect(row(page, source).getByText('Preserve expansion')).toBeVisible();
    expect((await read()).steps.at(-1)?.id).toBe(source);
    await choose('移到开头'); await expect(root(page).locator('.steps-pagination input')).toHaveValue('1'); await expect(menu(page)).toBeFocused();
    await choose('移动到…');
    const dialog = page.getByRole('dialog', { name: '移动步骤', exact: true });
    await expect(dialog.getByRole('radio')).toHaveCount(100);
    const targetPage = dialog.getByRole('spinbutton', { name: '目标结果页码' });
    await targetPage.fill('2'); await targetPage.press('Enter');
    const anchor = '00000096';
    await dialog.getByRole('radio', { name: new RegExp(anchor) }).click();
    await dialog.getByRole('searchbox', { name: '搜索名称或 ID' }).fill('Step 2');
    await expect(dialog.locator('.step-target-selected')).toContainText(anchor);
    await dialog.getByRole('combobox', { name: '相对位置', exact: true }).selectOption('after');
    const relativeReceipt = page.waitForResponse(response => response.url() === positionUrl && response.request().method() === 'PUT');
    await dialog.getByRole('button', { name: '移动', exact: true }).click(); await relativeReceipt;
    await expect(root(page).locator('.steps-pagination input')).toHaveValue('2'); await expect(menu(page)).toBeFocused();
    const moved = await read(); expect(moved.steps.findIndex(step => step.id === source)).toBe(moved.steps.findIndex(step => step.id === anchor) + 1);
    await expect(row(page, source).getByText('Preserve expansion')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 640 });
    await root(page).getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    await menu(page).focus(); await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Move up', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(menu(page)).toBeFocused();
    const box = await menu(page).boundingBox(); expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    const screenshot = info.outputPath('step-position-320.png');
    await page.screenshot({ path: screenshot, animations: 'disabled' });
    await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
    // An already adjacent placement is a real service no-op.
    await choose('Move to…');
    const english = page.getByRole('dialog', { name: 'Move step', exact: true });
    await english.getByRole('searchbox', { name: 'Search name or ID' }).fill(anchor);
    await english.getByRole('radio', { name: new RegExp(anchor) }).click();
    await english.getByRole('combobox', { name: 'Placement' }).selectOption('after');
    const beforeNoop = await read();
    const noopReceipt = page.waitForResponse(response => response.url() === positionUrl && response.request().method() === 'PUT');
    await english.getByRole('button', { name: 'Move', exact: true }).click(); await noopReceipt;
    await expect(menu(page)).toHaveAttribute('aria-disabled', 'false'); expect(await read()).toEqual(beforeNoop);
    const selfBefore = await read();
    const self = await api.put(`${path}/${source}/position`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: selfBefore.version, before: source }) });
    expect(self.status()).toBe(400); expect(await self.json()).toMatchObject({ error: { code: 'invalid_input' } });
    expect(await read()).toEqual(selfBefore);
    await choose('Move to…');
    const beforeDialog = page.getByRole('dialog', { name: 'Move step', exact: true });
    await beforeDialog.getByRole('searchbox', { name: 'Search name or ID' }).fill(anchor);
    await beforeDialog.getByRole('radio', { name: new RegExp(anchor) }).click();
    const beforeReceipt = page.waitForResponse(response => response.url() === positionUrl && response.request().method() === 'PUT');
    await beforeDialog.getByRole('button', { name: 'Move', exact: true }).click(); await beforeReceipt;
    await expect(menu(page)).toHaveAttribute('aria-disabled', 'false');
    const beforeMoved = await read(); expect(beforeMoved.steps.findIndex(step => step.id === source) + 1).toBe(beforeMoved.steps.findIndex(step => step.id === anchor));
    mode = 'conflict'; await choose('Move up');
    await expect(root(page).getByRole('alert')).toContainText(/changed/i);
    await expect(menu(page)).toHaveAttribute('aria-disabled', 'false');
    mode = 'lost'; await choose('Move up');
    await expect(root(page).getByRole('alert')).toContainText(/unknown/i);
    await expect(menu(page)).toHaveAttribute('aria-disabled', 'false');
    mode = 'missing'; await choose('Move up');
    await expect(root(page).getByRole('alert')).toContainText('step or target was not found');
    expect(writes).toBe(10);
    const touch = await browser.newContext({ baseURL, locale: 'en', hasTouch: true, viewport: { width: 320, height: 640 }, storageState: await page.context().storageState() });
    try {
      const touchPage = await touch.newPage(); await touchPage.goto(`/projects/${project.id}/tasks/${task.id}?tab=steps`);
      const pageNumber = root(touchPage).locator('.steps-pagination input'); await pageNumber.fill('2'); await pageNumber.press('Enter');
      await expect(menu(touchPage)).toHaveAttribute('aria-disabled', 'false'); await menu(touchPage).tap();
      await touchPage.getByRole('menuitem', { name: 'Move to…', exact: true }).tap();
      const picker = touchPage.getByRole('dialog', { name: 'Move step', exact: true });
      await picker.getByRole('radio').first().tap(); await picker.getByRole('button', { name: 'Cancel', exact: true }).tap();
    } finally { await touch.close(); }
  } finally { await page.unroute(positionUrl); }
});
