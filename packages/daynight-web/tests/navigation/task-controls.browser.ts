import { expectTextContrast, roleColors } from './color-roles';
import type { TaskStep } from '../../src/api/task-steps';
import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, taskSyncEpoch, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import type { TaskDetail } from '../../src/api/types';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const previousId = '00000000-0000-4000-8000-000000000042';
const personalId = '00000000-0000-4000-8000-000000000011';
const time = '2026-10-20T09:00:00Z';
const step = { id: '00000001', title: 'Review', description: 'Read this', status: 'todo', createdAt: time, updatedAt: time };
const longName = 'Alexandra Person With A Very Long Name For Narrow Assignment Layout';

type FixtureOptions = {
  readonly steps?: readonly TaskStep[];
  readonly outcome?: 'conflict' | 'lost' | 'malformed';
  readonly gate?: { readonly started: () => void; readonly wait: Promise<void> };
  readonly observe?: (before: TaskDetail, after: TaskDetail) => void;
  readonly exposeUpdate?: (update: (changes: Partial<TaskDetail>) => void) => void;
  readonly previousChanges?: Partial<TaskDetail>;
  readonly exposePreviousUpdate?: (update: (changes: Partial<TaskDetail>) => void) => void;
  readonly additionalTasks?: readonly TaskDetail[];
  readonly exposeDeleteTask?: (remove: () => void) => void;
};

async function install(page: Page, running = false, linked = false, large = false, rich = false, paused = false, moveGate?: { started: () => void; wait: Promise<void> }, changes: Partial<TaskDetail> = {}, options: FixtureOptions = {}) {
  let epoch = taskSyncEpoch(projectId);
  let taskRemoved = false;
  let task = detailFixture(projectId, taskId, { title: 'Target task', version: 5n, ...(running ? { status: 'in_progress' as const, ready: false, startedAt: time } : {}), ...(rich ? { assignedTo: TEST_VIEWER_ID } : {}), ...(paused ? { properties: { pullRequests: [], paused: true } } : {}), ...changes });
  let previous = detailFixture(projectId, previousId, { title: 'History origin', ...(linked ? { dependsOn: [taskId], blockedBy: [taskId], ready: false } : {}), version: 5n, ...options.previousChanges });
  const details = () => [...(taskRemoved ? [] : [task]), previous, ...(options.additionalTasks ?? [])];
  const graph = () => ({ ...graphFixture(details()), observedAt: task.updatedAt > previous.updatedAt ? task.updatedAt : previous.updatedAt });
  let statusRequests = 0;
  options.exposeUpdate?.((changes) => { task = { ...task, ...changes }; });
  options.exposePreviousUpdate?.((changes) => { previous = { ...previous, ...changes }; });
  options.exposeDeleteTask?.(() => { taskRemoved = true; epoch = '00000000-0000-4000-8000-000000000901'; });
  let steps = options.steps ? [...options.steps] : large ? [step, ...Array.from({ length: 100 }, (_, index) => ({ ...step, id: (index + 2).toString(16).padStart(8, '0'), title: `Other ${index + 1}` }))] : [step];
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...headers } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph().project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph().project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph(), { epoch, query: taskSyncQuery(url), versionForTask: row => details().find(detail => detail.id === row.id)!.version, propertiesForTask: row => details().find(detail => detail.id === row.id)!.properties }));
    if (path === `/api/v1/projects/${projectId}/task-graph`) return send(graph());
    if (path === `/api/v1/projects/${projectId}/tasks/search` && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({ query: `id:${taskId}`, type: 'task', tagIds: [], tagMatch: 'all', untagged: false, limit: 15 });
      return send({ projectId, total: 1, items: [{ id: task.id, type: task.type, parentId: task.parentId, projectId, tags: task.tags, title: task.title, status: task.status, assignedTo: task.assignedTo, updatedAt: task.updatedAt, cancelledAt: task.cancelledAt, context: null, match: { fields: ['id', 'description'], descriptionSnippet: 'A long matching description '.repeat(5) } }], nextCursor: null });
    }
    if (path === `/api/v1/projects/${projectId}/task-assignees`) {
      const requested = url.searchParams.getAll('userId');
      const person = { version: 'a'.repeat(64), userId: TEST_VIEWER_ID, name: longName, avatarUrl: '/missing-assignee-avatar.png', hasProjectAccess: true };
      return send({ items: requested.length === 0 || requested.includes(TEST_VIEWER_ID) ? [person] : [], unresolvedUserIds: requested.filter(id => id !== TEST_VIEWER_ID) });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/status` && request.method() === 'PUT') {
      const input = request.postDataJSON();
      expect(input).toEqual({ version: Number(task.version), status: 'cancelled' });
      statusRequests++;
      if (options.outcome === 'conflict' && statusRequests === 1) {
        task = { ...task, version: task.version + 1n, updatedAt: '2026-10-22T10:01:00Z' };
        return send({ error: { code: 'version_conflict', message: 'Changed task', requestId: 'cancel-conflict' } }, 409);
      }
      options.gate?.started(); await options.gate?.wait;
      const before = task;
      task = { ...task, status: 'cancelled', ready: false, cancelledAt: '2026-10-22T10:02:00Z', updatedAt: '2026-10-22T10:02:00Z', version: task.version + 1n };
      options.observe?.(before, task);
      if (options.outcome === 'lost') return route.abort('failed');
      if (options.outcome === 'malformed') return send({ ...task, cancelledAt: null });
      return send(task);
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps/${step.id}/position` && request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({ version: 5, position: 'last' });
      task = { ...task, version: 6n }; steps = [...steps.slice(1), steps[0]!];
      if (moveGate) { moveGate.started(); await moveGate.wait; }
      return send({ projectId, taskId, version: task.version, steps });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps` && request.method() === 'POST') {
      const input = request.postDataJSON() as { id: string; version: number; title: string; description: string; status: string; after: string };
      expect(input).toMatchObject({ version: 5, title: 'Inserted after anchor', description: '', status: 'todo', after: '00000064' });
      expect(input.id).toMatch(/^[0-9a-f]{8}$/);
      const anchor = steps.findIndex(value => value.id === input.after);
      expect(anchor).toBe(99);
      const added = { ...step, id: input.id, title: input.title, description: input.description, status: input.status };
      steps = [...steps.slice(0, anchor + 1), added, ...steps.slice(anchor + 1)]; task = { ...task, version: 6n };
      return route.fulfill({ status: 201, body: stringifyWireJson({ projectId, taskId, version: task.version, steps }), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, Location: `${path}/${input.id}` } });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/steps/00000065` && request.method() === 'DELETE') {
      expect(request.postDataJSON()).toEqual({ version: 5 });
      task = { ...task, version: 6n }; steps = steps.filter(value => value.id !== '00000065');
      return send({ projectId, taskId, version: task.version, steps });
    }
    for (const detail of details()) {
      const base = `/api/v1/projects/${projectId}/tasks/${detail.id}`;
      if (path === base) return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
      if (path === `${base}/steps`) return send({ projectId, taskId: detail.id, version: detail.version, steps: detail.id === taskId ? steps : [] });
      if (path === `${base}/sessions` || path === `${base}/attachments`) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return writes;
}

async function openDialog(page: Page) {
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
  await page.locator(`#standalone-task-${taskId}`).click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog).toHaveAccessibleName('Target task');
  return dialog;
}

test('ID search keeps long results readable and opens the correct task on narrow screens', async ({ page }) => {
  const title = 'Long search title '.repeat(12) + 'end';
  const writes = await install(page, false, false, false, false, false, undefined, { title, description: 'Full task details' });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const input = page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' });
  await input.fill(`id:${taskId}`); await input.press('Enter');
  const result = page.getByRole('button', { name: `Open task: ${title}` });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(result).toContainText(taskId);
    await expect(result).toContainText('ID match · Description match');
    await expect(result).toContainText('A long matching description');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await result.click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog).toHaveAccessibleName(title);
    await expect(dialog).toContainText('Full task details');
    await page.keyboard.press('Escape'); await expect(result).toBeFocused();
  }
  expect(writes).toEqual([`POST /api/v1/projects/${projectId}/tasks/search`]);
});

test('history protects a summary task draft before restoring its earlier direct search detail', async ({ page }) => {
  const writes = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' });
  await input.fill(`id:${taskId}`); await input.press('Enter');
  await page.getByRole('button', { name: 'Open task: Target task' }).click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog).toHaveAccessibleName('Target task');
  const directEntry = await page.evaluate(() => history.state.__daynightNavigation.entryId as string);
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close task details' }).click();
  await expect(dialog).toHaveCount(0);
  await input.fill('');
  await page.locator(`#standalone-task-${taskId}`).click();
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = dialog.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await draft.fill('Keep this summary draft');
  await page.evaluate(() => history.go(-3));
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(draft).toHaveValue('Keep this summary draft');
  await page.evaluate(() => history.go(-3));
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect.poll(() => page.evaluate(() => history.state.__daynightNavigation.entryId)).toBe(directEntry);
  await expect(dialog).toHaveAccessibleName('Target task');
  await expect(dialog.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(writes).toEqual([`POST /api/v1/projects/${projectId}/tasks/search`]);
});

test('returning from direct search detail to the earlier summary loads Steps', async ({ page }) => {
  const writes = await install(page);
  const dialog = await openDialog(page);
  const summaryEntry = await page.evaluate(() => history.state.__daynightNavigation.entryId as string);
  expect(await page.evaluate(() => history.state.__daynightNavigation.view.selection.detail.source)).toBe('summary');
  await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close task details' }).click();
  await expect(dialog).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Search task IDs, titles and descriptions' });
  await input.fill(`id:${taskId}`); await input.press('Enter');
  await page.getByRole('button', { name: 'Open task: Target task' }).click();
  await expect(dialog).toHaveAccessibleName('Target task');
  expect(await page.evaluate(() => history.state.__daynightNavigation.view.selection.detail.source)).toBe('direct');
  await page.evaluate(() => history.go(-2));
  await expect.poll(() => page.evaluate(() => history.state.__daynightNavigation.entryId)).toBe(summaryEntry);
  await expect(dialog).toHaveAccessibleName('Target task');
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await expect(dialog.getByText('Review', { exact: true })).toBeVisible();
  expect(writes).toEqual([`POST /api/v1/projects/${projectId}/tasks/search`]);
});

test('summary detail waits for a snapshot and retains its real editor through snapshot loss', async ({ page }) => {
  const writes = await install(page);
  await page.goto('/summary-detail-fixture');
  await page.waitForFunction(() => 'summaryDetailFixture' in window);
  const directReads = () => page.evaluate(() => (window as unknown as { summaryDetailFixture: { directReads(): number } }).summaryDetailFixture.directReads());
  const setRevision = (value: number | null) => page.evaluate(revision => (window as unknown as { summaryDetailFixture: { setRevision(value: number | null): void } }).summaryDetailFixture.setRevision(revision), value);
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.getByRole('status', { name: 'Loading task details' })).toBeVisible();
  expect(await directReads()).toBe(0);
  await setRevision(0);
  await expect(page.getByTestId('summary-fixture-stage')).toHaveText('summary:0');
  await expect(dialog.getByRole('status', { name: 'Loading task details' })).toBeVisible();
  expect(await directReads()).toBe(0);
  await setRevision(1);
  await expect(dialog).toHaveAccessibleName('Target task');
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = dialog.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await draft.fill('Retained after snapshot loss');
  const original = await draft.elementHandle();
  await setRevision(null);
  await expect(page.getByTestId('summary-fixture-stage')).toHaveText('summary:none');
  await expect(draft).toHaveValue('Retained after snapshot loss');
  expect(await draft.evaluate((element, previous) => element === previous, original)).toBe(true);
  expect(await directReads()).toBe(0);
  expect(writes).toEqual([]);
});

test('a direct Goal retains its editor when the summary snapshot is not yet available', async ({ page }) => {
  await install(page);
  const goal = detailFixture(projectId, taskId, { type: 'goal', title: 'Target goal', version: 5n, ready: false });
  await page.route(`**/api/v1/projects/${projectId}/tasks/${taskId}`, route => route.fulfill({ status: 200, body: stringifyWireJson(goal), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': taskSyncEpoch(projectId) } }));
  await page.goto('/summary-detail-fixture?resource=goal');
  await page.waitForFunction(() => 'summaryDetailFixture' in window);
  const goalDialog = page.getByRole('dialog', { name: 'Target goal' });
  await goalDialog.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('alertdialog', { name: 'Edit Goal' });
  const draft = editor.getByRole('textbox', { name: 'Description', exact: true });
  await draft.fill('Goal draft across observation changes');
  const original = await draft.elementHandle();
  await page.evaluate(() => (window as unknown as { summaryDetailFixture: { setSource(value: 'summary'): void } }).summaryDetailFixture.setSource('summary'));
  await expect(page.getByTestId('summary-fixture-stage')).toHaveText('summary:none');
  await expect(editor).toBeVisible(); await expect(draft).toHaveValue('Goal draft across observation changes');
  expect(await draft.evaluate((element, previous) => element === previous, original)).toBe(true);
  await page.evaluate(() => (window as unknown as { summaryDetailFixture: { setRevision(value: number): void } }).summaryDetailFixture.setRevision(0));
  await expect(page.getByTestId('summary-fixture-stage')).toHaveText('summary:0');
  await expect(editor).toBeVisible(); await expect(draft).toHaveValue('Goal draft across observation changes');
  expect(await draft.evaluate((element, previous) => element === previous, original)).toBe(true);
  await page.evaluate(() => (window as unknown as { summaryDetailFixture: { setRevision(value: number): void } }).summaryDetailFixture.setRevision(1));
  await expect(page.getByTestId('summary-fixture-stage')).toHaveText('summary:1');
  await expect(editor).toBeVisible(); await expect(draft).toHaveValue('Goal draft across observation changes');
  expect(await draft.evaluate((element, previous) => element === previous, original)).toBe(true);
});

test('Step status and position menus stay in a short viewport and return keyboard focus', async ({ page }) => {
  const writes = await install(page);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 240 });
  const row = dialog.locator('.step-row[data-step-id="00000001"]');
  const status = row.locator('.step-status');
  await expect(status).toBeEnabled(); await status.scrollIntoViewIfNeeded(); await status.focus(); await page.keyboard.press('Enter');
  const options = page.getByRole('menuitemradio'); await expect(options).toHaveCount(4);
  for (const option of await options.all()) {
    await expect(option).toBeVisible(); const box = await option.boundingBox(); expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(240);
  }
  await page.keyboard.press('Escape'); await expect(status).toBeFocused();
  await page.setViewportSize({ width: 320, height: 390 });
  await status.scrollIntoViewIfNeeded(); await status.click();
  const statusMenu = page.getByRole('menu'); await expect(statusMenu).toBeVisible();
  await dialog.locator('.task-detail-panel-steps').evaluate(element => { element.scrollTop += 30; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));
  const statusBox = await statusMenu.boundingBox(); expect(statusBox).not.toBeNull();
  expect(statusBox!.x).toBeGreaterThanOrEqual(0); expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(320);
  expect(statusBox!.y).toBeGreaterThanOrEqual(0); expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape'); await expect(status).toBeFocused();
  const more = row.locator('.step-more'); await more.scrollIntoViewIfNeeded(); await more.focus(); await page.keyboard.press('Enter');
  const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  const box = await menu.boundingBox(); expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape'); await expect(more).toBeFocused();
  expect(writes).toEqual([]);
});

test('a confirmed move follows the Step to its new page and restores focus and expansion', async ({ page }) => {
  const writes = await install(page, false, false, true);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  const row = dialog.locator('.step-row[data-step-id="00000001"]');
  const disclosure = row.locator('.step-disclosure');
  await disclosure.click(); await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const more = row.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
  await more.click(); await page.getByRole('menuitem', { name: 'Move to end', exact: true }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('2');
  await expect(row.locator('.step-disclosure')).toHaveAttribute('aria-expanded', 'true');
  await expect(row.locator('.step-more')).toBeFocused();
  expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/steps/${step.id}/position`]);
});

test('a confirmed relative insertion follows the new Step to the next page and focuses it', async ({ page }) => {
  const writes = await install(page, false, false, true);
  const dialog = await openDialog(page);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  const anchor = dialog.locator('.step-row[data-step-id="00000064"]');
  const more = anchor.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
  await more.click(); await page.getByRole('menuitem', { name: 'Add after', exact: true }).click();
  const form = dialog.locator('.step-add-form');
  await form.getByRole('textbox', { name: 'Title' }).fill('Inserted after anchor');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('2');
  const added = dialog.locator('.step-row').filter({ hasText: 'Inserted after anchor' });
  await expect(added).toBeVisible(); await expect(added.locator('.step-disclosure')).toBeFocused();
  expect(writes).toEqual([`POST /api/v1/projects/${projectId}/tasks/${taskId}/steps`]);
});

for (const presentation of ['dialog', 'fullscreen'] as const) test(`native Step menu Escape preserves its draft in ${presentation}`, async ({ page }) => {
  const writes = await install(page);
  const dialog = await openDialog(page);
  if (presentation === 'fullscreen') await dialog.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
  const form = dialog.locator('.step-add-form');
  const title = form.getByRole('textbox', { name: 'Title' });
  await title.fill('Retained draft');
  const status = form.getByRole('combobox', { name: 'Initial status' });
  const placement = form.getByRole('combobox', { name: 'Placement' });
  for (const select of [status, placement]) {
    expect(await select.evaluate(node => node.getBoundingClientRect().height)).toBe(38);
    await select.click();
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
    await expect(dialog).toBeVisible(); await expect(form).toBeVisible();
    await expect(title).toHaveValue('Retained draft'); await expect(select).toBeFocused();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    if (presentation === 'fullscreen') await expect(dialog).toHaveClass(/task-detail-fullscreen/);
  }
  await page.keyboard.press('Escape');
  const discard = page.getByRole('alertdialog'); await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(title).toHaveValue('Retained draft');
  expect(writes).toEqual([]);
});

test('native platform menu Escape precedes closing Task details', async ({ page }) => {
  const writes = await install(page);
  const dialog = await openDialog(page);
  const platform = dialog.getByRole('combobox', { name: 'Execution platform' });
  await platform.click();
  await expect.poll(() => platform.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => platform.evaluate(node => node.matches(':open'))).toBe(false);
  await expect(dialog).toBeVisible(); await expect(platform).toHaveValue(''); await expect(platform).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(page.locator(`#standalone-task-${taskId}`)).toBeFocused();
  expect(writes).toEqual([]);
});

test('a late move receipt does not steal focus or change the page of a new draft', async ({ page }) => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const writes = await install(page, false, false, true, false, false, { started: entered.resolve, wait: gate.promise });
  try {
    const dialog = await openDialog(page); await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
    const row = dialog.locator('.step-row[data-step-id="00000001"]');
    const more = row.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
    await more.click(); await page.getByRole('menuitem', { name: 'Move to end', exact: true }).click();
    await entered.promise;
    await dialog.getByRole('button', { name: 'Add step', exact: true }).click();
    const pageNumber = dialog.getByRole('spinbutton', { name: 'Page' });
    await expect(pageNumber).toHaveValue('2'); await expect(row).toHaveCount(0);
    await pageNumber.fill('1'); await pageNumber.press('Enter');
    await expect(pageNumber).toHaveValue('1'); await expect(row).toBeVisible();
    const form = dialog.locator('.step-add-form'), title = form.getByRole('textbox', { name: 'Title' });
    await title.fill('Draft during move'); await expect(title).toBeFocused();
    await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('1');
    gate.resolve(); await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await expect(title).toHaveValue('Draft during move'); await expect(title).toBeFocused();
    await expect(dialog.getByRole('spinbutton', { name: 'Page' })).toHaveValue('1');
    expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/steps/${step.id}/position`]);
  } finally { gate.resolve(); }
});

test('Back protects a dirty Step draft and a second Back may discard it', async ({ page }) => {
  const writes = await install(page, false, true, true);
  await page.goto(`/projects/${projectId}/tasks/${previousId}`);
  const root = page.locator('.task-detail-page');
  await root.getByRole('region', { name: 'Prerequisites', exact: true }).getByRole('button', { name: /Target task/ }).click();
  await root.getByRole('tab', { name: 'Steps', exact: true }).click();
  await root.getByRole('button', { name: 'Add step', exact: true }).click();
  const title = root.locator('.step-add-form').getByRole('textbox', { name: 'Title' }); await title.fill('Unsaved draft');
  const openMove = async () => {
    const pageNumber = root.getByRole('spinbutton', { name: 'Page' }); await pageNumber.fill('1'); await pageNumber.press('Enter');
    await root.locator('.step-row[data-step-id="00000001"] .step-more').click();
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Move step', exact: true })).toBeVisible();
  };
  await openMove();
  await page.evaluate(() => history.go(-2));
  const leave = page.getByRole('alertdialog'); await expect(leave).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Move step', exact: true })).toHaveCount(0);
  await expect(root).toHaveAttribute('inert', '');
  await expect(leave.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(leave.getByRole('button', { name: 'Discard and leave' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(leave.getByRole('button', { name: 'Keep editing' })).toBeFocused();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(root).not.toHaveAttribute('inert');
  await expect(title).toHaveValue('Unsaved draft'); await expect(title).toBeFocused();
  await openMove();
  await page.evaluate(() => history.go(-2)); await expect(leave).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Move step', exact: true })).toHaveCount(0);
  await leave.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${previousId}$`));
  await expect(root.locator('.task-detail-title')).toHaveText('History origin');
  expect(writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1440]) {
  test(`Step deletion confirms safely and restores focus at ${width}px in ${locale}`, async ({ page }) => {
    const writes = await install(page, false, false, true); await page.setViewportSize({ width, height: 800 });
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const root = page.locator('.task-detail-page');
    const pageNumber = root.getByRole('spinbutton', { name: locale === 'en' ? 'Page' : '页码' });
    await pageNumber.fill('2'); await pageNumber.press('Enter');
    const row = root.locator('.step-row[data-step-id="00000065"]'); await row.locator('.step-disclosure').click();
    await row.getByRole('button', { name: locale === 'en' ? 'Edit step' : '编辑步骤' }).click();
    const form = root.locator('.step-add-form'), title = form.getByRole('textbox', { name: locale === 'en' ? 'Title' : '标题', exact: true });
    await title.fill('Unpublished draft');
    await title.focus(); await page.keyboard.press('Tab'); await expect(form.locator(':focus')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const openDelete = async () => {
      const more = row.locator('.step-more'); await expect(more).toHaveAttribute('aria-disabled', 'false');
      await more.focus(); await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: locale === 'en' ? 'Delete step' : '删除步骤', exact: true }).click();
    };
    await openDelete(); const confirmation = page.getByRole('alertdialog');
    const cancel = confirmation.locator('.dialog-footer').getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true });
    await expect(cancel).toBeFocused(); await expect(confirmation).toContainText('00000065');
    await expect(confirmation).toContainText(locale === 'en' ? 'Attachments, pull requests and other references will remain' : '附件、拉取请求及其他引用会保留');
    await expect(confirmation).toContainText(locale === 'en' ? 'Unsaved changes' : '未保存修改');
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); await expect(confirmation.locator(':focus')).toHaveCount(1); }
    await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0); await expect(title).toHaveValue('Unpublished draft');
    await openDelete(); await page.getByRole('alertdialog').getByRole('button', { name: locale === 'en' ? 'Delete step' : '删除步骤', exact: true }).click();
    await expect(form).toHaveCount(0); await expect(root.locator('.steps-pagination')).toHaveCount(0);
    await expect(root.locator('.step-row[data-step-id="00000064"] .step-disclosure')).toBeFocused();
    expect(writes).toEqual([`DELETE /api/v1/projects/${projectId}/tasks/${taskId}/steps/00000065`]);
  });
}

test('touch can open and cancel the Step position target picker', async ({ browser, baseURL }) => {
  if (baseURL === undefined) throw new Error('The task controls fixture requires a base URL.');
  const context = await browser.newContext({ baseURL, locale: 'en-US', hasTouch: true, viewport: { width: 320, height: 640 } });
  try {
    const page = await context.newPage(); const writes = await install(page, false, false, true);
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
    const row = page.locator('.step-row[data-step-id="00000001"]');
    await expect(row.locator('.step-more')).toHaveAttribute('aria-disabled', 'false'); await row.locator('.step-more').tap();
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).tap();
    const picker = page.getByRole('dialog', { name: 'Move step', exact: true });
    await picker.getByRole('radio').first().tap(); await picker.getByRole('button', { name: 'Cancel', exact: true }).tap();
    await expect(picker).toHaveCount(0); expect(writes).toEqual([]);
  } finally { await context.close(); }
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390]) {
  test(`Task status and platform controls fit and keep focus at ${width}px in ${locale}`, async ({ page }) => {
    const writes = await install(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    const dialog = page.locator('.task-detail-dialog');
    const status = dialog.locator('.task-status-trigger');
    const platform = dialog.getByRole('combobox', { name: locale === 'en' ? 'Execution platform' : '执行平台' });
    await expect(status).toBeEnabled(); await expect(platform).toBeEnabled();
    expect(await platform.evaluate(node => getComputedStyle(node).height)).toBe('24px');
    await expect.poll(() => dialog.locator('.task-detail-status-row').evaluate(row => {
      const bounds = row.getBoundingClientRect();
      const boxes = Array.from(row.querySelectorAll('.task-status-trigger, .task-assignee-field, .native-select[data-density="compact"], .task-detail-ready, .task-detail-blocked, .task-detail-execution-mode, .task-automation-control')).map(element => element.getBoundingClientRect());
      return row.scrollWidth <= row.clientWidth && document.documentElement.scrollWidth <= innerWidth && boxes.every((box, index) => box.width > 0 && box.height > 0 && box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5 && boxes.slice(index + 1).every(other => box.right <= other.left + 0.5 || other.right <= box.left + 0.5 || box.bottom <= other.top + 0.5 || other.bottom <= box.top + 0.5));
    })).toBe(true);
    await status.focus(); await page.keyboard.press('Enter');
    const options = dialog.getByRole('menuitemradio'); await expect(options).toHaveCount(5);
    await page.keyboard.press('End'); await expect(options.last()).toBeFocused();
    await page.keyboard.press('Home'); await expect(options.first()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(status).toBeFocused();
    await status.click(); await options.last().click();
    const statusConfirmation = page.getByRole('alertdialog', { name: locale === 'en' ? 'Set task status' : '设置任务状态' });
    await expect(statusConfirmation).toBeVisible(); await page.keyboard.press('Escape');
    await expect(statusConfirmation).toHaveCount(0); await expect(status).toBeFocused();
    await platform.focus(); await expect(platform).toBeFocused();
    if (await page.evaluate(() => navigator.platform.startsWith('Mac'))) {
      const session = await page.context().newCDPSession(page);
      try { await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', text: 'w', unmodifiedText: 'w' }); await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' }); }
      finally { await session.detach(); }
    } else await page.keyboard.press('ArrowDown');
    const platformConfirmation = page.getByRole('alertdialog', { name: locale === 'en' ? 'Change execution platform?' : '修改执行平台？' });
    await expect(platformConfirmation).toBeVisible(); await expect(platform).toHaveValue('');
    await page.keyboard.press('Escape'); await expect(platformConfirmation).toHaveCount(0); await expect(platform).toBeFocused();
    expect(writes).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 375, 390]) {
  test(`platform labels and status row fit at ${width}px in ${locale}`, async ({ page }) => {
    let update!: (changes: Partial<TaskDetail>) => void;
    await install(page, false, false, false, false, false, undefined, {}, { exposeUpdate: value => { update = value; } });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
    for (const [index, requiredPlatform] of ([null, 'windows', 'linux', 'macos'] as const).entries()) {
      update({ requiredPlatform, version: BigInt(index + 6), updatedAt: `2026-10-23T10:00:0${index}Z` });
      await page.reload();
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      await page.locator('#project-section-tab-tasks').click();
      await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
      await page.locator(`#standalone-task-${taskId}`).click();
      const dialog = page.locator('.task-detail-dialog');
      const platform = dialog.getByRole('combobox', { name: locale === 'en' ? 'Execution platform' : '执行平台' });
      await expect(platform).toHaveValue(requiredPlatform ?? '');
      const geometry = await dialog.locator('.task-detail-status-row').evaluate(row => {
        const nodes = [...row.querySelectorAll('.task-status-trigger, .task-assignee-field, .native-select[data-density="compact"], .task-detail-ready, .task-detail-blocked, .task-detail-execution-mode, .task-automation-control')];
        const centers = nodes.map(node => { const r = node.getBoundingClientRect(); return (r.top + r.bottom) / 2; }).sort((a, b) => a - b);
        const lines: number[] = [];
        for (const center of centers) if (!lines.some(line => Math.abs(center - line) < 10)) lines.push(center);
        const select = row.querySelector<HTMLSelectElement>('.native-select select')!;
        const style = getComputedStyle(select), canvas = document.createElement('canvas'), context = canvas.getContext('2d')!;
        context.font = style.font;
        return { lines: lines.length, available: select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), text: context.measureText(select.selectedOptions[0]!.textContent ?? '').width };
      });
      expect(geometry.lines).toBeLessThanOrEqual(locale === 'en' && width === 320 ? 3 : 2);
      expect(geometry.available + 1).toBeGreaterThanOrEqual(geometry.text);
      await dialog.getByRole('button', { name: locale === 'en' ? 'Close task details' : '关闭任务详情' }).click();
    }
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390]) {
  test(`assignment and pause remain usable at ${width}px in ${locale}`, async ({ page }) => {
    const writes = await install(page, false, false, false, true, true);
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    const standaloneTab = page.locator('#project-task-tab-standalone');
    const chainTab = page.locator('#project-task-tab-chains');
    const goalTab = page.locator('#project-task-tab-goals');
    await expect(standaloneTab.locator('.graph-count-pill')).toHaveText('2');
    await expect(chainTab.locator('.graph-count-pill')).toHaveText('0');
    await expect(goalTab.locator('.graph-count-pill')).toHaveText('0');
    await expect(standaloneTab.locator('.graph-count-pill')).toHaveAttribute('title', locale === 'en' ? 'Unfinished task count' : '未完成任务数');
    await expect(chainTab.locator('.graph-count-pill')).toHaveAttribute('title', locale === 'en' ? 'Unfinished task chain count' : '未完成任务链数');
    const filter = page.locator('.task-assignee-filter .assignee-trigger');
    const status = page.getByRole('combobox', { name: locale === 'en' ? 'Status' : '状态', exact: true });
    await expect.poll(() => status.evaluate(select => {
      const owner = document.querySelector('.task-assignee-filter')!.getBoundingClientRect(); const box = select.getBoundingClientRect();
      return (owner.right <= box.left + 1 || box.right <= owner.left + 1 || owner.bottom <= box.top + 1 || box.bottom <= owner.top + 1) && owner.left >= 0 && box.left >= 0 && owner.right <= innerWidth && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    await filter.click();
    const picker = page.locator('.assignee-menu'); await expect(picker.getByRole('listbox')).toBeVisible();
    await picker.getByRole('option', { name: locale === 'en' ? 'Assigned to me' : '分配给我', exact: true }).click();
    await expect(standaloneTab.locator('.graph-count-pill')).toHaveText('1');
    await expect(chainTab.locator('.graph-count-pill')).toHaveText('0');
    await expect(goalTab.locator('.graph-count-pill')).toHaveText('0');
    expect(await page.locator('.project-task-tabs').evaluate(tabs => [...tabs.querySelectorAll('.graph-count-pill')].every(pill => {
      const box = pill.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.width > 0;
    }))).toBe(true);
    await standaloneTab.focus(); await page.keyboard.press('ArrowRight');
    await expect(chainTab).toBeFocused(); await expect(chainTab).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowLeft'); await expect(standaloneTab).toBeFocused();
    const row = page.locator(`#standalone-task-${taskId}`);
    await expect(row).toBeVisible(); await expect(page.locator(`#standalone-task-${previousId}`)).toHaveCount(0);
    const identity = row.locator('.task-assignee-identity');
    await expect(identity).toHaveAccessibleName(`${locale === 'en' ? 'Assignee: ' : '负责人：'}${longName}`);
    await expect(identity.locator('.assignee-avatar img')).toHaveCount(0); await expect(identity.locator('.assignee-avatar')).toHaveText('A');
    expect(await identity.locator('.assignee-name').evaluate(name => getComputedStyle(name).textOverflow === 'ellipsis' && name.scrollWidth > name.clientWidth)).toBe(true);
    await row.click(); const dialog = page.locator('.task-detail-dialog');
    const strip = dialog.locator('.task-pause-strip'); await expect(strip.locator('.task-pause-unpause')).toBeVisible();
    expect(await strip.evaluate(element => {
      const box = element.getBoundingClientRect(), label = element.querySelector('.task-pause-label')!.getBoundingClientRect(), button = element.querySelector('button')!.getBoundingClientRect();
      return element.scrollWidth <= element.clientWidth && label.right <= button.left && button.right <= box.right && box.left >= 0 && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    const trigger = dialog.getByRole('button', { name: new RegExp(`^(Assignee: |负责人：)${longName}`) }); await trigger.click();
    const menu = dialog.locator('.assignee-menu'); await expect(menu.getByRole('listbox')).toBeVisible();
    await expect(menu.getByRole('textbox')).toBeFocused(); await expect(menu.getByRole('option', { name: longName })).toBeVisible();
    await expect.poll(() => menu.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 11.5 && box.top >= 11.5 && box.right <= innerWidth - 11.5 && box.bottom <= innerHeight - 11.5 && box.width <= 306.5 && box.height <= 370.5; })).toBe(true);
    await dialog.locator('.task-detail-panel-overview').evaluate(panel => { panel.scrollTop = panel.scrollHeight; });
    await expect.poll(() => menu.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 11.5 && box.top >= 11.5 && box.right <= innerWidth - 11.5 && box.bottom <= innerHeight - 11.5; })).toBe(true);
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(writes).toEqual([]);
  });
}

test('locked automatic execution explains its state on focus and Escape dismisses it', async ({ page }) => {
  const writes = await install(page, true);
  const dialog = await openDialog(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const control = dialog.getByRole('switch', { name: 'Automatic execution' });
  await expect(control).toBeDisabled(); await expect(control).not.toBeChecked();
  const group = dialog.getByRole('group', { name: 'Automatic execution', exact: true });
  await group.focus(); await expect(group.getByRole('tooltip')).toBeVisible();
  await expect(control).toHaveAccessibleDescription(/in progress/i);
  await page.keyboard.press('Escape'); await expect(group.locator('.task-control-tip-bubble')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const platform = dialog.getByRole('combobox', { name: 'Execution platform' });
  await expect(platform).toBeDisabled();
  const platformGroup = dialog.getByRole('group', { name: 'Execution platform', exact: true });
  await platformGroup.focus(); await expect(platformGroup.getByRole('tooltip')).toBeVisible();
  await expect(platform).toHaveAccessibleDescription(/in progress/i);
  await page.keyboard.press('Escape'); await expect(platformGroup.locator('.task-control-tip-bubble')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});

test('cancelled tasks retain readable details and Steps without a status restoration control on narrow screens', async ({ page }) => {
  const writes = await install(page, false, false, false, false, false, undefined, { status: 'cancelled', cancelledAt: time, ready: false, description: 'Readable cancelled materials' });
  await page.setViewportSize({ width: 320, height: 844 });
  const observedTask = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tasks/${taskId}`);
  const synchronized = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  const dialog = await openDialog(page);
  expect((await observedTask).headers()['daynight-task-epoch']).toBe((await (await synchronized).json()).epoch);
  await expect(dialog.locator('.task-status-trigger')).toHaveText('Cancelled');
  await expect(dialog.locator('.task-status-trigger')).toBeDisabled();
  await expect(dialog.getByText('Readable cancelled materials')).toBeVisible();
  await expect(dialog.getByRole('complementary', { name: 'Task relationships and metadata' }).getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('tab', { name: 'Steps', exact: true }).click();
  await expect(dialog.getByText('Review', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(writes).toEqual([]);
});


for (const locale of ['en', 'zh-CN'] as const) {
  test(`cancellation keeps readable materials and dependency membership at 320px in ${locale}`, async ({ page }) => {
    let preserved: { before: TaskDetail; after: TaskDetail } | undefined;
    const writes = await install(page, false, true, false, false, false, undefined, { description: 'Cancellation leaves this description readable', allowAgents: true }, { observe: (before, after) => { preserved = { before, after }; } });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.locator(`#task-root-${taskId}`).click();
    await page.getByRole('button', { name: /Target task.*View Goal details|Target task.*查看 Goal 详情/ }).click();
    const dialog = page.locator('.task-detail-dialog');
    const status = dialog.locator('.task-status-trigger');
    await status.click(); await dialog.getByRole('menuitemradio', { name: locale === 'en' ? 'Cancelled' : '已取消', exact: true }).click();
    let confirmation = page.getByRole('alertdialog');
    await expect(confirmation).toContainText(locale === 'en' ? 'cannot be undone' : '不可恢复');
    await expect(confirmation).toContainText(locale === 'en' ? 'records and materials remain readable' : '资料仍可阅读');
    await page.keyboard.press('Escape'); await expect(confirmation).toHaveCount(0); expect(writes).toEqual([]);
    await expect(status).toBeFocused();
    await status.click(); await dialog.getByRole('menuitemradio', { name: locale === 'en' ? 'Cancelled' : '已取消', exact: true }).click();
    confirmation = page.getByRole('alertdialog'); await confirmation.getByRole('button', { name: locale === 'en' ? 'Confirm cancellation' : '确认取消', exact: true }).click();
    await expect(status).toHaveText(locale === 'en' ? 'Cancelled' : '已取消'); await expect(status).toBeDisabled();
    await expect(dialog.getByText('Cancellation leaves this description readable')).toBeVisible();
    await dialog.getByRole('tab', { name: locale === 'en' ? 'Steps' : '步骤', exact: true }).click(); await expect(dialog.getByText('Review', { exact: true })).toBeVisible();
    expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/status`]); expect(preserved).toBeDefined();
    expect(preserved!.after.allowAgents).toBe(preserved!.before.allowAgents); expect(preserved!.after.assignedTo).toBe(preserved!.before.assignedTo);
    expect(preserved!.after.startedAt).toBe(preserved!.before.startedAt); expect(preserved!.after.completedAt).toBe(preserved!.before.completedAt);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Close task details' : '关闭任务详情', exact: true }).click();
    await page.getByRole('combobox', { name: locale === 'en' ? 'Status' : '状态', exact: true }).selectOption('cancelled');
    await expect(page.locator(`[data-chain-id="${taskId}"] .root-progress-label`)).toContainText(locale === 'en' ? '0/1 completed' : '0/1 已完成');
    await expect(page.locator(`#chain-task-${taskId}-${previousId}`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const outcome of ['lost', 'malformed'] as const) {
  test(`cancellation ${outcome} response is reconciled by reading without replay`, async ({ page }) => {
    const writes = await install(page, false, false, false, false, false, undefined, { description: 'Readable after reconciliation' }, { outcome });
    const dialog = await openDialog(page); const status = dialog.locator('.task-status-trigger');
    await status.click(); await dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(status).toHaveText('Cancelled'); await expect(status).toBeDisabled();
    await expect(dialog.getByText('Readable after reconciliation')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Execution platform' })).toBeEnabled();
    expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/status`]);
  });
}

test('cancellation conflict requires a newly reviewed version and does not replay its request', async ({ page }) => {
  const writes = await install(page, false, false, false, false, false, undefined, {}, { outcome: 'conflict' });
  const dialog = await openDialog(page); const status = dialog.locator('.task-status-trigger');
  await status.click(); await dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(status).toHaveText('To do'); await expect(status).toBeEnabled(); expect(writes).toHaveLength(1);
  await status.click(); await dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(status).toHaveText('Cancelled'); expect(writes).toHaveLength(2);
});

test('active cancellation requires a fresh record without a claim before submission', async ({ page }) => {
  const claim = { claimId: previousId, state: 'active', userId: TEST_VIEWER_ID, workerId: projectId, machine: { id: projectId, name: 'Worker machine' }, platform: 'linux', agent: 'codex', agentControlMode: 'web', worktreeId: taskId, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time };
  let update!: (changes: Partial<TaskDetail>) => void;
  const writes = await install(page, true, false, false, false, false, undefined, { properties: { worker: claim }, allowAgents: true }, { exposeUpdate: value => { update = value; } });
  let dialog = await openDialog(page); await dialog.locator('.task-status-trigger').click();
  const cancelled = dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }); await expect(cancelled).toHaveAttribute('aria-disabled', 'true');
  await cancelled.focus(); await expect(dialog.locator('.task-control-tip-bubble')).toContainText('Release the active Worker execution');
  await page.keyboard.press('Enter'); expect(writes).toEqual([]); await page.keyboard.press('Escape'); await expect(dialog.getByRole('menu')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close task details', exact: true }).click();
  update({ status: 'todo', version: 6n, ready: true, allowAgents: false, startedAt: null, completedAt: null, properties: {} });
  dialog = await openDialog(page); await expect(dialog.locator('.task-status-trigger')).toHaveText('To do'); await expect(dialog.locator('.task-status-trigger')).toBeEnabled();
  await dialog.locator('.task-status-trigger').click(); await dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(dialog.locator('.task-status-trigger')).toHaveText('Cancelled'); expect(writes).toHaveLength(1);
});

test('pending cancellation survives closing and reopening details without a second submission', async ({ page }) => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const writes = await install(page, false, false, false, false, false, undefined, {}, { gate: { started: entered.resolve, wait: gate.promise } });
  try {
    let dialog = await openDialog(page); await dialog.locator('.task-status-trigger').click(); await dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click(); await entered.promise;
    await dialog.getByRole('button', { name: 'Close task details', exact: true }).click();
    await page.locator(`#standalone-task-${taskId}`).click(); dialog = page.locator('.task-detail-dialog');
    await expect(dialog.locator('.task-status-trigger')).toBeDisabled(); expect(writes).toHaveLength(1);
    gate.resolve(); await expect(dialog.locator('.task-status-trigger')).toHaveText('Cancelled');
    await expect(dialog.getByRole('combobox', { name: 'Execution platform' })).toBeEnabled(); expect(writes).toHaveLength(1);
  } finally { gate.resolve(); }
});

for (const state of ['in_progress', 'done'] as const) {
  test(`manual ${state} cancellation preserves the original execution interval`, async ({ page }) => {
    let original: TaskDetail | undefined, saved: TaskDetail | undefined;
    const writes = await install(page, false, false, false, false, false, undefined, { status: state, ready: false, startedAt: '2026-10-22T10:00:00Z', completedAt: state === 'done' ? '2026-10-22T10:00:00Z' : null }, { observe: (before, after) => { original = before; saved = after; } });
    const dialog = await openDialog(page); await dialog.locator('.task-status-trigger').click();
    await dialog.getByRole('menuitemradio', { name: 'Cancelled', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm cancellation' }).click();
    await expect(dialog.locator('.task-status-trigger')).toHaveText('Cancelled'); await expect(dialog.locator('.task-status-trigger')).toBeDisabled();
    expect(saved).toBeDefined(); expect(saved!.startedAt).toBe(original!.startedAt); expect(saved!.completedAt).toBe(original!.completedAt);
    expect(writes).toEqual([`PUT /api/v1/projects/${projectId}/tasks/${taskId}/status`]);
  });
}

test('linked PRs remain readable in the overview sidebar across detail presentations', async ({ page }) => {
  test.setTimeout(60_000);
  const url = `https://example.com/${'long-path'.repeat(25)}`;
  const pullRequests = Array.from({ length: 101 }, (_, index) => ({ title: `PR ${index + 1} ${'long-title'.repeat(15)}`, url }));
  let update!: (changes: Partial<TaskDetail>) => void;
  await install(page, false, false, false, false, false, undefined, { description: 'Task description', properties: { pullRequests } }, { exposeUpdate: value => { update = value; } });
  const dialog = await openDialog(page);
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const aside = dialog.getByRole('complementary', { name: 'Task relationships and metadata' });
    const prs = aside.getByRole('region', { name: 'Linked PRs' });
    const prerequisites = aside.getByRole('region', { name: 'Prerequisites', exact: true });
    await expect(prs.getByRole('heading')).toHaveText('Linked PRs · 101');
    await expect(dialog.locator('.task-detail-main').getByRole('region', { name: 'Linked PRs' })).toHaveCount(0);
    expect(await prs.evaluate((element, other) => Boolean(element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), await prerequisites.elementHandle())).toBe(true);
    expect(await prs.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const mainBox = await dialog.locator('.task-detail-main').boundingBox();
    const asideBox = await aside.boundingBox();
    expect(mainBox && asideBox).not.toBeNull();
    if (width <= 600) expect(asideBox!.y).toBeGreaterThan(mainBox!.y);
    else expect(asideBox!.x).toBeGreaterThan(mainBox!.x);
  }
  const prs = dialog.getByRole('region', { name: 'Linked PRs' });
  const link = prs.getByRole('link').first();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await link.focus(); await expect(link).toBeFocused();
  const next = prs.getByRole('button', { name: 'Next page' });
  await next.focus(); await page.keyboard.press('Enter');
  await expect(prs).toContainText('Items 101–101 of 101');
  await expect(prs).toContainText('PR 101');
  await dialog.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'Linked PRs' })).toContainText('PR 101');
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  const direct = page.locator('.task-detail-page');
  await expect(direct.getByRole('complementary', { name: 'Task relationships and metadata' }).getByRole('region', { name: 'Linked PRs' })).toBeVisible();
  await direct.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  const directPrs = direct.getByRole('region', { name: 'Linked PRs' });
  await expect(directPrs).toBeVisible();
  await directPrs.getByRole('button', { name: 'Next page' }).click();
  const pageSelect = directPrs.getByRole('combobox', { name: 'Linked PR page' });
  expect(await pageSelect.evaluate(node => getComputedStyle(node).height)).toBe('24px');
  await pageSelect.focus();
  update({ description: 'Refreshed task description', version: 6n });
  await page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tasks/${taskId}`, { timeout: 20_000 });
  await expect(direct.getByText('Refreshed task description')).toBeVisible();
  await expect(pageSelect).toHaveValue('1');
  await expect(pageSelect).toBeFocused();
  await pageSelect.click();
  await expect.poll(() => pageSelect.evaluate(node => node.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => pageSelect.evaluate(node => node.matches(':open'))).toBe(false);
  await expect(direct).toHaveClass(/task-detail-fullscreen/); await expect(pageSelect).toHaveValue('1');
  await expect(pageSelect).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(direct).not.toHaveClass(/task-detail-fullscreen/);
  await expect(direct.getByRole('button', { name: 'Enter fullscreen', exact: true })).toBeFocused();
  await page.goto(`/projects/${projectId}/tasks/${previousId}`);
  await expect(page.getByRole('heading', { name: 'History origin' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Linked PRs' })).toContainText('No linked PRs');
});

test('linked PR empty state survives relation errors and language changes in direct detail', async ({ page }) => {
  await install(page, false, false, false, false, false, undefined, { properties: { pullRequests: [] } });
  await page.route(`**/api/v1/projects/${projectId}/task-sync**`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Relation service unavailable', requestId: 'relation-error' } }) }));
  await page.route(`**/api/v1/projects/${projectId}/task-graph**`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Relation service unavailable', requestId: 'relation-error' } }) }));
  await page.goto(`/projects/${projectId}/tasks/${taskId}`);
  const detail = page.locator('.task-detail-page');
  const aside = detail.getByRole('complementary', { name: 'Task relationships and metadata' });
  const prs = aside.getByRole('region', { name: 'Linked PRs' });
  const error = aside.getByRole('alert');
  const prerequisites = aside.getByRole('region', { name: 'Prerequisites', exact: true });
  await expect(error).toBeVisible();
  await expect(prs).toContainText('No linked PRs');
  expect(await error.evaluate((element, other) => Boolean(element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), await prs.elementHandle())).toBe(true);
  expect(await prs.evaluate((element, other) => Boolean(element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING), await prerequisites.elementHandle())).toBe(true);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await expect(detail.getByRole('region', { name: '关联 PR' })).toContainText('暂无关联 PR');
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`semantic detail and Step roles stay readable at ${width}px in ${locale}`, async ({ page }) => {
    const stepStates = ['todo', 'in_progress', 'done', 'skipped'] as const;
    const writes = await install(page, false, false, false, true, false, undefined, { status: 'proposed', ready: false }, {
      steps: stepStates.map((status, index) => ({ ...step, id: (index + 1).toString(16).padStart(8, '0'), title: `Review ${status}`, status })),
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.getByRole('tab', { name: locale === 'en' ? 'Standalone tasks' : '独立任务' }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog.locator('.task-status-trigger i')).toHaveCSS('background-color', roleColors.proposed[3]);
    await dialog.locator('.task-status-trigger').click();
    for (const status of ['proposed', 'todo', 'in_progress', 'done', 'cancelled'] as const) {
      const dot = page.locator(`.task-status-menu .task-detail-dot-${status}`);
      await expect(dot).toHaveCSS('background-color', roleColors[status][3]);
      await expectTextContrast(dot.locator('..'));
    }
    await page.getByRole('menuitemradio', { name: locale === 'en' ? 'Cancelled' : '已取消', exact: true }).click();
    const confirmation = page.locator('.task-confirmation');
    for (const status of ['proposed', 'cancelled'] as const) {
      const chip = confirmation.locator(`.task-detail-status-${status}`);
      await expect(chip).toHaveCSS('background-color', roleColors[status][0]);
      await expect(chip).toHaveCSS('color', roleColors[status][3]);
      await expectTextContrast(chip);
    }
    await page.keyboard.press('Escape');
    await dialog.getByRole('tab', { name: locale === 'en' ? 'Steps' : '步骤', exact: true }).click();
    for (const status of stepStates) {
      const chip = dialog.locator(`.step-status-${status}`);
      const role = status === 'skipped' ? 'cancelled' : status;
      await page.mouse.move(0, 0);
      await expect(chip).toHaveCSS('background-color', roleColors[role][0]);
      await expect(chip).toHaveCSS('color', roleColors[role][3]);
      await expectTextContrast(chip);
      await chip.hover();
      await expect(chip).toHaveCSS('background-color', roleColors[role][1]);
      await expectTextContrast(chip);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(writes).toEqual([]);
  });
}

for (const [width, locale] of [[320, 'zh'], [390, 'en']] as const) {
  test(`paused task popover supports keyboard, exact detail and history at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 480 });
    const title = 'Long paused task title '.repeat(10);
    const writes = await install(page, false, false, false, false, true, undefined, { title }, {
      previousChanges: { title: 'Second paused task', properties: { paused: true } },
    });
    if (locale === 'zh') await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    const badge = page.locator('#project-section-panel-tasks .project-section-heading .task-pause-count');
    await expect(badge).toContainText('2');
    await badge.focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('.project-paused-menu');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate(element => element.matches(':popover-open'))).toBe(true);
    const rect = await menu.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(7);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width - 7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const rows = menu.getByRole('menuitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('…');
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('End');
    await expect(rows.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(rows.first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(badge).toBeFocused();
    await badge.click();
    await rows.last().click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog).toHaveAccessibleName('Second paused task');
    await expect(menu).toHaveCount(0);
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(badge).toBeFocused();
    await page.goForward();
    await expect(dialog).toHaveAccessibleName('Second paused task');
    await page.goBack();
    await expect(badge).toBeFocused();
    expect(writes).toEqual([]);
  });
}

test('paused popover preserves focus on refresh and moves it as tasks disappear', async ({ page }) => {
  let updateTask!: (changes: Partial<TaskDetail>) => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  let deleteTask!: () => void;
  const writes = await install(page, false, false, false, false, true, undefined, { assignedTo: TEST_VIEWER_ID }, {
    previousChanges: { properties: { paused: true }, assignedTo: TEST_VIEWER_ID }, exposeUpdate: update => { updateTask = update; },
    exposePreviousUpdate: update => { updatePrevious = update; }, exposeDeleteTask: remove => { deleteTask = remove; },
  });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('button', { name: /^Assignee:/ }).click();
  await page.getByRole('option', { name: 'Assigned to me' }).click();
  const badge = page.locator('#project-section-panel-tasks .project-section-heading .task-pause-count');
  await badge.click();
  const menu = page.locator('.project-paused-menu');
  const rows = menu.getByRole('menuitem');
  await expect(rows.first()).toBeFocused();
  const refresh = async () => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
    await page.getByRole('button', { name: 'Refresh', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
    await response;
  };
  await refresh();
  await expect(menu).toBeVisible();
  await expect(rows.first()).toBeFocused();
  updateTask({ status: 'done', ready: false, completedAt: '2026-10-23T09:00:00Z', version: 6n, updatedAt: '2026-10-23T09:00:00Z' });
  await refresh();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('History origin');
  await expect(rows.first()).toBeFocused();
  updateTask({ status: 'todo', completedAt: null, version: 7n, updatedAt: '2026-10-24T09:00:00Z' });
  await refresh();
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(rows.first()).toBeFocused();
  deleteTask();
  await refresh();
  await expect(menu).toHaveCount(0);
  await expect(badge).toContainText('1');
  await badge.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('History origin');
  await expect(rows.first()).toBeFocused();
  updatePrevious({ assignedTo: null, version: 6n, updatedAt: '2026-10-25T09:00:00Z' });
  await refresh();
  await expect(menu).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  await expect(page.locator('#project-task-tab-chains')).toBeFocused();
  expect(writes).toEqual([]);
});

test('many paused tasks scroll within the native popover and close on outside click', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  const additionalTasks = Array.from({ length: 20 }, (_, index) => detailFixture(projectId,
    `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    { title: `Additional paused task ${index}`, properties: { paused: true } }));
  const writes = await install(page, false, false, false, false, true, undefined, {}, { additionalTasks });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const badge = page.locator('#project-section-panel-tasks .project-section-heading .task-pause-count');
  await expect(badge).toContainText('21');
  await badge.click();
  const menu = page.locator('.project-paused-menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(21);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  const scrollTop = await menu.evaluate(element => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  const otherPage = await page.context().newPage();
  await otherPage.bringToFront();
  await page.bringToFront();
  await otherPage.close();
  const refreshed = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).evaluate((element: HTMLButtonElement) => element.click());
  await refreshed;
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  expect(await menu.evaluate(element => element.scrollTop)).toBe(scrollTop);
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(7);
  expect(box!.x + box!.width).toBeLessThanOrEqual(313);
  expect(box!.height).toBeLessThanOrEqual(344);
  await page.mouse.click(2, 2);
  await expect(menu).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('closing a chain graph after a paused detail restores its own trigger', async ({ page }) => {
  await install(page, false, true, false, false, true);
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const badge = page.locator('#project-section-panel-tasks .project-section-heading .task-pause-count');
  await badge.click();
  await page.locator('.project-paused-menu').getByRole('menuitem').click();
  await expect(page.locator('.task-detail-dialog')).toHaveAccessibleName('Target task');
  await page.goBack();
  await expect(badge).toBeFocused();
  const graphTrigger = page.locator(`#task-chain-graph-${taskId}`);
  await graphTrigger.click();
  await expect(page.locator('.task-chain-dialog')).toBeVisible();
  await page.locator('.task-chain-close').click();
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await expect(graphTrigger).toBeFocused();
});

test('paused Goal child opens its own detail from the project badge', async ({ page }) => {
  const goalId = '30000000-0000-4000-8000-000000000001';
  const childId = '40000000-0000-4000-8000-000000000001';
  const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Parent Goal', properties: { paused: true } });
  const child = detailFixture(projectId, childId, { parentId: goalId, title: 'Goal child', properties: { paused: true } });
  const writes = await install(page, false, false, false, false, false, undefined, {}, { additionalTasks: [goal, child] });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const badge = page.locator('#project-section-panel-tasks .project-section-heading .task-pause-count');
  await expect(badge).toContainText('1');
  await badge.click();
  const rows = page.locator('.project-paused-menu').getByRole('menuitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Goal child');
  await rows.first().click();
  await expect(page.locator('.task-detail-dialog')).toHaveAccessibleName('Goal child');
  await page.goBack();
  await expect(badge).toBeFocused();
  expect(writes).toEqual([]);
});
