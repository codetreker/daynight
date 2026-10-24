import type { Locator, Page } from '@playwright/test';
import { startTask, createProject, createTask, expect, test, updateTask, type Task } from './fixtures';
import { expectCenteredTaskDetail } from './detail-dialog';

const scenario = { annotation: { type: 'scenario', description: 'task-agent-permission' } };
const taskPath = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}`;
const detail = (page: Page): Locator => page.locator('.task-detail-dialog');
const automatic = (page: Page): Locator => detail(page).getByRole('switch');
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const enable = async (page: Page, value: boolean): Promise<void> => {
  await automatic(page).click();
  const dialog = page.getByRole('alertdialog', { name: value ? '开启自动执行' : '关闭自动执行', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: value ? '开启自动执行' : '关闭自动执行', exact: true }).click();
};
const open = async (page: Page, id: string): Promise<void> => {
  await page.getByRole('tab', { name: /^(独立任务|Standalone tasks)$/, exact: true }).click();
  await page.locator(`#standalone-task-${id}`).click();
  await expect(automatic(page)).toBeVisible();
};
const geometry = async (page: Page): Promise<void> => {
  await expectCenteredTaskDetail(page, detail(page));
  await expect(automatic(page)).toHaveCount(1);
  expect(await detail(page).locator('.task-detail-panel-overview [role=switch], .task-detail-heading .task-agent-permission').count()).toBe(0);
  expect(await detail(page).locator('.task-detail-status-row').evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const left = row.querySelector('.task-detail-badges')!.getBoundingClientRect();
    const right = row.querySelector('.task-automation-control')!.getBoundingClientRect();
    return Math.abs(bounds.right - right.right) < .5 && Math.abs(left.y - right.y) < .5 && left.right <= right.left;
  })).toBe(true);
};

test('task-agent-permission', scenario, async ({ page, api, allowBrowserWrites }, info) => {
  const own = await createProject(api, { name: 'Automatic execution acceptance' });
  let task = await createTask(api, own.id, { title: '自动执行许可', description: '许可与任务状态和 ready 独立。' });
  const other = await createTask(api, own.id, { title: '另一个任务', description: '原任务写入不能污染此任务。' });
  expect(task.allowAgents).toBe(false);
  const base = info.project.use.baseURL;
  if (typeof base !== 'string') throw new Error('Permission acceptance requires the actual service origin.');
  const endpoint = new URL(taskPath(own.id, task.id), base).href;
  allowBrowserWrites([{ method: 'PATCH', url: endpoint, count: 7 }]);
  const writes: { version: string; allowAgents: boolean; result: string }[] = [];
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
    if (raw === null) throw new Error('Permission PATCH requires an exact body.');
    const data = JSON.parse(raw) as { version: number; allowAgents: boolean };
    expect(Object.keys(data).sort()).toEqual(['allowAgents', 'version']);
    if (mode === 'conflict') {
      const current = await (await api.get(taskPath(own.id, task.id))).json() as Task;
      task = await updateTask(api, own.id, task.id, { version: current.version, description: '服务端在确认之后修改了任务。' });
      mode = 'ordinary';
    }
    const response = await route.fetch();
    writes.push({ version: String(data.version), allowAgents: data.allowAgents, result: String(response.status()) });
    if (mode === 'unknown') { rejectReconciliation = true; mode = 'ordinary'; await route.abort('connectionfailed'); return; }
    if (mode === 'pending') { mode = 'ordinary'; pendingReached.resolve(); await releasePending.promise; }
    await route.fulfill({ response });
  });

  try {
    await page.goto(`/projects/${own.id}`); await open(page, task.id); await geometry(page);
    await expect(automatic(page)).not.toBeChecked();
    for (const cancellation of ['取消', '关闭确认框', 'Escape']) {
      await automatic(page).click(); const dialog = page.getByRole('alertdialog', { name: '开启自动执行', exact: true });
      await expect(dialog).toBeVisible();
      if (cancellation === 'Escape') await page.keyboard.press('Escape'); else await dialog.getByRole('button', { name: cancellation, exact: true }).click();
      await expect(automatic(page)).not.toBeChecked(); await expect(automatic(page)).toBeFocused();
      expect(writes).toHaveLength(0);
    }

    await enable(page, true); await expect(automatic(page)).toBeChecked();
    const enabled = await (await api.get(taskPath(own.id, task.id))).json() as Task;
    expect(enabled).toMatchObject({ allowAgents: true, status: 'todo', ready: true });
    await enable(page, false); await expect(automatic(page)).not.toBeChecked();

    mode = 'conflict'; await enable(page, true);
    await expect(detail(page).getByText('任务已发生变化，请检查当前设置后重新确认修改。')).toBeVisible();
    await expect(automatic(page)).not.toBeChecked(); expect(writes).toHaveLength(3);
    await enable(page, true); await expect(automatic(page)).toBeChecked();

    mode = 'unknown'; await enable(page, false);
    await expect(detail(page).getByRole('button', { name: '核对实际任务', exact: true })).toBeEnabled();
    await expect(automatic(page)).toBeDisabled(); await expect(automatic(page)).toBeChecked();
    await expect(detail(page).getByRole('button', { name: '待处理', exact: true })).toBeDisabled();
    await expect(detail(page).getByRole('combobox', { name: '执行平台', exact: true })).toBeDisabled();
    rejectReconciliation = false;
    await detail(page).getByRole('button', { name: '核对实际任务', exact: true }).click();
    await expect(automatic(page)).not.toBeChecked(); await expect(automatic(page)).toBeEnabled(); expect(writes).toHaveLength(5);

    mode = 'pending'; await enable(page, true); await pendingReached.promise;
    await expect(automatic(page)).not.toBeChecked(); await expect(automatic(page)).toBeDisabled();
    await expect(detail(page).getByRole('combobox', { name: '执行平台', exact: true })).toBeDisabled();
    await expect(detail(page).locator('.task-status-trigger')).toBeDisabled();
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await open(page, other.id); await expect(automatic(page)).not.toBeChecked();
    releasePending.resolve();
    await expect.poll(async () => (await (await api.get(taskPath(own.id, task.id))).json() as Task).allowAgents).toBe(true);
    await expect(automatic(page)).not.toBeChecked();
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await open(page, task.id); await expect(automatic(page)).toBeChecked(); await expect(automatic(page)).toBeEnabled();
    await enable(page, false); await expect(automatic(page)).not.toBeChecked();
    expect(writes).toHaveLength(7); expect(writes.map((entry) => entry.result)).toEqual(['200', '200', '409', '200', '200', '200', '200']);

    task = await (await api.get(taskPath(own.id, task.id))).json() as Task;
    const running = await startTask(api, own.id, task);
    expect(running.allowAgents).toBe(false);
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await page.reload(); await open(page, task.id);
    await expect(automatic(page)).toBeDisabled(); await expect(automatic(page)).not.toBeChecked();
    const lockedAutomatic = detail(page).getByRole('group', { name: '自动执行', exact: true });
    await lockedAutomatic.focus();
    await expect(lockedAutomatic.getByRole('tooltip')).toHaveClass('task-control-tip-bubble');
    await expect(automatic(page)).toHaveAccessibleDescription('任务正在进行中，保持此状态时无法修改自动执行设置。');
    await page.keyboard.press('Escape');
    await expect(lockedAutomatic.locator('.task-control-tip-bubble')).toHaveCount(0);
    await expect(detail(page)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await geometry(page);
    await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('en');
    await open(page, task.id); await geometry(page);
    await expect(detail(page).locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
    const screenshot = info.outputPath('automatic-execution-detail.png'); await page.screenshot({ path: screenshot, animations: 'disabled' });
    await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
    await info.attach('permission-write-receipts', { body: JSON.stringify({ writes, final: { id: running.id, status: running.status, allowAgents: running.allowAgents } }, null, 2), contentType: 'application/json' });
  } finally { releasePending.resolve(); await page.unroute(endpoint); }
});
