import { expect, test, type Locator, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000100';
const goalId = '00000000-0000-4000-8000-000000000200';
const firstId = '00000000-0000-4000-8000-000000000201';
const secondId = '00000000-0000-4000-8000-000000000202';
const singleId = '00000000-0000-4000-8000-000000000203';
const otherGoalId = '00000000-0000-4000-8000-000000000204';
const otherTaskId = '00000000-0000-4000-8000-000000000205';
const outsideId = '00000000-0000-4000-8000-000000000206';
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-22T10:00:00Z';
const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal reading', ready: false, description: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the goal description.`).join('\n\n') });
const first = detailFixture(projectId, firstId, { parentId: goalId, title: 'First task' });
const second = detailFixture(projectId, secondId, { parentId: goalId, title: 'Second task', dependsOn: [firstId], blockedBy: [firstId], ready: false });
const single = detailFixture(projectId, singleId, { parentId: goalId, title: 'Standalone task' });
const all = [goal, first, second, single];
const graph = graphFixture(all);
async function expectHit(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  expect(await target.evaluate(element => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === element || element.contains(hit); })).toBe(true);
}
async function install(page: Page) {
  let details = all;
  let currentGraph = graph;
  let forbiddenGoal = false;
  let goalReads = 0;
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(currentGraph, { query: taskSyncQuery(url), versionForTask: task => details.find(item => item.id === task.id)!.version, propertiesForTask: () => ({ pullRequests: [] }) }));
    const detail = details.find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
    if (detail !== undefined) {
      if (detail.id === goalId) {
        goalReads++;
        if (forbiddenGoal) return send({ error: { code: 'forbidden', message: 'Forbidden', requestId: '00000000-0000-4000-8000-000000000099' } }, 403);
      }
      return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    }
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    if (path.endsWith('/attachments')) return send({ items: [{ path: 'notes.txt', contentType: 'text/plain', sizeBytes: 5, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path.endsWith('/attachments/files/notes.txt')) return route.fulfill({ body: 'notes', headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path.endsWith('/steps')) { const taskId = path.split('/').at(-2)!; return send({ projectId, taskId, version: details.find(item => item.id === taskId)!.version, steps: [] }); }
    if (path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  return { forbidGoal: () => { forbiddenGoal = true; }, goalReads: () => goalReads, addCrossGoal: () => {
    details = [...all, detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }), detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [secondId], blockedBy: [secondId], ready: false })];
    currentGraph = graphFixture(details);
  }, addOutsideChain: () => {
    const outside = detailFixture(projectId, outsideId, { title: 'Outside chain' });
    const otherGoal = detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false });
    const otherTask = detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [secondId], blockedBy: [secondId], ready: false });
    const fillers = Array.from({ length: 10 }, (_, n) => {
      const id = (number: number) => `00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
      const a = detailFixture(projectId, id(400 + n * 2), { title: `Filler chain ${n}` });
      const b = detailFixture(projectId, id(401 + n * 2), { title: `Filler member ${n}`, dependsOn: [a.id], blockedBy: [a.id], ready: false });
      return [a, b];
    }).flat();
    details = [goal, outside, { ...first, dependsOn: [outsideId], blockedBy: [outsideId], ready: false }, second, single, otherGoal, otherTask, ...fillers];
    currentGraph = graphFixture(details);
  }, reverseChain: () => {
    details = [goal, { ...first, version: 2n, dependsOn: [secondId], blockedBy: [secondId], ready: false }, { ...second, version: 2n, dependsOn: [], blockedBy: [], ready: true }, single];
    currentGraph = graphFixture(details);
  } };
}

test('a forbidden goal retires its attachment confirmation, while ordinary refresh preserves it', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const goalDialog = page.locator('.goal-detail-surface');
  await goalDialog.getByRole('tab', { name: 'Attachments' }).click();
  await goalDialog.getByRole('button', { name: 'More actions: notes.txt' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirmation = page.locator('dialog.attachment-delete-dialog');
  await expect(confirmation).toBeVisible();
  const original = await confirmation.elementHandle();
  const before = fixture.goalReads();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(fixture.goalReads).toBeGreaterThan(before);
  await expect(confirmation).toBeVisible();
  expect(await confirmation.evaluate((element, previous) => element === previous && (element as HTMLDialogElement).open, original)).toBe(true);
  fixture.forbidGoal();
  const beforeFailure = fixture.goalReads();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(fixture.goalReads).toBeGreaterThan(beforeFailure);
  await expect(confirmation).toHaveCount(0);
  await expect(goalDialog.getByRole('alert')).toBeVisible();
  await goalDialog.getByRole('button', { name: 'Close task details' }).click();
  await expect(goalDialog).toHaveCount(0);
});
for (const width of [1440, 390]) test(`Goal retains reading state and nested keyboard ownership at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const entry = page.locator(`#project-goal-${goalId}`); await entry.click();
  const goalDialog = page.locator('.goal-detail-surface'); await expect(goalDialog).toBeVisible();
  const chain = goalDialog.locator('.goal-detail-disclosure'); await expect(chain).toHaveAttribute('aria-expanded', 'false'); await chain.click();
  await expect(goalDialog.locator(`[data-goal-task-id="${firstId}"]`)).toBeVisible();
  const overview = goalDialog.locator('.goal-detail-overview');
  expect(await overview.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await overview.evaluate(element => { element.scrollTop = 100; });
  expect(await overview.evaluate(element => element.scrollTop)).toBe(100);
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click();
  const draft = goalDialog.locator('.thread-composer textarea'); await draft.fill('A retained draft');
  await goalDialog.getByRole('tab', { name: 'Attachments' }).click();
  await goalDialog.getByRole('button', { name: /^notes\.txt/ }).click();
  await goalDialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(goalDialog.locator('.attachment-file-selected')).toContainText('notes.txt');
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click(); await expect(draft).toHaveValue('A retained draft');
  await goalDialog.getByRole('tab', { name: 'Tasks' }).click(); await expect(chain).toHaveAttribute('aria-expanded', 'true');
  expect(await overview.evaluate(element => element.scrollTop)).toBe(100);
  const target = goalDialog.locator(`[data-goal-task-id="${firstId}"]`); await target.click();
  const child = page.getByRole('dialog', { name: 'First task', exact: true }); await expect(child).toBeVisible(); await expect(goalDialog).toHaveAttribute('inert', '');
  await page.keyboard.press('Tab'); expect(await child.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(child).toHaveCount(0); await expect(target).toBeFocused();
  await page.keyboard.press('Escape'); await expect(goalDialog.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  await expect(chain).toHaveAttribute('aria-expanded', 'true');
  await goalDialog.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.getByRole('dialog', { name: 'First task', exact: true });
  await expect(graphDialog).toBeVisible(); await expect(goalDialog).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape'); await expect(graphDialog).toHaveCount(0);
  await expect(goalDialog.getByRole('button', { name: 'View dependencies' })).toBeFocused();
});

test('returning from two goals restores the original unassigned chain view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page); fixture.addOutsideChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Task chains/ }).click();
  const status = page.getByRole('combobox', { name: 'Status', exact: true }); await status.selectOption('todo');
  const row = page.locator(`[data-chain-id="${outsideId}"]`);
  const disclosure = row.locator('.root-toggle'); await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const open = row.getByRole('button', { name: /View dependencies/ }); await open.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await open.click();
  const originalGraph = page.getByRole('dialog', { name: 'Outside chain' });
  const originalTarget = originalGraph.getByRole('button', { name: 'First task, Details' });
  await originalTarget.click();
  const firstGoal = page.getByRole('dialog', { name: 'Goal reading' });
  await expect(firstGoal.locator(`[data-goal-task-id="${firstId}"]`)).toBeFocused();
  await firstGoal.getByRole('button', { name: 'View dependencies' }).click();
  const nestedGraph = page.locator('.task-chain-dialog').last();
  await nestedGraph.getByRole('button', { name: 'Other task, Details' }).click();
  const otherGoal = page.getByRole('dialog', { name: 'Other goal' });
  await expect(otherGoal.locator(`[data-goal-task-id="${otherTaskId}"]`)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(otherGoal).toHaveCount(0); await expect(originalGraph).toBeVisible(); await expect(originalTarget).toBeFocused();
  await page.keyboard.press('Escape'); await expect(originalGraph).toHaveCount(0);
  await expect(open).toBeFocused(); await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(status).toHaveValue('todo');
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
});

test('cross-goal graph navigation asks before discarding the goal draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page); fixture.addCrossGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const entry = page.locator(`#project-goal-${goalId}`); await expectHit(entry); await entry.click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click();
  const draft = goalDialog.locator('.thread-composer textarea'); await draft.fill('Keep this Goal draft');
  await goalDialog.getByRole('tab', { name: 'Tasks' }).click();
  await goalDialog.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.getByRole('dialog', { name: 'First task' });
  const target = graphDialog.getByRole('button', { name: 'Other task, Details' });
  await target.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible(); await expect(graphDialog).toHaveAttribute('inert', '');
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(graphDialog).toBeVisible(); await expect(target).toBeFocused();
  await target.click();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  const otherGoal = page.getByRole('dialog', { name: 'Other goal' });
  await expect(otherGoal).toBeVisible();
  await expect(otherGoal.locator(`[data-goal-task-id="${otherTaskId}"]`)).toBeFocused();
});

test('a changing chain keeps its open task draft, focus and modal isolation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await goalDialog.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.getByRole('dialog', { name: 'First task' });
  await graphDialog.getByRole('button', { name: 'First task, Details' }).click();
  const child = page.getByRole('dialog', { name: 'First task' }).last();
  await child.getByRole('tab', { name: 'Discussion' }).click();
  const draft = child.locator('.thread-composer textarea');
  await draft.fill('Draft survives the changed chain');
  await draft.focus();
  await draft.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 8));
  const original = await child.elementHandle();
  fixture.reverseChain();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await expect(child).toBeVisible();
  expect(await child.evaluate((element, previous) => element === previous, original)).toBe(true);
  await expect(draft).toHaveValue('Draft survives the changed chain');
  await expect(draft).toBeFocused();
  expect(await draft.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 8]);
  await expect(goalDialog).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(child).toHaveCount(0);
  await expect(goalDialog).toBeVisible();
});

test('a nested task and goal draft share one topmost leave confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page); fixture.addCrossGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const entry = page.locator(`#project-goal-${goalId}`); await expectHit(entry); await entry.click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click();
  await goalDialog.locator('.thread-composer textarea').fill('Goal draft');
  await goalDialog.getByRole('tab', { name: 'Tasks' }).click();
  await goalDialog.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.getByRole('dialog', { name: 'First task' });
  const openTask = graphDialog.getByRole('button', { name: 'Second task, Details' }); await expectHit(openTask); await openTask.click();
  const taskDialog = page.getByRole('dialog', { name: 'Second task' });
  const stepsTab = taskDialog.getByRole('tab', { name: 'Steps' }); await expectHit(stepsTab); await stepsTab.click();
  await taskDialog.getByRole('button', { name: 'Add step', exact: true }).click();
  await taskDialog.getByLabel('Title', { exact: true }).fill('Task draft');
  await taskDialog.getByRole('tab', { name: 'Overview' }).click();
  const other = taskDialog.getByRole('button', { name: /Other task, ordinary dependency/i });
  await other.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toHaveCount(1);
  const keep = confirmation.getByRole('button', { name: 'Keep editing' });
  await expectHit(keep);
  await keep.click();
  await expect(taskDialog).toBeVisible(); await expect(graphDialog).toHaveAttribute('inert', '');
  await other.click();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  const otherGoal = page.getByRole('dialog', { name: 'Other goal' });
  await expect(otherGoal).toBeVisible();
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await expect(otherGoal.locator(`[data-goal-task-id="${otherTaskId}"]`)).toBeFocused();
});
