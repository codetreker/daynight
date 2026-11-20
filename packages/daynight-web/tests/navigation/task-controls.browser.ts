import { selectStatus, statusButton } from './status-filter';
import { expectTextContrast, roleColors } from './color-roles';
import type { TaskStep } from '../../src/api/task-steps';
import { expect, test, type Page, type Route } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { imageBrowserData } from '../helpers/sessionImageBrowser';
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
  readonly locale?: 'en' | 'zh-CN';
  readonly workerAlias?: string;
  readonly steps?: readonly TaskStep[];
  readonly outcome?: 'conflict' | 'lost' | 'malformed';
  readonly gate?: { readonly started: () => void; readonly wait: Promise<void> };
  readonly observe?: (before: TaskDetail, after: TaskDetail) => void;
  readonly exposeUpdate?: (update: (changes: Partial<TaskDetail>) => void) => void;
  readonly previousChanges?: Partial<TaskDetail>;
  readonly exposePreviousUpdate?: (update: (changes: Partial<TaskDetail>) => void) => void;
  readonly additionalTasks?: readonly TaskDetail[];
  readonly snapshotTasks?: (details: readonly TaskDetail[]) => readonly TaskDetail[];
  readonly exposeDeleteTask?: (remove: () => void) => void;
  readonly dualPauseReceipt?: boolean;
};

async function install(page: Page, running = false, linked = false, large = false, rich = false, paused = false, moveGate?: { started: () => void; wait: Promise<void> }, changes: Partial<TaskDetail> = {}, options: FixtureOptions = {}) {
  let epoch = taskSyncEpoch(projectId);
  let taskRemoved = false;
  let task = detailFixture(projectId, taskId, { title: 'Target task', version: 5n, ...(running ? { status: 'in_progress' as const, ready: false, startedAt: time } : {}), ...(rich ? { assignedTo: TEST_VIEWER_ID } : {}), ...(paused ? { properties: { pullRequests: [], paused: true } } : {}), ...changes });
  let previous = detailFixture(projectId, previousId, { title: 'History origin', ...(linked ? { dependsOn: [taskId], blockedBy: [taskId], ready: false } : {}), version: 5n, ...options.previousChanges });
  const details = () => [...(taskRemoved ? [] : [task]), previous, ...(options.additionalTasks ?? [])];
  const graph = () => ({ ...graphFixture(options.snapshotTasks?.(details()) ?? details()), observedAt: task.updatedAt > previous.updatedAt ? task.updatedAt : previous.updatedAt });
  let statusRequests = 0;
  options.exposeUpdate?.((changes) => { task = { ...task, ...changes }; });
  options.exposePreviousUpdate?.((changes) => { previous = { ...previous, ...changes }; });
  options.exposeDeleteTask?.(() => { taskRemoved = true; epoch = '00000000-0000-4000-8000-000000000901'; });
  let steps = options.steps ? [...options.steps] : large ? [step, ...Array.from({ length: 100 }, (_, index) => ({ ...step, id: (index + 2).toString(16).padStart(8, '0'), title: `Other ${index + 1}` }))] : [step];
  const writes: string[] = [];
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), options.locale ?? 'en');
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...headers } });
    if (options.workerAlias && path.endsWith('/alias')) return send({ workerId: path.split('/')[5], alias: { value: options.workerAlias, version: '1' } });
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
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}` && request.method() === 'PATCH' && options.dualPauseReceipt) {
      expect(request.postDataJSON()).toEqual({ version: Number(task.version), properties: { blocked: false } });
      task = { ...task, version: task.version + 1n, updatedAt: '2026-10-22T10:02:00Z', properties: { ...task.properties, paused: false, blocked: false } };
      return send(task);
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

test('task menu opens one native tab per Space press and preserves Enter and mouse activation', async ({ page, context }) => {
  await install(page);
  const dialog = await openDialog(page);
  const trigger = dialog.getByRole('button', { name: 'More task actions' });
  const link = dialog.getByRole('menuitem', { name: 'Open in new tab' });
  const opened: Page[] = [];
  context.on('page', tab => opened.push(tab));
  for (const action of ['Space', 'Space', 'Enter', 'click', 'middle', 'control'] as const) {
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(link).toBeFocused();
    const target = await link.getAttribute('href');
    const nextTab = context.waitForEvent('page');
    if (action === 'Space') {
      await page.keyboard.down('Space');
      await page.keyboard.down('Space');
      await page.keyboard.up('Space');
    } else if (action === 'Enter') await page.keyboard.press('Enter');
    else await link.click(action === 'middle' ? { button: 'middle' } : action === 'control' ? { modifiers: ['ControlOrMeta'] } : {});
    const tab = await nextTab;
    await expect(tab).toHaveURL(new URL(target!, page.url()).href);
    await expect(dialog.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(opened).toHaveLength(1);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.close();
    opened.length = 0;
  }
});

test('confirms the unblock action with a dual-key service receipt', async ({ page }) => {
  const writes = await install(page, true, false, false, false, true, undefined, {}, { dualPauseReceipt: true });
  const dialog = await openDialog(page);
  await expect(dialog.getByText('Blocked', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Unblock' }).click();
  await expect(dialog.getByText('The task is unblocked.')).toBeVisible();
  expect(writes).toEqual([`PATCH /api/v1/projects/${projectId}/tasks/${taskId}`]);
});

for (const width of [320, 1280]) for (const kind of ['detail', 'graph'] as const) {
  test(`keyboard-opened ${kind} covers the open status filter at ${width}px`, async ({ page }) => {
    const writes = await install(page, false, kind === 'graph');
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    if (kind === 'detail') await page.locator('#project-task-tab-standalone').click();
    const filter = statusButton(page);
    await filter.focus(); await page.keyboard.press('Enter');
    await expect(filter).toHaveAttribute('aria-expanded', 'true');
    const target = page.locator(kind === 'detail' ? `#standalone-task-${taskId}` : `#task-chain-graph-${taskId}`);
    for (let i = 0; i < 40 && !await target.evaluate(element => element === document.activeElement); i++) await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
    const panel = page.locator('.task-status-filter-panel');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    await page.keyboard.press('Enter');
    const modal = page.locator(kind === 'detail' ? '.task-detail-dialog' : '.task-chain-dialog');
    await expect(modal).toBeVisible();
    const covered = await page.evaluate(({ x, y, width: w, height, kind }) => {
      const top = document.elementFromPoint(x + w / 2, y + height / 2);
      return top !== null && top.closest(kind === 'detail' ? '.task-detail-backdrop' : '.task-chain-backdrop') !== null;
    }, { ...bounds!, kind });
    expect(covered).toBe(true);
    if (kind === 'detail') {
      const steps = modal.getByRole('tab', { name: 'Steps', exact: true });
      await steps.focus(); await page.keyboard.press('Enter'); await expect(steps).toHaveAttribute('aria-selected', 'true');
    } else {
      await expect(modal.locator('.task-chain-close')).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0); await expect(target).toBeFocused();
    await expect(filter).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(filter).toHaveAttribute('aria-expanded', 'false'); await expect(filter).toBeFocused();
    expect(writes).toEqual([]);
  });
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
    await expect(result.locator('.task-search-title')).toHaveCSS('font-size', '14px');
    await expect(result.locator('.root-status')).toHaveCSS('font-size', '14px');
    await expect(result.locator('.task-search-meta')).toHaveCSS('font-size', '12px');
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
    const filter = page.locator('.task-assignee-filter > button');
    const status = statusButton(page);
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
    const identity = row.locator('xpath=ancestor::li').locator('.task-assignee-identity');
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
    await page.getByRole('button', { name: /Target task.*View task details|Target task.*查看任务详情/ }).click();
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
    await selectStatus(page, 'cancelled', locale);
    await expect(page.locator(`[data-chain-id="${taskId}"] .root-progress-label`)).toContainText(locale === 'en' ? '0/1 completed' : '0/1 已完成');
    await expect(page.locator(`#chain-task-${taskId}-${previousId}`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`ordinary chain representative details retain focus and completion at 320px in ${locale}`, async ({ page }) => {
    const writes = await install(page, false, true, false, false, false, undefined, { status: 'done', completedAt: time, ready: false });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    const disclosure = page.locator(`#task-root-${taskId}`);
    await disclosure.click();
    const name = locale === 'en' ? 'Target task, View task details' : 'Target task，查看任务详情';
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toContainText(locale === 'en' ? 'View task details' : '查看任务详情');
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    const completion = button.locator('time');
    await expect(completion).toHaveAttribute('datetime', time);
    await button.focus();
    await expect(page.getByRole('tooltip')).toBeVisible();
    expect(await button.evaluate(element => {
      const time = element.querySelector('time')!;
      const range = document.createRange(); range.selectNodeContents(element.firstChild!);
      const label = time.getBoundingClientRect();
      return [...range.getClientRects()].every(text => text.right <= label.left || label.right <= text.left || text.bottom <= label.top || label.bottom <= text.top) && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
    if (locale === 'en') await page.keyboard.press('Enter'); else await button.click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog).toHaveAccessibleName('Target task');
    await expect(dialog).toContainText(taskId);
    await dialog.getByRole('button', { name: locale === 'en' ? 'Close task details' : '关闭任务详情', exact: true }).click();
    await expect(button).toBeFocused();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator(`#chain-task-${taskId}-${previousId}`)).toBeVisible();
    expect(writes).toEqual([]);
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

test('overview paused selection preserves the task list assignee, category and page', async ({ page }) => {
  const additionalTasks = Array.from({ length: 21 }, (_, index) => detailFixture(projectId,
    `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, { title: `Assigned task ${index}`, assignedTo: TEST_VIEWER_ID }));
  const writes = await install(page, false, false, false, false, true, undefined, { assignedTo: TEST_VIEWER_ID }, {
    previousChanges: { title: 'Unassigned blocked target', properties: { paused: true } }, additionalTasks,
  });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const assignee = page.getByRole('button', { name: /^Assignee:/ });
  await assignee.click();
  await page.getByRole('option', { name: 'Assigned to me' }).click();
  const pagination = page.getByRole('navigation', { name: 'Standalone task list pagination' });
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pagination).toContainText('Page 2 of 2');
  const visibleIds = await page.locator('.task-row-item .task-row-title').evaluateAll(rows => rows.map(row => row.getAttribute('href')));
  expect(visibleIds.length).toBeGreaterThan(0);
  await expect(page.locator('#project-section-panel-tasks .project-section-heading .task-pause-count')).toContainText('1');
  await page.locator('#project-section-tab-overview').click();
  const badge = page.locator('#project-section-panel-overview .project-section-heading .task-pause-count');
  await expect(badge).toContainText('2');
  await badge.click();
  await page.locator('.project-paused-menu').getByRole('menuitem').last().click();
  await expect(page.locator('.task-detail-dialog')).toHaveAccessibleName('Unassigned blocked target');
  await page.locator('.task-detail-close').click();
  await expect(badge).toBeFocused();
  await page.locator('#project-section-tab-tasks').click();
  await expect(assignee).toContainText('Assigned to me');
  await expect(page.locator('#project-task-tab-standalone')).toHaveAttribute('aria-selected', 'true');
  await expect(pagination).toContainText('Page 2 of 2');
  expect(await page.locator('.task-row-item .task-row-title').evaluateAll(rows => rows.map(row => row.getAttribute('href')))).toEqual(visibleIds);
  expect(writes).toEqual([]);
});

for (const [width, locale] of [[320, 'zh-CN'], [390, 'en']] as const) {
  test(`overview paused menu supports touch selection at ${width}px in ${locale}`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL!, viewport: { width, height: 480 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      const writes = await install(page, false, false, false, false, true, undefined, {}, {
        locale, previousChanges: { title: 'Second touch target', properties: { paused: true } },
      });
      await page.goto(`/projects/${projectId}`);
      const badge = page.locator('#project-section-panel-overview .project-section-heading .task-pause-count');
      await badge.tap();
      const menu = page.locator('.project-paused-menu');
      await expect(menu.getByRole('menuitem')).toHaveCount(2);
      await menu.getByRole('menuitem').last().tap();
      await expect(page.locator('.task-detail-dialog')).toHaveAccessibleName('Second touch target');
      await page.locator('.task-detail-close').tap();
      await expect(badge).toBeFocused();
      await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
      expect(writes).toEqual([]);
    } finally { await context.close(); }
  });
}

for (const section of ['overview', 'tasks'] as const) test(`${section} paused detail restores its source tab after the last badge item disappears`, async ({ page }) => {
  let updateTask!: (changes: Partial<TaskDetail>) => void;
  const writes = await install(page, false, false, false, false, true, undefined, {}, { exposeUpdate: update => { updateTask = update; } });
  await page.goto(`/projects/${projectId}`);
  await page.locator(`#project-section-tab-${section}`).click();
  const badge = page.locator(`#project-section-panel-${section} .project-section-heading .task-pause-count`);
  await badge.click();
  await page.locator('.project-paused-menu').getByRole('menuitem').click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog).toHaveAccessibleName('Target task');
  updateTask({ properties: { paused: false }, version: 6n, updatedAt: '2026-10-23T09:00:00Z' });
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.locator('[data-project-action="refresh"]').evaluate((element: HTMLButtonElement) => element.click());
  await refreshed;
  await expect(badge).toHaveCount(0);
  await dialog.locator('.task-detail-close').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(section === 'overview' ? '#project-section-tab-overview' : '#project-task-tab-chains')).toBeFocused();
  expect(writes).toEqual([]);
});

test('overview paused menu retains admitted tasks on refresh failure and withdraws them on denied access', async ({ page }) => {
  const writes = await install(page, false, false, false, false, true);
  let failure: number | null = null;
  await page.route(`**/api/v1/projects/${projectId}/access`, route => failure === 404 ? route.fulfill({ status: 404,
    headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID },
    body: JSON.stringify({ error: { code: 'not_found', message: 'Project access withdrawn', requestId: 'access-withdrawn' } }),
  }) : route.fallback());
  await page.route(`**/api/v1/projects/${projectId}/task-sync**`, route => failure === null ? route.fallback() : route.fulfill({ status: failure,
    headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID },
    body: JSON.stringify({ error: { code: failure === 404 ? 'not_found' : 'unavailable', message: 'Project snapshot unavailable', requestId: `snapshot-${failure}` } }),
  }));
  await page.goto(`/projects/${projectId}`);
  const badge = page.locator('#project-section-panel-overview .project-section-heading .task-pause-count');
  await badge.click();
  const menu = page.locator('.project-paused-menu');
  await expect(menu.getByRole('menuitem')).toBeFocused();
  const refresh = async (status: number) => {
    failure = status;
    const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && result.status() === status);
    await page.locator('[data-project-action="refresh"]').evaluate((element: HTMLButtonElement) => element.click());
    await response;
  };
  await refresh(503);
  await expect(menu.getByRole('menuitem')).toBeFocused();
  await expect(menu.getByRole('menuitem')).toContainText('Target task');
  await refresh(404);
  await expect(menu).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  expect(writes).toEqual([]);
});

for (const status of [403, 503]) test(`overview paused selection displays the actual detail read failure (${status})`, async ({ page }) => {
  const writes = await install(page, false, false, false, false, true);
  await page.route(`**/api/v1/projects/${projectId}/tasks/${taskId}`, route => route.fulfill({ status,
    headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID },
    body: JSON.stringify({ error: { code: status === 403 ? 'forbidden' : 'unavailable', message: 'Selected task cannot be read', requestId: `selected-detail-${status}` } }),
  }));
  await page.goto(`/projects/${projectId}`);
  const badge = page.locator('#project-section-panel-overview .project-section-heading .task-pause-count');
  await badge.click();
  await page.locator('.project-paused-menu').getByRole('menuitem').click();
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.getByRole('alert')).toContainText(`selected-detail-${status}`);
  await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
  await dialog.locator('.task-detail-close').click();
  await expect(badge).toBeFocused();
  expect(writes).toEqual([]);
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

for (const section of ['overview', 'tasks'] as const) for (const [width, locale] of [[320, 'zh'], [390, 'en'], [1280, 'en']] as const) {
  test(`${section} paused task popover supports keyboard, exact detail and history at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 480 });
    const title = 'Long paused task title '.repeat(10);
    const writes = await install(page, false, false, false, false, true, undefined, { title }, {
      previousChanges: { title: 'Second paused task', properties: { paused: true } },
    });
    if (locale === 'zh') await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
    await page.goto(`/projects/${projectId}`);
    await page.locator(`#project-section-tab-${section}`).click();
    const badge = page.locator(`#project-section-panel-${section} .project-section-heading .task-pause-count`);
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
    await expect(page.locator(`#project-section-tab-${section}`)).toHaveAttribute('aria-selected', 'true');
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(badge).toBeFocused();
    await page.goForward();
    await expect(dialog).toHaveAccessibleName('Second paused task');
    await page.goBack();
    await expect(badge).toBeFocused();
    await badge.click();
    await page.locator(`#project-section-tab-${section === 'overview' ? 'tasks' : 'overview'}`).focus();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}

for (const section of ['overview', 'tasks'] as const) test(`${section} paused popover preserves focus on refresh and moves it as tasks disappear`, async ({ page }) => {
  let updateTask!: (changes: Partial<TaskDetail>) => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  let deleteTask!: () => void;
  const writes = await install(page, false, false, false, false, true, undefined, { assignedTo: TEST_VIEWER_ID }, {
    previousChanges: { properties: { paused: true }, assignedTo: TEST_VIEWER_ID }, exposeUpdate: update => { updateTask = update; },
    exposePreviousUpdate: update => { updatePrevious = update; }, exposeDeleteTask: remove => { deleteTask = remove; },
  });
  await page.goto(`/projects/${projectId}`);
  await page.locator(`#project-section-tab-${section}`).click();
  if (section === 'tasks') {
    await page.getByRole('button', { name: /^Assignee:/ }).click();
    await page.getByRole('option', { name: 'Assigned to me' }).click();
  }
  const badge = page.locator(`#project-section-panel-${section} .project-section-heading .task-pause-count`);
  await badge.click();
  const menu = page.locator('.project-paused-menu');
  const rows = menu.getByRole('menuitem');
  await expect(rows.first()).toBeFocused();
  const refresh = async () => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
    await page.locator('[data-project-action="refresh"]').evaluate((element: HTMLButtonElement) => element.click());
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
  await expect(badge).toContainText('1');
  await expect(menu).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('History origin');
  await expect(rows.first()).toBeFocused();
  updatePrevious({ ...(section === 'overview' ? { properties: { paused: false } } : { assignedTo: null }), version: 6n, updatedAt: '2026-10-25T09:00:00Z' });
  await refresh();
  await expect(menu).toHaveCount(0);
  await expect(badge).toHaveCount(0);
  await expect(page.locator(section === 'overview' ? '#project-section-tab-overview' : '#project-task-tab-chains')).toBeFocused();
  expect(writes).toEqual([]);
});

for (const section of ['overview', 'tasks'] as const) test(`${section} many paused tasks scroll within the native popover and close on outside click`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  const additionalTasks = Array.from({ length: 20 }, (_, index) => detailFixture(projectId,
    `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    { title: `Additional paused task ${index}`, properties: { paused: true } }));
  const writes = await install(page, false, false, false, false, true, undefined, {}, { additionalTasks });
  await page.goto(`/projects/${projectId}`);
  await page.locator(`#project-section-tab-${section}`).click();
  const badge = page.locator(`#project-section-panel-${section} .project-section-heading .task-pause-count`);
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
  await page.locator('[data-project-action="refresh"]').evaluate((element: HTMLButtonElement) => element.click());
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

for (const section of ['overview', 'tasks'] as const) test(`${section} paused Goal child opens its own detail from the project badge`, async ({ page }) => {
  const goalId = '30000000-0000-4000-8000-000000000001';
  const childId = '40000000-0000-4000-8000-000000000001';
  const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Parent Goal', properties: { paused: true } });
  const child = detailFixture(projectId, childId, { parentId: goalId, title: 'Goal child', properties: { paused: true } });
  const writes = await install(page, false, false, false, false, false, undefined, {}, { additionalTasks: [goal, child] });
  await page.goto(`/projects/${projectId}`);
  await page.locator(`#project-section-tab-${section}`).click();
  const badge = page.locator(`#project-section-panel-${section} .project-section-heading .task-pause-count`);
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

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`project task rows preserve full titles at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const goalId = '00000000-0000-4000-8000-000000000051';
    const goalTaskId = '00000000-0000-4000-8000-000000000052';
    const chainTaskId = '00000000-0000-4000-8000-000000000053';
    const title = '完整 Long title 😀 '.repeat(22) + ' END';
    const extra = [detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', ready: false }),
      detailFixture(projectId, goalTaskId, { parentId: goalId, title }),
      detailFixture(projectId, chainTaskId, { dependsOn: [previousId], blockedBy: [previousId], ready: false, title })];
    await install(page, false, false, false, false, false, undefined, { title }, { additionalTasks: extra });
    const detailReads: string[] = [];
    page.on('request', request => { if (/\/tasks\/[0-9a-f-]+$/.test(new URL(request.url()).pathname)) detailReads.push(request.url()); });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    await page.locator('#project-task-tab-standalone').click();
    const titleFits = (selector: string) => page.locator(selector).evaluate(element => {
      const container = element.closest('.root-heading')!.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return [...range.getClientRects()].every(rect => rect.left >= container.left - 1 && rect.right <= container.right + 1);
    });
    const standalone = page.locator(`#standalone-task-${taskId}`);
    await expect(standalone.locator('.root-title')).toHaveText(title);
    expect(await titleFits(`#standalone-task-${taskId} .root-title`)).toBe(true);
    await page.locator('#project-task-tab-chains').click();
    await page.locator(`#task-root-${previousId}`).click();
    const chain = page.locator(`[id="chain-task-${previousId}-${chainTaskId}"]`);
    await expect(chain.locator('.root-title')).toHaveText(title);
    expect(await titleFits(`[id="chain-task-${previousId}-${chainTaskId}"] .root-title`)).toBe(true);
    await page.locator('#project-task-tab-goals').click();
    await page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`).click();
    const goal = page.locator(`[id="chain-task-goal-${goalId}-${goalTaskId}"]`);
    await expect(goal.locator('.root-title')).toHaveText(title);
    expect(await titleFits(`[id="chain-task-goal-${goalId}-${goalTaskId}"] .root-title`)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(detailReads).toEqual([]);
  });
}


for (const locale of ['en', 'zh-CN']) for (const width of [320, 1280]) for (const kind of ['standalone', 'chain']) {
  test(`shared project rows preserve Worker aliases ${kind} ${locale} ${width}px`, async ({ page }, info) => {
    const alias = '上海办公室跨页面识别的 Windows 工作站 '.repeat(2).trim();
    const workerId = '00000000-0000-4000-8000-000000000070';
    const claim = { claimId: '00000000-0000-4000-8000-000000000071', state: 'active', userId: TEST_VIEWER_ID, workerId, machine: { id: '00000000-0000-4000-8000-000000000072', name: 'Historical host' }, platform: 'windows', agent: 'codex', agentControlMode: 'web', worktreeId: '00000000-0000-4000-8000-000000000073', phase: 'executing', nativeSessionId: null, claimedAt: time };
    await install(page, true, kind === 'chain', false, false, false, undefined, { ...(kind === 'chain' ? { status: 'done' as const, completedAt: '2026-10-22T10:00:00Z' } : {}), properties: kind === 'standalone' ? { worker: claim } : {} }, { workerAlias: alias, ...(kind === 'chain' ? { previousChanges: { status: 'in_progress', startedAt: time, ready: false, properties: { worker: claim } } } : {}) });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await page.locator('.locale-control select').selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    if (kind === 'standalone') await page.locator('#project-task-tab-standalone').click();
    else await page.locator('.root-toggle').first().click();
    const row = page.locator('.task-row-item').filter({ has: page.getByRole('link', { name: kind === 'standalone' ? 'Target task' : 'History origin', exact: true }) });
    await expect(row.locator('.task-row-machine')).toContainText(alias);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await row.locator('.task-row-machine').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await row.locator('.task-row-machine').scrollIntoViewIfNeeded();
    await expect(row.locator('.task-row-machine')).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`${kind}-worker-alias.png`), fullPage: true });
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`search loading, failure and empty states remain usable at ${width}px in ${locale}`, async ({ page }) => {
    await install(page);
    let release!: () => void;
    let calls = 0;
    await page.route(`**/api/v1/projects/${projectId}/tasks/search`, async route => {
      calls++;
      if (calls === 1) { await new Promise<void>(resolve => { release = resolve; }); return route.fulfill({ status: 500, json: { error: { code: 'unavailable', message: 'Unavailable', requestId: 'fixture' } } }); }
      return route.fulfill({ json: { projectId, total: 0, items: [], nextCursor: null }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    const input = page.locator('.task-search-form input');
    await input.fill('missing'); await input.press('Enter');
    await expect(page.locator('.task-search-results [role=status]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    release();
    const error = page.locator('.task-search-error'); await expect(error).toBeVisible();
    await error.getByRole('button').click();
    await expect(page.locator('.task-search-results .state-box')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 375, 390] as const) for (const presentation of ['direct', 'dialog', 'fullscreen'] as const) {
  test(`Step touch editors retain readable drafts in ${presentation} at ${width}px (${locale})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL!, viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      const writes = await install(page, false, false, false, false, false, undefined, {}, { locale });
      let root;
      if (presentation === 'direct') {
        await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
        root = page.locator('.task-detail-page');
      } else {
        root = await openDialog(page);
        if (presentation === 'fullscreen') await root.getByRole('button', { name: /^(Enter fullscreen|进入全屏)$/ }).click();
        await root.getByRole('tab', { name: /^(Steps|步骤)$/ }).click();
      }
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      const add = root.getByRole('button', { name: /^(Add step|添加步骤)$/ });
      await expect(add).toHaveText(locale === 'en' ? 'Add step' : '添加步骤');
      await add.tap();
      const form = root.locator('.step-add-form');
      const title = form.locator('input');
      const description = form.locator('textarea');
      for (const field of [title, description]) await expect(field).toHaveCSS('font-size', '16px');
      await form.locator('button[type=submit]').click();
      await expect(title).toHaveAttribute('aria-invalid', 'true');
      const text = 'Long Markdown description with wrapping. '.repeat(30);
      await title.fill('Long title '.repeat(20)); await description.fill(text);
      const geometry = await description.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
      expect(geometry.scrollHeight).toBeGreaterThan(geometry.height);
      expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const bounds = await form.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await description.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(5, 15); });
      await form.getByRole('button', { name: /^(Preview|预览)$/ }).tap();
      await expect(form.locator('.step-add-preview p').first()).toHaveCSS('font-size', '14px');
      await form.getByRole('button', { name: /^(Edit|编辑)$/ }).tap();
      await expect(description).toHaveValue(text);
      expect(await description.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([5, 15]);
      await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
      for (const field of [title, description]) await expect(field).toHaveCSS('font-size', '20px');
      await title.focus(); await page.keyboard.press('Escape');
      await page.getByRole('alertdialog').getByRole('button', { name: /^(Discard|放弃)$/ }).click();
      await expect(add).toBeFocused();
      const row = root.locator('.step-row[data-step-id="00000001"]');
      await row.locator('.step-disclosure').tap();
      await row.getByRole('button', { name: /^(Edit step|编辑步骤)$/ }).tap();
      const edit = root.locator('.step-edit-form');
      await expect(edit.locator('textarea')).toHaveCount(2);
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      for (const field of await edit.locator('textarea').all()) await expect(field).toHaveCSS('font-size', '16px');
      await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
      for (const field of await edit.locator('textarea').all()) await expect(field).toHaveCSS('font-size', '20px');
      expect(writes).toEqual([]);
    } finally { await context.close(); }
  });
}

for (const [width, touch] of [[768, false], [1360, false], [1360, true]] as const) {
  test(`Step input typography follows pointer at ${width}px (touch=${touch})`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL: baseURL!, viewport: { width, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    try {
      await install(page); await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(touch);
      await page.locator('.task-detail-page .assignee-trigger').click();
      const search = page.locator('.assignee-menu .assignee-search');
      await expect(search).toBeFocused();
      for (const root of [12, 16, 24]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
        await expect(search).toHaveCSS('font-size', `${touch ? Math.max(root, 16) : root * 0.875}px`);
      }
      await search.press('Escape');
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      await page.getByRole('button', { name: 'Add step', exact: true }).click();
      const form = page.locator('.step-add-form');
      await expect(form.locator('input, textarea')).toHaveCount(2);
      for (const root of [12, 16, 24]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
        for (const field of await form.locator('input, textarea').all()) await expect(field).toHaveCSS('font-size', `${touch ? Math.max(root, 16) : root * 0.875}px`);
        await expect(page.locator('.steps-counts')).toHaveCSS('font-size', `${root * 0.75}px`);
        await expect(page.locator('.step-title').first()).toHaveCSS('font-size', `${root * 0.875}px`);
      }
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      const row = page.locator('.step-row[data-step-id="00000001"]');
      await row.locator('.step-disclosure').click();
      await row.getByRole('button', { name: 'Edit step' }).click();
      const fields = page.locator('.step-edit-form textarea');
      await expect(fields).toHaveCount(2);
      for (const root of [12, 16, 24]) {
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
        for (const field of await fields.all()) await expect(field).toHaveCSS('font-size', `${touch ? Math.max(root, 16) : root * 0.875}px`);
      }
    } finally { await context.close(); }
  });
}

test('Step touch fields retain their size while a save is pending', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    await install(page);
    await page.route(`**/api/v1/projects/${projectId}/tasks/${taskId}/steps`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      started.resolve(); await release.promise;
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', message: 'Refused', requestId: 'fixture' } }) });
    });
    await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=steps`);
    await page.getByRole('button', { name: 'Add step', exact: true }).tap();
    const form = page.locator('.step-add-form'), title = form.locator('input'), description = form.locator('textarea');
    await title.fill('Pending'); await description.fill('Draft');
    await title.focus(); await page.keyboard.press('Tab');
    await expect(form.getByRole('combobox', { name: 'Initial status' })).toBeFocused();
    await form.locator('button[type=submit]').tap(); await started.promise;
    for (const field of [title, description]) { await expect(field).toBeDisabled(); await expect(field).toHaveCSS('font-size', '16px'); }
    expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    release.resolve();
    await expect(title).toBeEnabled(); await expect(title).toHaveValue('Pending'); await expect(description).toHaveValue('Draft');
  } finally { release.resolve(); await context.close(); }
});

const usageSecondRoot = '00000000-0000-4000-8000-000000000051';
const usageSecondMember = '00000000-0000-4000-8000-000000000052';
const usageMetrics = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
const usageSummary = (known: string) => ({
  metrics: Object.fromEntries(usageMetrics.map(key => [key, { known: key === 'totalTokens' ? known : null, contributingRecords: key === 'totalTokens' ? '1' : '0', unknownRecords: key === 'totalTokens' ? '0' : '1' }])),
  scope: 'registered_executions', completeness: 'partial', reasonCodes: ['native_recovery_gap'],
  coverage: { executions: '2', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '1' },
  measurementRecords: '1', lastMeasuredAt: time, observedAt: time, etag: 'summary-revision',
});

async function installChainUsage(page: Page) {
  const requests: string[] = [];
  let outcome: 'ok' | 'temporary' | 'forbidden' | 'missing' | 'cursor' = 'ok';
  const respond = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    requests.push(`${request.method()} ${path}${url.search}`);
    if (path === '/api/usage/v1/capabilities') return send({ protocol: 'daynight.usage.v1' });
    if (path.endsWith('/usage/v1/task-summaries')) return send({ items: (request.postDataJSON() as { taskIds: string[] }).taskIds.map(taskId => ({ taskId, summary: usageSummary('42') })) });
    const match = path.match(/\/usage\/v1\/aggregates\/chain\/([^/]+)$/);
    if (match === null) return send({ error: { code: 'not_found', requestId: 'fixture' } }, 404);
    if (outcome === 'temporary') return send({ error: { code: 'unavailable', requestId: 'fixture' } }, 503);
    if (outcome === 'forbidden') return send({ error: { code: 'aggregate_scope_restricted', requestId: 'fixture' } }, 403);
    if (outcome === 'missing') return send({ error: { code: 'not_found', requestId: 'fixture' } }, 404);
    if (outcome === 'cursor' && url.searchParams.has('cursor')) return send({ error: { code: 'cursor_expired', requestId: 'fixture' } }, 409);
    const id = match[1]!;
    const second = id === usageSecondRoot || id === usageSecondMember;
    return send({ scope: 'chain', scopeId: id, membershipPolicy: 'current_members_excludes_deleted', membershipRevision: 'membership-revision', summary: usageSummary(second ? '321' : '0'),
      members: { total: '2', withKnownUsage: '1', complete: '0', collecting: '0', partial: '1', unsupported: '0', unavailable: '0', noData: '1', restricted: '0' },
      missingMembers: [{ taskId: second ? usageSecondMember : previousId, title: second ? 'Second chain member' : 'History origin', completeness: 'partial', reasonCodes: ['native_recovery_gap'] }],
      nextMembersCursor: 'next-page', observedAt: time });
  };
  await page.route('**/api/usage/v1/**', respond);
  await page.route('**/api/projects/**/usage/v1/**', respond);
  return { requests, setOutcome: (next: typeof outcome) => { outcome = next; } };
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`chain usage follows the selected chain and preserves list and graph at ${width}px in ${locale}`, async ({ page }) => {
    const second = [detailFixture(projectId, usageSecondRoot, { title: 'Second chain', version: 5n }),
      detailFixture(projectId, usageSecondMember, { title: 'Second chain member', dependsOn: [usageSecondRoot], blockedBy: [usageSecondRoot], ready: false, version: 5n })];
    const writes = await install(page, false, true, false, false, false, undefined, {}, { additionalTasks: second, locale });
    const usage = await installChainUsage(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    const firstToggle = page.locator(`#task-root-${taskId}`), secondToggle = page.locator(`#task-root-${usageSecondRoot}`);
    await firstToggle.click(); await secondToggle.click();
    const first = page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`);
    const secondButton = page.locator(`[data-chain-id="${usageSecondRoot}"] .chain-usage-button`);
    await expect(first).toBeVisible(); await expect(secondButton).toBeVisible();
    const position = await first.evaluate(element => ({ left: element.getBoundingClientRect().left, detail: element.parentElement!.querySelector('.goal-detail-link:not(.chain-usage-button)')!.getBoundingClientRect().left }));
    if (width === 1280) expect(position.left).toBeLessThan(position.detail);
    expect(usage.requests.filter(request => request.includes('/aggregates/'))).toHaveLength(0);
    await first.focus(); const scrollBefore = await page.evaluate(() => window.scrollY); await page.keyboard.press('Enter');
    const dialog = page.locator('.chain-usage-dialog');
    await expect(dialog).toHaveAccessibleName(locale === 'en' ? 'Token usage · Target task' : 'Token 用量 · Target task');
    await expect(dialog.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'History origin' })).toBeVisible();
    await expect(dialog).toContainText('0');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(first).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(firstToggle).toHaveAttribute('aria-expanded', 'true'); await expect(secondToggle).toHaveAttribute('aria-expanded', 'true');
    await secondButton.click();
    await expect(dialog).toHaveAccessibleName(locale === 'en' ? 'Token usage · Second chain' : 'Token 用量 · Second chain');
    await expect(dialog.getByRole('button', { name: 'Second chain member' })).toBeVisible();
    await expect(dialog).toContainText('321');
    await dialog.getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true }).click();
    await expect(secondButton).toBeFocused();
    expect(usage.requests.filter(request => request.includes('/aggregates/')).map(request => request.split('/').at(-1))).toEqual([taskId, usageSecondRoot]);
    const graphUsageRequests = usage.requests.filter(request => request.includes('/task-summaries')).length;
    await page.locator(`#task-chain-graph-${taskId}`).click();
    const graphDialog = page.locator('.task-chain-dialog');
    await expect(graphDialog).toBeVisible();
    await expect(graphDialog.locator('.usage-aggregate-disclosure, .task-node-usage')).toHaveCount(0);
    await graphDialog.locator('.graph-fullscreen-toggle').click();
    await expect(graphDialog).toHaveClass(/task-chain-dialog-fullscreen/);
    await expect(graphDialog.locator('.usage-aggregate-disclosure, .task-node-usage')).toHaveCount(0);
    expect(usage.requests.filter(request => request.includes('/task-summaries')).length).toBe(graphUsageRequests);
    await graphDialog.locator('.task-chain-close').click();
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('chain usage handles temporary failure, cursor expiry, permission and missing scope', async ({ page }) => {
  await install(page, false, true);
  const usage = await installChainUsage(page);
  usage.setOutcome('temporary');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click();
  await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const dialog = page.locator('.chain-usage-dialog');
  await expect(dialog.getByRole('alert')).toContainText('Unable to load aggregate usage');
  usage.setOutcome('ok'); await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(dialog.getByRole('button', { name: 'History origin' })).toBeVisible();
  usage.setOutcome('cursor'); await dialog.getByRole('button', { name: 'Load more incomplete tasks' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Refresh before continuing');
  await expect(dialog.getByRole('button', { name: 'History origin' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Load more incomplete tasks' })).toBeDisabled();
  usage.setOutcome('ok'); await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => usage.requests.filter(request => request.includes('/aggregates/')).at(-1)).not.toContain('?cursor=');
  usage.setOutcome('forbidden'); await dialog.getByRole('button', { name: 'Refresh usage' }).click();
  await expect(dialog.getByRole('alert')).toContainText('do not have permission');
  await expect(dialog.getByRole('button', { name: 'History origin' })).toHaveCount(0);
  usage.setOutcome('missing'); await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(dialog.getByRole('alert')).toContainText('no longer available');
  await expect(dialog.getByRole('button', { name: 'History origin' })).toHaveCount(0);
});

test('chain usage member details retain draft protection and return focus', async ({ page }) => {
  const writes = await install(page, false, true);
  await installChainUsage(page);
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click();
  await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog');
  const member = usage.getByRole('button', { name: 'History origin' });
  await member.click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await expect(detail).toHaveAccessibleName('History origin');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click();
  await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const title = detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' });
  await title.fill('Keep this draft');
  await detail.getByRole('button', { name: 'Close task details', exact: true }).click();
  const leave = page.getByRole('alertdialog'); await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(title).toHaveValue('Keep this draft'); await expect(usage).toBeVisible();
  await detail.getByRole('button', { name: 'Close task details', exact: true }).click();
  await leave.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(detail).toHaveCount(0); await expect(member).toBeFocused();
  await page.keyboard.press('Escape'); await expect(usage).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('chain usage member Step draft survives Back from Overview', async ({ page }) => {
  const writes = await install(page, false, true); await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog'); await usage.getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' }); await draft.fill('Draft across Back');
  const original = await draft.elementHandle();
  await detail.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(detail.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(detail.getByRole('tab', { name: 'Steps', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(draft).toHaveValue('Draft across Back');
  expect(await draft.evaluate((element, before) => element === before, original)).toBe(true);
  await expect(usage).toHaveCount(0); expect(writes).toEqual([]);
});

test('temporary project metadata failure preserves chain member draft and rejected navigation', async ({ page }) => {
  const writes = await install(page, false, true); await installChainUsage(page);
  let failing = false;
  await page.route(`**/api/v1/projects/${projectId}`, route => failing ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', requestId: 'fixture' } }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }) : route.fallback());
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog'); await usage.getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' }); await draft.fill('Draft through project failure');
  const original = await draft.elementHandle();
  failing = true;
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}` && response.status() === 503);
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await failed;
  await expect(page.locator('.snapshot-error')).toBeVisible();
  await expect(draft).toHaveValue('Draft through project failure');
  await detail.getByRole('button', { name: 'Close task details', exact: true }).click();
  const leave = page.getByRole('alertdialog'); await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(draft).toHaveValue('Draft through project failure');
  expect(await draft.evaluate((element, before) => element === before, original)).toBe(true);
  failing = false;
  await page.locator('.snapshot-error button').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('.snapshot-error')).toHaveCount(0);
  await expect(draft).toHaveValue('Draft through project failure');
  expect(await draft.evaluate((element, before) => element === before, original)).toBe(true);
  expect(writes).toEqual([]);
});

test('a cross-Goal scoped chain uses its visible member as an anchor for the whole chain', async ({ page }) => {
  const goalId = '00000000-0000-4000-8000-000000000061';
  await install(page, false, true, false, false, false, undefined, {}, {
    previousChanges: { parentId: goalId }, additionalTasks: [detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', version: 5n, ready: false })],
  });
  const usage = await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click();
  const trigger = page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`);
  await trigger.click();
  const dialog = page.locator('.chain-usage-dialog');
  await expect(dialog.getByRole('button', { name: 'History origin' })).toBeVisible();
  expect(usage.requests.filter(request => request.includes('/aggregates/')).map(request => request.split('/').at(-1))).toEqual([taskId]);
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
});

test('account change discards a late chain usage response', async ({ page, context }) => {
  await install(page, false, true);
  await installChainUsage(page);
  const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  await page.route(`**/api/projects/${projectId}/usage/v1/aggregates/chain/${taskId}`, async route => {
    started.resolve(); await gate.promise;
    await route.fulfill({ json: { scope: 'chain', scopeId: taskId, membershipPolicy: 'current_members_excludes_deleted', membershipRevision: 'old', summary: usageSummary('123456'),
      members: { total: '1', withKnownUsage: '1', complete: '0', collecting: '0', partial: '1', unsupported: '0', unavailable: '0', noData: '0', restricted: '0' },
      missingMembers: [{ taskId: previousId, title: 'Private late result', completeness: 'partial', reasonCodes: [] }], nextMembersCursor: null, observedAt: time },
      headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }).catch(() => {});
  });
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  await started.promise;
  const other = await context.newPage();
  const secondUser = '00000000-0000-4000-8000-000000000022';
  try {
    await page.route('**/api/v1/me', route => route.fulfill({ json: { id: secondUser, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Other', email: null, emailVerified: null, avatarUrl: null }, headers: { 'Daynight-User-ID': secondUser } }));
    await other.route('**/identity-sender', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Identity sender</title>' }));
    await other.goto('/identity-sender');
    await other.evaluate(userId => { localStorage.setItem('daynight.activeUser', JSON.stringify(userId)); const channel = new BroadcastChannel('daynight-identity'); channel.postMessage('identity-changed'); channel.close(); }, secondUser);
    await expect(page.locator('.chain-usage-dialog')).toHaveCount(0);
    await expect(page.getByText('Account changed', { exact: true }).first()).toBeVisible();
    gate.resolve();
    await expect(page.getByText('Private late result')).toHaveCount(0);
  } finally { gate.resolve(); await other.close(); }
});

test('removing the usage anchor retains an open member detail and its draft', async ({ page }) => {
  let remove!: () => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  await install(page, false, true, false, false, false, undefined, {}, { exposeDeleteTask: callback => { remove = callback; }, exposePreviousUpdate: callback => { updatePrevious = callback; } });
  await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog'); await usage.getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const title = detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' }); await title.fill('Retain this draft');
  const original = await title.elementHandle();
  updatePrevious({ dependsOn: [], blockedBy: [], ready: true, version: 6n, updatedAt: '2026-10-24T09:00:00Z' }); remove();
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.locator('[data-project-action="refresh"]').evaluate((button: HTMLButtonElement) => button.click()); await response;
  await expect(title).toHaveValue('Retain this draft');
  await expect(usage.locator('[role=alert]')).toContainText('scope is no longer available');
  expect(await title.evaluate((element, before) => element === before, original)).toBe(true);
  await expect(detail).toBeVisible();
});

test('removing the usage anchor retains a direct member detail and Step draft', async ({ page }) => {
  let remove!: () => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  const linkedId = '00000000-0000-4000-8000-000000000075';
  const linked = detailFixture(projectId, linkedId, { title: 'Snapshot member', dependsOn: [taskId], blockedBy: [taskId], ready: false, version: 5n });
  const writes = await install(page, false, true, false, false, false, undefined, {}, {
    additionalTasks: [linked], exposeDeleteTask: callback => { remove = callback; }, exposePreviousUpdate: callback => { updatePrevious = callback; },
    snapshotTasks: details => details.filter(detail => detail.id !== previousId).map(detail => detail.id === linkedId && !details.some(item => item.id === taskId) ? { ...detail, dependsOn: [], blockedBy: [], ready: true } : detail),
  });
  await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog');
  const directRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tasks/${previousId}` && response.status() === 200);
  await usage.getByRole('button', { name: 'History origin' }).click(); await directRead;
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await expect(detail).toHaveAccessibleName('History origin');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = detail.locator('.step-add-form input'); await draft.fill('Direct member draft');
  const original = await draft.elementHandle();
  const started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  await page.route(`**/api/v1/projects/${projectId}/tasks/${previousId}`, async route => { started.resolve(); await gate.promise; await route.fallback(); });
  try {
    updatePrevious({ dependsOn: [], blockedBy: [], ready: true, version: 6n, updatedAt: '2026-10-24T09:00:00Z' }); remove();
    const synchronized = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
    const reread = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tasks/${previousId}` && response.status() === 200 && response.headers()['daynight-task-epoch'] === '00000000-0000-4000-8000-000000000901');
    await page.locator('[data-project-action="refresh"]').evaluate((button: HTMLButtonElement) => button.click()); await synchronized; await started.promise;
    await expect(draft).toHaveCount(1); await expect(draft).toBeHidden();
    gate.resolve(); await reread;
    await expect(usage.locator('[role=alert]')).toContainText('scope is no longer available');
    await expect(detail).toHaveAccessibleName('History origin'); await expect(draft).toHaveValue('Direct member draft');
    expect(await draft.evaluate((element, before) => element === before, original)).toBe(true);
  } finally { gate.resolve(); }
  expect(writes).toEqual([]);
});

test('direct member draft survives a failed recheck but is retired on denial', async ({ page }) => {
  let remove!: () => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  const linkedId = '00000000-0000-4000-8000-000000000075';
  const linked = detailFixture(projectId, linkedId, { title: 'Snapshot member', dependsOn: [taskId], blockedBy: [taskId], ready: false, version: 5n });
  const writes = await install(page, false, true, false, false, false, undefined, {}, {
    additionalTasks: [linked], exposeDeleteTask: callback => { remove = callback; }, exposePreviousUpdate: callback => { updatePrevious = callback; },
    snapshotTasks: details => details.filter(detail => detail.id !== previousId).map(detail => detail.id === linkedId && !details.some(item => item.id === taskId) ? { ...detail, dependsOn: [], blockedBy: [], ready: true } : detail),
  });
  await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  await page.locator('.chain-usage-dialog').getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = detail.locator('.step-add-form input'); await draft.fill('Private direct draft');
  const original = await draft.elementHandle();
  let outcome: 'temporary' | 'denied' | 'ok' = 'temporary';
  await page.route(`**/api/v1/projects/${projectId}/tasks/${previousId}`, route => outcome === 'ok' ? route.fallback() : route.fulfill({ status: outcome === 'temporary' ? 503 : 403, json: { error: { code: outcome === 'temporary' ? 'unavailable' : 'forbidden', message: 'Fixture failure', requestId: 'fixture' } }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
  updatePrevious({ dependsOn: [], blockedBy: [], ready: true, version: 6n, updatedAt: '2026-10-24T09:00:00Z' }); remove();
  await page.locator('[data-project-action="refresh"]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(detail.locator('.task-detail-error')).toBeVisible();
  await expect(draft).toHaveCount(1); await expect(draft).toBeHidden();
  expect(await draft.evaluate((element, before) => element === before, original)).toBe(true);
  outcome = 'denied'; await detail.locator('.task-detail-error').getByRole('button', { name: 'Retry' }).click();
  await expect(draft).toHaveCount(0);
  outcome = 'ok'; await detail.locator('.task-detail-error').getByRole('button', { name: 'Retry' }).click();
  await expect(detail).toHaveAccessibleName('History origin');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  await expect(detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' })).toHaveValue('');
  expect(writes).toEqual([]);
});

test('browser history does not restore the transient chain usage layer', async ({ page }) => {
  await install(page, false, true); await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog'); await usage.getByRole('button', { name: 'History origin' }).click();
  await expect(page.locator('.task-detail-dialog:not(.chain-usage-dialog)')).toHaveAccessibleName('History origin');
  await page.goBack(); await expect(usage).toHaveCount(0);
  await page.goForward(); await expect(usage).toHaveCount(0);
  await expect(page.locator('.task-detail-dialog:not(.chain-usage-dialog)')).toHaveAccessibleName('History origin');
});

test('Goal graph and restored nested chain graph retain usage', async ({ page }) => {
  const goalId = '00000000-0000-4000-8000-000000000061';
  await install(page, false, true, false, false, false, undefined, { parentId: goalId }, {
    previousChanges: { parentId: goalId }, additionalTasks: [detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', version: 5n, ready: false })],
  });
  const usage = await installChainUsage(page);
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await card.locator(`#project-goal-graph-${goalId}`).click();
  const graph = page.locator(`#task-graph-${goalId}`);
  await expect(graph.locator('.usage-aggregate-disclosure')).toBeVisible();
  await expect.poll(() => usage.requests.filter(request => request.includes('/task-summaries')).length).toBeGreaterThan(0);
  await expect(graph.locator('.task-node-usage').first()).toBeVisible();
  await graph.locator('.task-chain-close').click();
  await card.locator('.goal-list-detail').click();
  const goal = page.locator('.goal-detail-surface'); await expect(goal).toHaveAccessibleName('Goal');
  await page.waitForFunction(() => history.state?.__daynightNavigation?.view !== undefined && typeof window.selectGoalReading === 'function');
  await page.evaluate(({ goalId, taskId }) => window.selectGoalReading(goalId, { graphRootId: taskId, task: null }), { goalId, taskId });
  const nested = page.locator(`#task-graph-${taskId}`);
  await expect(nested.locator('.usage-aggregate-disclosure')).toBeVisible();
  await expect(nested.locator('.task-node-usage').first()).toBeVisible();
  await nested.locator('.graph-fullscreen-toggle').click();
  await expect(nested.locator('.usage-aggregate-disclosure')).toBeVisible();
  await expect(nested.locator('.task-node-usage').first()).toBeVisible();
});


test('removing the usage anchor retains an open member Session draft', async ({ page }) => {
  const { source } = imageBrowserData();
  const snapshot = { ...source, identity: { ...source.identity, projectId, taskId: previousId }, lastEventSeq: '0', lastTimelineSeq: '0',
    lifecycle: 'active' as const, activity: 'idle' as const, connectionState: 'connected' as const, currentTurnId: null,
    operations: { canSend: true, canCancel: false, canRespond: false } };
  const worker = { claimId: source.claimId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Session fixture' }, platform: 'linux' as const, agent: 'codex' as const,
    agentControlMode: 'web' as const, worktreeId: source.identity.worktreeId, phase: 'executing' as const,
    herdr: null, nativeSessionId: source.identity.nativeSessionId, claimedAt: time };
  let remove!: () => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  await install(page, false, true, false, false, false, undefined, { status: 'done', ready: false, completedAt: time }, {
    previousChanges: { status: 'in_progress', ready: false, blockedBy: [], startedAt: time, properties: { worker } },
    exposeDeleteTask: callback => { remove = callback; }, exposePreviousUpdate: callback => { updatePrevious = callback; },
  });
  await installChainUsage(page);
  const sessionRoot = `/api/v1/projects/${projectId}/tasks/${previousId}/sessions`;
  const reply = (route: Route, body: unknown) => route.fulfill({ json: body, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
  await page.route(`**${sessionRoot}/current`, route => reply(route, { status: 'registered', session: snapshot }));
  await page.route(`**${sessionRoot}/${snapshot.sessionId}/timeline**`, route => reply(route, {
    sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null,
    hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0',
  }));
  await page.routeWebSocket('**/channel*', socket => {
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'fixture-event-0' }));
  });
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog');
  await usage.getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Session', exact: true }).click();
  const draft = detail.locator('.task-agent-session').getByRole('textbox', { name: 'Message' });
  await draft.fill('Retain the Session draft');
  updatePrevious({ dependsOn: [], blockedBy: [], ready: false, version: 6n, updatedAt: '2026-10-24T09:00:00Z' }); remove();
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.locator('[data-project-action="refresh"]').evaluate((button: HTMLButtonElement) => button.click()); await response;
  await expect(usage.locator('[role=alert]')).toContainText('scope is no longer available');
  await expect(draft).toHaveValue('Retain the Session draft');
  await expect(detail).toBeVisible();
});

test('member detail denial after anchor deletion clears retained draft through recovery', async ({ page }) => {
  let remove!: () => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  let denied = false, deniedReads = 0;
  await install(page, false, true, false, false, false, undefined, {}, {
    exposeDeleteTask: callback => { remove = callback; }, exposePreviousUpdate: callback => { updatePrevious = callback; },
  });
  await installChainUsage(page);
  await page.route(`**/api/v1/projects/${projectId}/tasks/${previousId}`, route => {
    if (denied) { deniedReads++; return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Forbidden', requestId: 'fixture-denied' } }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }); }
    const detail = detailFixture(projectId, previousId, deniedReads ? { title: 'History origin', version: 6n, dependsOn: [], blockedBy: [], ready: true, updatedAt: '2026-10-24T09:00:00Z' } : { title: 'History origin', version: 5n, dependsOn: [taskId], blockedBy: [taskId], ready: false });
    return route.fulfill({ status: 200, body: stringifyWireJson(detail), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': deniedReads ? '00000000-0000-4000-8000-000000000901' : taskSyncEpoch(projectId) } });
  });
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog'); await usage.getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click(); await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  const draft = detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' }); await draft.fill('Private denied draft');
  denied = true; updatePrevious({ dependsOn: [], blockedBy: [], ready: true, version: 6n, updatedAt: '2026-10-24T09:00:00Z' }); remove();
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.locator('[data-project-action="refresh"]').evaluate((button: HTMLButtonElement) => button.click()); await response;
  await expect.poll(() => deniedReads).toBeGreaterThan(0);
  const retry = detail.getByRole('button', { name: /retry/i }).first();
  await expect(retry).toBeVisible();
  await expect(draft).toHaveCount(0);
  denied = false;
  await retry.click();
  await expect(detail).toHaveAccessibleName('History origin');
  await detail.getByRole('tab', { name: 'Steps', exact: true }).click();
  await detail.getByRole('button', { name: 'Add step', exact: true }).click();
  await expect(detail.locator('.step-add-form').getByRole('textbox', { name: 'Title' })).toHaveValue('');
});

test('member Discussion draft survives anchor deletion and protects close', async ({ page }) => {
  let remove!: () => void;
  let updatePrevious!: (changes: Partial<TaskDetail>) => void;
  await install(page, false, true, false, false, false, undefined, {}, {
    exposeDeleteTask: callback => { remove = callback; }, exposePreviousUpdate: callback => { updatePrevious = callback; },
  });
  await installChainUsage(page);
  await page.route(`**/api/v1/projects/${projectId}/tasks/${previousId}/thread/messages**`, route => route.fulfill({ json: { items: [], hasMoreBefore: false, hasMoreAfter: false }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-root-${taskId}`).click(); await page.locator(`[data-chain-id="${taskId}"] .chain-usage-button`).click();
  const usage = page.locator('.chain-usage-dialog'); await usage.getByRole('button', { name: 'History origin' }).click();
  const detail = page.locator('.task-detail-dialog:not(.chain-usage-dialog)');
  await detail.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = detail.locator('.thread-composer textarea'); await draft.fill('Keep this discussion draft');
  updatePrevious({ dependsOn: [], blockedBy: [], ready: true, version: 6n, updatedAt: '2026-10-24T09:00:00Z' }); remove();
  const response = page.waitForResponse(result => new URL(result.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.locator('[data-project-action="refresh"]').evaluate((button: HTMLButtonElement) => button.click()); await response;
  await expect(usage.locator('[role=alert]')).toContainText('scope is no longer available');
  await expect(draft).toHaveValue('Keep this discussion draft');
  await detail.getByRole('button', { name: 'Close task details', exact: true }).click();
  const leave = page.getByRole('alertdialog'); await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(draft).toHaveValue('Keep this discussion draft');
  await detail.getByRole('button', { name: 'Close task details', exact: true }).click();
  await leave.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(detail).toHaveCount(0);
});
