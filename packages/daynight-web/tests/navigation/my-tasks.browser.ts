import { expect, test } from '@playwright/test';
import { unsupportedSessionObservation } from '../../../daynight/src/api/task-observation';

const userId = '00000000-0000-4000-8000-000000000011';
const projectId = '00000000-0000-4000-8000-000000000031';
const otherProjectId = '00000000-0000-4000-8000-000000000032';
const teamId = '00000000-0000-4000-8000-000000000041';
const goalId = '00000000-0000-4000-8000-000000000051';
const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const longProject = 'ProjectWithAnUnbrokenLongName'.repeat(4);
const longTask = 'TaskWithAnUnbrokenLongName'.repeat(5);
const longGoal = 'GoalWithAnUnbrokenLongName'.repeat(5);
const project = { id: projectId, name: longProject, ownerTeam: { id: teamId, kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 16 };
const observation = { ...unsupportedSessionObservation(), observation: 'observed', registration: 'not_applicable', reason: 'no_execution', error: null, observedAt: '2026-11-13T10:00:00Z', freshUntil: '2026-11-13T11:00:00Z' };
const row = (n: number) => ({ project, task: { id: taskId(n), version: '1', title: n === 1 ? longTask : `Task ${n}`, status: 'in_progress', startedAt: null, allowAgents: false, paused: false, goal: n === 1 ? { id: goalId, title: longGoal } : null }, session: observation });
const payload = { observedAt: '2026-11-13T10:00:00Z', inventoryRevision: 'a'.repeat(64), totalTaskCount: 17, totalProjectCount: 2, sessionPartial: false,
  items: [...Array.from({ length: 16 }, (_, i) => row(i + 1)), { ...row(17), project: { ...project, id: otherProjectId, name: 'Other project', matchedTaskCount: 1 } }], nextCursor: null };

for (const width of [320, 1280]) {
  test(`real overview retains layout, links and reading page at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 800 });
    let requests = 0, responses = 0;
    let release: (() => void) | null = null;
    await page.route('**/api/v1/me/in-progress-tasks?*', async route => {
      requests++;
      if (requests > 1) await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: payload, headers: { 'Daynight-User-ID': userId } });
      responses++;
    });
    await context.route('**/projects/**', route => route.fulfill({ contentType: 'text/html', body: 'Detail destination' }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    const group = page.getByRole('region', { name: `${longProject} · Team · ${projectId}` });
    await expect(group.getByText('16 in progress')).toBeVisible();
    const task = group.getByRole('link', { name: longTask });
    const goal = group.getByRole('link', { name: `View Goal: ${longGoal}` });
    await expect(task).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId(1)}`);
    await expect(goal).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
    await expect(goal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const popupPromise = context.waitForEvent('page');
    await goal.click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    await expect.poll(() => new URL(popup.url()).pathname).toBe(`/projects/${projectId}/tasks/${goalId}`);
    await popup.close();
    await page.getByLabel('Language').selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '进行中的任务' })).toBeVisible();
    await expect(group.getByRole('link', { name: `查看 Goal：${longGoal}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('语言').selectOption('en');
    await group.getByRole('button', { name: 'Next' }).click();
    const secondPageTask = group.getByRole('link', { name: 'Task 16' });
    await expect(secondPageTask).toBeVisible();
    await secondPageTask.focus();
    const before = await secondPageTask.boundingBox();
    const element = await secondPageTask.elementHandle();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => requests).toBe(2);
    await expect(secondPageTask).toBeFocused();
    expect(await secondPageTask.boundingBox()).toEqual(before);
    release!();
    await expect.poll(() => responses).toBe(2);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(secondPageTask).toBeVisible();
    await expect(secondPageTask).toBeFocused();
    expect(await secondPageTask.boundingBox()).toEqual(before);
    expect(await element!.evaluate(el => el === document.activeElement)).toBe(true);
  });
}

for (const width of [320, 1280]) {
  test(`overview opens complete details and preserves them after filtering at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const { detailFixture, graphFixture } = await import('../helpers/taskDetail');
    const { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION } = await import('../helpers/taskSync');
    const { stringifyWireJson } = await import('../helpers/wireJson');
    const goalDetail = detailFixture(projectId, goalId, { type: 'goal', title: longGoal, description: 'Goal description', ready: false });
    const taskDetail = detailFixture(projectId, taskId(1), { title: longTask, parentId: goalId, description: 'Task description', status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', assignedTo: userId });
    const details = [goalDetail, taskDetail];
    const graph = graphFixture(details);
    const epoch = taskSyncEpoch(projectId);
    let listed = true, failGraph = false;
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, ...extra } });
      if (path === '/api/v1/me/in-progress-tasks') return send(listed ? { ...payload, totalTaskCount: 1, totalProjectCount: 1, items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 } }] } : { ...payload, totalTaskCount: 0, totalProjectCount: 0, items: [] });
      if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId, userId));
      if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId, name: 'Owner', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
      if (path === `/api/v1/projects/${projectId}/task-sync`) {
        if (failGraph) { failGraph = false; return send({ error: { code: 'unavailable', message: 'Unavailable', requestId: 'sync-error' } }, 503); }
        return send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch, actorAccess: directAccessFixture(projectId, userId), versionForTask: () => 1n, propertiesForTask: task => details.find(item => item.id === task.id)!.properties }));
      }
      const detail = details.find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
      if (detail) return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
      if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
      if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
      if (path.endsWith('/steps')) return send({ projectId, taskId: taskId(1), version: 1, steps: [] });
      if (path.endsWith('/sessions')) return send({ items: [{ sessionId: taskId(80), claimId: taskId(81), executionGeneration: '1', agentControlMode: 'web', contentKind: 'native_timeline', createdAt: '2026-10-22T09:00:00Z', endedAt: '2026-10-22T10:00:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } }], nextCursor: null });
      if (path.endsWith('/archive')) return send({ archive: { state: 'pending', sha256: null, byteLength: null, errorCode: null } });
      return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
    });
    await page.route('**/my-tasks', async route => route.fulfill({ response: await route.fetch({ url: 'http://127.0.0.1:14295/tests/navigation/my-tasks-browser.html' }) }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    const task = page.getByRole('link', { name: longTask });
    await task.click();
    const taskDialog = page.getByRole('dialog', { name: longTask });
    await expect(taskDialog).toBeVisible();
    await expect(taskDialog.getByText('Task description')).toBeVisible();
    await expect(taskDialog.getByRole('tab', { name: 'Attachments' })).toBeVisible();
    for (const name of ['Attachments', 'Steps', 'Discussion', 'Session']) {
      const tab = taskDialog.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(taskDialog.getByRole('tabpanel', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(taskDialog).toHaveCount(0);
    await expect(task).toBeFocused();
    const goal = page.getByRole('link', { name: `View Goal: ${longGoal}` });
    failGraph = true;
    await goal.click();
    const goalDialog = page.getByRole('dialog', { name: longGoal });
    await expect(goalDialog.getByText('Goal description')).toBeVisible();
    const information = goalDialog.getByRole('complementary', { name: 'Goal information' });
    await expect(information.getByRole('alert')).toBeVisible();
    await information.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(information.getByText('Total tasks')).toBeVisible();
    await page.evaluate(id => window.selectMyTasksChild(id), taskId(1));
    await expect(taskDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(taskDialog).toHaveCount(0);
    await expect(goalDialog).toBeVisible();
    for (const name of ['Discussion', 'Attachments']) {
      const tab = goalDialog.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(goalDialog.getByRole('tabpanel', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(goalDialog).toHaveCount(0);
    await expect(goal).toBeFocused();
    await goal.click();
    await goalDialog.getByRole('tab', { name: 'Attachments' }).click();
    await page.reload();
    await expect(goalDialog).toBeVisible();
    await expect(goalDialog.getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(goalDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'In-progress tasks', exact: true })).toBeFocused();
    await task.click();
    await expect(taskDialog).toBeVisible();
    listed = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText('No in-progress tasks')).toBeVisible();
    await expect(taskDialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(taskDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'In-progress tasks', exact: true })).toBeFocused();
  });
}

for (const failedGraph of [false, true]) {
  test(`Task relation follows the actual target ${failedGraph ? 'when the project graph fails' : 'under its Goal'}`, async ({ page }) => {
    const { detailFixture, graphFixture } = await import('../helpers/taskDetail');
    const { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION } = await import('../helpers/taskSync');
    const { stringifyWireJson } = await import('../helpers/wireJson');
    const goalDetail = detailFixture(projectId, goalId, { type: 'goal', title: 'Target Goal', ready: false });
    const related = detailFixture(projectId, taskId(2), { title: 'Related task', parentId: goalId, status: 'done', ready: false, completedAt: '2026-10-22T10:00:00Z' });
    const source = detailFixture(projectId, taskId(1), { title: 'Source task', status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', dependsOn: [related.id], ready: false, assignedTo: userId });
    const details = [goalDetail, related, source], graph = graphFixture(details), epoch = taskSyncEpoch(projectId);
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, ...extra } });
      if (path === '/api/v1/me/in-progress-tasks') return send({ ...payload, totalTaskCount: 1, totalProjectCount: 1, items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, task: { ...row(1).task, title: 'Source task', goal: null } }] });
      if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId, userId));
      if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId, name: 'Owner', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
      if (path === `/api/v1/projects/${projectId}/task-sync`) return failedGraph ? send({ error: { code: 'unavailable', message: 'Unavailable', requestId: 'sync-error' } }, 503) : send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch, actorAccess: directAccessFixture(projectId, userId), versionForTask: () => 1n, propertiesForTask: task => details.find(item => item.id === task.id)!.properties }));
      if (path === `/api/v1/projects/${projectId}/task-graph`) return send(graphFixture([related, source]));
      const detail = details.find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
      if (detail) return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
      if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
      if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
      if (path.endsWith('/steps')) return send({ projectId, taskId: path.split('/').at(-2), version: 1, steps: [] });
      if (path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
      return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
    });
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByRole('link', { name: 'Source task' }).click();
    const sourceDialog = page.getByRole('dialog', { name: 'Source task' });
    await expect(sourceDialog).toBeVisible();
    if (!failedGraph) await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('task-sync')))).toBe(true);
    await sourceDialog.getByRole('button', { name: 'Related task, Ordinary dependency' }).click();
    if (failedGraph) {
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${projectId}/tasks/${related.id}`);
    } else {
      const child = page.getByRole('dialog', { name: 'Related task' });
      await expect(child).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(child).toHaveCount(0);
      const target = page.getByRole('dialog', { name: 'Target Goal' });
      await expect(target).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(target).toHaveCount(0);
    }
  });
}

test('Goal assignee receipt permits a write and refreshes both project graph and overview', async ({ page }) => {
  const { detailFixture, graphFixture } = await import('../helpers/taskDetail');
  const { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION } = await import('../helpers/taskSync');
  const { stringifyWireJson } = await import('../helpers/wireJson');
  let goalDetail = detailFixture(projectId, goalId, { type: 'goal', title: 'Assignment Goal', ready: false });
  const taskDetail = detailFixture(projectId, taskId(1), { title: 'Owned task', parentId: goalId, assignedTo: userId, status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', ready: false });
  const epoch = taskSyncEpoch(projectId);
  let graphReads = 0, listReads = 0, writes = 0;
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, ...extra } });
    if (path === '/api/v1/me/in-progress-tasks') { listReads++; return send({ ...payload, totalTaskCount: 1, totalProjectCount: 1, items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, task: { ...row(1).task, title: 'Owned task', goal: { id: goalId, title: 'Assignment Goal' } } }] }); }
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId, userId));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId, name: 'Owner', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/task-sync`) { graphReads++; const details = [goalDetail, taskDetail]; return send(taskSyncFixture(graphFixture(details), { query: taskSyncQuery(url), epoch, actorAccess: directAccessFixture(projectId, userId), versionForTask: task => details.find(item => item.id === task.id)!.version, propertiesForTask: task => details.find(item => item.id === task.id)!.properties })); }
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}` && route.request().method() === 'PATCH') {
      expect(route.request().postDataJSON()).toEqual({ assignedTo: userId, version: 1 });
      writes++; goalDetail = { ...goalDetail, assignedTo: userId, version: 2n, updatedAt: '2026-10-22T10:00:01Z' };
      return send(goalDetail, 200, { 'Daynight-Task-Epoch': epoch });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}`) return send(goalDetail, 200, { 'Daynight-Task-Epoch': epoch });
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  await page.goto('/tests/navigation/my-tasks-browser.html');
  await page.getByRole('link', { name: 'View Goal: Assignment Goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assignment Goal' });
  await expect(dialog.getByRole('complementary', { name: 'Goal information' }).getByText('Total tasks')).toBeVisible();
  const assignee = dialog.getByRole('button', { name: 'Assignee: Unassigned' });
  await expect(assignee).toBeEnabled();
  await assignee.click();
  const owner = dialog.getByRole('option', { name: /Owner/ });
  await expect(owner).toBeEnabled();
  const before = { graph: graphReads, list: listReads };
  await owner.click();
  await expect.poll(() => writes).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Assignee: Owner' })).toBeVisible();
  await expect.poll(() => graphReads).toBeGreaterThan(before.graph);
  await expect.poll(() => listReads).toBeGreaterThan(before.list);
  await expect(dialog).toBeVisible();
});
