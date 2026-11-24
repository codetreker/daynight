import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TaskDetail } from '../../src/api/types';
import type { GoalDependencies, RelatedGoal } from '../../src/api/goal-dependencies';
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
const fourthTerminalId = '00000000-0000-4000-8000-000000000408';
const teamId = '00000000-0000-4000-8000-000000000701';
const externalProjectId = '00000000-0000-4000-8000-000000000101';
const externalId = '00000000-0000-4000-8000-000000000501';
const externalSuccessorId = '00000000-0000-4000-8000-000000000502';
const nextSuccessorId = '00000000-0000-4000-8000-000000000503';
const time = '2026-10-22T10:00:00Z';

const graphDialog = (page: Page) => page.getByRole('dialog', { name: 'Goal acceptance dependencies', exact: true });
const card = (dialog: Locator, id: string) => dialog.locator(`.react-flow__node[data-id="${id}"] .goal-acceptance-node`);
const edge = (dialog: Locator, source: string, target: string) => dialog.locator(`.task-dependency-edge[data-source="${source}"][data-target="${target}"]`);

const pendingFixtures = new Set<() => void>();
test.afterEach(() => { for (const release of pendingFixtures) release(); pendingFixtures.clear(); });

const install = async (page: Page, options: { external?: boolean; bulk?: boolean; cycle?: boolean; inspectionSaturation?: boolean } = {}) => {
  let details: TaskDetail[] = [
    detailFixture(projectId, activeId, { type: 'goal', title: 'Release client', status: 'in_progress', startedAt: time, ready: false, dependsOn: [doneId, cancelledId] }),
    detailFixture(projectId, doneId, { type: 'goal', title: 'Accepted identity', status: 'done', completedAt: time, ready: false }),
    detailFixture(projectId, cancelledId, { type: 'goal', title: 'Cancelled migration', status: 'cancelled', cancelledAt: time, ready: false }),
    detailFixture(projectId, isolatedId, { type: 'goal', title: 'Independent acceptance', ready: false }),
    detailFixture(projectId, unrelatedId, { type: 'goal', title: 'Unrelated finished Goal', status: 'done', completedAt: time, ready: false }),
    detailFixture(projectId, childId, { parentId: activeId, title: 'First child' }),
    detailFixture(projectId, secondChildId, { parentId: activeId, title: 'Second child', dependsOn: [childId], blockedBy: [childId], ready: false }),
  ];
  if (options.inspectionSaturation) {
    details = details.map(detail => detail.id === activeId ? { ...detail, dependsOn: [doneId, cancelledId, unrelatedId, fourthTerminalId] }
      : detail.id === isolatedId ? { ...detail, status: 'done', completedAt: time } : detail);
    details.push(detailFixture(projectId, fourthTerminalId, { type: 'goal', title: 'Accepted storage', status: 'done', completedAt: time, ready: false }));
  }
  if (options.cycle) details = details.map(detail => detail.id === isolatedId ? { ...detail, dependsOn: [activeId] } : detail);
  if (options.bulk) details.push(...Array.from({ length: 6 }, (_, index) => detailFixture(projectId,
    `00000000-0000-4000-8000-${String(600 + index).padStart(12, '0')}`, { type: 'goal', title: `Acceptance branch ${index + 1}`, ready: false })));
  const externalDetails = [
    detailFixture(externalProjectId, externalId, { type: 'goal', title: 'External authentication', status: 'in_progress', startedAt: time, ready: false }),
    detailFixture(externalProjectId, externalSuccessorId, { type: 'goal', title: 'External rollout', ready: false }),
    detailFixture(externalProjectId, nextSuccessorId, { type: 'goal', title: 'External second rollout', ready: false }),
  ];
  let syncDetails = details;
  let epoch = taskSyncEpoch(projectId);
  let failingSync = false;
  let rotationReads = 0;
  let holdReplacement = false;
  let releaseReplacement: (() => void) | null = null;
  const syncRequests: string[] = [];
  const relationRequests: string[] = [];
  const failedSources = new Set<string>(), failedPages = new Set<string>(), heldSources = new Set<string>();
  const heldReplies = new Map<string, () => void>();
  const heldPages = new Set<string>(), heldPageReplies = new Map<string, () => void>();
  const cancelledRequests: string[] = [];
  const revokedProjects = new Set<string>();
  const sourceReplies = new Map<string, (cursor: string | null) => GoalDependencies>();
  let relationInFlight = 0, maxRelationInFlight = 0;
  const related = (detail: TaskDetail, sourceProject = projectId): RelatedGoal => ({ projectId: detail.projectId, projectName: detail.projectId === projectId ? 'Client' : 'Authentication',
    goalId: detail.id, title: detail.title, status: detail.status as RelatedGoal['status'], kind: detail.projectId === sourceProject ? 'internal' : 'external' });
  const defaultRelations = (source: TaskDetail, cursor: string | null): GoalDependencies => {
    const peers = source.projectId === projectId ? syncDetails : externalDetails;
    const prerequisites = source.dependsOn.map(id => ({ target: related(peers.find(detail => detail.id === id)!, source.projectId) }));
    const successors = peers.filter(detail => detail.type === 'goal' && detail.dependsOn.includes(source.id)).map(detail => related(detail, source.projectId));
    if (options.external && source.id === activeId) {
      prerequisites.push({ target: related(externalDetails[0]!) });
      successors.push(related(externalDetails[cursor === null ? 1 : 2]!));
    }
    if (options.cycle && source.id === isolatedId) prerequisites.push({ target: related(externalDetails[0]!) });
    return { goalId: source.id, canEdit: false, completionBlocked: prerequisites.some(item => item.target.status !== 'done'), prerequisites, successors,
      nextCursor: options.external && source.id === activeId && cursor === null ? 'second-page' : null };
  };
  const unexpected: string[] = [];
  await page.clock.install({ time: new Date(time) });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  page.on('requestfailed', request => { if (new URL(request.url()).pathname.endsWith('/goal-dependencies')) cancelledRequests.push(request.url()); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body),
      headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    const fail = () => send({ error: { code: 'not_found', message: 'Not found', requestId: activeId } }, 404);
    const graph = graphFixture(syncDetails), base = `/api/v1/projects/${projectId}`;
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: teamId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project, ...(options.external ? [graphFixture(externalDetails).project] : [])], nextCursor: null });
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
      relationRequests.push(`${path}${url.search}`);
      const goalId = path.split('/').at(-2)!;
      const source = [...syncDetails, ...externalDetails].find(detail => detail.id === goalId);
      if (source === undefined) throw new Error(`Unexpected Goal relation source: ${goalId}`);
      const pageKey = `${goalId}:${url.searchParams.get('cursor')}`;
      if (heldPages.has(pageKey)) await new Promise<void>(resolve => { heldPageReplies.set(pageKey, resolve); });
      heldPageReplies.delete(pageKey);
      if (path !== `/api/v1/projects/${source.projectId}/tasks/${goalId}/goal-dependencies`) throw new Error(`Relationship request uses the wrong source Project: ${path}`);
      if (failedSources.has(goalId) || failedPages.has(`${goalId}:${url.searchParams.get('cursor')}`)) return send({ error: { code: 'unavailable', message: 'Temporarily unavailable', requestId: goalId } }, 503);
      const body = (sourceReplies.get(goalId) ?? (cursor => defaultRelations(source, cursor)))(url.searchParams.get('cursor'));
      relationInFlight++; maxRelationInFlight = Math.max(maxRelationInFlight, relationInFlight);
      try {
        if (heldSources.has(goalId)) await new Promise<void>(resolve => { heldReplies.set(goalId, resolve); });
        heldReplies.delete(goalId);
        return await send(body);
      } finally { relationInFlight--; }
    }
    const externalGraph = graphFixture(externalDetails), externalBase = `/api/v1/projects/${externalProjectId}`;
    if (path.startsWith(externalBase) && revokedProjects.has(externalProjectId)) return fail();
    if (path === externalBase) return send(externalGraph.project);
    if (path === `${externalBase}/access`) return send(directAccessFixture(externalProjectId));
    if (path === `${externalBase}/task-sync`) return send(taskSyncFixture(externalGraph, { query: taskSyncQuery(url), versionForTask: () => 1n }));
    if (path === `${externalBase}/tags`) return send({ items: [], catalogEpoch: taskSyncEpoch(externalProjectId), nextCursor: null });
    if (path === `${externalBase}/task-assignees`) return send({ items: [], unresolvedUserIds: [] });
    const externalDetail = externalDetails.find(detail => path === `${externalBase}/tasks/${detail.id}`);
    if (externalDetail !== undefined) return send(externalDetail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(externalProjectId) });
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
  const releaseAll = () => { heldSources.clear(); heldPages.clear(); for (const release of [...heldReplies.values(), ...heldPageReplies.values()]) release(); heldReplies.clear(); heldPageReplies.clear(); releaseReplacement?.(); };
  pendingFixtures.add(releaseAll);
  return {
    syncRequests, relationRequests, unexpected, cancelledRequests,
    externalGoal: related(externalDetails[0]!),
    relatedGoal: (id: string, sourceProject = projectId) => related([...syncDetails, ...externalDetails].find(detail => detail.id === id)!, sourceProject),
    versionOf: (id: string) => syncDetails.find(detail => detail.id === id)!.version,
    changeGoal: (id: string, patch: Partial<Pick<TaskDetail, 'title' | 'status' | 'dependsOn' | 'startedAt' | 'completedAt'>>) => {
      syncDetails = syncDetails.map(detail => detail.id === id ? { ...detail, ...patch, version: detail.version + 1n, updatedAt: '2026-10-22T10:01:00Z' } : detail);
      details = syncDetails;
    },
    maxRelationInFlight: () => maxRelationInFlight,
    sourceReply: (id: string, reply: (cursor: string | null) => GoalDependencies) => sourceReplies.set(id, reply),
    failSource: (id: string, fail: boolean) => { if (fail) failedSources.add(id); else failedSources.delete(id); },
    failPage: (id: string, cursor: string, fail: boolean) => { if (fail) failedPages.add(`${id}:${cursor}`); else failedPages.delete(`${id}:${cursor}`); },
    holdSource: (id: string) => heldSources.add(id),
    sourceHeld: (id: string) => heldReplies.has(id),
    releaseSource: (id: string) => { heldSources.delete(id); heldReplies.get(id)?.(); },
    holdPage: (id: string, cursor: string) => heldPages.add(`${id}:${cursor}`),
    pageHeld: (id: string, cursor: string) => heldPageReplies.has(`${id}:${cursor}`),
    releasePage: (id: string, cursor: string) => { const key = `${id}:${cursor}`; heldPages.delete(key); heldPageReplies.get(key)?.(); },
    holdAllRoots: () => { for (const detail of syncDetails) if (detail.type === 'goal' && ['todo', 'in_progress'].includes(detail.status)) heldSources.add(detail.id); },
    releaseAll,
    revokeExternal: () => revokedProjects.add(externalProjectId),
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
  await expect(dialog.locator('.goal-relation-source[data-phase="ready"]')).toHaveCount(2);
  const syncRequests = [...state.syncRequests];
  await card(dialog, doneId).locator('.task-node-body').click();
  await expect(sourceStatus(dialog, doneId)).toHaveAttribute('data-phase', 'ready');
  expect(sourceReads(state.relationRequests, doneId)).toHaveLength(1);
  expect(state.syncRequests).toEqual(syncRequests);
  if (fullscreen) {
    await dialog.getByRole('button', { name: 'View fullscreen', exact: true }).click();
    await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
  }
  await card(dialog, activeId).locator('.task-node-body').click();
  const inspection = dialog.locator('.goal-acceptance-inspection');
  const prerequisite = inspection.getByRole('button', { name: 'Accepted identity', exact: true });
  const requests = [...state.syncRequests], viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  const relationRequests = [...state.relationRequests];
  await prerequisite.focus();
  await prerequisite.press('Enter');
  await expect(card(dialog, doneId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(inspection.getByRole('heading', { name: 'Accepted identity', exact: true })).toBeFocused();
  await expect(viewport).toHaveAttribute('style', position!);
  expect(state.syncRequests).toEqual(requests);
  expect(state.relationRequests).toEqual(relationRequests);
  expect(sourceReads(state.relationRequests, doneId)).toHaveLength(1);
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

const sourceStatus = (dialog: Locator, id: string) => dialog.locator(`.goal-relation-source[data-goal-id="${id}"]`);
const retryRelations = (dialog: Locator, title: string) => dialog.getByRole('button', { name: `Retry relationships: ${title}`, exact: true });
const relationPath = (goalId: string) => `/api/v1/projects/${projectId}/tasks/${goalId}/goal-dependencies`;

test('direct external context loads after the project graph and follows source pages sequentially', async ({ page }) => {
  const state = await install(page, { external: true });
  state.holdSource(activeId);
  const { dialog } = await open(page, state.syncRequests);
  await expect.poll(() => state.sourceHeld(activeId)).toBe(true);
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  await expect(card(dialog, externalId)).toHaveCount(0);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'loading');
  const reads = state.syncRequests.length;
  state.releaseSource(activeId);
  await expect(card(dialog, externalId)).toBeVisible();
  await expect(card(dialog, externalId)).toContainText('Authentication');
  await expect(edge(dialog, externalId, activeId)).toHaveAttribute('data-external', 'true');
  await expect(edge(dialog, activeId, externalSuccessorId)).toHaveCount(1);
  await expect(edge(dialog, activeId, nextSuccessorId)).toHaveCount(1);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  const requests = state.relationRequests.filter(value => value.startsWith(relationPath(activeId)));
  expect(requests.map(value => new URL(value, 'https://fixture.invalid').searchParams.get('cursor'))).toEqual([null, 'second-page']);
  expect(requests.every(value => new URL(value, 'https://fixture.invalid').searchParams.get('limit') === '20')).toBe(true);
  expect(state.syncRequests).toHaveLength(reads);
});

test('root relationship reads keep a finite concurrency bound while retaining the immediate project graph', async ({ page }) => {
  const state = await install(page, { bulk: true });
  state.holdAllRoots();
  const { dialog } = await open(page, state.syncRequests);
  await expect.poll(() => state.relationRequests.length).toBe(4);
  await expect(card(dialog, activeId)).toBeVisible();
  expect(state.maxRelationInFlight()).toBeLessThanOrEqual(4);
  await expect(dialog.locator('.goal-relation-source[data-phase="queued"]')).toHaveCount(4);
  const reads = state.syncRequests.length;
  state.releaseAll();
  await expect(dialog.locator('.goal-relation-source[data-phase="ready"]')).toHaveCount(8);
  expect(state.maxRelationInFlight()).toBeLessThanOrEqual(4);
  expect(state.syncRequests).toHaveLength(reads);
});

test('a failed successor page leaves partial context visible and retries the source without TaskSync', async ({ page }) => {
  const state = await install(page, { external: true });
  state.failPage(activeId, 'second-page', true);
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'failed');
  await expect(card(dialog, externalId)).toBeVisible();
  await expect(edge(dialog, activeId, externalSuccessorId)).toHaveCount(1);
  await expect(card(dialog, nextSuccessorId)).toHaveCount(0);
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  const reads = state.syncRequests.length;
  state.failPage(activeId, 'second-page', false);
  await retryRelations(dialog, 'Release client').click();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(edge(dialog, activeId, nextSuccessorId)).toHaveCount(1);
  expect(state.syncRequests).toHaveLength(reads);
});

test('an implicit unavailable prerequisite displays a warning without exposing a peer identity', async ({ page }) => {
  const state = await install(page, { external: true });
  state.sourceReply(activeId, () => ({ goalId: activeId, canEdit: false, completionBlocked: true, prerequisites: [{ target: null }], successors: [], nextCursor: null }));
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await card(dialog, activeId).locator('.task-node-body').click();
  await expect(dialog).toContainText('You cannot access');
  await expect(card(dialog, externalId)).toHaveCount(0);
  await expect(dialog).not.toContainText('External authentication');
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
});

test('independently observed reversed external edges cannot replace the legal project graph with a cycle', async ({ page }) => {
  const state = await install(page, { external: true, cycle: true });
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(sourceStatus(dialog, isolatedId)).toHaveAttribute('data-phase', 'ready');
  await expect(edge(dialog, activeId, isolatedId)).toHaveCount(1);
  await expect(edge(dialog, externalId, activeId)).toHaveCount(1);
  await card(dialog, activeId).locator('.task-node-body').click();
  const viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  const reads = state.syncRequests.length;
  state.sourceReply(isolatedId, () => ({ goalId: isolatedId, canEdit: false, completionBlocked: false, prerequisites: [], successors: [state.externalGoal], nextCursor: null }));
  await retryRelations(dialog, 'Independent acceptance').click();
  await expect(sourceStatus(dialog, isolatedId)).toHaveAttribute('data-phase', 'conflict');
  await expect(sourceStatus(dialog, isolatedId)).toContainText('conflict');
  await expect(edge(dialog, isolatedId, externalId)).toHaveCount(0);
  await expect(edge(dialog, activeId, isolatedId)).toHaveCount(1);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).toHaveAttribute('style', position!);
  expect(state.syncRequests).toHaveLength(reads);
});

test('closing the graph aborts its held relation request and creates no TaskSync request', async ({ page }) => {
  const state = await install(page, { external: true });
  state.holdSource(activeId);
  const { dialog, trigger } = await open(page, state.syncRequests);
  await expect.poll(() => state.sourceHeld(activeId)).toBe(true);
  const reads = state.syncRequests.length;
  await dialog.getByRole('button', { name: 'Close acceptance graph', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.cancelledRequests.some(value => value.includes(relationPath(activeId)))).toBe(true);
  state.releaseSource(activeId);
  await expect(trigger).toBeFocused();
  expect(state.syncRequests).toHaveLength(reads);
});

test('credible peer withdrawal removes cards and rejects a late relationship response', async ({ page }) => {
  const state = await install(page, { external: true });
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(card(dialog, externalId)).toBeVisible();
  const peer = await page.context().newPage();
  try {
    const peerState = await install(peer, { external: true });
    await peer.goto(`/projects/${externalProjectId}/tasks/${externalId}`);
    await expect(peer.locator('.task-detail-title')).toHaveText('External authentication');
    await page.bringToFront();
    await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
    state.holdSource(activeId);
    await retryRelations(dialog, 'Release client').click();
    await expect.poll(() => state.sourceHeld(activeId)).toBe(true);
    peerState.revokeExternal();
    await peer.clock.fastForward(61_000);
    await expect(peer.locator('.goal-detail-surface .goal-information')).toHaveCount(0);
    await expect(card(dialog, externalId)).toHaveCount(0);
    await expect(edge(dialog, externalId, activeId)).toHaveCount(0);
    state.releaseSource(activeId);
    await page.bringToFront();
    await expect(card(dialog, externalId)).toHaveCount(0);
    await expect(dialog).not.toContainText('External authentication');
    await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  } finally { await peer.close(); }
});

test('refreshing a complete paginated source retains its selected last-page Goal and Details until a complete replacement', async ({ page }) => {
  const state = await install(page, { external: true }), { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await card(dialog, activeId).locator('.task-node-body').click();
  const inspector = dialog.locator('.goal-acceptance-inspection');
  await inspector.getByRole('button', { name: 'External second rollout', exact: true }).click();
  await expect(card(dialog, nextSuccessorId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  state.sourceReply(activeId, cursor => ({ goalId: activeId, canEdit: false, completionBlocked: true,
    prerequisites: [{ target: state.externalGoal }], successors: cursor === null ? [state.relatedGoal(externalSuccessorId)] : [], nextCursor: cursor === null ? 'second-page' : null }));
  state.holdSource(activeId);
  state.holdPage(activeId, 'second-page');
  await retryRelations(dialog, 'Release client').click();
  await expect.poll(() => state.sourceHeld(activeId)).toBe(true);
  await inspector.getByRole('button', { name: 'Details', exact: true }).click();
  const reader = page.locator('.goal-detail-surface');
  await expect(reader.locator('.task-detail-title')).toHaveText('External second rollout');
  const readerNode = await reader.elementHandle(), requests = [...state.syncRequests];
  state.releaseSource(activeId);
  await expect.poll(() => state.pageHeld(activeId, 'second-page')).toBe(true);
  await expect(card(dialog, nextSuccessorId)).toHaveCount(1);
  await expect(edge(dialog, activeId, nextSuccessorId)).toHaveCount(1);
  await expect(card(dialog, nextSuccessorId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(await reader.evaluate((node, original) => node === original, readerNode)).toBe(true);
  state.failPage(activeId, 'second-page', true);
  state.releasePage(activeId, 'second-page');
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'failed');
  await expect(reader.locator('.task-detail-title')).toHaveText('External second rollout');
  await expect(edge(dialog, activeId, nextSuccessorId)).toHaveCount(1);
  await expect(card(dialog, nextSuccessorId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(state.syncRequests).toEqual(requests);
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  state.failPage(activeId, 'second-page', false);
  state.holdPage(activeId, 'second-page');
  await retryRelations(dialog, 'Release client').click();
  await expect.poll(() => state.pageHeld(activeId, 'second-page')).toBe(true);
  await expect(card(dialog, nextSuccessorId)).toHaveCount(1);
  await inspector.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(reader.locator('.task-detail-title')).toHaveText('External second rollout');
  state.releasePage(activeId, 'second-page');
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(card(dialog, nextSuccessorId)).toHaveCount(0);
  await expect(edge(dialog, activeId, nextSuccessorId)).toHaveCount(0);
  await expect(reader).toHaveCount(0);
  expect(state.syncRequests).toEqual(requests);
});

test('local inspection follows other Goals committed TaskSync changes while the selected source raw relationships remain cached', async ({ page }) => {
  const state = await install(page, { external: true });
  state.changeGoal(unrelatedId, { dependsOn: [activeId] });
  let cacheLocalSuccessor = false;
  state.sourceReply(activeId, () => ({ goalId: activeId, canEdit: false, completionBlocked: true,
    prerequisites: [{ target: state.relatedGoal(doneId) }, { target: state.relatedGoal(cancelledId) }, { target: state.externalGoal }],
    successors: [state.relatedGoal(unrelatedId), state.relatedGoal(externalSuccessorId), ...(cacheLocalSuccessor ? [state.relatedGoal(isolatedId)] : [])], nextCursor: null }));
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await card(dialog, activeId).locator('.task-node-body').click();
  const inspector = dialog.locator('.goal-acceptance-inspection');
  const successors = inspector.locator('section').filter({ has: page.getByRole('heading', { name: 'Dependent Goals', exact: true }) });
  await expect(successors.getByRole('button', { name: 'Unrelated finished Goal', exact: true })).toBeVisible();
  await expect(card(dialog, unrelatedId)).toHaveCount(0);
  const sourceReads = () => state.relationRequests.filter(value => value.startsWith(relationPath(activeId))).length;
  const originalReads = sourceReads(), version = state.versionOf(activeId);
  state.changeGoal(isolatedId, { dependsOn: [activeId], title: 'Renamed acceptance', status: 'in_progress', startedAt: time });
  await page.clock.fastForward(16_000);
  await expect(edge(dialog, activeId, isolatedId)).toHaveCount(1);
  await expect(successors.getByRole('button', { name: 'Renamed acceptance', exact: true })).toBeVisible();
  await expect(successors).toContainText('In progress');
  expect(sourceReads()).toBe(originalReads);
  expect(state.versionOf(activeId)).toBe(version);
  cacheLocalSuccessor = true;
  await retryRelations(dialog, 'Release client').click();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  const cachedReads = sourceReads();
  state.changeGoal(isolatedId, { dependsOn: [], title: 'Changed independent acceptance' });
  state.changeGoal(doneId, { title: 'Current accepted identity' });
  await page.clock.fastForward(16_000);
  await expect(edge(dialog, activeId, isolatedId)).toHaveCount(0);
  await expect(successors.getByRole('button', { name: 'Renamed acceptance', exact: true })).toHaveCount(0);
  await expect(successors.getByRole('button', { name: 'Changed independent acceptance', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Current accepted identity', exact: true })).toBeVisible();
  await expect(successors.getByRole('button', { name: 'Unrelated finished Goal', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'External authentication', exact: true })).toBeVisible();
  await expect(successors.getByRole('button', { name: 'External rollout', exact: true })).toBeVisible();
  expect(sourceReads()).toBe(cachedReads);
  expect(state.versionOf(activeId)).toBe(version);
});

test('a complete same-source refresh may reverse an external edge without conflicting with its replaced contribution', async ({ page }) => {
  const state = await install(page, { external: true }), { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(edge(dialog, externalId, activeId)).toHaveCount(1);
  state.sourceReply(activeId, () => ({ goalId: activeId, canEdit: false, completionBlocked: false, prerequisites: [], successors: [state.externalGoal], nextCursor: null }));
  const requests = [...state.syncRequests];
  await retryRelations(dialog, 'Release client').click();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(edge(dialog, externalId, activeId)).toHaveCount(0);
  await expect(edge(dialog, activeId, externalId)).toHaveCount(1);
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  expect(state.syncRequests).toEqual(requests);
});

test('a stable prerequisite edge becoming hidden retires its Goal and Details before refresh completes and rejects late peer context', async ({ page }) => {
  const state = await install(page, { external: true });
  const edgeId = '00000000-0000-4000-8000-000000000801';
  state.sourceReply(activeId, cursor => ({ goalId: activeId, canEdit: true, revision: '1', completionBlocked: true,
    prerequisites: [{ edgeId, target: state.externalGoal }], successors: cursor === null ? [state.relatedGoal(externalSuccessorId)] : [], nextCursor: cursor === null ? 'second-page' : null }));
  state.sourceReply(isolatedId, () => ({ goalId: isolatedId, canEdit: false, completionBlocked: true, prerequisites: [{ target: state.externalGoal }], successors: [], nextCursor: null }));
  state.holdSource(isolatedId);
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect.poll(() => state.sourceHeld(isolatedId)).toBe(true);
  await card(dialog, activeId).locator('.task-node-body').click();
  const inspector = dialog.locator('.goal-acceptance-inspection');
  await inspector.getByRole('button', { name: 'External authentication', exact: true }).click();
  state.sourceReply(activeId, cursor => ({ goalId: activeId, canEdit: true, revision: '1', completionBlocked: true,
    prerequisites: [{ edgeId, target: null }], successors: cursor === null ? [state.relatedGoal(externalSuccessorId)] : [], nextCursor: cursor === null ? 'second-page' : null }));
  state.holdSource(activeId);
  state.holdPage(activeId, 'second-page');
  await retryRelations(dialog, 'Release client').click();
  await expect.poll(() => state.sourceHeld(activeId)).toBe(true);
  await inspector.getByRole('button', { name: 'Details', exact: true }).click();
  const reader = page.locator('.goal-detail-surface');
  await expect(reader.locator('.task-detail-title')).toHaveText('External authentication');
  const requests = [...state.syncRequests];
  state.releaseSource(activeId);
  await expect.poll(() => state.pageHeld(activeId, 'second-page')).toBe(true);
  await expect(card(dialog, externalId)).toHaveCount(0);
  await expect(edge(dialog, externalId, activeId)).toHaveCount(0);
  await expect(reader).toHaveCount(0);
  await expect(dialog).not.toContainText('External authentication');
  await expect(sourceStatus(dialog, activeId)).toContainText('You cannot access 1 prerequisite Goals');
  await expect(card(dialog, isolatedId)).toHaveCount(1);
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  state.failPage(activeId, 'second-page', true);
  state.releasePage(activeId, 'second-page');
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'failed');
  await expect(card(dialog, externalSuccessorId)).toHaveCount(1);
  await expect(card(dialog, externalId)).toHaveCount(0);
  await expect(reader).toHaveCount(0);
  state.releaseSource(isolatedId);
  await expect.poll(() => state.sourceHeld(isolatedId)).toBe(false);
  await expect(sourceStatus(dialog, isolatedId)).not.toHaveAttribute('data-phase', 'loading');
  await expect(card(dialog, externalId)).toHaveCount(0);
  await expect(edge(dialog, externalId, isolatedId)).toHaveCount(0);
  await expect(dialog).not.toContainText('External authentication');
  await expect(sourceStatus(dialog, activeId)).toContainText('You cannot access 1 prerequisite Goals');
  expect(state.syncRequests).toEqual(requests);
});

const expandRelations = (dialog: Locator, title: string) => dialog.getByRole('button', { name: `Expand relationships: ${title}`, exact: true });
const sourceReads = (requests: readonly string[], id: string) => requests.filter(value => value.includes(`/tasks/${id}/goal-dependencies`));
const frameBranch = async (page: Page, dialog: Locator) => {
  await dialog.getByRole('button', { name: 'Show all Goals', exact: true }).click();
  await page.clock.runFor(300);
};
const prepareBranch = async (page: Page) => {
  const state = await install(page, { external: true });
  state.sourceReply(activeId, () => ({ goalId: activeId, canEdit: false, completionBlocked: true, prerequisites: [{ target: state.externalGoal }], successors: [], nextCursor: null }));
  state.sourceReply(externalId, () => ({ goalId: externalId, canEdit: false, completionBlocked: true,
    prerequisites: [{ target: state.relatedGoal(externalSuccessorId, externalProjectId) }], successors: [state.relatedGoal(activeId, externalProjectId)], nextCursor: null }));
  return state;
};

test('expanding a foreign Goal reads its real Project and retains a second-hop edge internal to that Project', async ({ page }) => {
  const state = await prepareBranch(page), { dialog, trigger } = await open(page, state.syncRequests);
  await expect(card(dialog, externalId)).toBeVisible();
  await expect(card(dialog, externalSuccessorId)).toHaveCount(0);
  await frameBranch(page, dialog);
  const reads = [...state.syncRequests];
  await card(dialog, activeId).locator('.task-node-body').click();
  await dialog.locator('.react-flow__controls-zoomout').click();
  await page.clock.runFor(300);
  const viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  await expandRelations(dialog, 'External authentication').click();
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-mode', 'expanded');
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-phase', 'ready');
  await expect(card(dialog, externalSuccessorId)).toBeVisible();
  await expect(edge(dialog, externalSuccessorId, externalId)).toHaveAttribute('data-external', 'true');
  await expect(edge(dialog, externalId, activeId)).toHaveCount(1);
  expect(sourceReads(state.relationRequests, externalId)).toEqual([`/api/v1/projects/${externalProjectId}/tasks/${externalId}/goal-dependencies?limit=20`]);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).toHaveAttribute('style', position!);
  await expandRelations(dialog, 'External authentication').click();
  expect(sourceReads(state.relationRequests, externalId)).toHaveLength(1);
  expect(state.syncRequests).toEqual(reads);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(state.syncRequests).toEqual(reads);
});

test('an uncovered inspection source upgrades its in-flight read to expansion without extending the canvas early', async ({ page }) => {
  const state = await prepareBranch(page);
  state.holdSource(externalId);
  const { dialog } = await open(page, state.syncRequests);
  await expect(card(dialog, externalId)).toBeVisible();
  await frameBranch(page, dialog);
  const reads = [...state.syncRequests];
  await card(dialog, externalId).locator('.task-node-body').click();
  await expect.poll(() => state.sourceHeld(externalId)).toBe(true);
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-mode', 'inspection');
  await expect(card(dialog, externalSuccessorId)).toHaveCount(0);
  const viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  await expandRelations(dialog, 'External authentication').click();
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-mode', 'expanded');
  expect(sourceReads(state.relationRequests, externalId)).toHaveLength(1);
  state.releaseSource(externalId);
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-phase', 'ready');
  await expect(edge(dialog, externalSuccessorId, externalId)).toHaveCount(1);
  await expect(card(dialog, externalId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).toHaveAttribute('style', position!);
  expect(sourceReads(state.relationRequests, externalId)).toHaveLength(1);
  expect(state.syncRequests).toEqual(reads);
});

test('completed inspection pages are reused on expansion and repeated expansion', async ({ page }) => {
  const state = await prepareBranch(page), { dialog } = await open(page, state.syncRequests);
  await expect(card(dialog, externalId)).toBeVisible();
  await frameBranch(page, dialog);
  const reads = [...state.syncRequests];
  await card(dialog, externalId).locator('.task-node-body').click();
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-phase', 'ready');
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-mode', 'inspection');
  await expect(card(dialog, externalSuccessorId)).toHaveCount(0);
  await expect(dialog.locator('.goal-acceptance-inspection')).toContainText('External rollout');
  await expandRelations(dialog, 'External authentication').click();
  await expect(card(dialog, externalSuccessorId)).toBeVisible();
  await expandRelations(dialog, 'External authentication').click();
  expect(sourceReads(state.relationRequests, externalId)).toHaveLength(1);
  expect(state.syncRequests).toEqual(reads);
});

test('expanded branches survive one root withdrawal and prune only after losing every root path', async ({ page }) => {
  const state = await prepareBranch(page);
  state.sourceReply(isolatedId, () => ({ goalId: isolatedId, canEdit: false, completionBlocked: true, prerequisites: [{ target: state.externalGoal }], successors: [], nextCursor: null }));
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, isolatedId)).toHaveAttribute('data-phase', 'ready');
  await frameBranch(page, dialog);
  await expandRelations(dialog, 'External authentication').click();
  await expect(card(dialog, externalSuccessorId)).toBeVisible();
  await card(dialog, activeId).locator('.task-node-body').click();
  const viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  const reads = [...state.syncRequests];
  const empty = (id: string): GoalDependencies => ({ goalId: id, canEdit: false, completionBlocked: false, prerequisites: [], successors: [], nextCursor: null });
  state.sourceReply(activeId, () => empty(activeId));
  await retryRelations(dialog, 'Release client').click();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(dialog.locator('.goal-acceptance-inspection')).not.toContainText('External authentication');
  await expect(edge(dialog, externalId, isolatedId)).toHaveCount(1);
  await expect(edge(dialog, externalSuccessorId, externalId)).toHaveCount(1);
  state.sourceReply(isolatedId, () => empty(isolatedId));
  await retryRelations(dialog, 'Independent acceptance').click();
  await expect(card(dialog, externalId)).toHaveCount(0);
  await expect(card(dialog, externalSuccessorId)).toHaveCount(0);
  await expect(sourceStatus(dialog, externalId)).toHaveCount(0);
  await expect(edge(dialog, doneId, activeId)).toHaveCount(1);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(viewport).toHaveAttribute('style', position!);
  expect(state.syncRequests).toEqual(reads);
});

test('external Details remains clickable beside Expand and returns to the same Goal graph', async ({ page }) => {
  const state = await prepareBranch(page), { dialog } = await open(page, state.syncRequests);
  await expect(card(dialog, externalId)).toBeVisible();
  await frameBranch(page, dialog);
  const details = dialog.getByRole('button', { name: 'Details: External authentication', exact: true });
  await details.click();
  const reader = page.locator('.goal-detail-surface');
  await expect(reader.locator('.task-detail-title')).toHaveText('External authentication');
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(details).toBeFocused();
  const requests = [...state.syncRequests];
  await expandRelations(dialog, 'External authentication').click();
  await expect(edge(dialog, externalSuccessorId, externalId)).toHaveCount(1);
  expect(state.syncRequests).toEqual(requests);
});

test('removing synchronized local prerequisites cancels abandoned inspections and admits new roots before held responses finish', async ({ page }) => {
  const state = await install(page, { inspectionSaturation: true });
  const terminals = [doneId, cancelledId, unrelatedId, fourthTerminalId];
  for (const id of terminals) state.holdSource(id);
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await frameBranch(page, dialog);
  for (const id of terminals) {
    await card(dialog, id).locator('.task-node-body').click();
    await expect.poll(() => state.sourceHeld(id)).toBe(true);
    await expect(sourceStatus(dialog, id)).toHaveAttribute('data-mode', 'inspection');
  }
  state.changeEdges([]);
  state.changeGoal(isolatedId, { status: 'todo', completedAt: null });
  await page.clock.runFor(30_000);
  await expect(card(dialog, isolatedId)).toBeVisible();
  for (const id of terminals) {
    await expect.poll(() => state.cancelledRequests.some(url => new URL(url).pathname.endsWith(`/${id}/goal-dependencies`))).toBe(true);
    await expect(card(dialog, id)).toHaveCount(0);
    await expect(sourceStatus(dialog, id)).toHaveCount(0);
    expect(state.sourceHeld(id)).toBe(true);
  }
  await expect(sourceStatus(dialog, isolatedId)).toHaveAttribute('data-phase', 'ready');
  await expect.poll(() => sourceReads(state.relationRequests, activeId).length).toBe(2);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  const requests = [...state.syncRequests];
  for (const id of terminals) state.releaseSource(id);
  await expect(card(dialog, isolatedId)).toBeVisible();
  await expect(dialog.locator('.goal-acceptance-node')).toHaveCount(2);
  expect(state.syncRequests).toEqual(requests);
});

test('an expanded foreign successor cannot retain a withdrawn local terminal Goal while its root refresh fails', async ({ page }) => {
  const state = await install(page, { external: true });
  state.changeEdges([doneId]);
  const completedForeign = { ...state.externalGoal, status: 'done' as const };
  state.sourceReply(activeId, () => ({ goalId: activeId, canEdit: false, completionBlocked: false,
    prerequisites: [{ target: state.relatedGoal(doneId) }, { target: completedForeign }], successors: [], nextCursor: null }));
  state.sourceReply(externalId, () => ({ goalId: externalId, canEdit: false, completionBlocked: false, prerequisites: [],
    successors: [state.relatedGoal(activeId, externalProjectId), state.relatedGoal(doneId, externalProjectId)], nextCursor: null }));
  const { dialog } = await open(page, state.syncRequests);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await frameBranch(page, dialog);
  await expandRelations(dialog, 'External authentication').click();
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-phase', 'ready');
  await expect(card(dialog, externalId)).toHaveAttribute('data-goal-status', 'done');
  await card(dialog, doneId).locator('.task-node-body').click();
  await expect(sourceStatus(dialog, doneId)).toHaveAttribute('data-mode', 'inspection');
  await expect(sourceStatus(dialog, doneId)).toHaveAttribute('data-phase', 'ready');
  state.failSource(activeId, true);
  state.changeEdges([]);
  await page.clock.runFor(30_000);
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'failed');
  await expect(sourceStatus(dialog, doneId)).toHaveCount(0);
  await expect(card(dialog, doneId)).toHaveCount(0);
  await expect(edge(dialog, externalId, doneId)).toHaveCount(0);
  await expect(edge(dialog, externalId, activeId)).toHaveCount(1);
  const requests = [...state.syncRequests];
  await card(dialog, externalId).locator('.task-node-body').click();
  await expect(dialog.locator('.goal-acceptance-inspection h3')).toHaveText('External authentication');
  await card(dialog, activeId).locator('.task-node-body').click();
  await expect(dialog.locator('.goal-acceptance-inspection h3')).toHaveText('Release client');
  await expect(dialog.locator('.goal-acceptance-inspection')).toContainText('External authentication');
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'failed');
  expect(state.syncRequests).toEqual(requests);
});
