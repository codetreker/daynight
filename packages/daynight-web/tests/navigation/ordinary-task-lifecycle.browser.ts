import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { expectTextContrast } from './color-roles';

const projectId = '00000000-0000-4000-8000-000000000031';
const parentId = '00000000-0000-4000-8000-000000000041';
const childId = '00000000-0000-4000-8000-000000000042';
const personalId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
type RelationOptions = { empty?: boolean; paginate?: boolean; oldServer?: boolean; endedParent?: boolean; mixedChain?: boolean };
const install = async (context: BrowserContext, locale: string, lost = false, endedChildren = false, options: RelationOptions = {}) => {
  let parent = detailFixture(projectId, parentId, { title: 'Parent acceptance', ...(options.oldServer ? {} : { parentTaskId: null }), version: 5n, ...(options.endedParent ? { status: 'done', completedAt: time, ready: false } : {}) });
  let child = detailFixture(projectId, childId, { title: 'Repair child', parentTaskId: parentId, version: 2n, ...(options.mixedChain ? { requiredPlatform: 'windows' } : {}), ...(endedChildren ? { status: 'done', completedAt: time, ready: false } : {}) });
  let removed = false;
  let hasChild = !options.empty;
  let failNext = options.paginate ?? false;
  const writes: unknown[] = [];
  const successor = detailFixture(projectId, '00000000-0000-4000-8000-000000000051', { title: 'Visible successor', parentTaskId: null, dependsOn: [childId] });
  const hidden = detailFixture(projectId, '00000000-0000-4000-8000-000000000052', { title: 'Hidden descendant', parentTaskId: childId, requiredPlatform: 'windows' });
  const hiddenNext = detailFixture(projectId, '00000000-0000-4000-8000-000000000053', { title: 'Hidden chain member', parentTaskId: parentId, dependsOn: [hidden.id], requiredPlatform: 'windows' });
  const otherChildren = (['proposed', 'in_progress', 'done', 'cancelled'] as const).map((status, index) => detailFixture(projectId, `00000000-0000-4000-8000-0000000000${43 + index}`, { title: `Child ${status}`, parentTaskId: parentId, status, ready: false, version: 2n, ...(status === 'in_progress' ? { startedAt: time } : {}), ...(status === 'done' ? { completedAt: time } : {}), ...(status === 'cancelled' ? { cancelledAt: time } : {}) }));
  const details = () => [parent, ...(hasChild ? [child] : []), ...(options.paginate ? otherChildren : []), ...(options.mixedChain ? [successor, hidden, hiddenNext] : [])];
  const graph = () => graphFixture(details());
  await context.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...headers } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph().project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph().project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/webhook-event-types') return send({ error: { code: 'not_found', message: 'Webhooks unavailable in this fixture', requestId: 'w2-webhooks' } }, 404);
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path.endsWith('/access')) return send(directAccessFixture(projectId));
    if (path.endsWith('/task-assignees')) return send({ items: [], unresolvedUserIds: [] });
    if (path.endsWith('/tags') && request.method() === 'GET') return send({ items: [], catalogEpoch: taskSyncEpoch(projectId), nextCursor: null });
    if (path.endsWith('/tags/resolve')) return send({ items: [] });
    if (path.endsWith('/tags/colors/resolve')) return send({ items: [], catalogEpoch: taskSyncEpoch(projectId) });
    if (path.endsWith('/task-sync')) {
      if (removed) return send({ error: { code: 'unavailable', message: 'Refresh unavailable', requestId: 'w2-refresh' } }, 503);
      const sync = taskSyncFixture(graph(), { query: taskSyncQuery(url), versionForTask: row => details().find(item => item.id === row.id)!.version });
      return send({ ...sync, tasks: sync.tasks.map(row => ({ ...row, ...(options.oldServer ? {} : { parentTaskId: details().find(item => item.id === row.id)!.parentTaskId ?? null }) })) });
    }
    if (path.endsWith('/task-graph')) return send(graph());
    if (path.endsWith('/tasks') && request.method() === 'POST') {
      const input = request.postDataJSON(); writes.push(input);
      child = detailFixture(projectId, childId, { title: input.title, description: input.description, assignedTo: input.assignedTo, parentTaskId: parentId, status: input.status, ready: input.status === 'todo', version: 1n }); hasChild = true;
      return send(child, 201, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    }
    if (path.endsWith('/tasks') && request.method() === 'GET') {
      const selectedParent = url.searchParams.get('parentTaskId');
      const cursor = url.searchParams.get('cursor');
      if (options.paginate && cursor !== null && failNext) { failNext = false; return send({ error: { code: 'unavailable', message: 'Page unavailable', requestId: 'page-error' } }, 503); }
      const all = details().filter(item => item.parentTaskId === selectedParent);
      return send({ items: cursor === null ? all.slice(0, 3) : all.slice(3), nextCursor: options.paginate && cursor === null ? 'next-page' : null }, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${parentId}` && request.method() === 'DELETE') {
      writes.push(request.postDataJSON()); removed = true;
      return route.fulfill({ status: 204, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${parentId}/status` && request.method() === 'PUT') {
      const input = request.postDataJSON(); writes.push(input);
      expect(input.version).toBe(Number(parent.version));
      if (input.cancelDescendants !== true) return send({ error: { code: 'task_unfinished_children', message: 'Unfinished children', requestId: 'w2-refusal', details: { taskIds: [childId] } } }, 409);
      expect(input.status).toBe('cancelled');
      parent = { ...parent, status: 'cancelled', ready: false, cancelledAt: time, version: parent.version + 1n };
      child = { ...child, status: 'cancelled', ready: false, cancelledAt: time, version: child.version + 1n };
      if (lost) return route.abort('failed');
      return send(parent);
    }
    for (const detail of details()) {
      const base = `/api/v1/projects/${projectId}/tasks/${detail.id}`;
      if (path === base) return removed ? send({ error: { code: 'task_deleted', message: 'Deleted', requestId: 'w2-deleted' } }, 410) : send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
      if (path === `${base}/thread/messages`) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
      if (path === `${base}/attachments`) return send({ items: endedChildren && detail.id === childId ? [{ path: 'evidence.txt', contentType: 'text/plain', sizeBytes: 24, createdAt: time, updatedAt: time }] : [], nextCursor: null });
      if (path === `${base}/attachments/files/evidence.txt`) return route.fulfill({ body: 'Private repair evidence.', headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
      if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    }
    throw new Error(`Unexpected fixture request: ${request.method()} ${path}`);
  });
  return writes;
};
const openCancellation = async (page: Page) => {
  await page.locator('.task-status-trigger').click();
  await page.locator('.task-status-option').filter({ hasText: /^(Cancelled|已取消)$/ }).click();
  return page.getByRole('alertdialog');
};

for (const locale of ['en', 'zh-CN']) for (const width of [320, 1280]) {
  test(`confirms recursive cancellation once and navigates blockers at ${width}px in ${locale}`, async ({ context, page }, info) => {
    const writes = await install(context, locale);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}/tasks/${parentId}`);
    await page.getByRole('tab', { name: /^(Subtasks|子任务)$/ }).click();
    await expect(page.getByRole('region', { name: /^(Subtasks|子任务)$/ })).toContainText('Repair child');
    let confirmation = await openCancellation(page);
    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0); expect(writes).toHaveLength(0);
    await expect(page.locator('.task-status-trigger')).toBeFocused();
    confirmation = await openCancellation(page);
    await confirmation.getByRole('button', { name: /^(Confirm cancellation|确认取消)$/ }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(page.getByRole('button', { name: /^(Cancel with subtasks|一并取消)$/ })).toBeVisible();
    expect(writes).toHaveLength(1);
    const blocker = page.getByRole('link', { name: childId, exact: true });
    await expect(blocker).toHaveAttribute('href', `/projects/${projectId}/tasks/${childId}`);
    await expectTextContrast(blocker);
    await page.getByRole('button', { name: /^(Cancel with subtasks|一并取消)$/ }).click();
    await expect(page.getByRole('alertdialog')).toContainText(locale === 'en' ? 'Cancel this task and its subtasks?' : '取消父任务和子任务？');
    await expectTextContrast(page.getByRole('alertdialog').getByRole('button', { name: /^(Confirm cancellation|确认取消)$/ }));
    await info.attach('recursive-confirmation', { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('alertdialog').getByRole('button', { name: /^(Cancel|取消)$/ }).click();
    expect(writes).toHaveLength(1);
    await page.getByRole('button', { name: /^(Cancel with subtasks|一并取消)$/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^(Confirm cancellation|确认取消)$/ }).click();
    await expect(page.locator('.task-status-trigger')).toContainText(locale === 'en' ? 'Cancelled' : '已取消');
    expect(writes).toEqual([{ version: 5, status: 'cancelled' }, { version: 5, status: 'cancelled', cancelDescendants: true }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await info.attach('confirmed-layout', { body: await page.screenshot(), contentType: 'image/png' });
  });
}

test('lost recursive receipt reconciles without replaying the cancellation', async ({ context, page }) => {
  const writes = await install(context, 'en', true);
  await page.goto(`/projects/${projectId}/tasks/${parentId}`);
  await openCancellation(page);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
  await page.getByRole('button', { name: 'Cancel with subtasks' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.locator('.task-status-trigger')).toContainText('Cancelled');
  expect(writes).toHaveLength(2);
});

test('ordinary parent deletion withdraws peer graph and child attachments while refresh fails', async ({ context, page }, info) => {
  const writes = await install(context, 'en', false, true);
  const project = await context.newPage();
  await project.goto(`/projects/${projectId}`);
  await project.locator('#project-section-tab-tasks').click();
  await project.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  await expect(project.getByText('Parent acceptance', { exact: true }).first()).toBeVisible();
  const parentReader = await context.newPage();
  await parentReader.goto(`/projects/${projectId}/tasks/${parentId}?tab=subtasks`);
  await expect(parentReader.getByRole('region', { name: 'Subtasks' })).toContainText('Repair child');
  const child = await context.newPage();
  await child.goto(`/projects/${projectId}/tasks/${childId}?tab=attachments`);
  await expect(child.getByRole('heading', { name: 'Repair child', exact: true })).toBeVisible();
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await child.getByRole('button', { name: /^evidence\.txt/ }).click();
  await expect(child.getByText('Private repair evidence.', { exact: true })).toBeVisible();
  await info.attach('admitted-child-material', { body: await child.screenshot(), contentType: 'image/png' });
  await page.goto(`/projects/${projectId}/tasks/${parentId}`);
  await page.getByRole('button', { name: 'More task actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete task' }).click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: 'Delete and remove dependencies', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(project.getByText('Repair child', { exact: true })).toHaveCount(0);
  await expect(project.getByText('Parent acceptance', { exact: true })).toHaveCount(0);
  await expect(parentReader.getByText('Repair child', { exact: true })).toHaveCount(0);
  await expect(child.getByText('Private repair evidence.', { exact: true })).toHaveCount(0);
  await expect(child.getByRole('button', { name: /^evidence\.txt/ })).toHaveCount(0);
  await expect(child.getByRole('heading', { name: 'Repair child', exact: true })).toHaveCount(0);
  await info.attach('retired-project', { body: await project.screenshot(), contentType: 'image/png' });
  await info.attach('retired-child-material', { body: await child.screenshot(), contentType: 'image/png' });
});

for (const width of [320, 1280]) test(`ordinary children stay out of project lists but retain real navigation at ${width}px`, async ({ context, page }, info) => {
  await install(context, 'en', false, false, { mixedChain: true });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const standalone = page.getByRole('tabpanel', { name: 'Standalone tasks', exact: true });
  await expect(standalone.getByText('Parent acceptance', { exact: true })).toBeVisible();
  await expect(standalone.getByText('Hidden descendant', { exact: true })).toHaveCount(0);
  await expect(standalone.getByText('Repair child', { exact: true })).toHaveCount(0);
  await page.locator('#project-task-tab-chains').click();
  const chains = page.getByRole('tabpanel', { name: 'Task chains', exact: true });
  const row = chains.locator('.root-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.root-title')).toHaveText('Visible successor');
  await row.locator('.root-toggle').click();
  await expect(row.locator('.goal-task-list')).toContainText('Visible successor');
  await expect(row.locator('.goal-task-list')).not.toContainText('Repair child');
  await expect(chains).not.toContainText('Hidden chain member');
  await row.locator('.goal-graph-button').click();
  const graph = page.locator('.task-chain-dialog');
  await expect(graph.locator(`.react-flow__node[data-id="${childId}"]`)).toBeVisible();
  await expect(graph.locator('.react-flow__edge')).toHaveCount(1);
  await graph.locator('.task-chain-close').click();
  const platform = page.getByRole('combobox', { name: 'Platform' });
  await platform.selectOption('windows');
  await expect(chains.locator('.root-row')).toHaveCount(0);
  await platform.selectOption('all');
  await expect(chains.locator('.root-row')).toHaveCount(1);
  await info.attach('scoped-chain', { body: await page.screenshot(), contentType: 'image/png' });

  await page.goto(`/projects/${projectId}/tasks/${parentId}?tab=subtasks`);
  const children = page.getByRole('region', { name: 'Subtasks' });
  await children.getByRole('link', { name: 'Repair child', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Repair child', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Subtasks', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Subtasks' })).toContainText('Hidden descendant');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('region', { name: 'Parent Task' }).getByRole('link', { name: 'Parent acceptance', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Parent acceptance', exact: true })).toBeVisible();
  await page.goto(`/projects/${projectId}/tasks/${childId}`);
  await expect(page.getByRole('heading', { name: 'Repair child', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('direct children keep five statuses and recover from a failed next page', async ({ context, page }) => {
  const writes = await install(context, 'en', false, false, { paginate: true });
  await page.goto(`/projects/${projectId}/tasks/${parentId}?tab=subtasks`);
  const panel = page.getByRole('region', { name: 'Subtasks' });
  await expect(panel).toContainText('Repair child');
  await expect(panel).toContainText('Child proposed');
  await expect(panel).toContainText('Child in_progress');
  await panel.getByRole('button', { name: 'Next' }).click();
  await expect(panel.getByRole('alert')).toContainText('Could not load subtasks');
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel).toContainText('Child done');
  await expect(panel).toContainText('Child cancelled');
  await panel.getByRole('button', { name: 'Previous' }).click();
  await expect(panel).toContainText('Repair child');
  expect(writes).toEqual([]);
});

test('project member creates the first child and remains on the subtask tab', async ({ context, page }, info) => {
  const writes = await install(context, 'en', false, false, { empty: true });
  await page.goto(`/projects/${projectId}/tasks/${parentId}`);
  await page.getByRole('tab', { name: 'Subtasks', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Subtasks' });
  await expect(panel).toContainText('No subtasks');
  await panel.getByRole('button', { name: 'New subtask' }).click();
  const dialog = page.getByRole('dialog', { name: 'New subtask' });
  await expect(dialog).toContainText(`Parent Task: Parent acceptance (${parentId})`);
  await dialog.getByLabel('Title').fill('First child');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Subtasks', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel).toContainText('First child');
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ title: 'First child', parentTaskId: parentId });
  await info.attach('first-child', { body: await page.screenshot(), contentType: 'image/png' });
});

test('terminal parent remains readable while creation is disabled', async ({ context, page }) => {
  const writes = await install(context, 'en', false, false, { endedParent: true });
  await page.goto(`/projects/${projectId}/tasks/${parentId}?tab=subtasks`);
  const panel = page.getByRole('region', { name: 'Subtasks' });
  await expect(panel).toContainText('Repair child');
  await expect(panel.getByRole('button', { name: 'New subtask' })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('older server without ordinary parent projection reports unsupported on the subtask tab', async ({ context, page }) => {
  const writes = await install(context, 'en', false, false, { oldServer: true });
  await page.goto(`/projects/${projectId}/tasks/${parentId}`);
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Subtasks', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Subtasks' });
  await expect(panel).toContainText('This server does not support ordinary Task relationships.');
  await expect(panel.getByRole('button', { name: 'New subtask' })).toBeDisabled();
  expect(writes).toEqual([]);
});
