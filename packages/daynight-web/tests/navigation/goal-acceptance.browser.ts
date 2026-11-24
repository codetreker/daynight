import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TaskDetail } from '../../src/api/types';
import type { GoalDependencies, RelatedGoal } from '../../src/api/goal-dependencies';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { unsupportedSessionObservation } from '../../../daynight/src/api/task-observation';

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
const externalChildId = '00000000-0000-4000-8000-000000000504';
const time = '2026-10-22T10:00:00Z';

const graphDialog = (page: Page) => page.getByRole('dialog', { name: 'Goal acceptance dependencies', exact: true });
const card = (dialog: Locator, id: string) => dialog.locator(`.react-flow__node[data-id="${id}"] .goal-acceptance-node`);
const edge = (dialog: Locator, source: string, target: string) => dialog.locator(`.task-dependency-edge[data-source="${source}"][data-target="${target}"]`);

const pendingFixtures = new Set<() => void>();
test.afterEach(() => { for (const release of pendingFixtures) release(); pendingFixtures.clear(); });

const install = async (page: Page, options: { external?: boolean; bulk?: boolean; cycle?: boolean; inspectionSaturation?: boolean; empty?: boolean } = {}) => {
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
    detailFixture(externalProjectId, externalChildId, { parentId: externalId, title: 'Owned authentication task', status: 'in_progress', startedAt: time, ready: false }),
  ];
  if (options.empty) details = [detailFixture(projectId, childId, { title: 'Independent task' })];
  let syncDetails = details;
  let epoch = taskSyncEpoch(projectId);
  let failingSync = false;
  let rotationReads = 0;
  let holdReplacement = false;
  let releaseReplacement: (() => void) | null = null;
  const syncRequests: string[] = [];
  const relationRequests: string[] = [];
  const tagRequests: string[] = [];
  const failedSources = new Set<string>(), failedPages = new Set<string>(), heldSources = new Set<string>();
  const heldReplies = new Map<string, () => void>();
  const heldPages = new Set<string>(), heldPageReplies = new Map<string, () => void>();
  const cancelledRequests: string[] = [];
  const revokedProjects = new Set<string>();
  const deniedGoals = new Set<string>();
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
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.stack ?? error.message));
  await page.clock.install({ time: new Date(time) });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  page.on('requestfailed', request => { if (new URL(request.url()).pathname.endsWith('/goal-dependencies')) cancelledRequests.push(request.url()); });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.endsWith('/tags')) tagRequests.push(`${path}${url.search}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body),
      headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    const fail = () => send({ error: { code: 'not_found', message: 'Not found', requestId: activeId } }, 404);
    const graph = graphFixture(syncDetails), base = `/api/v1/projects/${projectId}`;
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: teamId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/me/in-progress-tasks') return send({ observedAt: time, responseTaskAt: time, responseSessionAt: time, inventoryRevision: 'a'.repeat(64), totalTaskCount: 1, totalProjectCount: 1, sessionPartial: false, nextCursor: null,
      items: [{ project: { id: externalProjectId, name: 'Authentication', ownerTeam: { id: teamId, kind: 'personal', name: null }, executionWarningMinutes: 120, matchedTaskCount: 1 },
        task: { id: externalChildId, version: '1', title: 'Owned authentication task', status: 'in_progress', startedAt: time, createdAt: time, requiredPlatform: null, tags: [], blockedBy: [], ready: false, allowAgents: false, paused: false, worker: null, goal: { id: externalId, title: 'External authentication' } },
        session: { ...unsupportedSessionObservation(), observation: 'observed', registration: 'not_applicable', reason: 'no_execution', error: null, observedAt: time, freshUntil: '2026-10-22T11:00:00Z' },
        sessionRow: { taskVersion: '1', state: 'no_session', observedAt: time, freshUntil: '2026-10-22T11:00:00Z', needsAttention: false, canOpen: false } }] });
    if (path === '/api/v1/projects') return send({ items: [graph.project, ...(options.external ? [graphFixture(externalDetails).project] : [])], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ id: teamId, kind: 'personal', name: null, version: 1n, createdAt: time, updatedAt: time,
      membership: { teamId, userId: TEST_VIEWER_ID, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path.startsWith(base) && revokedProjects.has(projectId)) return fail();
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
      if (deniedGoals.has(goalId)) return fail();
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
    if (path === `${externalBase}/task-sync`) { syncRequests.push(`${path}${url.search}`); return send(taskSyncFixture(externalGraph, { query: taskSyncQuery(url), versionForTask: () => 1n })); }
    if (path === `${externalBase}/tags`) return send({ items: [], catalogEpoch: taskSyncEpoch(externalProjectId), nextCursor: null });
    if (path === `${externalBase}/task-assignees`) return send({ items: [], unresolvedUserIds: [] });
    const externalDetail = externalDetails.find(detail => path === `${externalBase}/tasks/${detail.id}`);
    if (externalDetail !== undefined) return send(externalDetail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(externalProjectId) });
    const detail = details.find(detail => path === `${base}/tasks/${detail.id}`);
    if (detail !== undefined) {
      if (deniedGoals.has(detail.id)) return fail();
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
    syncRequests, relationRequests, tagRequests, unexpected, cancelledRequests, pageErrors,
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
    revokeProject: () => revokedProjects.add(projectId),
    denyGoal: (id: string) => deniedGoals.add(id),
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

test('project history retirement removes its graph and nested detail until an explicit fresh entry', async ({ page }) => {
  const state = await install(page), { dialog } = await open(page, state.syncRequests);
  state.holdSource(doneId);
  await card(dialog, doneId).locator('.task-node-body').click();
  await expect.poll(() => state.sourceHeld(doneId)).toBe(true);
  await card(dialog, activeId).locator('.task-node-body').click();
  const oldDialog = await dialog.elementHandle();
  await dialog.getByRole('button', { name: 'Details: Release client', exact: true }).click();
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Release client');
  state.rotateEpoch();
  await page.clock.fastForward(16_000);
  await expect.poll(state.replacementHeld).toBe(true);
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  expect(await oldDialog!.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.getByRole('status', { name: 'Loading task graph', exact: true })).toBeVisible();
  await expect.poll(() => state.cancelledRequests.some(url => new URL(url).pathname.endsWith(`/${doneId}/goal-dependencies`))).toBe(true);
  state.releaseSource(doneId);
  state.releaseReplacement();
  await expect(page.getByRole('status', { name: 'Loading task graph', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Goals/ }).click();
  const trigger = page.getByRole('button', { name: 'Acceptance graph', exact: true });
  await expect(trigger).toBeEnabled();
  await expect(dialog).toHaveCount(0);
  const requests = [...state.syncRequests];
  await trigger.click();
  await expect(card(dialog, activeId)).toContainText('0 / 1 child Tasks done');
  expect(await dialog.evaluate((node, original) => node === original, oldDialog)).toBe(false);
  await card(dialog, activeId).locator('.task-node-body').click();
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(state.syncRequests).toEqual(requests);
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
  expect(state.syncRequests).toEqual(requests);
  await inspector.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(reader.locator('.task-detail-title')).toHaveText('External second rollout');
  await expect(detailGraphButton(reader)).toBeEnabled();
  await expect.poll(() => state.syncRequests.length).toBe(requests.length + 1);
  const readerReentry = state.syncRequests.at(-1)!;
  expect(readerReentry).toMatch(new RegExp(`^/api/v1/projects/${externalProjectId}/task-sync\\?epoch=.+&since=`));
  expect(state.syncRequests.filter(value => value.startsWith(`/api/v1/projects/${projectId}/task-sync`))).toEqual(requests.filter(value => value.startsWith(`/api/v1/projects/${projectId}/task-sync`)));
  const reopenedRequests = [...state.syncRequests];
  state.releasePage(activeId, 'second-page');
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  await expect(card(dialog, nextSuccessorId)).toHaveCount(0);
  await expect(edge(dialog, activeId, nextSuccessorId)).toHaveCount(0);
  await expect(reader).toHaveCount(0);
  expect(state.syncRequests).toEqual(reopenedRequests);
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

const detailGraphButton = (detail: Locator) => detail.locator('.goal-information').getByRole('button', { name: 'Acceptance graph', exact: true });
const goalSurface = async (page: Page, title: string) => {
  const heading = page.locator('.goal-detail-surface:not([inert]) .task-detail-title').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  await expect(heading).toHaveCount(1);
  const id = await heading.getAttribute('id');
  if (id === null) throw new Error('Goal reader heading has no identity.');
  return page.locator(`.goal-detail-surface:has(.task-detail-title[id="${id}"])`);
};
const openProjectGoal = async (page: Page) => {
  await page.goto(`/projects/${projectId}?tab=tasks`);
  await page.getByRole('tab', { name: /^Goals/ }).click();
  await page.getByRole('button', { name: 'Release client, Goal details', exact: true }).click();
  const detail = page.locator('.goal-detail-surface').last();
  await expect(detail.locator('.task-detail-title')).toHaveText('Release client');
  await expect(detailGraphButton(detail)).toBeEnabled();
  return detail;
};

test('Project Goal description opens the focused graph and preserves its background reader, list, and sync schedule', async ({ page }) => {
  const state = await install(page), detail = await openProjectGoal(page), button = detailGraphButton(detail);
  const list = page.getByRole('region', { name: 'Goals', exact: true }), listNode = await list.elementHandle(), detailNode = await detail.elementHandle();
  const url = page.url(), requests = [...state.syncRequests];
  await button.click();
  const dialog = graphDialog(page);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(await detail.evaluate((node, original) => node === original, detailNode)).toBe(true);
  expect(await list.evaluate((node, original) => node === original, listNode)).toBe(true);
  expect(page.url()).toBe(url);
  expect(state.syncRequests).toEqual(requests);
  await dialog.getByRole('button', { name: 'Close acceptance graph', exact: true }).click();
  await expect(button).toBeFocused();
  await expect(detail.locator('.task-detail-title')).toHaveText('Release client');
  expect(state.syncRequests).toEqual(requests);
  await button.click();
  await page.goBack();
  await expect(graphDialog(page)).toHaveCount(0);
  await expect(detail).toHaveCount(0);
  await expect(list).toBeVisible();
  expect(new URL(page.url()).search).not.toContain('goalGraph=');
});

for (const [id, title, status] of [[unrelatedId, 'Unrelated finished Goal', 'done'], [cancelledId, 'Cancelled migration', 'cancelled']] as const) test(`standalone ${status} Goal initializes its actual focus and one-hop source without another TaskSync owner`, async ({ page }) => {
  const state = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${id}`);
  const detail = page.locator('.goal-detail-surface'), button = detailGraphButton(detail);
  await expect(detail.locator('.task-detail-title')).toHaveText(title);
  await expect(button).toBeEnabled();
  const url = page.url(), requests = [...state.syncRequests];
  await button.click();
  const dialog = graphDialog(page);
  await expect(card(dialog, id)).toHaveAttribute('data-goal-status', status);
  await expect(card(dialog, id).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(sourceStatus(dialog, id)).toHaveAttribute('data-phase', 'ready');
  expect(sourceReads(state.relationRequests, id).every(value => value.startsWith(relationPath(id)))).toBe(true);
  await dialog.locator('.react-flow__controls-zoomout').click();
  await page.clock.runFor(300);
  expect(page.url()).toBe(url);
  expect(state.syncRequests).toEqual(requests);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  expect(state.syncRequests).toEqual(requests);
});

test('My Tasks Goal detail uses its actual source Project and retains the personal inventory behind the graph', async ({ page }) => {
  const state = await install(page, { external: true });
  await page.goto('/my-tasks');
  const inventory = page.locator('.my-task-groups');
  await expect.poll(async () => await inventory.count() > 0 || state.pageErrors.length > 0).toBe(true);
  expect(state.pageErrors).toEqual([]);
  const inventoryNode = await inventory.elementHandle();
  await page.getByRole('link', { name: 'View Goal: External authentication', exact: true }).click();
  const detail = page.locator('.goal-detail-surface'), button = detailGraphButton(detail);
  await expect(detail.locator('.task-detail-title')).toHaveText('External authentication');
  await expect(button).toBeEnabled();
  const requests = [...state.syncRequests], url = page.url();
  await button.click();
  const dialog = graphDialog(page);
  await expect(card(dialog, externalId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(sourceStatus(dialog, externalId)).toHaveAttribute('data-phase', 'ready');
  expect(sourceReads(state.relationRequests, externalId).every(value => value.startsWith(`/api/v1/projects/${externalProjectId}/`))).toBe(true);
  expect(state.syncRequests.every(value => value.startsWith(`/api/v1/projects/${externalProjectId}/`))).toBe(true);
  expect(await inventory.evaluate((node, original) => node === original, inventoryNode)).toBe(true);
  expect(page.url()).toBe(url);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  expect(state.syncRequests).toEqual(requests);
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await expect(inventory).toBeVisible();
});

test('focused graph nested Details trap Escape and protect their discussion draft with Keep and Discard', async ({ page }) => {
  const state = await install(page), source = await openProjectGoal(page);
  await detailGraphButton(source).click();
  const dialog = graphDialog(page);
  await dialog.getByRole('button', { name: 'View fullscreen', exact: true }).click();
  await page.clock.runFor(300);
  await dialog.getByRole('button', { name: 'Details: Accepted identity', exact: true }).click();
  const nested = await goalSurface(page, 'Accepted identity');
  await expect(nested.locator('.task-detail-title')).toHaveText('Accepted identity');
  await nested.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = nested.getByRole('textbox', { name: 'Discussion message', exact: true });
  await draft.fill('Keep this acceptance discussion draft');
  const requests = [...state.syncRequests];
  await page.keyboard.press('Escape');
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(draft).toHaveValue('Keep this acceptance discussion draft');
  await draft.focus();
  await page.keyboard.press('Escape');
  await confirmation.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(page.locator('.goal-detail-surface')).toHaveCount(1);
  await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toHaveClass(/task-chain-dialog-fullscreen/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(detailGraphButton(source)).toBeFocused();
  expect(state.syncRequests).toEqual(requests);
});

test('standalone focused graph protects a nested Goal edit draft during manual history traversal', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${activeId}`);
  const source = page.locator('.goal-detail-surface');
  await source.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await source.getByRole('tab', { name: 'Description', exact: true }).click();
  await detailGraphButton(source).click();
  const dialog = graphDialog(page);
  await dialog.getByRole('button', { name: 'Details: Accepted identity', exact: true }).click();
  const nested = await goalSurface(page, 'Accepted identity');
  try { await nested.getByRole('button', { name: 'Edit', exact: true }).click({ timeout: 5_000 }); }
  catch (error) {
    const layers = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.goal-detail-surface')].map((surface, index) => {
      const backdrop = surface.closest<HTMLElement>('.task-detail-backdrop'), edit = [...surface.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Edit');
      const bounds = edit?.getBoundingClientRect();
      const hit = bounds === undefined ? null : document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return { index, title: surface.querySelector('.task-detail-title')?.textContent, backdropStack: backdrop === null ? null : { inline: backdrop.style.zIndex, computed: getComputedStyle(backdrop).zIndex },
        unavailable: surface.closest('[hidden], [inert]')?.outerHTML.slice(0, 240), editBounds: bounds?.toJSON(), hit: hit?.outerHTML.slice(0, 300),
        hitTitle: hit?.closest('.task-detail-backdrop')?.querySelector('.task-detail-title')?.textContent };
    }));
    await test.info().attach('edit-overlay-layers', { body: JSON.stringify(layers, null, 2), contentType: 'application/json' });
    throw error;
  }
  const editor = page.getByRole('alertdialog', { name: 'Edit Goal', exact: true });
  const title = editor.getByRole('textbox', { name: 'Name', exact: true });
  await title.fill('Unsaved acceptance title');
  await page.goBack();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(title).toHaveValue('Unsaved acceptance title');
  await title.focus();
  await page.goBack();
  await confirmation.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(graphDialog(page)).toHaveCount(0);
  await expect(page.locator('.goal-detail-surface')).toHaveCount(1);
  await expect(source.getByRole('tab', { name: 'Discussion', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(state.unexpected).toEqual([]);
});

for (const width of [320, 390]) test(`Goal description focused graph restores its source button at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await install(page), detail = await openProjectGoal(page), button = detailGraphButton(detail);
  await button.click();
  const dialog = graphDialog(page);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`focused-goal-acceptance-${width}.png`) });
  const requests = [...state.syncRequests];
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  expect(state.syncRequests).toEqual(requests);
});

test('a focused source Project access retirement closes its graph and reader without admitting late context', async ({ page }) => {
  const state = await install(page), detail = await openProjectGoal(page);
  await detailGraphButton(detail).click();
  await expect(graphDialog(page)).toBeVisible();
  state.revokeProject();
  await page.clock.fastForward(61_000);
  await expect(graphDialog(page)).toHaveCount(0);
  await expect(page.locator('.goal-detail-surface .goal-information')).toHaveCount(0);
});

test('focused Goal resource retirement restores focus to its visible failed reader heading', async ({ page }) => {
  const state = await install(page), detail = await openProjectGoal(page);
  await detailGraphButton(detail).click();
  await expect(graphDialog(page)).toBeVisible();
  state.denyGoal(activeId);
  await page.clock.fastForward(61_000);
  await expect(graphDialog(page)).toHaveCount(0);
  const failedHeading = page.getByRole('heading', { name: 'Task details could not be loaded', exact: true });
  await expect(failedHeading).toBeVisible();
  await expect(failedHeading).toBeFocused();
});

test('source history retirement focuses its fresh direct reader and requires a new graph entry after recovery', async ({ page }) => {
  const state = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${activeId}`);
  const detail = page.locator('.goal-detail-surface');
  await expect(detailGraphButton(detail)).toBeEnabled();
  await detailGraphButton(detail).click();
  const dialog = graphDialog(page), oldDialog = await dialog.elementHandle();
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  state.holdSource(doneId);
  await card(dialog, doneId).locator('.task-node-body').click();
  await expect.poll(() => state.sourceHeld(doneId)).toBe(true);
  state.changeGoal(activeId, { title: 'Recovered release client' });
  state.rotateEpoch();
  await page.clock.fastForward(16_000);
  await expect.poll(state.replacementHeld).toBe(true);
  await expect(dialog).toHaveCount(0);
  expect(await oldDialog!.evaluate(node => node.isConnected)).toBe(false);
  const freshHeading = detail.locator('.task-detail-title');
  await expect(freshHeading).toHaveText('Recovered release client');
  await expect(freshHeading).toBeFocused();
  await expect(detailGraphButton(detail)).toBeDisabled();
  await expect.poll(() => state.cancelledRequests.some(url => new URL(url).pathname.endsWith(`/${doneId}/goal-dependencies`))).toBe(true);
  state.releaseSource(doneId);
  state.releaseReplacement();
  await expect(detail.locator('.task-detail-title')).toHaveText('Recovered release client');
  const button = detailGraphButton(detail);
  await expect(button).toBeEnabled();
  await expect(dialog).toHaveCount(0);
  const requests = [...state.syncRequests];
  await button.click();
  await expect(card(dialog, activeId)).toContainText('0 / 1 child Tasks done');
  expect(await dialog.evaluate((node, original) => node === original, oldDialog)).toBe(false);
  await expect(card(dialog, activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  expect(state.syncRequests).toEqual(requests);
});
test('same-Project nested Goal graph preserves its own detail and discussion draft while reusing synchronization', async ({ page }) => {
  const state = await install(page), source = await openProjectGoal(page);
  await detailGraphButton(source).click();
  const outer = graphDialog(page);
  await outer.getByRole('button', { name: 'Details: Accepted identity', exact: true }).click();
  const nested = await goalSurface(page, 'Accepted identity');
  await nested.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await nested.getByRole('textbox', { name: 'Discussion message', exact: true }).fill('Retained same-Project reader draft');
  await nested.getByRole('tab', { name: 'Description', exact: true }).click();
  const requests = [...state.syncRequests], nestedNode = await nested.elementHandle();
  await detailGraphButton(nested).click();
  await expect(graphDialog(page)).toHaveCount(2);
  const inner = graphDialog(page).last();
  await expect(card(inner, doneId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(await nested.evaluate((node, original) => node === original, nestedNode)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(graphDialog(page)).toHaveCount(1);
  await expect(detailGraphButton(nested)).toBeFocused();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await nested.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(nested.getByRole('textbox', { name: 'Discussion message', exact: true })).toHaveValue('Retained same-Project reader draft');
  expect(state.syncRequests).toEqual(requests);
});

test('foreign nested graphs reuse ancestor Project owners and preserve each source reader and draft through layered Escape', async ({ page }) => {
  const state = await install(page, { external: true });
  state.sourceReply(externalId, () => ({ goalId: externalId, canEdit: false, completionBlocked: true, prerequisites: [{ target: state.relatedGoal(activeId, externalProjectId) }], successors: [], nextCursor: null }));
  const source = await openProjectGoal(page);
  await detailGraphButton(source).click();
  const outer = graphDialog(page);
  await expect(card(outer, externalId)).toBeVisible();
  await frameBranch(page, outer);
  const originalProjectReads = state.syncRequests.filter(value => value.startsWith(`/api/v1/projects/${projectId}/`));
  await outer.getByRole('button', { name: 'Details: External authentication', exact: true }).click();
  const foreign = await goalSurface(page, 'External authentication');
  await expect(foreign.locator('.task-detail-title')).toHaveText('External authentication');
  await expect(detailGraphButton(foreign)).toBeEnabled();
  await foreign.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await foreign.getByRole('textbox', { name: 'Discussion message', exact: true }).fill('Keep foreign source draft');
  await foreign.getByRole('tab', { name: 'Description', exact: true }).click();
  const requests = [...state.syncRequests];
  await detailGraphButton(foreign).click();
  await expect(graphDialog(page)).toHaveCount(2);
  const foreignGraph = graphDialog(page).last();
  await expect(card(foreignGraph, externalId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  await expect(card(foreignGraph, activeId)).toBeVisible();
  await frameBranch(page, foreignGraph);
  await foreignGraph.getByRole('button', { name: 'Details: Release client', exact: true }).click();
  const returned = await goalSurface(page, 'Release client');
  await expect(returned.locator('.task-detail-title')).toHaveText('Release client');
  await expect(detailGraphButton(returned)).toBeEnabled();
  const tagReads = state.tagRequests.length;
  await returned.getByRole('button', { name: 'Edit tags', exact: true }).click();
  const tagSearch = returned.getByRole('searchbox', { name: 'Search tags', exact: true });
  await expect.poll(async () => state.pageErrors.length > 0 || await tagSearch.isVisible()).toBe(true);
  expect(state.pageErrors).toEqual([]);
  await tagSearch.fill('ancestor tag');
  await page.clock.runFor(400);
  await expect(returned.locator('.task-tags-editor')).toContainText('No matching tags.');
  await expect.poll(() => state.tagRequests.slice(tagReads).some(path => path.includes('ancestor'))).toBe(true);
  expect(state.tagRequests.slice(tagReads).every(path => path.startsWith(`/api/v1/projects/${projectId}/tags`))).toBe(true);
  expect(state.syncRequests.filter(value => value.startsWith(`/api/v1/projects/${projectId}/`))).toEqual(originalProjectReads);
  expect(state.syncRequests).toEqual(requests);
  await returned.locator('.task-tags-editor').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(returned.getByRole('button', { name: 'Edit tags', exact: true })).toBeFocused();
  await returned.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await returned.getByRole('textbox', { name: 'Discussion message', exact: true }).fill('Keep returned ancestor draft');
  await returned.getByRole('tab', { name: 'Description', exact: true }).click();
  await detailGraphButton(returned).click();
  await expect(graphDialog(page)).toHaveCount(3);
  await expect(card(graphDialog(page).last(), activeId).locator('.task-node-body')).toHaveAttribute('aria-pressed', 'true');
  expect(state.syncRequests.filter(value => value.startsWith(`/api/v1/projects/${projectId}/`))).toEqual(originalProjectReads);
  expect(state.syncRequests).toEqual(requests);
  await page.keyboard.press('Escape');
  await expect(graphDialog(page)).toHaveCount(2);
  await expect(detailGraphButton(returned)).toBeFocused();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await returned.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const returnedDraft = returned.getByRole('textbox', { name: 'Discussion message', exact: true });
  await expect(returnedDraft).toHaveValue('Keep returned ancestor draft');
  await returnedDraft.focus();
  await page.keyboard.press('Escape');
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true });
  await confirmation.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(page.locator('.goal-detail-surface')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(graphDialog(page)).toHaveCount(1);
  await expect(detailGraphButton(foreign)).toBeFocused();
  await foreign.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(foreign.getByRole('textbox', { name: 'Discussion message', exact: true })).toHaveValue('Keep foreign source draft');
  expect(state.syncRequests).toEqual(requests);
});

const layoutMetrics = (dialog: Locator) => dialog.evaluate(element => {
  const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
  const graph = box('.goal-acceptance-graph'), canvas = box('.task-graph-canvas');
  const reading = box('.goal-acceptance-reading'), inspection = box('.goal-acceptance-inspection'), foot = box('.graph-foot');
  const aside = element.querySelector<HTMLElement>('.goal-acceptance-inspection')!;
  const status = element.querySelector<HTMLElement>('.goal-relation-status');
  return { canvasHeight: canvas.height, canvasBottom: canvas.bottom, readingBottom: reading.bottom, inspectionTop: inspection.top,
    footBottom: foot.bottom, graphBottom: graph.bottom, asideHeight: inspection.height, asideScroll: aside.scrollHeight,
    statusHeight: status?.getBoundingClientRect().height ?? 0, dialogScroll: element.scrollHeight, dialogHeight: element.clientHeight,
    horizontalOverflow: element.scrollWidth - element.clientWidth };
});

const prepareLongInspection = async (state: Awaited<ReturnType<typeof install>>) => {
  const ids = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-${String(600 + index).padStart(12, '0')}`);
  for (const [index, id] of ids.entries()) state.changeGoal(id, { title: `Long prerequisite ${index + 1} ${'readable relationship title '.repeat(8)}` });
  state.changeEdges([doneId, cancelledId, ...ids]);
};

for (const fullscreen of [false, true]) test(`acceptance graph allocates desktop height with ${fullscreen ? 'fullscreen' : 'ordinary'} long inspection`, async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const state = await install(page, { bulk: true });
  await prepareLongInspection(state);
  const { dialog } = await open(page, state.syncRequests);
  await expect(dialog.locator('.goal-relation-source[data-phase="ready"]')).toHaveCount(8);
  if (fullscreen) await dialog.getByRole('button', { name: 'View fullscreen', exact: true }).click();
  const before = await layoutMetrics(dialog);
  expect.soft(before.canvasHeight).toBeGreaterThan(300);
  expect.soft(Math.abs(before.footBottom - before.graphBottom)).toBeLessThanOrEqual(1);
  expect(before.statusHeight).toBeLessThanOrEqual(153);
  await frameBranch(page, dialog);
  const requests = [...state.syncRequests], viewport = dialog.locator('.react-flow__viewport'), position = await viewport.getAttribute('style');
  await card(dialog, activeId).locator('.task-node-body').click();
  await expect(dialog.locator('.goal-acceptance-inspection h3')).toHaveText('Release client');
  const after = await layoutMetrics(dialog);
  expect.soft(Math.abs(after.canvasHeight - before.canvasHeight)).toBeLessThanOrEqual(1);
  expect(after.asideScroll).toBeGreaterThan(after.asideHeight);
  expect(Math.abs(after.footBottom - after.graphBottom)).toBeLessThanOrEqual(1);
  expect(after.horizontalOverflow).toBe(0);
  await expect(viewport).toHaveAttribute('style', position!);
  expect(state.syncRequests).toEqual(requests);
});

for (const size of [{ width: 320, height: 900 }, { width: 390, height: 900 }, { width: 390, height: 480 }]) test(`acceptance graph stacks and scrolls at ${size.width}x${size.height}`, async ({ page }) => {
  await page.setViewportSize(size);
  const state = await install(page, { bulk: true });
  await prepareLongInspection(state);
  const { dialog } = await open(page, state.syncRequests);
  await expect(dialog.locator('.goal-relation-source[data-phase="ready"]')).toHaveCount(8);
  const unselected = await layoutMetrics(dialog);
  if (size.height > 480) expect(unselected.canvasHeight).toBeGreaterThan(200);
  await frameBranch(page, dialog);
  await card(dialog, activeId).locator('.task-node-body').click();
  const metrics = await layoutMetrics(dialog);
  expect(metrics.canvasHeight).toBeGreaterThanOrEqual(199);
  expect(metrics.inspectionTop).toBeGreaterThanOrEqual(metrics.canvasBottom - 1);
  expect(metrics.asideHeight).toBeLessThanOrEqual(261);
  expect(metrics.asideScroll).toBeGreaterThan(metrics.asideHeight);
  expect(metrics.horizontalOverflow).toBe(0);
  if (size.height === 480) expect(metrics.dialogScroll).toBeGreaterThan(metrics.dialogHeight);
  else expect(Math.abs(metrics.footBottom - metrics.graphBottom)).toBeLessThanOrEqual(1);
  await dialog.locator('.graph-foot').scrollIntoViewIfNeeded();
  await expect(dialog.locator('.graph-foot')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close acceptance graph', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Close acceptance graph', exact: true })).toBeVisible();
});


test('acceptance graph retains its allocated height through loading, failure and retry', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const state = await install(page, { bulk: true });
  state.holdAllRoots();
  const { dialog } = await open(page, state.syncRequests);
  await expect.poll(() => state.relationRequests.length).toBe(4);
  const loading = await layoutMetrics(dialog);
  expect(loading.canvasHeight).toBeGreaterThan(300);
  expect(Math.abs(loading.footBottom - loading.graphBottom)).toBeLessThanOrEqual(1);
  state.releaseAll();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  state.failSource(activeId, true);
  await retryRelations(dialog, 'Release client').click();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'failed');
  const failed = await layoutMetrics(dialog);
  expect(failed.canvasHeight).toBeGreaterThan(300);
  expect(Math.abs(failed.footBottom - failed.graphBottom)).toBeLessThanOrEqual(1);
  state.failSource(activeId, false);
  await retryRelations(dialog, 'Release client').click();
  await expect(sourceStatus(dialog, activeId)).toHaveAttribute('data-phase', 'ready');
  expect((await layoutMetrics(dialog)).canvasHeight).toBeGreaterThan(300);
});

test('empty acceptance graph uses the available dialog height', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await install(page, { empty: true });
  await page.goto(`/projects/${projectId}?tab=tasks`);
  await page.getByRole('tab', { name: /^Goals/ }).click();
  await page.getByRole('button', { name: 'Acceptance graph', exact: true }).click();
  const dialog = graphDialog(page);
  await expect(dialog.locator('.goal-acceptance-empty')).toBeVisible();
  const metrics = await layoutMetrics(dialog);
  expect(metrics.canvasHeight).toBeGreaterThan(300);
  expect(Math.abs(metrics.footBottom - metrics.graphBottom)).toBeLessThanOrEqual(1);
});
