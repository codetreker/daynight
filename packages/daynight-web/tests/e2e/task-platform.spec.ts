import { selectTaskList } from './project-view';
import type { Locator, Page } from '@playwright/test';
import { startTask, createProject, createTask, expect, test, updateTask, type Task } from './fixtures';
import { expectCenteredTaskDetail } from './detail-dialog';
import { parseApiJson } from '../../src/api/json';
import { parseServerError, parseTaskDetail } from '../../src/api/parse';
import { authenticatedAPI, fulfillAuthenticatedResponse } from './authentication';

const scenario = { annotation: { type: 'scenario', description: 'task-platform' } };
const taskPath = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}`;
const detail = (page: Page): Locator => page.locator('.task-detail-dialog');
const platform = (page: Page): Locator => detail(page).getByRole('combobox', { name: /^(执行平台|Execution platform)$/, exact: true });
const confirmation = (page: Page): Locator => page.getByRole('alertdialog', { name: /^(修改执行平台？|Change execution platform\?)$/, exact: true });
const review = async (page: Page, target: string): Promise<void> => {
  const select = platform(page);
  await expect(select).toBeEnabled();
  const saved = await select.inputValue();
  await select.focus(); await expect(select).toBeFocused();
  await select.selectOption(target);
  await expect(confirmation(page)).toBeVisible(); await expect(select).toHaveValue(saved);
};
const confirm = async (page: Page): Promise<void> => {
  await confirmation(page).getByRole('button', { name: /^(修改平台|Change platform)$/, exact: true }).click();
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const open = async (page: Page, id: string): Promise<void> => {
  await selectTaskList(page);
  await page.getByRole('tab', { name: /^(独立任务|Standalone tasks)$/, exact: true }).click();
  await page.locator(`#standalone-task-${id}`).click();
  await expect(platform(page)).toBeVisible();
};
const geometry = async (page: Page): Promise<void> => {
  await expectCenteredTaskDetail(page, detail(page));
  expect(await detail(page).locator('.task-detail-status-row').evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const left = row.querySelector('.task-detail-badges')!.getBoundingClientRect();
    const right = row.querySelector('.task-automation-control')!.getBoundingClientRect();
    const select = row.querySelector('select')!.getBoundingClientRect();
    const status = row.querySelector('.task-status-trigger')!.getBoundingClientRect();
    const controls = row.querySelector('.task-detail-state-controls')!.getBoundingClientRect();
    const separated = left.right <= right.left || left.bottom <= right.top;
    const adjacent = status.right <= select.left || status.bottom <= select.top;
    return Math.abs(bounds.right - right.right) < .5 && separated && adjacent
      && status.left >= controls.left && status.right <= controls.right
      && select.left >= controls.left && select.right <= controls.right && row.scrollWidth <= row.clientWidth;
  })).toBe(true);
  expect(await detail(page).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
};

test('task-platform', scenario, async ({ page, api, allowBrowserWrites }, info) => {
  const own = await createProject(api, { name: 'Execution platform acceptance' });
  let task = await createTask(api, own.id, { title: '执行平台：原生环境要求', description: '平台、自动执行与任务状态分别保有原义。' });
  const other = await createTask(api, own.id, { title: '另一个任务', requiredPlatform: 'windows' });
  expect(task.requiredPlatform).toBeNull(); expect(other.requiredPlatform).toBe('windows');
  const base = info.project.use.baseURL;
  if (typeof base !== 'string') throw new Error('Platform acceptance requires the actual service origin.');
  const endpoint = new URL(taskPath(own.id, task.id), base).href;
  allowBrowserWrites([{ method: 'PATCH', url: endpoint, count: 6 }]);
  const writes: { version: string; requiredPlatform: Task['requiredPlatform']; result: number; requestId: string }[] = [];
  let mode: 'ordinary' | 'conflict' | 'unknown' | 'pending' = 'ordinary';
  let rejectReconciliation = false;
  const pendingReached = deferred(); const releasePending = deferred();
  await page.route(endpoint, async (route) => {
    if (route.request().method() === 'GET') {
      if (rejectReconciliation) await route.abort('connectionfailed'); else await route.continue();
      return;
    }
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    const raw = route.request().postData();
    if (raw === null) throw new Error('Platform PATCH requires an exact body.');
    const data = parseApiJson(raw) as { version: bigint; requiredPlatform: Task['requiredPlatform'] };
    expect(typeof data.version).toBe('bigint');
    expect(Object.keys(data).sort()).toEqual(['requiredPlatform', 'version']);
    if (mode === 'conflict') {
      const current = await (await api.get(taskPath(own.id, task.id))).json() as Task;
      task = await updateTask(api, own.id, task.id, { version: current.version, description: '平台确认之前，任务版本已变化。' });
      mode = 'ordinary';
    }
    const beforeResponse = await api.get(taskPath(own.id, task.id)); expect(beforeResponse.status()).toBe(200);
    const before = parseTaskDetail(parseApiJson(await beforeResponse.text()), own.id, task.id);
    const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    const responseBody = await response.text();
    const requestId = response.headers()['x-request-id'];
    if (requestId === undefined) throw new Error('Platform responses require a correlation ID.');
    expect(requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    writes.push({ version: String(data.version), requiredPlatform: data.requiredPlatform, result: response.status(), requestId });
    if (response.status() === 200) {
      expect(before.version).toBe(data.version);
      const after = parseTaskDetail(parseApiJson(responseBody), own.id, task.id);
      expect(after, 'Platform changes preserve task material, status, permission, relations and execution times').toEqual({
        ...before, requiredPlatform: data.requiredPlatform, version: before.version + 1n, updatedAt: after.updatedAt,
      });
    } else {
      expect(response.status()).toBe(409);
      const refusal = parseServerError(parseApiJson(responseBody));
      expect(refusal.code).toBe('version_conflict');
      expect(refusal.requestId).toBe(requestId);
    }
    if (mode === 'unknown') { rejectReconciliation = true; mode = 'ordinary'; await route.abort('connectionfailed'); return; }
    if (mode === 'pending') { mode = 'ordinary'; pendingReached.resolve(); await releasePending.promise; }
    await fulfillAuthenticatedResponse(route, response);
  });
  try {
    await page.goto(`/projects/${own.id}`); await open(page, task.id); await geometry(page);
    await expect(detail(page).locator('.task-detail-status-row select')).toHaveCount(1);
    await expect(detail(page).locator('.task-detail-badges .task-platform')).toHaveCount(0);
    await expect(detail(page).getByRole('button', { name: /^(保存平台|Save platform)$/, exact: true })).toHaveCount(0);
    await platform(page).selectOption(''); expect(writes).toHaveLength(0); await expect(confirmation(page)).toHaveCount(0);
    await platform(page).focus(); await page.keyboard.press('ArrowDown'); await expect(confirmation(page)).toBeVisible();
    await expect(platform(page)).toHaveValue(''); expect(writes).toHaveLength(0);
    await page.keyboard.press('Escape'); await expect(confirmation(page)).toHaveCount(0); await expect(platform(page)).toBeFocused();

    for (const { locale, width } of [{ locale: 'zh-CN', width: 390 }, { locale: 'en', width: 390 }, { locale: 'zh-CN', width: 320 }, { locale: 'en', width: 320 }]) {
      await detail(page).getByRole('button', { name: /^(关闭任务详情|Close task details)$/, exact: true }).click();
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await page.setViewportSize({ width, height: 844 }); await open(page, task.id); await geometry(page); await expect(platform(page)).toBeEnabled();
      const editable = info.outputPath(`task-platform-editable-${locale}-${width}.png`); await page.screenshot({ path: editable, animations: 'disabled' });
      await info.attach('scenario-screenshot', { path: editable, contentType: 'image/png' });
      await review(page, 'windows');
      await expect(confirmation(page).getByText(locale === 'en' ? 'Current platform: Any platform. New platform: Windows.' : '当前平台：不限平台。目标平台：Windows。', { exact: true })).toBeVisible();
      const modal = info.outputPath(`task-platform-confirmation-${locale}-${width}.png`); await page.screenshot({ path: modal, animations: 'disabled' });
      await info.attach('scenario-screenshot', { path: modal, contentType: 'image/png' });
      await page.keyboard.press('Escape'); await expect(platform(page)).toBeFocused(); expect(writes).toHaveLength(0);
    }
    await detail(page).getByRole('button', { name: /^(关闭任务详情|Close task details)$/, exact: true }).click();
    await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    await page.setViewportSize({ width: 1600, height: 1100 }); await open(page, task.id);

    await review(page, 'linux'); expect(writes).toHaveLength(0);
    expect((await (await api.get(taskPath(own.id, task.id))).json() as Task).requiredPlatform).toBeNull();
    await confirm(page); await expect(platform(page)).toHaveValue('linux');
    expect((await (await api.get(taskPath(own.id, task.id))).json() as Task)).toMatchObject({ requiredPlatform: 'linux', allowAgents: false, status: 'todo', ready: true });
    await review(page, ''); await confirm(page); await expect(platform(page)).toHaveValue('');

    mode = 'conflict'; await review(page, 'windows'); await confirm(page);
    await expect(detail(page).getByText('任务已发生变化，请检查当前平台后重新确认修改。')).toBeVisible();
    await expect(platform(page)).toHaveValue(''); await expect(confirmation(page)).toHaveCount(0); expect(writes).toHaveLength(3);
    await expect(detail(page).locator('.task-platform-error .request-id code')).toHaveText(writes[2]!.requestId);
    await review(page, 'windows'); await confirm(page); await expect(platform(page)).toHaveValue('windows');

    mode = 'unknown'; await review(page, 'linux'); await confirm(page);
    const check = detail(page).getByRole('button', { name: '核对实际任务', exact: true }); await expect(check).toBeEnabled();
    await expect(platform(page)).toBeDisabled(); await expect(detail(page).getByRole('switch')).toBeDisabled();
    await expect(detail(page).locator('.task-status-trigger')).toBeDisabled(); await expect(platform(page)).toHaveValue('windows');
    rejectReconciliation = false; await check.click(); await expect(platform(page)).toHaveValue('linux'); await expect(platform(page)).toBeEnabled(); expect(writes).toHaveLength(5);

    mode = 'pending'; await review(page, 'macos'); await confirm(page); await pendingReached.promise;
    await expect(platform(page)).toBeDisabled(); await expect(detail(page).getByRole('switch')).toBeDisabled();
    await expect(detail(page).locator('.task-status-trigger')).toBeDisabled();
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await open(page, other.id); await expect(platform(page)).toHaveValue('windows'); releasePending.resolve();
    await expect.poll(async () => (await (await api.get(taskPath(own.id, task.id))).json() as Task).requiredPlatform).toBe('macos');
    await expect(platform(page)).toHaveValue('windows'); await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await expect(page.locator(`#standalone-task-${task.id} .task-platform`)).toHaveText('macOS');
    await open(page, task.id); await expect(platform(page)).toHaveValue('macos'); await expect(platform(page)).toBeEnabled();
    expect(writes.map((entry) => entry.result)).toEqual([200, 200, 409, 200, 200, 200]);

    task = await (await api.get(taskPath(own.id, task.id))).json() as Task;
    const running = await startTask(api, own.id, task); expect(running.requiredPlatform).toBe('macos');
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click(); await page.reload(); await open(page, task.id);
    await expect(platform(page)).toBeDisabled();
    const lockedPlatform = detail(page).getByRole('group', { name: '执行平台', exact: true });
    await lockedPlatform.focus();
    await expect(lockedPlatform.getByRole('tooltip')).toHaveClass('task-control-tip-bubble');
    await expect(platform(page)).toHaveAccessibleDescription('任务正在进行中，保持此状态时无法修改执行平台。');
    await page.keyboard.press('Escape');
    await expect(lockedPlatform.locator('.task-control-tip-bubble')).toHaveCount(0);
    await expect(detail(page)).toBeVisible();
    for (const { locale, width } of [{ locale: 'zh-CN', width: 390 }, { locale: 'en', width: 390 }, { locale: 'zh-CN', width: 320 }, { locale: 'en', width: 320 }]) {
      await detail(page).getByRole('button', { name: /^(关闭任务详情|Close task details)$/, exact: true }).click();
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await page.setViewportSize({ width, height: 844 }); await open(page, task.id); await geometry(page);
      await detail(page).getByRole('group', { name: locale === 'zh-CN' ? '执行平台' : 'Execution platform', exact: true }).hover();
      const screenshot = info.outputPath(`task-platform-locked-${locale}-${width}.png`); await page.screenshot({ path: screenshot, animations: 'disabled' });
      await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
    }
    await info.attach('platform-write-receipts', { body: JSON.stringify({ writes, final: { id: running.id, status: running.status, requiredPlatform: running.requiredPlatform } }, null, 2), contentType: 'application/json' });
  } finally { releasePending.resolve(); await page.unroute(endpoint); }
});
