import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { closeChain, openChain } from './chain-dialog';
import { fulfillAuthenticatedResponse } from './authentication';
import { createProject, createTask, executeTask, expect, startTask, test, updateTask, type Task } from './fixtures';
import { selectOverview, selectTaskList } from './project-view';
import type { TaskDetail } from '../../src/api/types';

const endpoint = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}`;
const screenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};
const expectPauseLayout = async (page: Page, surface: Locator): Promise<void> => {
  await expect(surface.locator('.task-pause-unpause')).toBeVisible();
  const geometry = await surface.locator('.task-pause-strip').evaluate(element => {
    const strip = element.getBoundingClientRect();
    const label = element.querySelector('.task-pause-label')!.getBoundingClientRect();
    const button = element.querySelector('button')!.getBoundingClientRect();
    return { left: strip.left, right: strip.right, labelRight: label.right, buttonLeft: button.left, buttonRight: button.right, overflow: element.scrollWidth > element.clientWidth };
  });
  expect(geometry.overflow).toBe(false);
  expect(geometry.labelRight).toBeLessThanOrEqual(geometry.buttonLeft);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.right);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
};

test('paused tasks are discoverable and unpause preserves their execution', {
  annotation: { type: 'scenario', description: 'task-pause' },
}, async ({ page, api, baseURL, allowBrowserWrites }, info) => {
  const project = await createProject(api, { name: 'Paused automatic execution' });
  const identity = await api.get('/api/v1/me');
  expect(identity.status()).toBe(200);
  const caller = await identity.json() as { id: string };
  const title = 'Paused automatic task: '.repeat(12) + 'complete';
  const created = await createTask(api, project.id, { title, assignedTo: caller.id, requiredPlatform: 'linux', properties: { pullRequests: [{ url: 'https://github.com/example/repository/pull/42', title: 'Preserved pull request' }] } });
  const path = endpoint(project.id, created.id);
  const enabled = await api.patch(path, { data: { version: created.version, allowAgents: true } });
  expect(enabled.status()).toBe(200);
  const permitted = await enabled.json() as Task;
  const claimed = await api.post(`${path}/worker-claim`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: { version: permitted.version, claimId: randomUUID(), workerId: randomUUID(), machine: { id: randomUUID(), name: 'Pause browser fixture' }, platform: 'linux', agent: 'codex', agentControlMode: 'herdr', worktreeId: randomUUID() } });
  expect(claimed.status()).toBe(200);
  const active = await claimed.json() as Task;
  const paused = await updateTask(api, project.id, active.id, { version: active.version, properties: { paused: true } }) as Task & Pick<TaskDetail, 'startedAt' | 'completedAt'>;
  const root = await executeTask(api, project.id, await createTask(api, project.id, { title: 'Pause chain root' }));
  const child = await startTask(api, project.id, await createTask(api, project.id, { title: 'Paused chain member', dependsOn: [root.id], properties: { paused: true } }));
  const explicitFalse = await createTask(api, project.id, { title: 'Explicitly unpaused task', properties: { paused: false } });
  const absent = await createTask(api, project.id, { title: 'Task without pause property' });
  const childPath = endpoint(project.id, child.id);
  allowBrowserWrites([{ method: 'PATCH', url: new URL(path, baseURL).href, count: 2 }, { method: 'PATCH', url: new URL(childPath, baseURL).href, count: 1 }]);

  await page.goto(`/projects/${project.id}`);
  const overviewPause = page.locator('.project-section-heading .task-pause-count');
  await expect(overviewPause).toContainText('2');
  await overviewPause.click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.locator('.task-pause-strip')).toBeVisible();
  await dialog.locator('.task-detail-close').click();
  await selectTaskList(page);
  await page.getByRole('tab', { name: /^(任务链|Task chains)$/, exact: true }).click();
  await page.locator(`#task-root-${root.id}`).click();
  const chain = page.locator(`[data-chain-id="${root.id}"]`);
  await expect(chain.locator('.task-pause-count')).toContainText('1');
  await expect(chain.locator('.goal-task-row').filter({ hasText: child.title }).locator('.task-paused-badge')).toBeVisible();
  await openChain(page, root.id);
  await expect(page.locator(`.react-flow__node[data-id="${child.id}"] .task-paused-badge`)).toBeVisible();
  await screenshot(page, info, 'paused-graph');
  await closeChain(page);
  await page.getByRole('tab', { name: /^(独立任务|Standalone tasks)$/, exact: true }).click();
  const row = page.locator('.standalone-row').filter({ hasText: 'Paused automatic task:' });
  await expect(row.locator('.task-paused-badge')).toBeVisible();
  for (const task of [explicitFalse, absent]) await expect(page.locator('.standalone-row').filter({ hasText: task.title }).locator('.task-paused-badge')).toHaveCount(0);
  await row.click();
  for (const name of ['讨论', '附件', '概览']) {
    await dialog.getByRole('tab', { name, exact: true }).click();
    await expect(dialog.locator('.task-pause-strip')).toBeVisible();
  }
  await page.goto(`/projects/${project.id}/tasks/${paused.id}`);
  const surface = page.locator('.task-detail-page');
  for (const locale of ['zh-CN', 'en']) {
    await surface.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
    await page.setViewportSize({ width: 320, height: 800 });
    await expectPauseLayout(page, surface);
    await screenshot(page, info, `paused-${locale}-320`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await surface.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
  await screenshot(page, info, 'paused-task-detail');
  const unpause = surface.locator('.task-pause-unpause');
  await expect(unpause).toBeEnabled();
  const submitted: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredPending = new Promise<void>(resolve => { entered = resolve; });
  const concurrentDescription = 'A concurrent task update must be read before retrying unpause.';
  await page.route(path, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) await updateTask(api, project.id, paused.id, { version: paused.version, description: concurrentDescription });
    else { entered(); await pending; }
    await fulfillAuthenticatedResponse(route, await api.patch(path, { data: route.request().postDataJSON() }));
  });
  try {
    await unpause.click();
    await expect(page.locator('.task-detail-toast [role="alert"]').first()).toBeVisible();
    await expect(unpause).toBeEnabled();
    expect(submitted).toEqual([{ version: paused.version, properties: { paused: false } }]);
    await unpause.click(); await enteredPending;
    await expect(unpause).toBeDisabled();
    await expect(unpause).toHaveAttribute('aria-busy', 'true');
    await expect(surface.locator('.task-pause-strip')).toBeVisible();
    await unpause.evaluate(button => (button as HTMLButtonElement).click());
    expect(submitted).toHaveLength(2);
    release();
    await expect(surface.locator('.task-pause-strip')).toHaveCount(0);
    await expect(surface.locator('.task-detail-title')).toBeFocused();
    const result = await (await api.get(path)).json() as Task;
    expect(result).toMatchObject({ status: paused.status, allowAgents: true, requiredPlatform: paused.requiredPlatform, assignedTo: paused.assignedTo, startedAt: paused.startedAt, completedAt: paused.completedAt, description: concurrentDescription, properties: { ...paused.properties, paused: false } });
    expect(result.version).toBe(paused.version + 2);
    expect(submitted[1]).toEqual({ version: paused.version + 1, properties: { paused: false } });
  } finally { release(); await page.unroute(path); }

  await page.goto(`/projects/${project.id}/tasks/${child.id}`);
  await expect(unpause).toBeEnabled();
  let lostWrites = 0;
  await page.route(childPath, async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    lostWrites += 1;
    const response = await api.patch(childPath, { data: route.request().postDataJSON() });
    expect(response.status()).toBe(200);
    await route.abort('failed');
  });
  try {
    await unpause.click();
    await expect(surface.locator('.task-pause-strip')).toHaveCount(0);
    expect(lostWrites).toBe(1);
    expect(await (await api.get(childPath)).json()).toMatchObject({ status: child.status, properties: { paused: false }, version: child.version + 1 });
  } finally { await page.unroute(childPath); }
  await page.goto(`/projects/${project.id}`);
  await selectOverview(page);
  await expect(page.locator('.project-section-heading .task-pause-count')).toHaveCount(0);
  await selectTaskList(page);
  await expect(page.locator('.task-paused-badge')).toHaveCount(0);
  await screenshot(page, info, 'all-tasks-unpaused');
});
