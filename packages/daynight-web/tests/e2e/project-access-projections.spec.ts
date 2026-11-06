import { randomUUID } from 'node:crypto';
import { decodeMembersJson, parseMembers } from '../../src/api/auth-parse';
import { stringifyApiJson } from '../../src/api/json';
import { authenticatedAPI, bearerContext, browserAuthentication, fulfillAuthenticatedResponse } from './authentication';
import { createProject, createTask, expect, test, type Task } from './fixtures';

test('project access withdrawal retires independent projections across tabs', {
  annotation: { type: 'scenario', description: 'project-access-projections' },
}, async ({ browser, playwright, api, baseURL }, info) => {
  if (baseURL === undefined) throw new Error('Access withdrawal requires the actual service origin.');
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  const context = await browser.newContext({ baseURL, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  let release = () => {};
  try {
    const aliceId = (await (await api.get('/api/v1/me')).json() as { id: string }).id;
    const bobId = (await (await bob.get('/api/v1/me')).json() as { id: string }).id;
    const project = await createProject(api, { name: `Private projection ${randomUUID()}`, repoUrl: `https://example.com/private/${randomUUID()}` });
    const healthy = await createProject(bob, { name: `Independent project ${randomUUID()}` });
    const invitation = await api.post(`/api/v1/projects/${project.id}/invitations`, { data: { expectedUserId: aliceId } });
    expect(invitation.status()).toBe(201);
    const link = (await invitation.json() as { link: string }).link;
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: new URL(link).hash.slice(1), expectedUserId: bobId } })).status()).toBe(200);
    const task = await createTask(bob, project.id, { title: `Private Worker task ${randomUUID()}`, assignedTo: bobId });
    const path = `/api/v1/projects/${project.id}/tasks/${task.id}`;
    const enabled = await bob.patch(path, { data: { version: task.version, allowAgents: true } }); expect(enabled.status()).toBe(200);
    const current = await enabled.json() as Task;
    const workerId = randomUUID(), claimId = randomUUID(), machine = { id: randomUUID(), name: `Projection Worker ${randomUUID()}` };
    const claim = await bob.post(`${path}/worker-claim`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: {
      version: current.version, claimId, workerId, machine, platform: 'linux', agent: 'codex', agentControlMode: 'herdr', worktreeId: randomUUID(),
    } });
    expect(claim.status()).toBe(200);
    const now = new Date().toISOString();
    const report = await bob.post(`/api/v1/me/workers/${workerId}/report`, { headers: { 'Daynight-Worker-Configuration': '1' }, data: {
      machine, platform: 'linux', workingDirectory: '/tmp/projection-fixture', sampledAt: now,
      os: { state: 'ok', checkedAt: now, value: { type: 'Linux', release: 'fixture', version: 'fixture', arch: 'x86_64' } },
      cpu: { state: 'ok', checkedAt: now, value: { model: 'Fixture CPU', logicalProcessors: 2, usagePercent: 10 } },
      memory: { state: 'ok', checkedAt: now, value: { usedBytes: 1000, totalBytes: 2000 } },
      disk: { state: 'ok', checkedAt: now, value: { availableBytes: 1000, totalBytes: 2000 } },
      versions: { daynight: 'fixture', herdr: { state: 'not_running', checkedAt: now }, codex: { state: 'not_installed', checkedAt: now }, copilot: { state: 'not_installed', checkedAt: now } },
      taskInventory: { observedAt: now, claims: [{ projectId: project.id, taskId: task.id, claimId }] },
      configuration: { bootstrap: { maxConcurrent: 2, pollIntervalMs: 60000, recoveryLimit: 3, native: { agent: 'codex', model: null, args: [] }, projects: [project, healthy].map(item => ({ projectId: item.id, nativeOverrides: {} })) }, observation: null },
    } });
    expect(report.status()).toBe(200);
    const before = await bob.get(`/api/v1/me/workers/${workerId}`); expect(before.status()).toBe(200);
    expect((await before.json() as { worker: { tasks: { title: string }[] } }).worker.tasks.map(item => item.title)).toContain(task.title);
    await browserAuthentication(context, baseURL, 'bob');
    const projectPage = await context.newPage(), workerPage = await context.newPage(), directoryPage = await context.newPage(), workerList = await context.newPage();
    const errors: string[] = [], writes: string[] = [];
    for (const page of [projectPage, workerPage, directoryPage, workerList]) {
      page.on('pageerror', error => errors.push(error.name));
      page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
    }
    await projectPage.bringToFront();
    await projectPage.goto(`/projects/${project.id}`);
    await expect(projectPage.getByText(project.name).first()).toBeVisible();
    await directoryPage.bringToFront();
    await directoryPage.goto('/shared-projects');
    await expect(directoryPage.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await workerList.bringToFront();
    await workerList.goto('/workers');
    const workerCard = workerList.getByRole('link', { name: `查看 ${machine.name}` });
    await expect(workerCard).toContainText('1 个进行中的任务');
    const listRoute = '**/api/v1/me/workers?*';
    await workerList.route(listRoute, async route => { await route.abort('failed'); });
    await workerPage.bringToFront();
    await workerPage.goto(`/workers/${workerId}`);
    await expect(workerPage.getByText(task.title)).toBeVisible();
    await expect(workerPage.getByText(machine.name).first()).toBeVisible();
    let entered!: () => void;
    const enteredRead = new Promise<void>(resolve => { entered = resolve; });
    const heldRead = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await workerPage.route(`**/api/v1/me/workers/${workerId}`, async route => {
      if (held || route.request().method() !== 'GET') { await route.continue(); return; }
      held = true;
      const response = await authenticatedAPI(context.request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      entered(); await heldRead;
      try { await fulfillAuthenticatedResponse(route, response); } catch { /* The browser may cancel a withdrawn request. */ }
    });
    await workerPage.getByRole('button', { name: '刷新', exact: true }).click();
    await enteredRead;
    await workerPage.getByRole('tab', { name: '配置', exact: true }).click();
    await expect(workerPage.locator('.worker-configuration').getByText(project.name, { exact: true }).first()).toBeVisible();
    await expect(workerPage.locator('.worker-configuration').getByText(healthy.name, { exact: true }).first()).toBeVisible();
    await workerPage.getByRole('button', { name: `移除项目 ${project.name}` }).click();
    await workerPage.getByRole('button', { name: '保存配置', exact: true }).click();
    const dialog = workerPage.getByRole('dialog');
    await expect(dialog.getByText(task.title)).toBeVisible();
    await expect(dialog.getByText(project.name).first()).toBeVisible();
    const members = await api.get(`/api/v1/projects/${project.id}/members`); expect(members.status()).toBe(200);
    const member = parseMembers(await decodeMembersJson(new Response(await members.text())), project.id).items.find(value => value.userId === bobId);
    if (member?.directGrant == null) throw new Error('The fixture requires the exact direct grant.');
    const revoked = await api.delete(`/api/v1/projects/${project.id}/members/${bobId}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: member.directGrant.version, expectedUserId: aliceId }) });
    expect(revoked.status()).toBe(204);
    const denied = projectPage.waitForResponse(response => {
      const path = new URL(response.url()).pathname;
      return (path === `/api/v1/projects/${project.id}/task-sync` || path === `/api/v1/projects/${project.id}/access`) && response.status() === 404;
    });
    await projectPage.bringToFront();
    await denied;
    await expect(projectPage.locator('body')).not.toContainText(task.title);
    await expect(directoryPage.locator('body')).not.toContainText(project.name);
    await expect(directoryPage.locator('body')).not.toContainText(project.repoUrl);
    await expect(dialog).not.toContainText(project.name);
    await expect(dialog).not.toContainText(task.title);
    await expect(workerCard).toContainText('任务信息待同步');
    await expect(workerPage.locator('.worker-configuration').getByText(healthy.name, { exact: true }).first()).toBeAttached();
    const withdrawn = info.outputPath('project-access-withdrawn.png');
    await workerPage.screenshot({ path: withdrawn, animations: 'disabled' });
    await info.attach('scenario-screenshot', { path: withdrawn, contentType: 'image/png' });
    await workerList.unroute(listRoute);
    await workerList.bringToFront();
    await expect(workerCard).toContainText('当前没有进行中的任务');
    release();
    await workerPage.bringToFront();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await workerPage.getByRole('tab', { name: '运行概况', exact: true }).click();
    await expect(workerPage.locator('body')).not.toContainText(task.title);
    await expect(workerPage.getByText(machine.name).first()).toBeVisible();
    await expect(workerPage.getByText('Fixture CPU').first()).toBeVisible();
    const reinvitation = await api.post(`/api/v1/projects/${project.id}/invitations`, { data: { expectedUserId: aliceId } });
    expect(reinvitation.status()).toBe(201);
    const renewedLink = (await reinvitation.json() as { link: string }).link;
    expect((await bob.post('/api/v1/invitations/accept', { data: { token: new URL(renewedLink).hash.slice(1), expectedUserId: bobId } })).status()).toBe(200);
    await workerPage.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(workerPage.getByText(task.title)).toBeVisible();
    await directoryPage.bringToFront();
    await directoryPage.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(directoryPage.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    expect(writes).toEqual([]); expect(errors).toEqual([]);
    const screenshot = info.outputPath('project-access-restored.png');
    await directoryPage.screenshot({ path: screenshot, animations: 'disabled' });
    await info.attach('scenario-screenshot', { path: screenshot, contentType: 'image/png' });
    await info.attach('project-access-projection-evidence', { contentType: 'application/json', body: Buffer.from(JSON.stringify({ projectId: project.id, healthyProjectId: healthy.id, workerId, taskId: task.id, revokeStatus: revoked.status(), deniedStatus: 404, heldWorkerRead: held, browserWrites: writes, pageErrors: errors }, null, 2)) });
  } finally { release(); await context.close(); await bob.dispose(); }
});
