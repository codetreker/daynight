import { expect, test, type Locator, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000100';
const goalId = '00000000-0000-4000-8000-000000000200';
const firstId = '00000000-0000-4000-8000-000000000201';
const secondId = '00000000-0000-4000-8000-000000000202';
const singleId = '00000000-0000-4000-8000-000000000203';
const otherGoalId = '00000000-0000-4000-8000-000000000204';
const otherTaskId = '00000000-0000-4000-8000-000000000205';
const outsideId = '00000000-0000-4000-8000-000000000206';
const otherTask2Id = '00000000-0000-4000-8000-000000000207';
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
async function install(page: Page, locale: 'en' | 'zh-CN' = 'en') {
  let details = all;
  let currentGraph = graph;
  let epoch = taskSyncEpoch(projectId);
  let forbiddenGoal = false;
  let goalReads = 0;
  const statusWrites: { status: string; version: number }[] = [];
  const creates: unknown[] = [];
  const edits: unknown[] = [];
  let editMode: 'pending' | 'conflict' | 'pending-conflict' | 'unknown' | 'unknown-read-failure' = 'pending';
  let failGoalRead = false;
  let failedGoalReads = 0;
  let rejectGoalWrites = false;
  let releaseEdit: (() => void) | null = null;
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: TEST_VIEWER_ID, name: 'Long owner name '.repeat(8), avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/tasks` && route.request().method() === 'POST') { creates.push(route.request().postDataJSON()); return route.abort('failed'); }
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(currentGraph, { query: taskSyncQuery(url), epoch, versionForTask: task => details.find(item => item.id === task.id)!.version, propertiesForTask: task => details.find(item => item.id === task.id)!.properties }));
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}/status` && route.request().method() === 'PUT') {
      if (rejectGoalWrites) return send({ error: { code: 'forbidden', message: 'secret SQL detail', requestId: 'goal-write-2' } }, 403);
      const request = route.request().postDataJSON() as { status: 'todo' | 'in_progress' | 'done' | 'cancelled'; version: number };
      statusWrites.push(request);
      const current = details.find(item => item.id === goalId)!;
      const changedAt = `2026-10-22T10:00:0${statusWrites.length}Z`;
      const updated = { ...current, status: request.status, version: current.version + 1n, updatedAt: changedAt,
        startedAt: request.status === 'in_progress' ? changedAt : request.status === 'done' && current.status === 'in_progress' ? current.startedAt : null, completedAt: request.status === 'done' ? changedAt : null, cancelledAt: request.status === 'cancelled' ? changedAt : null };
      details = details.map(item => item.id === goalId ? updated : item);
      currentGraph = { ...graphFixture(details), observedAt: changedAt };
      return send(updated);
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}` && route.request().method() === 'PATCH') {
      edits.push(route.request().postDataJSON());
      if (rejectGoalWrites) return send({ error: { code: 'invalid_input', message: 'secret SQL detail', requestId: 'goal-write-3' } }, 400);
      if (editMode === 'unknown' || editMode === 'unknown-read-failure') { failGoalRead = editMode === 'unknown-read-failure'; return route.abort('failed'); }
      if (editMode === 'pending' || editMode === 'pending-conflict') await new Promise<void>(resolve => { releaseEdit = resolve; });
      if (editMode === 'conflict' || editMode === 'pending-conflict') {
        const updated = { ...details.find(item => item.id === goalId)!, version: 2n, title: 'Changed elsewhere', updatedAt: '2026-10-22T10:00:01Z' };
        details = details.map(item => item.id === goalId ? updated : item);
        currentGraph = { ...graphFixture(details), observedAt: updated.updatedAt };
      }
      const conflict = editMode === 'conflict' || editMode === 'pending-conflict';
      return send({ error: { code: conflict ? 'version_conflict' : 'invalid_input', message: 'secret SQL detail', requestId: 'goal-write-1' } }, conflict ? 409 : 422);
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}` && route.request().method() === 'DELETE' && rejectGoalWrites) return send({ error: { code: 'forbidden', message: 'secret SQL detail', requestId: 'goal-write-4' } }, 403);
    const detail = details.find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
    if (detail !== undefined) {
      if (detail.id === goalId) {
        goalReads++;
        if (failGoalRead) { failedGoalReads++; return route.abort('failed'); }
        if (forbiddenGoal) return send({ error: { code: 'forbidden', message: 'Forbidden', requestId: '00000000-0000-4000-8000-000000000099' } }, 403);
      }
      return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
    }
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    if (path.endsWith('/attachments')) return send({ items: [{ path: 'notes.txt', contentType: 'text/plain', sizeBytes: 5, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path.endsWith('/attachments/files/notes.txt')) return route.fulfill({ body: 'notes', headers: { 'Content-Type': 'text/plain', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path.endsWith('/steps')) { const taskId = path.split('/').at(-2)!; return send({ projectId, taskId, version: details.find(item => item.id === taskId)!.version, steps: [] }); }
    if (path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  return { statusWrites: () => statusWrites, creates: () => creates, edits: () => edits, rejectWrites: () => { rejectGoalWrites = true; }, setEditMode: (mode: typeof editMode) => { editMode = mode; }, releaseEdit: () => releaseEdit?.(), failedGoalReads: () => failedGoalReads, restoreGoalReads: () => { failGoalRead = false; }, advanceEpoch: () => { epoch = '40000000-0000-4000-8000-000000000001'; }, addPausedTask: () => {
    details = [goal, first, { ...second, title: 'A very long paused task title '.repeat(5), properties: { paused: true } }, single];
    currentGraph = graphFixture(details);
  }, addActiveChain: () => {
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'host' }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    const root = detailFixture(projectId, outsideId, { title: 'Long chain title '.repeat(12), assignedTo: TEST_VIEWER_ID, status: 'done' });
    const child = detailFixture(projectId, firstId, { title: 'Child task', status: 'in_progress', startedAt: time, dependsOn: [outsideId], blockedBy: [], ready: false, properties: { worker } });
    details = [root, child]; currentGraph = graphFixture(details);
  }, forbidGoal: () => { forbiddenGoal = true; }, goalReads: () => goalReads, addCrossGoal: () => {
    details = [...all, detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }), detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [secondId], blockedBy: [secondId], ready: false })];
    currentGraph = graphFixture(details);
  }, addTwoExternalTasks: () => {
    details = [...all, detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }),
      detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [secondId], blockedBy: [secondId], ready: false }),
      detailFixture(projectId, otherTask2Id, { parentId: otherGoalId, title: 'Other second task', dependsOn: [secondId], blockedBy: [secondId], ready: false })];
    currentGraph = graphFixture(details);
  }, moveOtherTask: () => {
    details = details.map(item => item.id === otherTaskId ? { ...item, parentId: null, version: item.version + 1n, updatedAt: '2026-10-22T10:00:01Z' } : item);
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

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal pause presentation and navigation at ${width}px in ${locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale); fixture.addPausedTask();
  const zh = locale === 'zh-CN';
  const badgeLabel = zh ? '已暂停' : 'Paused';
  const viewDependencies = zh ? '查看依赖关系' : 'View dependencies';
  const closeGraph = zh ? '关闭依赖图' : 'Close dependency graph';
  const fullscreen = zh ? '进入全屏' : 'Enter fullscreen';
  const exitFullscreen = zh ? '退出全屏' : 'Exit fullscreen';

  async function checkGoal(mode: 'dialog' | 'page') {
    const surface = page.locator('.goal-detail-surface');
    await expect(surface).toBeVisible();
    const disclosure = surface.locator('.goal-detail-disclosure');
    await disclosure.click();
    const row = surface.locator(`[data-goal-task-id="${secondId}"]`);
    await row.scrollIntoViewIfNeeded();
    const badge = row.locator('.task-paused-badge');
    await expect(badge).toHaveText(badgeLabel);
    await expect(badge).toBeVisible();
    await expect(row.locator('.goal-detail-task-title')).toContainText('A very long paused task title');
    const status = row.locator('span').last();
    await expect(status).toHaveText(zh ? '待处理' : 'To do');
    await expect(status).toBeVisible();
    expect(await row.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && [...element.children].every(child => {
        const rect = child.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      });
    })).toBe(true);
    expect(await row.evaluate(element => {
      const parts = [...element.children].map(child => child.getBoundingClientRect());
      return parts.every((a, i) => parts.slice(i + 1).every(b => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1));
    })).toBe(true);
    expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`goal-${mode}.png`) });
    await row.click();
    const pausedChild = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
    await expect(pausedChild.locator('.task-detail-title')).toContainText('A very long paused task title');
    await page.keyboard.press('Escape');
    await expect(pausedChild).toHaveCount(0);
    await expect(row).toBeFocused();
    await surface.getByRole('button', { name: fullscreen }).click();
    await expect(badge).toBeVisible();
    await surface.getByRole('button', { name: exitFullscreen }).click();
    const graphOpener = surface.getByRole('button', { name: viewDependencies });
    await graphOpener.click();
    const graphDialog = page.locator('.task-chain-dialog');
    await expect(graphDialog.locator('.task-pause-count')).toHaveText(zh ? '1 已暂停' : '1 paused');
    const graphBadge = graphDialog.locator('.task-node-paused .task-paused-badge');
    await expect(graphBadge).toHaveText(badgeLabel);
    await expect(graphBadge).toHaveClass(/compact/);
    await expect(graphBadge).toBeVisible();
    expect(await graphBadge.evaluate(element => {
      const badge = element.getBoundingClientRect(), node = element.closest('.task-node')!.getBoundingClientRect();
      return badge.width > 0 && badge.height > 0 && badge.left >= node.left - 1 && badge.right <= node.right + 1 && badge.top >= node.top - 1 && badge.bottom <= node.bottom + 1;
    })).toBe(true);
    await graphDialog.getByRole('button', { name: zh ? '适应画布' : 'Fit to canvas' }).click();
    await expect.poll(() => graphBadge.evaluate(element => {
      const badge = element.getBoundingClientRect(), canvas = element.closest('.task-graph-canvas')!.getBoundingClientRect();
      return badge.left >= canvas.left && badge.right <= canvas.right && badge.top >= canvas.top && badge.bottom <= canvas.bottom;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`graph-${mode}.png`) });
    await graphDialog.getByRole('button', { name: zh ? 'First task，详情' : 'First task, Details' }).click();
    const child = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
    await expect(child).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(child).toHaveCount(0);
    await graphDialog.getByRole('button', { name: closeGraph }).click();
    await expect(graphDialog).toHaveCount(0);
    await expect(graphOpener).toBeFocused();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  }

  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: zh ? '任务列表' : 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  await checkGoal('dialog');
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  await checkGoal('page');
});

test('Goal write errors identify refusals without exposing internal diagnostics', async ({ page }) => {
  const fixture = await install(page); fixture.rejectWrites();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const dialog = page.getByRole('dialog', { name: 'Goal reading' });
  await dialog.getByRole('combobox', { name: 'Goal status' }).selectOption('in_progress');
  await expect(dialog.locator('p[role=alert]').filter({ hasText: 'goal-write-2' })).toContainText('You do not have permission');
  await dialog.getByRole('button', { name: /^Assignee:/ }).click();
  await dialog.locator('.assignee-menu').getByRole('option', { name: /Long owner name/ }).click();
  await expect(dialog.locator('p[role=alert]').filter({ hasText: 'goal-write-3' })).toContainText('assignee is unavailable');
  await dialog.getByRole('button', { name: 'Delete Goal' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this Goal?' }).getByRole('button', { name: 'Delete Goal' }).click();
  await expect(dialog.locator('p[role=alert]').filter({ hasText: 'goal-write-4' })).toContainText('You do not have permission');
  await expect(dialog).not.toContainText('secret SQL detail');
});

for (const mode of ['pending', 'conflict', 'unknown'] as const) test(`Goal editing preserves its draft on ${mode} result`, async ({ page }) => {
  const fixture = await install(page); fixture.setEditMode(mode);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  await page.getByRole('dialog', { name: 'Goal reading' }).getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('alertdialog', { name: 'Edit Goal' });
  const title = editor.getByLabel('Name', { exact: true });
  const description = editor.getByRole('textbox', { name: 'Description', exact: true });
  await title.fill('Unsaved goal');
  await description.fill('Keep this draft');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => fixture.edits().length).toBe(1);
  if (mode === 'pending') {
    await expect(title).toBeDisabled();
    await expect(description).toBeDisabled();
    await expect(editor.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
    fixture.releaseEdit();
    await expect(editor.getByRole('alert')).toContainText('invalid_input');
    await expect(editor.getByRole('alert')).toContainText('goal-write-1');
    await expect(editor).not.toContainText('secret SQL detail');
    await expect(title).toBeEnabled();
  } else if (mode === 'conflict') {
    await expect(editor.getByRole('button', { name: 'Use latest version' })).toBeVisible();
    await expect(editor.getByRole('alert').last()).toContainText('version_conflict');
    await expect(editor).not.toContainText('secret SQL detail');
  } else {
    await expect(title).toBeEnabled();
    await expect(editor).toContainText('The operation outcome is unknown');
  }
  await expect(title).toHaveValue('Unsaved goal');
  await expect(description).toHaveValue('Keep this draft');
  expect(fixture.edits()).toHaveLength(1);
});

test('a closed Goal editor retains an unknown draft and exposes read-only recovery after the automatic read fails', async ({ page }) => {
  const fixture = await install(page); fixture.setEditMode('unknown-read-failure');
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const goalDialog = page.locator('.goal-detail-surface');
  const edit = goalDialog.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const editor = page.getByRole('alertdialog', { name: 'Edit Goal' });
  await editor.getByRole('textbox', { name: 'Name' }).fill('Retained goal');
  await editor.getByRole('textbox', { name: 'Description' }).fill('Retained description');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect.poll(fixture.failedGoalReads).toBeGreaterThan(0);
  await expect(editor.getByRole('button', { name: 'Check state' })).toBeEnabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(goalDialog.getByText(/draft is retained; checking state will not resend/i)).toBeVisible();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Retained goal');
  await expect(editor.getByRole('textbox', { name: 'Description' })).toHaveValue('Retained description');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  fixture.restoreGoalReads();
  await goalDialog.getByRole('button', { name: 'Check state' }).click();
  await expect(goalDialog.getByText(/draft is retained; checking state will not resend/i)).toHaveCount(0);
  await expect(goalDialog.getByText(/original save outcome remains unknown/i)).toBeVisible();
  await edit.click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Retained goal');
  await expect(editor.getByRole('textbox', { name: 'Description' })).toHaveValue('Retained description');
  expect(fixture.edits()).toHaveLength(1);
});

for (const mode of ['pending', 'pending-conflict'] as const) test(`a closed Goal editor retains its draft and shows a delayed ${mode} refusal`, async ({ page }) => {
  const fixture = await install(page); fixture.setEditMode(mode);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const goalDialog = page.locator('.goal-detail-surface');
  const edit = goalDialog.getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  const editor = page.getByRole('alertdialog', { name: 'Edit Goal' });
  await editor.getByRole('textbox', { name: 'Name' }).fill('Retained goal');
  await editor.getByRole('textbox', { name: 'Description' }).fill('Retained description');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => fixture.edits().length).toBe(1);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  fixture.releaseEdit();
  await expect(goalDialog.getByText(mode === 'pending' ? /invalid_input/ : /version_conflict/)).toBeVisible();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(editor.getByRole('textbox', { name: 'Name' })).toHaveValue('Retained goal');
  await expect(editor.getByRole('textbox', { name: 'Description' })).toHaveValue('Retained description');
  if (mode === 'pending-conflict') await expect(editor.getByRole('button', { name: 'Use latest version' })).toBeVisible();
  expect(fixture.edits()).toHaveLength(1);
});

test('unknown Goal creation retains its draft and blocks replay after leaving the tab', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.getByRole('button', { name: 'New Goal' }).click();
  const form = page.getByRole('dialog', { name: 'New Goal' });
  await form.getByLabel('Name', { exact: true }).fill('A new Goal');
  await form.getByLabel('Description').fill('Keep this draft');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(form.getByRole('alert').first()).toContainText('outcome is unknown');
  expect(fixture.creates()).toEqual([{ title: 'A new Goal', description: 'Keep this draft', type: 'goal', assignedTo: TEST_VIEWER_ID }]);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: /^Task chains/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.getByRole('button', { name: 'New Goal' }).click();
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('A new Goal');
  await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  expect(fixture.creates()).toHaveLength(1);
});

for (const width of [1440, 390]) test(`Goal status confirmations preserve children and permit reopening at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  const status = goalDialog.getByRole('combobox', { name: 'Goal status' });
  await status.selectOption('done');
  const confirmation = page.getByRole('alertdialog', { name: 'Complete this Goal?' });
  await expect(confirmation).toContainText('Task statuses remain unchanged');
  await confirmation.getByRole('button', { name: 'Back' }).click();
  expect(fixture.statusWrites()).toHaveLength(0);
  await expect(status).toHaveValue('todo');
  await status.selectOption('done');
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => fixture.statusWrites().length).toBe(1);
  await expect(status).toHaveValue('done');
  await expect(goalDialog.getByRole('button', { name: 'New Task' })).toBeEnabled();
  await status.selectOption('todo');
  await expect.poll(() => fixture.statusWrites().length).toBe(2);
  await expect(status).toHaveValue('todo');
  await status.selectOption('cancelled');
  await page.getByRole('alertdialog', { name: 'Cancel this Goal?' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => fixture.statusWrites().length).toBe(3);
  await expect(status).toHaveValue('cancelled');
  await status.selectOption('in_progress');
  await expect.poll(() => fixture.statusWrites().length).toBe(4);
  await expect(status).toHaveValue('in_progress');
  expect(fixture.statusWrites()).toEqual([{ status: 'done', version: 1 }, { status: 'todo', version: 2 }, { status: 'cancelled', version: 3 }, { status: 'in_progress', version: 4 }]);
  await goalDialog.getByRole('button', { name: 'Delete Goal' }).click();
  const deletion = page.getByRole('alertdialog', { name: 'Delete this Goal?' });
  await expect(deletion).toContainText('Their Parent remains');
  await deletion.getByRole('button', { name: 'Back' }).click();
  await expect(goalDialog).toBeVisible();
});

for (const width of [1366, 390, 320]) test(`active chain indicator remains usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page); fixture.addActiveChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  const header = page.locator(`#task-root-${outsideId}`);
  await expect(header).toHaveAccessibleName(/Automatic execution active/);
  await expect(header.locator('.chain-worker-active')).toBeVisible();
  await expect(header.locator('.assignee-name')).toHaveText('Long owner name '.repeat(8).trim());
  expect(await page.locator(`[data-chain-id="${outsideId}"]`).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await header.focus(); await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(header.locator('.chain-worker-active')).toBeVisible();
  await expect(page.locator(`#chain-task-${outsideId}-${firstId}`)).toBeVisible();
  await expectHit(page.locator(`#task-chain-graph-${outsideId}`));
  await expectHit(page.locator(`#chain-task-${outsideId}-${outsideId}`));
  expect(await page.locator(`[data-chain-id="${outsideId}"]`).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

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

for (const width of [1440, 320]) test(`Project reading traverses graph and nested Goal selections at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page); fixture.addOutsideChain();
  const writes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
  await page.goto(`/projects/${projectId}`);
  const activate = async (target: Locator) => { await target.focus(); await page.keyboard.press('Enter'); };
  await activate(page.getByRole('tab', { name: 'Task list', exact: true }));
  await activate(page.getByRole('tab', { name: /^Goal/ }));
  await activate(page.getByRole('tab', { name: /^Task chains/ }));
  const open = page.locator(`[data-chain-id="${outsideId}"]`).getByRole('button', { name: /View dependencies/ });
  await activate(open);
  const projectGraph = page.getByRole('dialog', { name: 'Outside chain' });
  await expect(projectGraph).toBeVisible();
  await activate(projectGraph.getByRole('button', { name: 'First task, Details' }));
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await expect(goalDialog).toBeVisible();
  await activate(goalDialog.getByRole('button', { name: 'View dependencies' }));
  const nestedGraph = page.locator('.task-chain-dialog').nth(1);
  await expect(nestedGraph).toBeVisible();
  await activate(nestedGraph.getByRole('button', { name: 'First task, Details' }));
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'First task' }) });
  await activate(child.getByRole('tab', { name: 'Attachments', exact: true }));
  await activate(child.getByRole('button', { name: /^notes\.txt/ }));
  await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toBeVisible();
  const preferences = await page.evaluate(() => ({ ...localStorage }));

  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(child).toHaveCount(0); await expect(nestedGraph).toBeVisible();
  await page.goBack(); await expect(nestedGraph).toHaveCount(0); await expect(goalDialog).toBeVisible();
  await page.goBack(); await expect(goalDialog).toHaveCount(0); await expect(projectGraph).toBeVisible();
  await expect.poll(() => projectGraph.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.goBack(); await expect(projectGraph).toHaveCount(0);
  await page.goBack(); await expect(page.getByRole('tab', { name: /^Goal/ })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(page.getByRole('tab', { name: /^Task chains/ })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: 'Task list', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: /^Goal/ })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: /^Task chains/ })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(projectGraph).toBeVisible();
  await page.goForward(); await expect(goalDialog).toBeVisible();
  await page.goForward(); await expect(nestedGraph).toBeVisible();
  await page.goForward(); await expect(child).toBeVisible();
  await page.goForward(); await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(preferences);
  expect(writes).toEqual([]);
});

test('Project nested child retains its draft and closing replaces the parent selection', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-${goalId}`).click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await goalDialog.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.getByRole('dialog', { name: 'First task', exact: true });
  await graphDialog.getByRole('button', { name: 'First task, Details' }).click();
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'First task' }) });
  await child.getByRole('tab', { name: 'Steps', exact: true }).click();
  await child.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = child.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await draft.fill('Project child draft');
  const original = await child.elementHandle();
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await child.getByRole('button', { name: /^notes\.txt/ }).click();
  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(draft).toHaveValue('Project child draft');
  expect(await child.evaluate((element, previous) => element === previous, original)).toBe(true);
  await page.goBack(); await page.goBack();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(child).toBeVisible();
  await child.getByRole('button', { name: 'Close task details' }).click();
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(child).toHaveCount(0); await expect(graphDialog).toBeVisible();
  await page.goBack(); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(graphDialog).toBeVisible(); await expect(child).toHaveCount(0);
  await graphDialog.getByRole('button', { name: 'Close dependency graph' }).click();
  await expect(graphDialog).toHaveCount(0); await expect(goalDialog).toBeVisible();
  await page.goBack(); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(graphDialog).toHaveCount(0); await expect(goalDialog).toBeVisible();
});

test('standalone Goal restores graph, child, tab and file through browser history', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await expect(goalPage.locator('.task-detail-title')).toHaveText('Goal reading');
  await goalPage.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}\\?tab=attachments$`));
  await goalPage.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await goalPage.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.locator('.task-chain-dialog');
  await expect(graphDialog).toBeVisible();
  await graphDialog.getByRole('button', { name: 'First task, Details' }).click();
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'First task' }) });
  await expect(child).toBeVisible();
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await child.getByRole('button', { name: /^notes\.txt/ }).click();
  await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');

  await page.goBack();
  await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack();
  await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(child).toHaveCount(0); await expect(graphDialog).toBeVisible();
  await page.goBack(); await expect(graphDialog).toHaveCount(0);
  await expect(goalPage.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(goalPage.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(goalPage.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(child).toBeVisible();
  await page.goForward(); await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
});

test('closing a standalone Goal child replaces the current entry with its graph parent', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await goalPage.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.locator('.task-chain-dialog');
  await graphDialog.getByRole('button', { name: 'First task, Details' }).click();
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'First task' }) });
  await child.getByRole('button', { name: 'Close task details' }).click();
  await expect(child).toHaveCount(0); await expect(graphDialog).toBeVisible();
  await page.goBack(); await expect(graphDialog).toBeVisible(); await expect(child).toHaveCount(0);
  await page.goBack(); await expect(graphDialog).toHaveCount(0);
  await page.goForward(); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(graphDialog).toBeVisible(); await expect(child).toHaveCount(0);
  await graphDialog.getByRole('button', { name: 'Close dependency graph' }).click();
  await expect(graphDialog).toHaveCount(0);
  await page.goBack(); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(graphDialog).toHaveCount(0);
});

test('standalone Goal child keeps its draft across tab and file history and protects departure', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await goalPage.locator(`[data-goal-task-id="${singleId}"]`).click();
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'Standalone task' }) });
  await child.getByRole('tab', { name: 'Steps', exact: true }).click();
  await child.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = child.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await draft.fill('Retained child draft');
  const original = await child.elementHandle();
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await child.getByRole('button', { name: /^notes\.txt/ }).click();
  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack();
  await expect(draft).toHaveValue('Retained child draft');
  expect(await child.evaluate((element, previous) => element === previous, original)).toBe(true);
  await page.goBack();
  await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(child).toBeVisible();
  await child.getByRole('tab', { name: 'Steps', exact: true }).click();
  await expect(draft).toHaveValue('Retained child draft');
});

test('a new child draft is protected from a retired same-child history entry', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await goalPage.locator(`[data-goal-task-id="${singleId}"]`).click();
  const child = page.getByRole('dialog', { name: 'Standalone task' });
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  fixture.advanceEpoch();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(child).toHaveCount(0);
  await goalPage.locator(`[data-goal-task-id="${singleId}"]`).click();
  await child.getByRole('tab', { name: 'Steps', exact: true }).click();
  await child.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = child.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await draft.fill('New draft after recovery');
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await page.goBack();
  await expect(draft).toHaveValue('New draft after recovery');
  const entry = await page.evaluate(() => history.state.__daynightNavigation.entryId as string);
  await page.evaluate(() => history.go(-3));
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect.poll(() => page.evaluate(() => history.state.__daynightNavigation.entryId)).toBe(entry);
  await expect(draft).toHaveValue('New draft after recovery');
  await page.evaluate(() => history.go(-3));
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(child).toHaveCount(0);
});

test('standalone Goal restores the external Goal dialog and its reading selection', async ({ page }) => {
  const fixture = await install(page); fixture.addCrossGoal();
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await goalPage.getByRole('button', { name: 'View dependencies' }).click();
  const graphDialog = page.locator('.task-chain-dialog');
  await graphDialog.getByRole('button', { name: 'Other task, Details' }).click();
  const external = page.getByRole('dialog', { name: 'Other goal' });
  await expect(external).toBeVisible(); await expect(graphDialog).toHaveCount(0);
  await external.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await external.getByRole('button', { name: /^notes\.txt/ }).click();
  await expect(external.locator('.attachment-file-selected')).toContainText('notes.txt');
  await page.goBack(); await expect(external.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(external.getByRole('tab', { name: 'Tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(external).toHaveCount(0); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(external).toBeVisible(); await expect(graphDialog).toHaveCount(0);
  await page.goForward(); await expect(external.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(external.locator('.attachment-file-selected')).toContainText('notes.txt');
});

test('history retains an external Goal draft when its old witness moves', async ({ page }) => {
  const fixture = await install(page); fixture.addTwoExternalTasks();
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await goalPage.getByRole('button', { name: 'View dependencies' }).click();
  await page.locator('.task-chain-dialog').getByRole('button', { name: 'Other task, Details' }).click();
  const external = page.getByRole('dialog', { name: 'Other goal' });
  await external.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await external.getByRole('button', { name: 'Close task details' }).click();
  await goalPage.getByRole('button', { name: 'View dependencies' }).click();
  await page.locator('.task-chain-dialog').getByRole('button', { name: 'Other second task, Details' }).click();
  await expect(external.locator(`[data-goal-task-id="${otherTaskId}"]`)).toHaveCount(1);
  await external.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await external.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('alertdialog', { name: 'Edit Goal' });
  const draft = edit.getByRole('textbox', { name: 'Description', exact: true });
  await draft.fill('Keep this Goal draft');
  const original = await external.elementHandle();
  fixture.moveOtherTask();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(external.locator(`[data-goal-task-id="${otherTaskId}"]`)).toHaveCount(0);
  await page.evaluate(() => history.go(-4));
  await expect(external.locator('[role="tab"][aria-selected="true"]')).toHaveText('Tasks');
  await expect(edit).toBeVisible();
  await expect(draft).toHaveValue('Keep this Goal draft');
  expect(await external.evaluate((element, previous) => element === previous, original)).toBe(true);
});
