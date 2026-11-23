import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TaskDetail } from '../../src/api/types';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000100';
const activeId = '00000000-0000-4000-8000-000000000401';
const doneId = '00000000-0000-4000-8000-000000000402';
const cancelledId = '00000000-0000-4000-8000-000000000403';
const isolatedId = '00000000-0000-4000-8000-000000000404';
const unrelatedId = '00000000-0000-4000-8000-000000000405';
const childId = '00000000-0000-4000-8000-000000000406';
const secondChildId = '00000000-0000-4000-8000-000000000407';
const teamId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-22T10:00:00Z';

const graphDialog = (page: Page) => page.getByRole('dialog', { name: 'Goal acceptance dependencies', exact: true });
const card = (dialog: Locator, id: string) => dialog.locator(`.react-flow__node[data-id="${id}"] .goal-acceptance-node`);
const edge = (dialog: Locator, source: string, target: string) => dialog.locator(`.task-dependency-edge[data-source="${source}"][data-target="${target}"]`);

const install = async (page: Page) => {
  let details: TaskDetail[] = [
    detailFixture(projectId, activeId, { type: 'goal', title: 'Release client', status: 'in_progress', startedAt: time, ready: false, dependsOn: [doneId, cancelledId] }),
    detailFixture(projectId, doneId, { type: 'goal', title: 'Accepted identity', status: 'done', completedAt: time, ready: false }),
    detailFixture(projectId, cancelledId, { type: 'goal', title: 'Cancelled migration', status: 'cancelled', cancelledAt: time, ready: false }),
    detailFixture(projectId, isolatedId, { type: 'goal', title: 'Independent acceptance', ready: false }),
    detailFixture(projectId, unrelatedId, { type: 'goal', title: 'Unrelated finished Goal', status: 'done', completedAt: time, ready: false }),
    detailFixture(projectId, childId, { parentId: activeId, title: 'First child' }),
    detailFixture(projectId, secondChildId, { parentId: activeId, title: 'Second child', dependsOn: [childId], blockedBy: [childId], ready: false }),
  ];
  let syncDetails = details;
  let epoch = taskSyncEpoch(projectId);
  let failingSync = false;
  let rotationReads = 0;
  let holdReplacement = false;
  let releaseReplacement: (() => void) | null = null;
  const syncRequests: string[] = [];
  const relationRequests: string[] = [];
  const unexpected: string[] = [];
  await page.clock.install({ time: new Date(time) });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body),
      headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    const fail = () => send({ error: { code: 'not_found', message: 'Not found', requestId: activeId } }, 404);
    const graph = graphFixture(syncDetails), base = `/api/v1/projects/${projectId}`;
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: teamId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ id: teamId, kind: 'personal', name: null, version: 1n, createdAt: time, updatedAt: time,
      membership: { teamId, userId: TEST_VIEWER_ID, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === base) return send(graph.project);
    if (path === `${base}/access`) return send(directAccessFixture(projectId));
    if (path === `${base}/tags`) return send({ items: [], catalogEpoch: taskSyncEpoch(projectId), nextCursor: null });
    if (path === `${base}/task-assignees`) return send({ items: [], unresolvedUserIds: [] });
    if (path === `${base}/task-sync`) {
      syncRequests.push(`${path}${url.search}`);
      if (failingSync) return send({ error: { code: 'unavailable', message: 'Temporarily unavailable', requestId: activeId } }, 503);
      if (holdReplacement && ++rotationReads > 1) {
        await new Promise<void>(resolve => { releaseReplacement = resolve; });
        releaseReplacement = null;
      }
      return send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch, versionForTask: task => syncDetails.find(detail => detail.id === task.id)!.version,
        propertiesForTask: task => syncDetails.find(detail => detail.id === task.id)!.properties }));
    }
    if (path.endsWith('/goal-dependencies')) {
      relationRequests.push(path);
      const goalId = path.split('/').at(-2)!;
      return send({ goalId, canEdit: false, completionBlocked: false, prerequisites: [], successors: [], nextCursor: null });
    }
    const detail = details.find(detail => path === `${base}/tasks/${detail.id}`);
    if (detail !== undefined) {
      if (request.method() === 'PATCH') {
        const input = request.postDataJSON() as { title: string; description: string };
        const next = { ...detail, title: input.title, description: input.description, version: detail.version + 1n, updatedAt: '2026-10-22T10:01:00Z' };
        details = details.map(item => item.id === detail.id ? next : item);
        return send({ ...next, dependsOn: [], externalDependsOn: [] }, 200, { 'Daynight-Task-Epoch': epoch });
      }
      return send({ ...detail, ...(detail.type === 'goal' ? { dependsOn: [], externalDependsOn: [] } : {}) }, 200, { 'Daynight-Task-Epoch': epoch });
    }
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    if (path.endsWith('/attachments') || path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
    unexpected.push(`${request.method()} ${path}`);
    return fail();
  });
  return {
    syncRequests, relationRequests, unexpected,
    changeEdges: (dependsOn: readonly string[]) => {
      syncDetails = syncDetails.map(detail => detail.id === activeId ? { ...detail, dependsOn, version: detail.version + 1n, updatedAt: '2026-10-22T10:01:00Z' } : detail);
      details = syncDetails;
    },
    commitDetail: () => { syncDetails = details; },
    failSync: (value: boolean) => { failingSync = value; },
    rotateEpoch: () => {
      epoch = '00000000-0000-4000-8000-000000000999';
      syncDetails = syncDetails.filter(detail => detail.id !== unrelatedId && detail.id !== secondChildId);
      details = syncDetails;
      holdReplacement = true;
    },
    replacementHeld: () => releaseReplacement !== null,
    releaseReplacement: () => { holdReplacement = false; releaseReplacement?.(); },
  };
};

const open = async (page: Page, syncRequests: readonly string[]) => {
  await page.goto(`/projects/${projectId}?tab=tasks`);
  await page.getByRole('tab', { name: /^Goals/ }).click();
  const trigger = page.getByRole('button', { name: 'Acceptance graph', exact: true });
  await expect(trigger).toBeVisible();
  const reads = syncRequests.length;
  await trigger.click();
  const dialog = graphDialog(page);
  await expect(dialog).toBeVisible();
  await expect(card(dialog, activeId)).toBeVisible();
  expect(syncRequests).toHaveLength(reads);
  return { dialog, trigger };
};

test('project Goal graph keeps isolated roots and terminal prerequisites, and inspects without TaskSync reads', async ({ page }) => {
  const state = await install(page), { dialog, trigger } = await open(page, state.syncRequests);
  await expect(dialog.locator('.goal-acceptance-node')).toHaveCount(4);
  await expect(card(dialog, isolatedId)).toBeVisible();
  await expect(card(dialog, doneId)).toHaveAttribute('data-goal-status', 'done');
  await expect(card(dialog, cancelledId)).toHaveAttribute('data-goal-status', 'cancelled');
  await expect(card(dialog, unrelatedId)).toHaveCount(0);
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  await expect(edge(dialog, cancelledId, activeId)).toHaveCount(1);
  const reads = state.syncRequests.length;
  const viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  await card(dialog, activeId).locator('.task-node-body').click();
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(edge(dialog, doneId, activeId)).toHaveAttribute('data-inspection', 'highlighted');
  await expect(viewport).toHaveAttribute('style', position!);
  await expect(dialog).toContainText('Cancelled migration');
  await dialog.locator('.react-flow__controls-zoomin').click();
  await expect(viewport).not.toHaveAttribute('style', position!);
  expect(state.syncRequests).toHaveLength(reads);
  await dialog.getByRole('button', { name: 'Close acceptance graph', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.syncRequests).toHaveLength(reads);
  expect(new URL(page.url()).search).toBe('?tab=tasks');
});

test('normal project deltas update open and closed graphs without clearing selection or changing requests', async ({ page }) => {
  const state = await install(page), { dialog, trigger } = await open(page, state.syncRequests);
  await card(dialog, activeId).locator('.task-node-body').click();
  const reads = state.syncRequests.length;
  state.changeEdges([doneId]);
  await page.clock.fastForward(16_000);
  await expect.poll(() => state.syncRequests.length).toBeGreaterThan(reads);
  await expect(edge(dialog, cancelledId, activeId)).toHaveCount(0);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Close acceptance graph', exact: true }).click();
  state.changeEdges([]);
  const closedReads = state.syncRequests.length;
  await page.clock.fastForward(16_000);
  await expect.poll(() => state.syncRequests.length).toBeGreaterThan(closedReads);
  const reopenedReads = state.syncRequests.length;
  await trigger.click();
  await expect(graphDialog(page).locator('.task-dependency-edge')).toHaveCount(0);
  await expect(graphDialog(page).locator('.goal-acceptance-node')).toHaveCount(2);
  expect(state.syncRequests).toHaveLength(reopenedReads);
  expect(state.syncRequests.slice(1).every(value => value.includes('epoch=') && value.includes('since='))).toBe(true);
});

test('Goal detail title receipts preserve committed edges until normal synchronization', async ({ page }) => {
  const state = await install(page), { dialog } = await open(page, state.syncRequests);
  await dialog.getByRole('button', { name: 'Details: Release client', exact: true }).click();
  const detail = page.locator('.goal-detail-surface').last();
  await expect(detail.locator('.task-detail-title')).toHaveText('Release client');
  await detail.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('alertdialog', { name: 'Edit Goal', exact: true });
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Renamed release');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(detail.locator('.task-detail-title')).toHaveText('Renamed release');
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  await expect(edge(dialog, cancelledId, activeId)).toHaveCount(1);
  await expect(card(dialog, activeId)).toContainText('Release client');
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  state.commitDetail();
  await page.clock.fastForward(16_000);
  await expect(card(dialog, activeId)).toContainText('Renamed release');
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
});

test('normal epoch retirement preserves the graph viewport and selection while retiring nested detail', async ({ page }) => {
  const state = await install(page), { dialog } = await open(page, state.syncRequests);
  await card(dialog, activeId).locator('.task-node-body').click();
  const canvas = dialog.locator('.task-graph-canvas'), bounds = await canvas.boundingBox();
  if (bounds === null) throw new Error('Goal canvas bounds are missing.');
  await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + 20);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 80, bounds.y + 70);
  await page.mouse.up();
  const viewport = dialog.locator('.react-flow__viewport');
  const dialogNode = await dialog.elementHandle(), viewportNode = await viewport.elementHandle();
  const position = await viewport.getAttribute('style');
  await dialog.getByRole('button', { name: 'Details: Release client', exact: true }).click();
  const detail = page.locator('.goal-detail-surface').last();
  await expect(detail.locator('.task-detail-title')).toHaveText('Release client');
  state.rotateEpoch();
  await page.clock.fastForward(16_000);
  await expect.poll(state.replacementHeld).toBe(true);
  await expect(detail).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node, original) => node === original, dialogNode)).toBe(true);
  expect(await viewport.evaluate((node, original) => node === original, viewportNode)).toBe(true);
  await expect(viewport).toHaveAttribute('style', position!);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  state.releaseReplacement();
  await expect.poll(state.replacementHeld).toBe(false);
  await expect(card(dialog, activeId)).toContainText('0 / 1 child Tasks done');
  expect(await viewport.evaluate((node, original) => node === original, viewportNode)).toBe(true);
  await expect(viewport).toHaveAttribute('style', position!);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
});

test('transient TaskSync failures show an in-dialog retry and retain the readable graph', async ({ page }) => {
  const state = await install(page), { dialog } = await open(page, state.syncRequests);
  await card(dialog, activeId).locator('.task-node-body').click();
  const viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  const original = await viewport.elementHandle();
  state.failSync(true);
  await page.clock.fastForward(16_000);
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).toHaveAttribute('style', position!);
  state.failSync(false);
  await dialog.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(await viewport.evaluate((node, previous) => node === previous, original)).toBe(true);
  await expect(viewport).toHaveAttribute('style', position!);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
});

for (const width of [320, 390]) test(`Goal graph inspection fits ${width}px and Escape restores the list trigger`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await install(page);
  const { dialog, trigger } = await open(page, state.syncRequests);
  await card(dialog, activeId).locator('.task-node-body').click();
  await expect(dialog).toContainText('Accepted identity');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const layout = await dialog.evaluate(element => ({ width: element.getBoundingClientRect().width, overflow: element.scrollWidth > element.clientWidth }));
  expect(layout.width).toBeLessThanOrEqual(width);
  expect(layout.overflow).toBe(false);
  await page.screenshot({ path: info.outputPath(`goal-acceptance-${width}.png`) });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('existing Goal child Task graph address retains ordinary Task edges', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/projects/${projectId}?tab=tasks&goalGraph=${activeId}`);
  const original = page.locator(`#task-graph-${activeId}`);
  await expect(original).toBeVisible();
  await expect(original.locator('.task-node')).toHaveCount(2);
  await expect(edge(original, childId, secondChildId)).toHaveCount(1);
  await expect(original.locator('.goal-acceptance-node')).toHaveCount(0);
  expect(new URL(page.url()).search).toBe(`?tab=tasks&goalGraph=${activeId}`);
  expect(state.syncRequests.length).toBeGreaterThan(0);
});

for (const fullscreen of [false, true]) test(`keyboard inspector navigation retains focus and Escape ${fullscreen ? 'exits fullscreen before closing' : 'closes the graph'}`, async ({ page }) => {
  const state = await install(page), { dialog, trigger } = await open(page, state.syncRequests);
  if (fullscreen) {
    await dialog.getByRole('button', { name: 'View fullscreen', exact: true }).click();
    await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
  }
  await card(dialog, activeId).locator('.task-node-body').click();
  const inspection = dialog.locator('.goal-acceptance-inspection');
  const prerequisite = inspection.getByRole('button', { name: 'Accepted identity', exact: true });
  const requests = [...state.syncRequests], viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  await prerequisite.focus();
  await prerequisite.press('Enter');
  await expect(card(dialog, doneId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(inspection.getByRole('heading', { name: 'Accepted identity', exact: true })).toBeFocused();
  await expect(viewport).toHaveAttribute('style', position!);
  expect(state.syncRequests).toEqual(requests);
  expect(state.relationRequests).toHaveLength(0);
  await page.keyboard.press('Escape');
  if (fullscreen) {
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toHaveClass(/task-chain-dialog-fullscreen/);
    await expect(dialog.getByRole('button', { name: 'View fullscreen', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
  }
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.syncRequests).toEqual(requests);
});
