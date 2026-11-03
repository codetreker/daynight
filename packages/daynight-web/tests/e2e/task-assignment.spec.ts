import type { Locator, Page } from '@playwright/test';
import { parseApiJson } from '../../src/api/json';
import { parseTaskDetail } from '../../src/api/parse';
import { authenticatedAPI, bearerContext, fulfillAuthenticatedResponse } from './authentication';
import { createProject, createTask, expect, test, updateTask, type Task } from './fixtures';
import { selectTaskList } from './project-view';

const scenario = { annotation: { type: 'scenario', description: 'task-assignment' } };
const taskPath = (projectId: string, taskId: string): string => `/api/v1/projects/${projectId}/tasks/${taskId}`;
const detail = (page: Page): Locator => page.locator('.task-detail-dialog');
const assignee = (page: Page): Locator => detail(page).locator('.task-assignee-field .assignee-trigger');
const popup = (page: Page): Locator => detail(page).locator('.assignee-menu');
const choose = async (page: Page, name: string): Promise<void> => {
  await expect(assignee(page)).toBeEnabled();
  await assignee(page).click();
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole('option', { name, exact: true }).click();
  await expect(popup(page)).toHaveCount(0);
};

test('task-assignment', scenario, async ({ page, api, playwright, allowBrowserWrites }, info) => {
  const origin = info.project.use.baseURL;
  if (typeof origin !== 'string') throw new Error('Assignment acceptance requires the actual service origin.');
  const bob = await bearerContext(playwright.request, origin, 'bob');
  try {
    const project = await createProject(api, { name: 'Task assignment transaction acceptance' });
    const aliceProfile = await (await api.get('/api/v1/me')).json() as { id: string; name: string };
    const bobProfile = await (await bob.get('/api/v1/me')).json() as { id: string; name: string };
    const invitationResponse = await api.post(`/api/v1/projects/${project.id}/invitations`, { data: {} });
    expect(invitationResponse.status()).toBe(201);
    const invitation = await invitationResponse.json() as { link: string };
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: new URL(invitation.link).hash.slice(1) } })).status()).toBe(200);
    let task = await createTask(api, project.id, { title: 'Assignment preserves the complete task', description: 'The transaction changes ownership and disables automatic execution.' });
    const permission = await api.patch(taskPath(project.id, task.id), { data: { version: task.version, allowAgents: true } });
    expect(permission.status()).toBe(200); task = await permission.json() as Task;
    expect(task).toMatchObject({ assignedTo: null, allowAgents: true });
    const endpoint = new URL(taskPath(project.id, task.id), origin).href;
    allowBrowserWrites([{ method: 'PATCH', url: endpoint, count: 3 }]);
    const writes: { assignedTo: string | null; version: string; status: number; requestId: string }[] = [];
    let mode: 'ordinary' | 'conflict' | 'commit-then-abort' = 'ordinary';
    let rejectReconciliation = false;
    await page.route(endpoint, async (route) => {
      if (route.request().method() === 'GET') {
        if (rejectReconciliation) await route.abort('connectionfailed'); else await route.continue();
        return;
      }
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const raw = route.request().postData();
      if (raw === null) throw new Error('Assignment PATCH has no request body.');
      const input = parseApiJson(raw) as { version: bigint; assignedTo: string | null };
      expect(Object.keys(input).sort()).toEqual(['assignedTo', 'version']);
      expect(typeof input.version).toBe('bigint');
      if (mode === 'conflict') {
        const current = await (await api.get(taskPath(project.id, task.id))).json() as Task;
        task = await updateTask(api, project.id, task.id, { version: current.version, description: 'A concurrent writer changed the complete current resource.' });
        mode = 'ordinary';
      }
      const before = parseTaskDetail(parseApiJson(await (await api.get(taskPath(project.id, task.id))).text()), project.id, task.id);
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      const requestId = response.headers()['x-request-id'];
      if (requestId === undefined) throw new Error('Assignment responses require a correlation ID.');
      writes.push({ assignedTo: input.assignedTo, version: String(input.version), status: response.status(), requestId });
      if (response.status() === 200) {
        const saved = parseTaskDetail(parseApiJson(await response.text()), project.id, task.id);
        expect(saved).toEqual({ ...before, assignedTo: input.assignedTo, allowAgents: false, version: before.version + 1n, updatedAt: saved.updatedAt });
      } else expect(response.status()).toBe(409);
      if (mode === 'commit-then-abort') {
        mode = 'ordinary'; rejectReconciliation = true; await route.abort('connectionfailed'); return;
      }
      await fulfillAuthenticatedResponse(route, response);
    });
    try {
      await page.goto(`/projects/${project.id}`); await selectTaskList(page);
      await page.getByRole('tab', { name: /^(独立任务|Standalone tasks)$/, exact: true }).click();
      await page.locator(`#standalone-task-${task.id}`).click();
      await expect(assignee(page)).toHaveAccessibleName('负责人：未分配');
      await expect(detail(page).getByRole('switch', { name: '自动执行' })).toBeChecked();
      await choose(page, bobProfile.name);
      await expect(assignee(page)).toHaveAccessibleName(`负责人：${bobProfile.name}`);
      await expect(detail(page).getByRole('switch', { name: '自动执行' })).not.toBeChecked();
      const assigned = await (await api.get(taskPath(project.id, task.id))).json() as Task;
      expect(assigned).toMatchObject({ assignedTo: bobProfile.id, allowAgents: false, version: task.version + 1 });
      expect(writes).toHaveLength(1);
      await choose(page, bobProfile.name);
      expect(writes).toHaveLength(1);
      mode = 'conflict'; await choose(page, aliceProfile.name);
      await expect(detail(page).locator('.task-assignment-feedback')).toContainText('任务已变化');
      await expect(assignee(page)).toBeEnabled();
      await expect(assignee(page)).toHaveAccessibleName(`负责人：${bobProfile.name}`);
      expect(writes.map((write) => write.status)).toEqual([200, 409]);
      mode = 'commit-then-abort'; await choose(page, aliceProfile.name);
      await expect(detail(page).locator('.task-assignment-feedback')).toContainText('核对');
      await expect(assignee(page)).toBeDisabled();
      expect((await (await api.get(taskPath(project.id, task.id))).json() as Task).assignedTo).toBe(aliceProfile.id);
      expect(writes).toHaveLength(3);
      const uncertainScreenshot = info.outputPath('assignment-pending-verification.png');
      await page.screenshot({ path: uncertainScreenshot, animations: 'disabled' });
      await info.attach('scenario-screenshot', { path: uncertainScreenshot, contentType: 'image/png' });
      rejectReconciliation = false;
      await detail(page).getByRole('button', { name: '核对当前状态', exact: true }).click();
      await expect(assignee(page)).toBeEnabled();
      await expect(assignee(page)).toHaveAccessibleName(`负责人：${aliceProfile.name}`);
      expect(writes.map((write) => write.status)).toEqual([200, 409, 200]);
      const savedScreenshot = info.outputPath('assignment-reconciled.png');
      await page.screenshot({ path: savedScreenshot, animations: 'disabled' });
      await info.attach('scenario-screenshot', { path: savedScreenshot, contentType: 'image/png' });
      await info.attach('assignment-transaction-receipts', { body: JSON.stringify({ writes, final: { assignedTo: aliceProfile.id, allowAgents: false } }, null, 2), contentType: 'application/json' });
    } finally { await page.unroute(endpoint); }
  } finally { await bob.dispose(); }
});
