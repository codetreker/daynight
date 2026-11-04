import type { Locator, Page } from '@playwright/test';
import { parseApiJson } from '../../src/api/json';
import { parseTaskSteps } from '../../src/api/task-steps';
import { authenticatedAPI, fulfillAuthenticatedResponse } from './authentication';
import { createTask, expect, test, updateTask } from './fixtures';

test.use({ preparationFamily: 'status' });
const root = (page: Page): Locator => page.locator('.task-detail-page, .task-detail-dialog');
const form = (page: Page): Locator => root(page).locator('.step-add-form');
const endpoint = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}/steps`;

test('append steps with draft protection and recovery through the real service', { annotation: { type: 'scenario', description: 'task-step-add' } }, async ({ page, api, baseURL, allowBrowserWrites, statusPreparation }, info) => {
  const projectId = statusPreparation.projectId;
  const task = await createTask(api, projectId, { title: 'Append browser acceptance' });
  const previousTask = await createTask(api, projectId, { title: 'History origin', dependsOn: [task.id] });
  const path = endpoint(projectId, task.id);
  let version = task.version;
  for (let index = 0; index < 100; index++) {
    const response = await api.post(path, { data: { version, id: index.toString(16).padStart(8, '0'), title: `Existing ${index}` } });
    expect(response.status()).toBe(201);
    version = Number(parseTaskSteps(parseApiJson(await response.text()), projectId, task.id).version);
  }
  const url = new URL(path, baseURL).href;
  allowBrowserWrites([{ method: 'POST', url, count: 5 }]);
  let mode: 'normal' | 'conflict' | 'lost' | 'late' = 'normal';
  let readsBlocked = false;
  let releaseLate!: () => void; let enterLate!: () => void; let releaseMove = () => {};
  const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
  const lateEntered = new Promise<void>(resolve => { enterLate = resolve; });
  const writes: { id: string; requestId: string; status: number }[] = [];
  await page.route(url, async route => {
    if (route.request().method() === 'GET') {
      if (readsBlocked) await route.abort('connectionfailed'); else await route.continue();
      return;
    }
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const currentMode = mode; mode = 'normal';
    if (currentMode === 'conflict') {
      const current = await (await api.get(`/api/v1/projects/${projectId}/tasks/${task.id}`)).json();
      await updateTask(api, projectId, task.id, { version: current.version, description: 'Concurrent parent change' });
    }
    const request = route.request();
    const response = await authenticatedAPI(page.context().request).fetch(request, { timeout: 15_000, maxRetries: 0 });
    writes.push({ id: request.postDataJSON().id as string, requestId: request.headers()['x-request-id']!, status: response.status() });
    if (currentMode === 'lost') { readsBlocked = true; await route.abort('connectionfailed'); return; }
    if (currentMode === 'late') { enterLate(); await lateGate; }
    await fulfillAuthenticatedResponse(route, response);
  });
  const add = async (title: string, description = '') => {
    await root(page).getByRole('button', { name: '添加步骤', exact: true }).click();
    await form(page).getByRole('textbox', { name: '标题', exact: true }).fill(title);
    if (description) await form(page).getByRole('textbox', { name: '说明（Markdown，可选）', exact: true }).fill(description);
  };
  const save = () => form(page).getByRole('button', { name: '保存', exact: true }).click();
  try {
    // Reach this task through application history so a Back traversal leaves its draft scope.
    await page.goto(`/projects/${projectId}/tasks/${previousTask.id}`);
    const relation = () => root(page).getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: 'Append browser acceptance，普通依赖', exact: true });
    await relation().click();
    await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await expect(root(page).getByRole('button', { name: '添加步骤', exact: true })).toBeEnabled();
    await add('移动导航草稿');
    const moveTrigger = root(page).locator('.step-row[data-step-id="00000000"] .step-more');
    const openRelativeMove = async () => {
      await expect(moveTrigger).toHaveAttribute('aria-disabled', 'false');
      await moveTrigger.click();
      await page.getByRole('menuitem', { name: '移动到…', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '移动步骤', exact: true })).toBeVisible();
    };
    await openRelativeMove();
    await page.evaluate(() => history.go(-2));
    const leave = page.getByRole('alertdialog');
    await expect(leave).toBeVisible();
    await expect(page.getByRole('dialog', { name: '移动步骤', exact: true })).toHaveCount(0);
    await expect(leave.getByRole('button', { name: '继续编辑' })).toBeFocused();
    await leave.getByRole('button', { name: '继续编辑' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}\\?tab=steps$`));
    await expect(form(page).getByRole('textbox', { name: '标题' })).toHaveValue('移动导航草稿');
    await expect(form(page).getByRole('textbox', { name: '标题' })).toBeFocused();
    await openRelativeMove();
    await page.evaluate(() => history.go(-2));
    await expect(leave).toBeVisible();
    await expect(page.getByRole('dialog', { name: '移动步骤', exact: true })).toHaveCount(0);
    await leave.getByRole('button', { name: '放弃并离开' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${previousTask.id}$`));
    await expect(root(page).locator('.task-detail-title')).toHaveText('History origin');
    await relation().click(); await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await expect(root(page).getByRole('button', { name: '添加步骤', exact: true })).toBeEnabled();
    await add('新增真实步骤', '**说明**');
    await form(page).getByRole('combobox', { name: '初始状态' }).selectOption('in_progress');
    await form(page).getByRole('button', { name: '预览', exact: true }).click();
    await expect(form(page).locator('strong')).toHaveText('说明');
    await root(page).getByRole('tab', { name: '概览', exact: true }).click();
    await root(page).getByRole('tab', { name: '步骤', exact: true }).click();
    await expect(form(page).getByRole('textbox', { name: '标题' })).toHaveValue('新增真实步骤');
    await page.locator('.task-detail-page-back').click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
    await expect(form(page).getByRole('textbox', { name: '标题' })).toHaveValue('新增真实步骤');
    for (const locale of ['zh-CN', 'en']) {
      await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const image = info.outputPath(`step-add-${locale}-${width}.png`);
        await page.screenshot({ path: image, animations: 'disabled' });
        await info.attach('scenario-screenshot', { path: image, contentType: 'image/png' });
      }
    }
    await root(page).getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
    await page.setViewportSize({ width: 1440, height: 800 });
    await save();
    await expect(form(page)).toHaveCount(0);
    const first = writes[0]!; expect(first.status).toBe(201);
    const firstRow = root(page).locator(`.step-row[data-step-id="${first.id}"]`);
    await expect(firstRow).toBeVisible(); await expect(firstRow.locator('.step-disclosure')).toBeFocused();
    await expect(root(page).getByRole('spinbutton', { name: '页码' })).toHaveValue('2');
    const cli = await statusPreparation.cli.run(['task', 'step', 'show', task.id, first.id, '--project', projectId, '--json']);
    expect(cli.exitCode).toBe(0); expect(cli.stderr).toBe('');
    const cliResult = JSON.parse(cli.stdout) as { step: { id: string; title: string; description: string; status: string } };
    expect(cliResult.step).toMatchObject({ id: first.id, title: '新增真实步骤', description: '**说明**', status: 'in_progress' });

    await add('冲突草稿'); mode = 'conflict'; await save();
    await expect(form(page).getByText(/已读取步骤/)).toBeVisible();
    expect(writes[1]?.status).toBe(409); await expect(form(page).getByRole('textbox', { name: '标题' })).toHaveValue('冲突草稿');
    await expect(form(page).getByRole('button', { name: '保存', exact: true })).toBeEnabled(); await save();
    await expect(form(page)).toHaveCount(0); expect(writes[2]?.status).toBe(201);

    await add('未知草稿'); mode = 'lost'; await save();
    await expect(form(page).getByText(/添加结果未知/)).toBeVisible();
    await expect(form(page).getByRole('textbox', { name: '标题' })).toBeDisabled();
    await expect(form(page).getByRole('button', { name: '读取当前步骤' })).toBeEnabled();
    const lost = writes[3]!; expect(lost.status).toBe(201);
    readsBlocked = false; await form(page).getByRole('button', { name: '读取当前步骤' }).click();
    await expect(form(page).getByText(/先前请求的结果仍未知/)).toBeVisible();
    const afterLost = await api.get(path); expect(afterLost.status()).toBe(200);
    expect(parseTaskSteps(parseApiJson(await afterLost.text()), projectId, task.id).steps.find(step => step.id === lost.id)?.title).toBe('未知草稿');
    expect(writes).toHaveLength(4);
    await form(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click();

    await add('晚回执'); mode = 'late'; await save(); await lateEntered;
    await form(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click();
    await add('新的草稿'); releaseLate();
    await expect(form(page).getByRole('textbox', { name: '标题' })).toHaveValue('新的草稿');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: '继续编辑' }).click();
    await expect(form(page).getByRole('textbox', { name: '标题' })).toHaveValue('新的草稿');
    expect(writes).toHaveLength(5);
    await form(page).getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '放弃', exact: true }).click();

    // A move receipt for a row on page 2 must not steal an active add editor or switch it to page 1.
    const positionUrl = new URL(`${path}/${first.id}/position`, baseURL).href;
    allowBrowserWrites([{ method: 'PUT', url: positionUrl, count: 1 }]);
    let moveEntered!: () => void;
    const moveWaiting = new Promise<void>(resolve => { moveEntered = resolve; });
    const moveGate = new Promise<void>(resolve => { releaseMove = resolve; });
    await page.route(positionUrl, async route => {
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200); moveEntered(); await moveGate;
      await fulfillAuthenticatedResponse(route, response);
    });
    const movedRow = root(page).locator(`.step-row[data-step-id="${first.id}"]`);
    const more = movedRow.locator('.step-more');
    await expect(more).toHaveAttribute('aria-disabled', 'false'); await more.click();
    await page.getByRole('menuitem', { name: '移到开头', exact: true }).click();
    await moveWaiting; await add('移动期间的新草稿');
    const editor = form(page).getByRole('textbox', { name: '标题', exact: true });
    await expect(editor).toBeFocused();
    await expect(root(page).getByRole('spinbutton', { name: '页码' })).toHaveValue('2');
    releaseMove();
    await expect(form(page).getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await expect(editor).toHaveValue('移动期间的新草稿'); await expect(editor).toBeFocused();
    await expect(root(page).getByRole('spinbutton', { name: '页码' })).toHaveValue('2');
    const afterMove = await api.get(path); expect(afterMove.status()).toBe(200);
    expect(parseTaskSteps(parseApiJson(await afterMove.text()), projectId, task.id).steps[0]?.id).toBe(first.id);
  } finally { releaseLate(); releaseMove(); }
});
