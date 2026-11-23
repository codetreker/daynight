import { selectStatus, statusButton } from './status-filter';
import { expectTextContrast, roleColors } from './color-roles';
import { expectCopyButtonSkin } from './copy-button-assertions';
import { expectGraphCardBadges } from './graph-card-badges';
import { usageMetricKeys } from '../../src/api/usage';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { checkDependencyGeometry } from '../helpers/dependency-geometry';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { expectDescriptionCard } from '../helpers/description-card';

const projectId = '00000000-0000-4000-8000-000000000100';
const goalId = '00000000-0000-4000-8000-000000000200';
const firstId = '00000000-0000-4000-8000-000000000201';
const secondId = '00000000-0000-4000-8000-000000000202';
const singleId = '00000000-0000-4000-8000-000000000203';
const otherGoalId = '00000000-0000-4000-8000-000000000204';
const otherTaskId = '00000000-0000-4000-8000-000000000205';
const outsideId = '00000000-0000-4000-8000-000000000206';
const otherTask2Id = '00000000-0000-4000-8000-000000000207';
const layoutChildId = '00000000-0000-4000-8000-000000000208';
const layoutWorkerId = '00000000-0000-4000-8000-000000000209';
const layoutStandaloneId = '00000000-0000-4000-8000-000000000210';
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-22T10:00:00Z';
const longChainTitle = 'Long completed chain title '.repeat(5).trim();

test('Goal attachment image recovers from a network failure without rereading the Goal', async ({ page }) => {
  const state = await install(page);
  state.setGoalDescription('# Goal image\n\n![Goal attachment](images/goal.svg?size=small#diagram)\n\nGoal text remains readable.');
  const images: string[] = [];
  let detailReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/v1/projects/${projectId}/tasks/${goalId}`) detailReads++; });
  await page.route(`**/api/v1/projects/${projectId}/tasks/${goalId}/goal-dependencies?*`, route => route.fulfill({
    contentType: 'application/json', headers: { 'Daynight-User-ID': TEST_VIEWER_ID },
    body: stringifyWireJson({ goalId, canEdit: false, completionBlocked: false, prerequisites: [], successors: [], nextCursor: null }),
  }));
  await page.route('**/preview/images/goal.svg?size=small', route => {
    images.push(route.request().url());
    return images.length === 1 ? route.abort('failed') : route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#256a48"/></svg>' });
  });
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const description = page.locator('.goal-detail-description');
  await expect(description.getByRole('heading', { name: 'Goal image', exact: true })).toBeVisible();
  const error = description.getByRole('alert', { name: 'Goal attachment', exact: true });
  await expect(error).toContainText('Unable to load the attachment image');
  await expect(description.locator('.goal-dependencies .goal-dependency-empty')).toHaveCount(2);
  const before = detailReads;
  await error.getByRole('button', { name: 'Retry image', exact: true }).click();
  await expect(error).toHaveCount(0);
  const image = description.getByRole('img', { name: 'Goal attachment', exact: true });
  await expect(image).toHaveAttribute('src', `http://${goalId}.preview.localhost:8787/api/v1/projects/${projectId}/tasks/${goalId}/preview/images/goal.svg?size=small#diagram`);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(120);
  expect(images).toHaveLength(2); expect(images[0]).toBe(images[1]);
  expect(detailReads).toBe(before);
  expect(state.statusWrites()).toEqual([]); expect(state.edits()).toEqual([]);
});

async function restoreGoalGraph(page: Page, surface: Locator, representativeId = firstId) {
  await expect(surface.locator('.goal-information-counts').first()).toBeAttached();
  await page.waitForFunction(() => history.state?.__daynightNavigation?.view !== undefined);
  if (await surface.getAttribute('inert') === null && !new URL(page.url()).search) {
    await surface.getByRole('tab', { name: /^(Attachments|附件)$/ }).click();
    await surface.getByRole('tab', { name: /^(Description|描述)$/ }).click();
  }
  const parentId = await surface.locator('.task-detail-title').textContent() === 'Other goal' ? otherGoalId : goalId;
  await page.evaluate(({ parentId, representativeId }) => window.selectGoalReading(parentId, { graphRootId: representativeId, task: null }), { parentId, representativeId });
}
async function restoreGoalChild(page: Page, taskId: string, parentId = goalId) {
  await expect(page.locator('.goal-detail-surface .goal-information-counts').first()).toBeAttached();
  await page.waitForFunction(() => history.state?.__daynightNavigation?.view !== undefined);
  const surface = page.locator('.goal-detail-surface').last();
  if (await surface.getAttribute('inert') === null && !new URL(page.url()).search) {
    await surface.getByRole('tab', { name: /^(Attachments|附件)$/ }).click();
    await surface.getByRole('tab', { name: /^(Description|描述)$/ }).click();
  }
  await page.evaluate(({ parentId, taskId }) => window.selectGoalReading(parentId, { task: { id: taskId, navigation: { tab: 'overview', path: null } } }), { parentId, taskId });
}

const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal reading', ready: false, description: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the goal description.`).join('\n\n') });
const first = detailFixture(projectId, firstId, { parentId: goalId, title: 'First task' });
const second = detailFixture(projectId, secondId, { parentId: goalId, title: 'Second task', dependsOn: [firstId], blockedBy: [firstId], ready: false });
const single = detailFixture(projectId, singleId, { parentId: goalId, title: 'Standalone task' });
const all = [goal, first, second, single];
const graph = graphFixture(all);

test('Goal status and assignee retain their shared typography', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const controls = page.locator('.goal-detail-surface .task-detail-status-assignee');
  for (const root of [16, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
    for (const element of [controls.locator('.task-status-trigger'), controls.locator('.assignee-field-label'), controls.locator('.assignee-trigger'), controls.locator('.task-assignee-identity')]) {
      await expect(element).toHaveCSS('font-size', `${root * 0.875}px`);
    }
  }
});

for (const width of [1440, 320]) test(`Goal successor inspection keeps keyboard focus and viewport at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await install(page);
  await page.goto(`/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
  const dialog = page.locator(`#task-graph-${goalId}`);
  const selected = dialog.locator(`.react-flow__node[data-id="${firstId}"] .task-node-body`);
  const successor = dialog.locator(`.react-flow__node[data-id="${secondId}"] .task-node`);
  await expect(selected).toBeVisible();
  await selected.focus();
  const viewport = dialog.locator('.react-flow__viewport');
  const before = await viewport.getAttribute('style');
  await selected.press('Enter');
  await expect(selected).toBeFocused();
  await expect(successor).toHaveAttribute('data-inspection', 'successor');
  await expect(successor).toHaveCSS('outline-color', 'rgb(8, 127, 140)');
  await expect(successor.locator('.task-node-body')).toHaveAccessibleName(/successor of the selected task/);
  await expect(dialog.locator('.task-dependency-edge')).toHaveAttribute('data-inspection', 'successor');
  await expect(dialog.locator('.graph-successor-legend')).toHaveText('Successors');
  await page.screenshot({ path: info.outputPath('successor-goal.png') });
  await expect(viewport).toHaveAttribute('style', before!);
  await selected.press('Enter');
  await expect(successor).toHaveAttribute('data-inspection', 'normal');
  await expect(viewport).toHaveAttribute('style', before!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

async function expectHit(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  expect(await target.evaluate(element => { const r = element.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return hit === element || element.contains(hit); })).toBe(true);
}
async function expectChainTimeLayout(header: Locator) {
  const layout = await header.evaluate(element => {
    const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const title = box('.root-title'), meta = box('.chain-summary-meta'), time = box('.chain-completion-time');
    const headerBox = element.getBoundingClientRect();
    const other = ['.root-progress', '.session-status-slot', '.goal-graph-button'].map(box);
    const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    return {
      belowTitle: time.top >= title.bottom - 1,
      inMeta: time.left >= meta.left - 1 && time.right <= meta.right + 1 && time.top >= meta.top - 1 && time.bottom <= meta.bottom + 1,
      alignedLeft: Math.abs(meta.left - title.left) <= 8,
      insideHeader: [title, time, ...other].every(rect => rect.width > 0 && rect.height > 0 && rect.left >= headerBox.left - 1 && rect.right <= headerBox.right + 1 && rect.top >= headerBox.top - 1 && rect.bottom <= headerBox.bottom + 1),
      separate: other.every(rect => separate(time, rect)),
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth,
    };
  });
  expect(layout).toEqual({ belowTitle: true, inMeta: true, alignedLeft: true, insideHeader: true, separate: true, noHorizontalOverflow: true });
}
async function install(page: Page, locale: 'en' | 'zh-CN' = 'en', ownerName = 'Long owner name '.repeat(8), hasProjectAccess = true) {
  let details = all;
  let currentGraph = graph;
  let sessionStates: Record<string, 'working' | 'notice' | 'warning' | 'pending'> = {};
  let colorRevision = 0;
  let epoch = taskSyncEpoch(projectId);
  let forbiddenGoal = false;
  let failPeople = false;
  let failOtherDetail = false;
  let goalReads = 0;
  const statusWrites: { status: string; version: number }[] = [];
  const creates: unknown[] = [];
  const edits: unknown[] = [];
  let editMode: 'pending' | 'conflict' | 'pending-conflict' | 'unknown' | 'unknown-read-failure' = 'pending';
  let failGoalRead = false;
  let failedGoalReads = 0;
  let rejectGoalWrites = false;
  let releaseEdit: (() => void) | null = null;
  let failNextSync = false;
  let holdNextSync = false;
  let denyHeldSync = false;
  let latestHeldSync = false;
  let projectRevoked = false;
  let releaseSync: (() => void) | null = null;
  let heldSyncFinished = false;
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return projectRevoked ? send({ error: { code: 'not_found', message: 'Not found', requestId: goalId } }, 404) : send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return projectRevoked ? send({ error: { code: 'not_found', message: 'Not found', requestId: goalId } }, 404) : send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/tags`) return send({ items: [], catalogEpoch: taskSyncEpoch(projectId), nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/task-assignees` && failPeople) return send({ error: { code: 'unavailable', message: 'Assignee service unavailable', requestId: 'people-error' } }, 503);
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: TEST_VIEWER_ID, name: ownerName, avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/tasks` && route.request().method() === 'POST') { creates.push(route.request().postDataJSON()); return route.abort('failed'); }
    if (path === `/api/v1/projects/${projectId}/task-sync`) {
      if (failNextSync) { failNextSync = false; return send({ error: { code: 'unavailable', message: 'Unavailable', requestId: 'sync-error' } }, 503); }
      const makeResponse = () => taskSyncFixture(currentGraph, { query: taskSyncQuery(url), epoch, sessions: sessionStates, ...(!hasProjectAccess ? { assigneeVersions: [{ userId: TEST_VIEWER_ID, version: TEST_PROFILE_VERSION, hasProjectAccess }] } : {}), ...(sessionStates[layoutWorkerId] === undefined ? {} : { taskObservations: { [layoutWorkerId]: { taskVersion: details.find(item => item.id === layoutWorkerId)!.version, state: 'working' as const, observedAt: currentGraph.observedAt, freshUntil: '2055-01-01T00:01:00Z', needsAttention: false, canOpen: true } } }), versionForTask: task => details.find(item => item.id === task.id)!.version, propertiesForTask: task => details.find(item => item.id === task.id)!.properties, tagsForTask: task => details.find(item => item.id === task.id)!.tags });
      const response = makeResponse();
      if (holdNextSync) {
        holdNextSync = false; await new Promise<void>(resolve => { releaseSync = resolve; }); releaseSync = null;
        try { if (denyHeldSync) { denyHeldSync = false; projectRevoked = true; await send({ error: { code: 'not_found', message: 'Not found', requestId: goalId } }, 404); } else { const result = latestHeldSync ? makeResponse() : response; latestHeldSync = false; await send(result); } } finally { heldSyncFinished = true; }
        return;
      }
      return send(response);
    }
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
    if (path === `/api/v1/projects/${projectId}/tasks/${otherTaskId}` && failOtherDetail) return send({ error: { code: 'unavailable', message: 'Long error '.repeat(30), requestId: 'other-read-error' } }, 503);
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
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}/preview/image.png`) return route.fulfill({ body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN8AAAAASUVORK5CYII=', 'base64'), headers: { 'Content-Type': 'image/png', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  return { setGoalSessionFixture: (status: 'todo' | 'in_progress' | 'done' | 'cancelled', indicator: 'working' | 'notice' | 'warning' | 'pending') => {
    const changedAt = `2026-10-22T10:00:${String(++colorRevision).padStart(2, '0')}Z`;
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'host' }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    details = [{ ...goal, title: 'Long Goal 长标题 '.repeat(16), status, assignedTo: TEST_VIEWER_ID, version: BigInt(colorRevision + 1), updatedAt: changedAt,
      startedAt: status === 'in_progress' ? time : null, completedAt: status === 'done' ? time : null, cancelledAt: status === 'cancelled' ? time : null },
      { ...first, status: 'in_progress', startedAt: time, properties: { worker } }, { ...second, properties: { paused: true } }, single];
    sessionStates = { [firstId]: indicator };
    currentGraph = { ...graphFixture(details), observedAt: changedAt };
  }, compactDesktopGoal: () => {
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'host' }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    details = [{ ...goal, title: 'Goal reading', assignedTo: TEST_VIEWER_ID },
      { ...first, status: 'in_progress', startedAt: time, properties: { worker, paused: true } },
      { ...second, status: 'cancelled', cancelledAt: time },
      ...Array.from({ length: 79 }, (_, i) => detailFixture(projectId,
        `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`,
        { parentId: goalId, title: `Completed task ${i}`, status: 'done', completedAt: time }))];
    sessionStates = { [firstId]: 'working' };
    currentGraph = graphFixture(details);
  }, mixedLayoutGoal: () => {
    const statuses = ['proposed', 'todo', 'in_progress', 'done', 'cancelled'] as const;
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'long-machine-name-'.repeat(12) }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    details = [goal, ...statuses.map((status, i) => detailFixture(projectId,
      `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`,
      { parentId: goalId, title: 'Long title 中文长标题 '.repeat(12).trim(), status, assignedTo: TEST_VIEWER_ID,
        startedAt: status === 'in_progress' ? time : null, completedAt: status === 'done' ? time : null,
        cancelledAt: status === 'cancelled' ? time : null, properties: status === 'in_progress' ? { worker } : {},
        tags: [{ id: layoutChildId, name: 'Long tag '.repeat(6).trim() }, { id: layoutWorkerId, name: 'Second tag 标签' }] }))];
    currentGraph = graphFixture(details);
  }, taggedAndEmptyGoals: () => {
    details = [goal, ...[first, second, single].map(item => ({ ...item, tags: [{ id: layoutChildId, name: 'Tagged' }] })),
      detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Empty goal', ready: false })];
    currentGraph = graphFixture(details);
  }, independentGoalTasks: () => {
    details = [goal, ...Array.from({ length: 30 }, (_, n) => detailFixture(projectId,
      `00000000-0000-4000-8000-${String(800 + n).padStart(12, '0')}`,
      { parentId: goalId, title: n === 0 ? 'Long task 长标题 '.repeat(15) : `Grid task ${n}` }))];
    currentGraph = graphFixture(details);
  }, setGoalStatusFixture: (status: 'todo' | 'in_progress' | 'done' | 'cancelled', completedChildren: boolean) => {
    const changedAt = `2026-10-22T10:00:${String(++colorRevision).padStart(2, '0')}Z`;
    details = details.map(item => item.id === goalId
      ? { ...item, status, assignedTo: TEST_VIEWER_ID, version: item.version + 1n, updatedAt: changedAt, startedAt: status === 'in_progress' ? time : null, completedAt: status === 'done' ? time : null, cancelledAt: status === 'cancelled' ? time : null }
      : item.parentId === goalId && item.status !== (completedChildren ? 'done' : 'todo')
        ? { ...item, status: completedChildren ? 'done' as const : 'todo' as const, version: item.version + 1n, updatedAt: changedAt, completedAt: completedChildren ? time : null, cancelledAt: null } : item);
    currentGraph = { ...graphFixture(details), observedAt: changedAt };
  }, assignChainRoot: () => {
    details = [...details,
      detailFixture(projectId, outsideId, { title: 'Short chain', assignedTo: TEST_VIEWER_ID }),
      detailFixture(projectId, otherTaskId, { title: 'Chain child', dependsOn: [outsideId], blockedBy: [outsideId], ready: false })];
    currentGraph = graphFixture(details);
  }, compactChains: () => {
    const done = { status: 'done' as const, completedAt: '2026-10-22T09:59:30Z' };
    details = [goal, detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }),
      detailFixture(projectId, firstId, { title: 'Full complete', assignedTo: TEST_VIEWER_ID, ...done }),
      detailFixture(projectId, secondId, { title: 'Full member', dependsOn: [firstId], ...done }),
      detailFixture(projectId, otherTask2Id, { title: 'Full pending', assignedTo: TEST_VIEWER_ID }),
      detailFixture(projectId, layoutChildId, { title: 'Pending member', dependsOn: [otherTask2Id] }),
      detailFixture(projectId, outsideId, { title: 'Scoped complete', parentId: otherGoalId, ...done }),
      detailFixture(projectId, otherTaskId, { title: 'Scoped member', dependsOn: [outsideId], ...done }),
      detailFixture(projectId, layoutWorkerId, { title: 'Scoped unknown', parentId: otherGoalId, status: 'done' }),
      detailFixture(projectId, singleId, { title: 'Unknown member', dependsOn: [layoutWorkerId], status: 'done' })];
    currentGraph = graphFixture(details);
  }, clearCompactCompletion: () => {
    details = details.map(item => item.id === firstId || item.id === secondId
      ? { ...item, status: 'cancelled' as const, completedAt: null, cancelledAt: '2026-10-22T10:00:01Z', updatedAt: '2026-10-22T10:00:01Z', version: item.version + 1n }
      : item);
    currentGraph = { ...graphFixture(details), observedAt: '2026-10-22T10:00:01Z' };
  }, setMixedChildren: () => {
    const changedAt = `2026-10-22T10:00:${String(++colorRevision).padStart(2, '0')}Z`;
    details = details.map(item => item.id === singleId ? { ...item, status: 'cancelled' as const, version: item.version + 1n, updatedAt: changedAt, cancelledAt: time } : item);
    currentGraph = { ...graphFixture(details), observedAt: changedAt };
  }, cancelChildren: () => {
    const changedAt = `2026-10-22T10:00:${String(++colorRevision).padStart(2, '0')}Z`;
    details = details.map(item => item.parentId === goalId ? { ...item, status: 'cancelled' as const, version: item.version + 1n, updatedAt: changedAt, cancelledAt: changedAt } : item);
    currentGraph = { ...graphFixture(details), observedAt: changedAt };
  }, progressChains: () => {
    const make = (base: number, parentId: string | null, title: string) => {
      const id = (n: number) => `00000000-0000-4000-8000-${String(base + n).padStart(12, '0')}`;
      return Array.from({ length: 9 }, (_, n) => detailFixture(projectId, id(n), {
        title: n === 0 ? title : `${title} member ${n}`, parentId,
        status: n < 4 ? 'done' : n < 6 ? 'todo' : 'cancelled',
        completedAt: n < 4 ? time : null, cancelledAt: n >= 6 ? time : null,
        dependsOn: n === 0 ? [] : [id(0)], blockedBy: [], ready: n >= 4 && n < 6,
      }));
    };
    details = [goal, ...make(300, goalId, 'Scoped progress chain'), ...make(500, null, 'Overview progress chain')];
    currentGraph = graphFixture(details);
  }, completionGoal: (layout = false) => {
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'host' }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    const outside = detailFixture(projectId, outsideId, { title: layout ? longChainTitle : 'Outside chain', parentId: otherGoalId, status: 'done', completedAt: '2026-10-22T09:59:55Z', ...(layout ? { assignedTo: TEST_VIEWER_ID } : {}) });
    details = [{ ...goal, status: 'done', createdAt: '2026-10-22T09:58:00Z', updatedAt: '2026-10-22T09:59:40Z', completedAt: '2026-10-22T09:59:40Z' },
      detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }), outside,
      { ...first, title: 'First task with a long title '.repeat(5), status: 'done', completedAt: '2026-10-22T09:59:10Z', dependsOn: [outsideId] },
      { ...second, status: 'done', completedAt: '2026-10-22T09:59:30Z', dependsOn: [firstId] }, single];
    if (layout) details.push(
      detailFixture(projectId, otherTaskId, { title: 'Scoped member', status: 'done', completedAt: '2026-10-22T09:59:35Z', dependsOn: [outsideId] }),
      detailFixture(projectId, otherTask2Id, { title: longChainTitle, status: 'done', assignedTo: TEST_VIEWER_ID, completedAt: '2026-10-22T09:59:40Z' }),
      detailFixture(projectId, layoutChildId, { title: 'Complete member', status: 'done', completedAt: '2026-10-22T09:59:50Z', dependsOn: [otherTask2Id] }),
      detailFixture(projectId, layoutWorkerId, { title: 'Active outside member', parentId: otherGoalId, status: 'in_progress', startedAt: time, dependsOn: [outsideId], properties: { worker } }),
    );
    currentGraph = layout ? { ...graphFixture(details), observedAt: '2055-01-01T00:00:00Z' } : graphFixture(details);
  }, layoutMemberEvidence: () => {
    details = [...details.map(item => item.type === 'task' ? { ...item, ...(item.id === layoutWorkerId ? { parentId: null, allowAgents: true } : {}), tags: [{ id: layoutChildId, name: 'Long tag 标签' }] } : item),
      detailFixture(projectId, layoutStandaloneId, { title: 'Ordinary task' })];
    sessionStates = { [layoutWorkerId]: 'working' };
    currentGraph = { ...graphFixture(details), observedAt: '2055-01-01T00:00:00Z' };
  }, completeOtherGoal: () => { details = details.map(item => item.id === otherGoalId ? { ...item, status: 'done' as const, completedAt: '2026-10-22T09:59:40Z' } : item); currentGraph = graphFixture(details); }, emptyGoal: () => { details = [goal]; currentGraph = graphFixture(details); }, failNextSync: () => { failNextSync = true; }, holdNextSync: () => { holdNextSync = true; }, holdDeniedSync: () => { holdNextSync = true; denyHeldSync = true; }, holdLatestSync: () => { holdNextSync = true; latestHeldSync = true; }, syncHeld: () => releaseSync !== null, heldSyncFinished: () => heldSyncFinished, releaseSync: () => releaseSync?.(), finishGoal: () => {
    details = details.map(item => item.id === goalId ? { ...item, status: 'done' as const, completedAt: '2026-10-22T10:00:01Z', updatedAt: '2026-10-22T10:00:01Z', version: item.version + 1n } : item);
    currentGraph = graphFixture(details);
  }, failPeople: () => { failPeople = true; }, failOtherDetail: () => { failOtherDetail = true; }, setOtherTaskTitle: (title: string) => { details = details.map(item => item.id === otherTaskId ? { ...item, title } : item); currentGraph = graphFixture(details); }, setGoalTitle: (title: string) => { details = details.map(item => item.id === goalId ? { ...item, title } : item); currentGraph = graphFixture(details); }, setGoalDescription: (description: string) => { details = details.map(item => item.id === goalId ? { ...item, description } : item); currentGraph = graphFixture(details); }, setTaskDescription: (description: string) => { details = details.map(item => item.id === singleId ? { ...item, description } : item); currentGraph = graphFixture(details); }, statusWrites: () => statusWrites, creates: () => creates, edits: () => edits, rejectWrites: () => { rejectGoalWrites = true; }, setEditMode: (mode: typeof editMode) => { editMode = mode; }, releaseEdit: () => releaseEdit?.(), failedGoalReads: () => failedGoalReads, restoreGoalReads: () => { failGoalRead = false; }, advanceEpoch: () => { epoch = '40000000-0000-4000-8000-000000000001'; }, addPausedTask: () => {
    details = [goal, first, { ...second, title: 'A very long paused task title '.repeat(5), properties: { paused: true } }, single];
    currentGraph = graphFixture(details);
  }, addActiveChain: (assignedTo: string | null = TEST_VIEWER_ID) => {
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'host' }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    const root = detailFixture(projectId, outsideId, { title: 'Long chain title '.repeat(12), assignedTo, status: 'done' });
    const child = detailFixture(projectId, firstId, { title: 'Child task', status: 'in_progress', startedAt: time, dependsOn: [outsideId], blockedBy: [], ready: false, properties: { worker } });
    details = [root, child]; currentGraph = graphFixture(details);
  }, addTimedGoalChain: () => {
    const external = detailFixture(projectId, outsideId, { title: 'Timed external prerequisite', status: 'done',
      startedAt: '2026-10-22T09:57:00Z', completedAt: '2026-10-22T09:57:30Z' });
    details = [goal,
      { ...first, status: 'done', startedAt: '2026-10-22T09:58:00Z', completedAt: '2026-10-22T09:58:45Z' },
      { ...second, status: 'in_progress', startedAt: '2026-10-22T09:59:00Z', dependsOn: [firstId, outsideId], externalDependsOn: [outsideId] },
      single, external];
    currentGraph = graphFixture(details);
  }, retireGoal: () => {
    details = details.filter(item => item.id !== goalId).map(item => item.parentId === goalId
      ? { ...item, parentId: null, version: item.version + 1n, updatedAt: '2026-10-22T10:00:01Z' } : item);
    currentGraph = graphFixture(details);
  }, forbidGoal: () => { forbiddenGoal = true; }, goalReads: () => goalReads, addCrossGoal: () => {
    details = [...all, detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }), detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [secondId], blockedBy: [secondId], ready: false })];
    currentGraph = graphFixture(details);
  }, addExternalGoalChain: () => {
    const targetGoal = detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false });
    const targetRoot = detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task' });
    const targetChild = detailFixture(projectId, otherTask2Id, { parentId: otherGoalId, title: 'Other second task', dependsOn: [otherTaskId] });
    details = [goal, { ...first, dependsOn: [otherTaskId], externalDependsOn: [otherTaskId], ready: false }, second, single, targetGoal, targetRoot, targetChild];
    currentGraph = graphFixture(details);
  }, addGoalInspectionGraph: () => {
    details = [goal,
      { ...first, dependsOn: [otherTaskId], externalDependsOn: [otherTaskId], ready: false },
      { ...single, dependsOn: [otherTaskId], externalDependsOn: [otherTaskId], ready: false },
      { ...second, dependsOn: [firstId, singleId], blockedBy: [firstId, singleId] },
      detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }),
      detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [otherTask2Id] }),
      detailFixture(projectId, otherTask2Id, { title: 'Hidden ancestor', dependsOn: [outsideId] }),
      detailFixture(projectId, outsideId, { title: 'Hidden root' })];
    currentGraph = graphFixture(details);
  }, addComplexExternalGoalTask: (title: string) => {
    details = [goal, { ...first, dependsOn: [otherTaskId], externalDependsOn: [otherTaskId], blockedBy: [otherTaskId], ready: false },
      detailFixture(projectId, otherGoalId, { type: 'goal', title: 'A very long external owner name that should truncate', ready: false }),
      detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title, status: 'in_progress', ready: false, startedAt: '2026-10-08T08:21:00Z',
        allowAgents: true, requiredPlatform: 'linux', properties: { paused: true, pullRequests: [] } })];
    currentGraph = graphFixture(details);
  }, addTwoExternalTasks: () => {
    details = [...all, detailFixture(projectId, otherGoalId, { type: 'goal', title: 'Other goal', ready: false }),
      detailFixture(projectId, otherTaskId, { parentId: otherGoalId, title: 'Other task', dependsOn: [secondId], blockedBy: [secondId], ready: false }),
      detailFixture(projectId, otherTask2Id, { parentId: otherGoalId, title: 'Other second task', dependsOn: [secondId], blockedBy: [secondId], ready: false })];
    currentGraph = graphFixture(details);
  }, moveOtherTaskToGoal: () => {
    details = details.map(item => item.id === otherTaskId ? { ...item, parentId: goalId, version: item.version + 1n, updatedAt: '2026-10-22T10:00:01Z' } : item);
    currentGraph = graphFixture(details);
  }, moveOtherTask: () => {
    details = details.map(item => item.id === otherTaskId ? { ...item, parentId: null, version: item.version + 1n, updatedAt: '2026-10-22T10:00:01Z' } : item);
    currentGraph = graphFixture(details);
  }, addLongGoalListWorker: () => {
    const worker = { claimId: firstId, state: 'active' as const, userId: TEST_VIEWER_ID, workerId: secondId, machine: { id: singleId, name: 'long-machine-name-'.repeat(12) }, platform: 'linux' as const, agent: 'codex', agentControlMode: 'web' as const, worktreeId: otherTaskId, phase: 'executing' as const, herdr: null, nativeSessionId: null, claimedAt: time };
    details = details.map(item => item.id === firstId ? { ...item, assignedTo: TEST_VIEWER_ID, status: 'in_progress', startedAt: time, ready: false, properties: { worker } } : item);
    currentGraph = graphFixture(details);
  }, moveActiveGoalChild: () => {
    const changedAt = `2026-10-22T10:00:${String(++colorRevision).padStart(2, '0')}Z`;
    details = details.map(item => item.id === firstId ? { ...item, parentId: otherGoalId, version: item.version + 1n, updatedAt: changedAt } : item);
    currentGraph = { ...graphFixture(details), observedAt: changedAt };
  }, addGoalExternalChain: () => {
    const outside = detailFixture(projectId, outsideId, { title: 'Outside chain', dependsOn: [singleId], externalDependsOn: [singleId] });
    const outsideChild = detailFixture(projectId, otherTaskId, { title: 'Outside child', dependsOn: [outsideId] });
    const singleton = detailFixture(projectId, singleId, { title: 'Outside singleton' });
    details = [goal, first, { ...second, dependsOn: [firstId, outsideId], externalDependsOn: [outsideId] }, outside, outsideChild, singleton];
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

async function copyGoalId(page: Page, locale: 'en' | 'zh-CN', keyboard = false) {
  const surface = page.locator('.goal-detail-surface');
  const aside = surface.getByRole('complementary', { name: locale === 'zh-CN' ? 'Goal 信息' : 'Goal information' });
  const field = aside.locator('dl > div').first();
  await expect(field.locator('dt')).toHaveText('Goal ID');
  await expect(field.locator('dd > span')).toHaveText(goalId);
  const button = field.getByRole('button', { name: locale === 'zh-CN' ? '复制 Goal ID' : 'Copy Goal ID', exact: true });
  await expect(button).toHaveAttribute('title', locale === 'zh-CN' ? '复制 Goal ID' : 'Copy Goal ID');
  await button.scrollIntoViewIfNeeded();
  await expectCopyButtonSkin(page, button);
  const before = await aside.boundingBox();
  expect(await field.locator('dd > span').evaluate(element => {
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range);
    const text = selection.toString(); selection.removeAllRanges(); return text;
  })).toBe(goalId);
  await page.evaluate(() => navigator.clipboard.writeText('Before copying the Goal ID'));
  if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
  else await button.click();
  await expect(surface.locator('.task-detail-notifications').getByRole('status')).toHaveText(locale === 'zh-CN' ? '已复制' : 'Copied');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(goalId);
  expect(await aside.boundingBox()).toEqual(before);
  expect(await button.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth;
  })).toBe(true);
}

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) for (const empty of [false, true]) test(`Goal information replaces the Task pane at ${width}px in ${locale}, empty=${empty}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page, locale);
  if (empty) fixture.emptyGoal();
  await page.route(`**/api/v1/projects/${projectId}/tasks/${goalId}/goal-dependencies?*`, route => route.fulfill({
    contentType: 'application/json', headers: { 'Daynight-User-ID': TEST_VIEWER_ID },
    body: stringifyWireJson({ goalId, canEdit: false, completionBlocked: !empty,
      prerequisites: empty ? [] : [{ target: { projectId, projectName: 'Client', goalId: otherGoalId, title: 'Long prerequisite Goal '.repeat(5), status: 'todo', kind: 'internal' } }],
      successors: [], nextCursor: null }),
  }));
  const zh = locale === 'zh-CN';
  const writes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
  const check = async (presentation: string) => {
    const surface = page.locator('.goal-detail-surface');
    await expect(surface.getByRole('tab')).toHaveText(zh ? ['描述', '附件', '讨论', '用量'] : ['Description', 'Attachments', 'Discussion', 'Usage']);
    await expect(surface.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await expect(surface.locator('[data-goal-task-id], .goal-detail-overview')).toHaveCount(0);
    const aside = surface.getByRole('complementary', { name: zh ? 'Goal 信息' : 'Goal information' });
    await expect(aside).toBeVisible();
    for (const root of [12, 16, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
      await expect(surface.locator('.task-detail-title')).toHaveCSS('font-size', `${root * 1.375}px`);
      for (const heading of await aside.locator('.goal-information-section > h3').all()) await expect(heading).toHaveCSS('font-size', `${root * 0.875}px`);
      await expect(aside).toHaveCSS('font-size', `${root * 0.75}px`);
      for (const selector of ['.goal-dependencies h4', '.goal-dependency-empty', '.goal-information-general dt', '.goal-information-general dd', '.goal-information-general time', '.goal-information-counts dt', '.goal-information-counts dd', '.goal-information-progress', '.task-tags-summary .button']) {
        const elements = aside.locator(selector);
        await expect(elements.first()).toHaveCSS('font-size', `${root * 0.75}px`);
      }
      if (!empty) for (const selector of ['.goal-dependencies li', '.goal-dependencies a', '.goal-dependency-context', '.goal-dependency-status', '.goal-dependency-blocked']) {
        await expect(aside.locator(selector).first()).toHaveCSS('font-size', `${root * 0.75}px`);
      }
      await expect(surface.locator('.goal-detail-description .markdown-content')).toHaveCSS('font-size', `${root * 0.875}px`);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    const count = (label: string) => aside.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
    await expect(count(zh ? '独立任务数' : 'Standalone tasks')).toHaveText(empty ? '0' : '1');
    await expect(count(zh ? '任务链数' : 'Task chains')).toHaveText(empty ? '0' : '1');
    await expect(count(zh ? '任务总数' : 'Total tasks')).toHaveText(empty ? '0' : '3');
    await expect(count(zh ? '未结束' : 'Unfinished')).toHaveText(empty ? '0' : '3');
    await expect(aside.locator('time').nth(0)).toHaveAttribute('datetime', goal.createdAt);
    await expect(aside.locator('time').nth(1)).toHaveAttribute('datetime', goal.updatedAt);
    const geometry = await surface.evaluate(element => {
      const main = element.querySelector('.goal-detail-description-body')!.getBoundingClientRect();
      const aside = element.querySelector('.goal-information')!.getBoundingClientRect();
      return { mainBottom: main.bottom, mainRight: main.right, asideTop: aside.top, asideLeft: aside.left, overflow: element.scrollWidth > element.clientWidth || document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.overflow).toBe(false);
    if (width <= 740) expect(geometry.asideTop).toBeGreaterThanOrEqual(geometry.mainBottom);
    else expect(geometry.asideLeft).toBeGreaterThanOrEqual(geometry.mainRight);
    await copyGoalId(page, locale, true);
    await page.screenshot({ path: testInfo.outputPath(`goal-information-${presentation}.png`) });
    await surface.getByRole('tab', { name: zh ? '附件' : 'Attachments', exact: true }).click();
    await expect(aside).not.toBeVisible();
    await surface.getByRole('tab').first().click();
    await expect(aside).toBeVisible();
    expect(writes).toEqual([]);
  };
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: zh ? '任务列表' : 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  await check('dialog');
  await page.locator('.goal-detail-surface').getByRole('button', { name: zh ? '进入全屏' : 'Enter fullscreen' }).click();
  await check('fullscreen');
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  await check('page');
});

test('Goal statistics distinguish loading and failures from empty data and retain the last snapshot', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page); fixture.holdNextSync();
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const aside = page.getByRole('complementary', { name: 'Goal information' });
  await expect(aside).toBeVisible();
  await expect(aside.getByRole('status')).toBeVisible();
  await expect(aside.getByRole('status')).toHaveCSS('font-size', '12px');
  await expect(aside.getByText('Total tasks', { exact: true })).toHaveCount(0);
  await copyGoalId(page, 'en');
  await expect.poll(fixture.syncHeld).toBe(true);
  fixture.releaseSync();
  await expect(aside.getByText('Total tasks', { exact: true })).toBeVisible();
  const original = await aside.elementHandle();
  fixture.failNextSync();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(aside.locator('.goal-information-error')).toBeVisible();
  await expect(aside.locator('.goal-information-error')).toHaveCSS('font-size', '12px');
  await expect(aside.getByRole('button', { name: 'Retry refresh' })).toHaveCSS('font-size', '12px');
  await copyGoalId(page, 'en');
  await expect(aside.locator('dt').filter({ hasText: /^Total tasks$/ }).locator('..').locator('dd')).toHaveText('3');
  expect(await aside.evaluate((element, previous) => element === previous, original)).toBe(true);
  await aside.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(aside.locator('.goal-information-error')).toHaveCount(0);
});

test('Goal copy failure stays in its notification host and keyboard retry writes the full ID', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await install(page, 'zh-CN');
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const surface = page.locator('.goal-detail-surface');
  const aside = surface.getByRole('complementary', { name: 'Goal 信息' });
  const button = aside.getByRole('button', { name: '复制 Goal ID', exact: true });
  await button.scrollIntoViewIfNeeded();
  const before = await aside.boundingBox();
  await page.evaluate(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    let reject = true;
    navigator.clipboard.writeText = (value) => {
      if (reject) { reject = false; return Promise.reject(new DOMException('Denied', 'NotAllowedError')); }
      return write(value);
    };
  });
  await button.click();
  const notice = surface.locator('.task-detail-notifications');
  await expect(notice.getByRole('alert')).toHaveText('无法复制 Goal ID，请选中并手动复制。');
  await expect(aside.locator('dd > span').first()).toHaveText(goalId);
  expect(await aside.boundingBox()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('goal-copy-failure.png') });
  await notice.getByRole('button', { name: '关闭提示' }).focus();
  await page.keyboard.press('Enter');
  await expect(surface.locator('.task-detail-title')).toBeFocused();
  await copyGoalId(page, 'zh-CN', true);
  await expect(notice.getByRole('alert')).toHaveCount(0);
});

test('Goal dialog retains statistics through a failed background graph refresh and retries locally', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  const aside = page.getByRole('complementary', { name: 'Goal information' });
  const total = aside.locator('dt').filter({ hasText: /^Total tasks$/ }).locator('..').locator('dd');
  await expect(total).toHaveText('3');
  const original = await aside.elementHandle();
  fixture.failNextSync();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(aside.getByRole('alert')).toBeVisible();
  await expect(total).toHaveText('3');
  expect(await aside.evaluate((element, previous) => element === previous, original)).toBe(true);
  await aside.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(aside.getByRole('alert')).toHaveCount(0);
  await expect(total).toHaveText('3');
});

test('copies the child Task overview from a Goal', async ({ page, context }) => {
  await install(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  await restoreGoalChild(page, singleId);
  const child = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
  await expect(child.locator('.task-detail-title')).toHaveText('Standalone task');
  await child.getByRole('button', { name: 'More task actions' }).click();
  await child.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/projects/${projectId}/tasks/${singleId}`);
  await expect(child.getByText('Link copied')).toBeVisible();
});

for (const presentation of ['dialog', 'page'] as const) test(`restored Goal timed graph stays usable in ${presentation} presentation`, async ({ page }, testInfo) => {
  const errors: Error[] = [];
  page.on('pageerror', error => errors.push(error));
  const fixture = await install(page); fixture.addTimedGoalChain();
  if (presentation === 'dialog') {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: 'Task list', exact: true }).click();
    await page.getByRole('tab', { name: /^Goal/ }).click();
    await page.locator(`#project-goal-detail-${goalId}`).click();
  } else await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const surface = page.locator('.goal-detail-surface');
  await restoreGoalGraph(page, surface);
  const graphDialog = page.locator('.task-chain-dialog');
  await expect(graphDialog).toBeVisible();
  await expect(graphDialog.locator('.task-node')).toHaveCount(3);
  await expect(graphDialog.locator(`[data-id="${firstId}"] .task-duration`)).toHaveAttribute('datetime', 'PT45.000S');
  await expect(graphDialog.locator(`[data-id="${secondId}"] .task-duration`)).toBeVisible();
  const external = graphDialog.locator(`[data-id="${outsideId}"] .task-node-external`);
  await expect(external.locator('.task-duration')).toHaveAttribute('datetime', 'PT30.000S');
  await page.screenshot({ path: testInfo.outputPath(`goal-timed-graph-${presentation}.png`) });
  await graphDialog.getByRole('button', { name: 'Second task, Details' }).click();
  const child = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
  await expect(child.locator('.task-detail-title')).toHaveText('Second task');
  await page.keyboard.press('Escape');
  await expect(child).toHaveCount(0);
  await expect(graphDialog).toBeVisible();
  await graphDialog.getByRole('button', { name: 'Close dependency graph' }).click();
  await expect(graphDialog).toHaveCount(0);
  await expect(surface.locator('.task-detail-title')).toBeFocused();
  expect(errors.map(error => error.message)).toEqual([]);
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal description navigation at ${width}px in ${locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  await install(page, locale);
  const zh = locale === 'zh-CN';
  const names = zh ? ['描述', '附件', '讨论'] : ['Description', 'Attachments', 'Discussion'];
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const surface = page.locator('.goal-detail-surface');
  const tabs = surface.getByRole('tab');
  await expect(tabs).toHaveText(names);
  const descriptionTab = tabs.nth(0), attachmentsTab = tabs.nth(1), discussionTab = tabs.nth(2);
  await expect(descriptionTab).toHaveAttribute('aria-selected', 'true');
  const originalEntry = await page.evaluate(() => history.state.__daynightNavigation.entryId);
  const originalUrl = page.url();
  await descriptionTab.click();
  expect(await page.evaluate(() => history.state.__daynightNavigation.entryId)).toBe(originalEntry);
  expect(page.url()).toBe(originalUrl);
  await expect(surface.locator('.goal-detail-overview')).toHaveCount(0);
  await descriptionTab.focus();
  await page.keyboard.press('Home');
  await expect(descriptionTab).toBeFocused();
  await expect(descriptionTab).toHaveAttribute('aria-selected', 'true');
  await expect(descriptionTab).toHaveAttribute('tabindex', '0');
  const panelId = await descriptionTab.getAttribute('aria-controls');
  const descriptionId = await descriptionTab.getAttribute('id');
  const panel = surface.locator('.goal-detail-description');
  await expect(panel).toHaveAttribute('id', panelId!);
  await expect(panel).toHaveAttribute('aria-labelledby', descriptionId!);
  await expect(panel).toContainText('Paragraph 0 of the goal description.');
  expect(await panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('goal-description.png') });
  await panel.evaluate(element => { element.scrollTop = 100; });
  await page.keyboard.press('ArrowRight');
  await expect(attachmentsTab).toBeFocused();
  await page.keyboard.press('End');
  await expect(discussionTab).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(descriptionTab).toBeFocused();
  expect(await panel.evaluate(element => element.scrollTop)).toBe(100);
  await surface.getByRole('button', { name: zh ? '进入全屏' : 'Enter fullscreen' }).click();
  await expect(descriptionTab).toHaveAttribute('aria-selected', 'true');
  expect(await panel.evaluate(element => element.scrollTop)).toBe(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('goal-description-fullscreen.png') });
});

test('Goal description deep link, reload, history, and empty state', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}?tab=description`);
  const surface = page.locator('.goal-detail-surface');
  const description = surface.getByRole('tab', { name: 'Description', exact: true });
  const attachments = surface.getByRole('tab', { name: 'Attachments', exact: true });
  await expect(description).toHaveAttribute('aria-selected', 'true');
  await expect(surface.locator('.goal-detail-description')).toContainText('Paragraph 0 of the goal description.');
  await page.reload();
  await expect(description).toHaveAttribute('aria-selected', 'true');
  await attachments.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}\\?tab=attachments$`));
  await page.goBack();
  await expect(description).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(attachments).toHaveAttribute('aria-selected', 'true');
  fixture.setGoalDescription('');
  await page.reload();
  await description.click();
  await expect(surface.locator('.goal-detail-description')).toContainText('No description');
});

test('Goal description resolves its image and attachment link to the Goal', async ({ page }) => {
  const fixture = await install(page);
  fixture.setGoalDescription('![Goal image](image.png)\n\n[Read notes](notes.txt)');
  await page.goto(`/projects/${projectId}/tasks/${goalId}?tab=description`);
  const surface = page.locator('.goal-detail-surface');
  const image = surface.getByRole('img', { name: 'Goal image' });
  await expect(image).toHaveAttribute('src', `http://${goalId}.preview.localhost:8787/api/v1/projects/${projectId}/tasks/${goalId}/preview/image.png`);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  await surface.getByRole('link', { name: 'Read notes' }).click();
  await expect(surface.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}/attachments/notes\\.txt$`));
  await expect(surface.locator('.attachment-file-selected')).toContainText('notes.txt');
});

test('ordinary Task description URL normalizes without trapping browser Back', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.goto(`/projects/${projectId}/tasks/${firstId}?tab=description`);
  const task = page.locator('.task-detail-page');
  await expect(task.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(task.getByRole('tab', { name: 'Description', exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=(overview|tasks|prs|tags)$`));
});

test('Goal tabs stay visible during keyboard navigation in a short phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}?tab=description`);
  const surface = page.locator('.goal-detail-surface');
  const tabs = surface.getByRole('tab');
  const list = surface.getByRole('tablist', { name: 'Goal content' });
  const visibleInList = async (tab: Locator) => tab.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const viewport = element.parentElement!.getBoundingClientRect();
    return bounds.left >= viewport.left - 1 && bounds.right <= viewport.right + 1 && bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
  });
  await expect(list).toBeVisible();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  expect(await visibleInList(tabs.nth(0))).toBe(true);
  await tabs.nth(0).focus();
  await page.keyboard.press('End');
  await expect(tabs.nth(2)).toBeFocused();
  expect(await visibleInList(tabs.nth(2))).toBe(true);
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  expect(await visibleInList(tabs.nth(0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

async function retainGoalAttachmentPath(page: Page, goalPage: Locator) {
  await goalPage.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await goalPage.getByRole('button', { name: /^notes\.txt/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}/attachments/notes\\.txt$`));
  await goalPage.getByRole('tab', { name: 'Description', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}/attachments/notes\\.txt\\?tab=description$`));
}

for (const width of [1440, 390, 320]) test(`Task parent Goal is a read-only overview link at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await install(page);
  const longTitle = 'LongGoal标题'.repeat(30);
  fixture.setGoalTitle(longTitle);
  const writes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
  await page.goto(`/projects/${projectId}/tasks/${firstId}`);
  const task = page.locator('.task-detail-page');
  const aside = task.locator('.task-detail-aside');
  const section = aside.getByRole('region', { name: 'Current Goal' });
  const link = section.getByRole('link');
  await expect(link).toHaveText(`${Array.from(longTitle).slice(0, 160).join('')}…`);
  await expect(link).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
  await expect(aside.locator(':scope > section').first()).toHaveAttribute('aria-label', 'Current Goal');
  await expect(task.getByRole('combobox', { name: 'Current Goal' })).toHaveCount(0);
  await expect(task.getByRole('button', { name: 'Save Goal membership' })).toHaveCount(0);
  const geometry = async () => task.evaluate(element => {
    const main = element.querySelector('.task-detail-main')!.getBoundingClientRect();
    const aside = element.querySelector('.task-detail-aside')!.getBoundingClientRect();
    return { mainBottom: main.bottom, mainRight: main.right, asideTop: aside.top, asideLeft: aside.left, scrollWidth: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
  });
  const before = await geometry();
  expect(before.scrollWidth).toBeLessThanOrEqual(before.viewport);
  if (width <= 600) expect(before.asideTop).toBeGreaterThanOrEqual(before.mainBottom);
  else expect(before.asideLeft).toBeGreaterThanOrEqual(before.mainRight);
  await task.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(link).toBeVisible();
  const fullscreen = await geometry();
  expect(fullscreen.scrollWidth).toBeLessThanOrEqual(fullscreen.viewport);
  await task.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await expect(section).toHaveCount(0);
  await task.getByRole('tab', { name: 'Overview', exact: true }).click();
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}$`));
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText(longTitle);
  expect(writes).toEqual([]);
});

test('Task parent Goal link preserves native modified clicks and protects unsaved drafts', async ({ page, context }) => {
  await install(page);
  const writes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
  await page.goto(`/projects/${projectId}/tasks/${firstId}`);
  const task = page.locator('.task-detail-page');
  const link = task.getByRole('region', { name: 'Current Goal' }).getByRole('link', { name: 'Goal reading' });
  const popupPromise = context.waitForEvent('page');
  await link.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp(`/tasks/${goalId}$`));
  await popup.close();
  await expect(page).toHaveURL(new RegExp(`/tasks/${firstId}$`));
  await task.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await task.locator('.thread-composer textarea').fill('Unsaved draft');
  await task.getByRole('tab', { name: 'Overview', exact: true }).click();
  await link.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${firstId}$`));
  await link.click();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}$`));
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  expect(writes).toEqual([]);
});

for (const attachmentBacked of [false, true]) test(`nested Task follows its parent Goal with attachment path ${attachmentBacked}`, async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  if (attachmentBacked) await retainGoalAttachmentPath(page, goalPage);
  await restoreGoalChild(page, singleId);
  const task = page.getByRole('dialog', { name: 'Standalone task' });
  const aside = task.locator('.task-detail-aside');
  await expect(aside.locator(':scope > section').first()).toHaveAttribute('aria-label', 'Current Goal');
  await expect(aside.getByRole('link', { name: 'Goal reading' })).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
  await task.getByRole('button', { name: 'Enter fullscreen' }).click();
  const link = aside.getByRole('link', { name: 'Goal reading' });
  await expect(link).toBeVisible();
  await task.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await task.locator('.thread-composer textarea').fill('Nested draft');
  await task.getByRole('tab', { name: 'Overview', exact: true }).click();
  await link.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(task).toBeVisible();
  if (attachmentBacked) await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}/attachments/notes\\.txt\\?tab=description$`));
  await link.click();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(task).toHaveCount(0);
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}$`));
});

test('Task opened from its Goal dependency graph follows the parent link', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await restoreGoalGraph(page, goalPage);
  const graphDialog = page.locator('.task-chain-dialog');
  await graphDialog.getByRole('button', { name: 'First task, Details' }).click();
  const task = page.getByRole('dialog', { name: 'First task', exact: true });
  await task.getByRole('region', { name: 'Current Goal' }).getByRole('link', { name: 'Goal reading' }).click();
  await expect(task).toHaveCount(0);
  await expect(graphDialog).toHaveCount(0);
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}$`));
});

test('Task parent link returns a Goal URL with a different query to overview', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}?tab=overview`);
  const goalPage = page.locator('.goal-detail-surface');
  await restoreGoalChild(page, singleId);
  const task = page.getByRole('dialog', { name: 'Standalone task' });
  await task.getByRole('region', { name: 'Current Goal' }).getByRole('link', { name: 'Goal reading' }).click();
  await expect(task).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}$`));
  await expect(goalPage.getByRole('tab', { name: 'Description', exact: true })).toHaveAttribute('aria-selected', 'true');
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal pause count remains readable with a long title at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale); fixture.addPausedTask();
  fixture.setGoalTitle('Long Goal 标题 '.repeat(20));
  const zh = locale === 'zh-CN';
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: zh ? '任务列表' : 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const toggle = card.locator('.goal-list-toggle');
  const count = card.locator('.task-pause-count');
  await expect(count).toHaveText(zh ? '1 受阻' : '1 blocked');
  await expect(toggle).toHaveAccessibleDescription(zh ? /1 受阻/ : /1 blocked/);
  const layout = await card.evaluate(element => {
    const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const count = box('.task-pause-count'), progress = box('.goal-in-progress'), row = box('.goal-list-row');
    const others = ['.goal-list-title', '.goal-list-progress', '.root-status', '.goal-list-detail', '.goal-list-graph'].map(box);
    const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    return {
      ordered: count.top >= progress.bottom - 1 || (count.bottom > progress.top && count.top < progress.bottom && count.left >= progress.right - 1),
      inside: count.width > 0 && count.height > 0 && count.left >= row.left - 1 && count.right <= row.right + 1 && count.top >= row.top - 1 && count.bottom <= row.bottom + 1,
      separate: others.every(other => separate(count, other)),
      noOverflow: document.documentElement.scrollWidth <= innerWidth && element.scrollWidth <= element.clientWidth + 1,
      noClipping: [...element.querySelectorAll<HTMLElement>('.goal-in-progress, .task-pause-count')].every(part => part.scrollWidth <= part.clientWidth + 1 && part.scrollHeight <= part.clientHeight + 1),
    };
  });
  expect(layout).toEqual({ ordered: true, inside: true, separate: true, noOverflow: true, noClipping: true });
  await expectHit(count);
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(count).toHaveText(zh ? '1 受阻' : '1 blocked');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expectHit(card.locator('.goal-list-detail'));
  await expectHit(card.locator('.goal-list-graph'));
  expect(await page.locator('button button, button a, a button').count()).toBe(0);
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal list owns paused Task and graph navigation at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale); fixture.addPausedTask();
  const zh = locale === 'zh-CN';
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: zh ? '任务列表' : 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await card.locator('.goal-list-toggle').click();
  await expect(card.locator('.task-paused-badge')).toHaveText(zh ? '受阻' : 'Blocked');
  const opener = card.locator(`#project-goal-graph-${goalId}`);
  await opener.click();
  const graph = page.locator('.task-chain-dialog');
  const graphBadge = graph.locator('.task-node-paused .task-paused-badge');
  await expect(graphBadge).toHaveText(zh ? '受阻' : 'Blocked');
  await expect(graphBadge).toHaveClass(/compact/);
  await expect(graphBadge).toBeVisible();
  expect(await graphBadge.evaluate(element => {
    const badge = element.getBoundingClientRect(), node = element.closest('.task-node')!.getBoundingClientRect();
    return badge.width > 0 && badge.height > 0 && badge.left >= node.left - 1 && badge.right <= node.right + 1 && badge.top >= node.top - 1 && badge.bottom <= node.bottom + 1;
  })).toBe(true);
  await graph.getByRole('button', { name: zh ? '适应画布' : 'Fit to canvas' }).click();
  await expect.poll(() => graphBadge.evaluate(element => {
    const badge = element.getBoundingClientRect(), canvas = element.closest('.task-graph-canvas')!.getBoundingClientRect();
    return badge.left >= canvas.left && badge.right <= canvas.right && badge.top >= canvas.top && badge.bottom <= canvas.bottom;
  })).toBe(true);
  await graph.locator(`[data-id="${secondId}"] .task-node-details`).click();
  const child = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
  await expect(child).toBeVisible();
  await page.keyboard.press('Escape');
  await graph.getByRole('button', { name: zh ? '关闭依赖图' : 'Close dependency graph' }).click();
  await expect(opener).toBeFocused();
  await expect(card.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 320]) test(`external Expand opens the target Goal chain and Details opens its Task at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page); fixture.addExternalGoalChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await card.locator('.goal-list-toggle').click();
  const opener = card.locator(`#project-goal-detail-${goalId}`);
  await opener.click();
  const sourceGoal = page.getByRole('dialog', { name: 'Goal reading', exact: true });
  await restoreGoalGraph(page, sourceGoal);
  const sourceGraph = page.locator('.task-chain-dialog').first();
  const target = sourceGraph.locator(`[data-id="${otherTaskId}"]`);
  const expand = target.getByRole('button', { name: 'Expand Other task in its task or Goal', exact: true });
  await test.step('Open the external Goal chain', () => expand.click());
  const targetGoal = page.getByRole('dialog', { name: 'Other goal', exact: true });
  const targetGraph = page.locator('.task-chain-dialog').filter({ has: page.getByRole('heading', { name: 'Other task', exact: true }) });
  await expect(targetGoal).toBeVisible();
  await expect(targetGoal.getByRole('tab')).toHaveText(['Description', 'Attachments', 'Discussion']);
  await expect(targetGraph).toHaveAccessibleName('Other task');
  await expect(targetGraph.locator('.task-node')).toHaveCount(2);
  await expect(targetGoal).toHaveAttribute('inert', '');
  const closeTargetGraph = targetGraph.getByRole('button', { name: 'Close dependency graph' });
  await expect(closeTargetGraph).toBeFocused();
  await expectHit(closeTargetGraph);
  await expect(page.locator('.task-detail-dialog:not(.goal-detail-surface)')).toHaveCount(0);
  await test.step('Return to the source graph', () => page.goBack({ timeout: 5_000 }));
  await expect(targetGoal).toHaveCount(0);
  await expect(sourceGraph).toBeVisible();
  await test.step('Restore the target graph', () => page.goForward({ timeout: 5_000 }));
  await expect(targetGraph).toHaveAccessibleName('Other task');
  await expect(targetGraph.locator('.task-node')).toHaveCount(2);
  await expect(targetGoal).toHaveAttribute('inert', '');
  await expect(closeTargetGraph).toBeFocused();
  await expectHit(closeTargetGraph);
  await test.step('Close the target graph', () => targetGraph.getByRole('button', { name: 'Close dependency graph' }).click());
  await test.step('Close the target Goal', () => targetGoal.getByRole('button', { name: 'Close task details' }).click());
  await opener.click();
  await restoreGoalGraph(page, sourceGoal);
  await expect(sourceGraph).toBeVisible();
  await target.getByRole('button', { name: 'Other task, Details' }).click();
  await expect(targetGoal).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Other task', exact: true })).toBeVisible();
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  await expect(card.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('standalone Goal external Expand enters an unowned chain through the project fragment and preserves history', async ({ page }) => {
  const fixture = await install(page); fixture.addGoalExternalChain();
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const sourceGoal = page.locator('.goal-detail-surface');
  await restoreGoalGraph(page, sourceGoal);
  const sourceGraph = page.locator('.task-chain-dialog');
  await sourceGraph.locator(`[data-id="${outsideId}"]`).getByRole('button', { name: 'Expand Outside chain in its task or Goal' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=tasks$`));
  await expect(page.getByRole('tab', { name: /^Task chains/ })).toHaveAttribute('aria-selected', 'true');
  const targetGraph = page.locator('.task-chain-dialog');
  await expect(targetGraph).toHaveAccessibleName('Outside chain');
  await expect(targetGraph.locator('.task-node')).toHaveCount(3);
  await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
  await page.goBack();
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  await expect(page.locator('.task-chain-dialog')).toHaveAccessibleName('First task');
  await page.goForward();
  await expect(targetGraph).toHaveAccessibleName('Outside chain');
  await targetGraph.locator(`[data-id="${singleId}"]`).getByRole('button', { name: 'Expand Outside singleton in its task or Goal' }).click();
  await expect(page.getByRole('dialog', { name: 'Outside singleton', exact: true })).toBeVisible();
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
});

test('Goal write errors identify refusals without exposing internal diagnostics', async ({ page, context }) => {
  const fixture = await install(page); fixture.rejectWrites();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  const dialog = page.getByRole('dialog', { name: 'Goal reading' });
  await dialog.locator('.task-status-trigger').click();
  await dialog.getByRole('menuitemradio', { name: 'In progress' }).click();
  await expect(dialog.locator('p[role=alert]').filter({ hasText: 'goal-write-2' })).toContainText('You do not have permission');
  await dialog.getByRole('button', { name: /^Assignee:/ }).click();
  await dialog.locator('.assignee-menu').getByRole('option', { name: /Long owner name/ }).click();
  await expect(dialog.locator('p[role=alert]').filter({ hasText: 'goal-write-3' })).toContainText('assignee is unavailable');
  await dialog.getByRole('button', { name: 'Delete Goal' }).click();
  await page.getByRole('alertdialog', { name: 'Delete this Goal?' }).getByRole('button', { name: 'Delete Goal' }).click();
  await expect(dialog.locator('p[role=alert]').filter({ hasText: 'goal-write-4' })).toContainText('You do not have permission');
  await expect(dialog).not.toContainText('secret SQL detail');
  await dialog.getByRole('button', { name: 'Close task details' }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await card.getByRole('button', { name: 'Copy Goal ID' }).click();
  await expect(card.getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(goalId);
  await expect(card.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'false');
});

for (const mode of ['pending', 'conflict', 'unknown'] as const) test(`Goal editing preserves its draft on ${mode} result`, async ({ page }) => {
  const fixture = await install(page); fixture.setEditMode(mode);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
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
  await page.locator(`#project-goal-detail-${goalId}`).click();
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
  await page.locator(`#project-goal-detail-${goalId}`).click();
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
  await form.locator('input[required]').fill('A new Goal');
  await form.getByLabel('Description').fill('Keep this draft');
  await form.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(form.getByRole('alert').first()).toContainText('outcome is unknown');
  expect(fixture.creates()).toEqual([{ title: 'A new Goal', description: 'Keep this draft', type: 'goal', assignedTo: TEST_VIEWER_ID, tagIds: [] }]);
  await form.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('tab', { name: /^Task chains/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.getByRole('button', { name: 'New Goal' }).click();
  await expect(form.locator('input[required]')).toHaveValue('A new Goal');
  await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
  expect(fixture.creates()).toHaveLength(1);
});

for (const width of [1440, 390]) test(`Goal status confirmations preserve children and permit reopening at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  const status = goalDialog.locator('.task-status-trigger');
  const selectStatus = async (label: string) => {
    await status.click();
    await goalDialog.getByRole('menuitemradio', { name: label, exact: true }).click();
  };
  await selectStatus('Done');
  const confirmation = page.getByRole('alertdialog', { name: 'Complete this Goal?' });
  await expect(confirmation).toContainText('Task statuses remain unchanged');
  await confirmation.getByRole('button', { name: 'Back' }).click();
  expect(fixture.statusWrites()).toHaveLength(0);
  await expect(status).toHaveText('To do');
  await selectStatus('Done');
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => fixture.statusWrites().length).toBe(1);
  await expect(status).toHaveText('Done');
  await expect(goalDialog.getByRole('button', { name: 'New Task' })).toHaveCount(0);
  await expect(goalDialog.locator('[data-goal-task-id]')).toHaveCount(0);
  await expect(goalDialog.locator('.goal-information')).toContainText('3');
  await selectStatus('To do');
  await expect.poll(() => fixture.statusWrites().length).toBe(2);
  await expect(status).toHaveText('To do');
  await selectStatus('Cancelled');
  await page.getByRole('alertdialog', { name: 'Cancel this Goal?' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => fixture.statusWrites().length).toBe(3);
  await expect(status).toHaveText('Cancelled');
  await selectStatus('In progress');
  await expect.poll(() => fixture.statusWrites().length).toBe(4);
  await expect(status).toHaveText('In progress');
  expect(fixture.statusWrites()).toEqual([{ status: 'done', version: 1 }, { status: 'todo', version: 2 }, { status: 'cancelled', version: 3 }, { status: 'in_progress', version: 4 }]);
  await goalDialog.getByRole('button', { name: 'Delete Goal' }).click();
  const deletion = page.getByRole('alertdialog', { name: 'Delete this Goal?' });
  await expect(deletion).toContainText('Their Parent remains');
  await deletion.getByRole('button', { name: 'Back' }).click();
  await expect(goalDialog).toBeVisible();
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal status menu fits the detail page and fullscreen at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale);
  const zh = locale === 'zh-CN';
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const surface = page.locator('.goal-detail-surface');
  const status = surface.locator('.task-status-trigger');
  const check = async () => {
    await expect(status).toHaveText(zh ? '待处理' : 'To do');
    await expect(surface.locator('.goal-detail-meta select')).toHaveCount(0);
    const controls = surface.locator('.task-detail-status-assignee');
    await expect(controls.locator('.task-assignee-field')).toBeVisible();
    expect(await controls.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const parts = [...element.children].map(child => child.getBoundingClientRect());
      return element.scrollWidth <= element.clientWidth && parts.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1)
        && Math.abs(parts[0]!.top - parts[1]!.top) < 2;
    })).toBe(true);
    await status.focus();
    await page.keyboard.press('Enter');
    const menu = surface.getByRole('menu');
    const options = menu.getByRole('menuitemradio');
    await expect(options).toHaveCount(4);
    const names = zh ? ['待处理', '进行中', '已完成', '已取消'] : ['To do', 'In progress', 'Done', 'Cancelled'];
    for (const name of names) await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeVisible();
    await expect(options.first()).toHaveAttribute('aria-checked', 'true');
    expect(await menu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    await page.keyboard.press('End');
    await expect(options.last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(status).toBeFocused();
    expect(fixture.statusWrites()).toHaveLength(0);
  };
  await check();
  await surface.getByRole('button', { name: zh ? '进入全屏' : 'Enter fullscreen' }).click();
  await check();
});

for (const width of [1366, 390, 320]) test(`active chain indicator remains usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page); fixture.addActiveChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  const header = page.locator(`#task-root-${outsideId}`);
  const chain = page.locator(`[data-chain-id="${outsideId}"]`);
  await expect(header).toHaveAccessibleName(/Automatic execution active/);
  await expect(chain.locator('.chain-worker-active')).toBeVisible();
  await expect(chain.locator('.assignee-name').first()).toHaveText('Long owner name '.repeat(8).trim());
  expect(await page.locator(`[data-chain-id="${outsideId}"]`).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await header.focus(); await page.keyboard.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(chain.locator('.chain-worker-active')).toBeVisible();
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
  await page.locator(`#project-goal-detail-${goalId}`).click();
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
  const entry = page.locator(`#project-goal-detail-${goalId}`); await entry.click();
  const goalDialog = page.locator('.goal-detail-surface'); await expect(goalDialog).toBeVisible();
  await expect(goalDialog.locator('[data-goal-task-id]')).toHaveCount(0);
  await goalDialog.getByRole('tab', { name: 'Description', exact: true }).click();
  const description = goalDialog.locator('.goal-detail-description');
  expect(await description.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await description.evaluate(element => { element.scrollTop = 100; });
  expect(await description.evaluate(element => element.scrollTop)).toBe(100);
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click();
  const draft = goalDialog.locator('.thread-composer textarea'); await draft.fill('A retained draft');
  await goalDialog.getByRole('tab', { name: 'Attachments' }).click();
  await goalDialog.getByRole('button', { name: /^notes\.txt/ }).click();
  await goalDialog.getByRole('button', { name: 'Enter fullscreen' }).click();
  await expect(goalDialog.locator('.attachment-file-selected')).toContainText('notes.txt');
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click(); await expect(draft).toHaveValue('A retained draft');
  await goalDialog.getByRole('tab', { name: 'Description', exact: true }).click();
  expect(await description.evaluate(element => element.scrollTop)).toBe(100);
  await goalDialog.getByRole('tab', { name: 'Description' }).click();
  await restoreGoalChild(page, firstId);
  const child = page.getByRole('dialog', { name: 'First task', exact: true }); await expect(child).toBeVisible(); await expect(goalDialog).toHaveAttribute('inert', '');
  await page.keyboard.press('Tab'); expect(await child.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(child).toHaveCount(0); await expect(goalDialog.locator('.task-detail-title')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(goalDialog.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  await restoreGoalGraph(page, goalDialog);
  const graphDialog = page.getByRole('dialog', { name: 'First task', exact: true });
  await expect(graphDialog).toBeVisible(); await expect(goalDialog).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape'); await expect(graphDialog).toHaveCount(0);
  await expect(goalDialog.locator('.task-detail-title')).toBeFocused();
});

test('returning from two goals restores the original unassigned chain view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page); fixture.addOutsideChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Task chains/ }).click();
  await selectStatus(page, 'todo'); const status = statusButton(page);
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
  const firstChild = page.getByRole('dialog', { name: 'First task', exact: true });
  await expect(firstChild).toBeVisible();
  await firstChild.getByRole('button', { name: 'Close task details' }).click();
  await restoreGoalGraph(page, firstGoal, outsideId);
  const nestedGraph = page.locator('.task-chain-dialog').last();
  await nestedGraph.getByRole('button', { name: 'Other task, Details' }).click();
  const otherGoal = page.getByRole('dialog', { name: 'Other goal' });
  await expect(page.getByRole('dialog', { name: 'Other task', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Other task', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(otherGoal).toHaveCount(0); await expect(originalGraph).toBeVisible(); await expect(originalTarget).toBeFocused();
  await page.keyboard.press('Escape'); await expect(originalGraph).toHaveCount(0);
  await expect(open).toBeFocused(); await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(status).toHaveText('To do');
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
});

test('cross-goal graph navigation asks before discarding the goal draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page); fixture.addCrossGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const entry = page.locator(`#project-goal-detail-${goalId}`); await expectHit(entry); await entry.click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click();
  const draft = goalDialog.locator('.thread-composer textarea'); await draft.fill('Keep this Goal draft');
  await goalDialog.getByRole('tab', { name: 'Description' }).click();
  await restoreGoalGraph(page, goalDialog);
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
  await expect(page.getByRole('dialog', { name: 'Other task', exact: true })).toBeVisible();
});

test('a changing chain keeps its open task draft, focus and modal isolation', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await restoreGoalGraph(page, goalDialog);
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
  const entry = page.locator(`#project-goal-detail-${goalId}`); await expectHit(entry); await entry.click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await goalDialog.getByRole('tab', { name: 'Discussion' }).click();
  await goalDialog.locator('.thread-composer textarea').fill('Goal draft');
  await goalDialog.getByRole('tab', { name: 'Description' }).click();
  await restoreGoalGraph(page, goalDialog);
  const graphDialog = page.getByRole('dialog', { name: 'First task' });
  const openTask = graphDialog.getByRole('button', { name: 'Second task, Details' }); await expectHit(openTask); await openTask.click();
  const taskDialog = page.getByRole('dialog', { name: 'Second task' });
  const discussionTab = taskDialog.getByRole('tab', { name: 'Discussion' }); await expectHit(discussionTab); await discussionTab.click();
  await taskDialog.locator('.thread-composer textarea').fill('Task draft');
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
  await expect(page.getByRole('dialog', { name: 'Other task', exact: true })).toBeVisible();
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
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'First task' }) });
  await activate(child.getByRole('tab', { name: 'Attachments', exact: true }));
  await activate(child.getByRole('button', { name: /^notes\.txt/ }));
  await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toBeVisible();
  const preferences = await page.evaluate(() => ({ ...localStorage }));

  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(child).toHaveCount(0); await expect(goalDialog).toHaveCount(0); await expect(projectGraph).toBeVisible();
  await expect.poll(() => projectGraph.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.goBack(); await expect(projectGraph).toHaveCount(0);
  await page.goBack(); await expect(page.getByRole('tab', { name: /^Goal/ })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(page.getByRole('tab', { name: /^Task chains/ })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: 'Task list', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: /^Goal/ })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(page.getByRole('tab', { name: /^Task chains/ })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(projectGraph).toBeVisible();
  await page.goForward(); await expect(goalDialog).toBeVisible(); await expect(child).toBeVisible();
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
  await page.locator(`#project-goal-detail-${goalId}`).click();
  const goalDialog = page.getByRole('dialog', { name: 'Goal reading' });
  await restoreGoalGraph(page, goalDialog);
  const graphDialog = page.getByRole('dialog', { name: 'First task', exact: true });
  await graphDialog.getByRole('button', { name: 'First task, Details' }).click();
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'First task' }) });
  await child.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = child.locator('.thread-composer textarea');
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
  await goalPage.getByRole('tab', { name: 'Description', exact: true }).click();
  await restoreGoalGraph(page, goalPage);
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
  await expect(goalPage.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(goalPage.getByRole('tab', { name: 'Description', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(goalPage.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(child).toBeVisible();
  await page.goForward(); await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
});

test('closing a standalone Goal child replaces the current entry with its graph parent', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await restoreGoalGraph(page, goalPage);
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
  await restoreGoalChild(page, singleId);
  const child = page.locator('.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'Standalone task' }) });
  await child.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = child.locator('.thread-composer textarea');
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
  await child.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(draft).toHaveValue('Retained child draft');
});

test('a new child draft is protected from a retired same-child history entry', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await restoreGoalChild(page, singleId);
  const child = page.getByRole('dialog', { name: 'Standalone task' });
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  fixture.advanceEpoch();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(child).toHaveCount(0);
  await restoreGoalChild(page, singleId);
  await child.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = child.locator('.thread-composer textarea');
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
  await restoreGoalGraph(page, goalPage);
  const graphDialog = page.locator('.task-chain-dialog');
  await graphDialog.getByRole('button', { name: 'Other task, Details' }).click();
  const external = page.getByRole('dialog', { name: 'Other goal' });
  await expect(external).toBeVisible(); await expect(graphDialog).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Other task', exact: true }).getByRole('button', { name: 'Close task details' }).click();
  await external.getByRole('tab', { name: 'Description', exact: true }).click();
  await expect(external.locator('.goal-detail-description')).toContainText('No description');
  await external.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await external.getByRole('button', { name: /^notes\.txt/ }).click();
  await expect(external.locator('.attachment-file-selected')).toContainText('notes.txt');
  await page.goBack(); await expect(external.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(external.getByRole('tab', { name: 'Description', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(external).toHaveCount(0); await expect(graphDialog).toBeVisible();
  await page.goForward(); await expect(external).toBeVisible(); await expect(graphDialog).toHaveCount(0);
  await page.goForward(); await expect(external.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(external.locator('.attachment-file-selected')).toContainText('notes.txt');
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}\\?tab=description$`));
  await page.reload();
  await expect(external).toHaveCount(0);
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
});

for (const attachmentBacked of [false, true]) test(`a moved external Goal child follows its latest parent and protects both drafts with attachment path ${attachmentBacked}`, async ({ page }) => {
  const fixture = await install(page); fixture.addCrossGoal();
  const writes: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface.task-detail-page');
  if (attachmentBacked) await retainGoalAttachmentPath(page, goalPage);
  await restoreGoalGraph(page, goalPage);
  await page.locator('.task-chain-dialog').getByRole('button', { name: 'Other task, Details' }).click();
  const external = page.locator('.goal-detail-surface.task-detail-dialog').filter({ has: page.locator('.task-detail-title', { hasText: 'Other goal' }) });
  await page.getByRole('dialog', { name: 'Other task', exact: true }).getByRole('button', { name: 'Close task details' }).click();
  await external.getByRole('tab', { name: 'Discussion' }).click();
  const goalDraft = external.locator('.thread-composer textarea');
  await goalDraft.fill('External Goal draft');
  await external.getByRole('tab', { name: 'Description' }).click();
  await restoreGoalChild(page, otherTaskId, otherGoalId);
  const child = page.getByRole('dialog', { name: 'Other task', exact: true });
  await child.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const taskDraft = child.locator('.thread-composer textarea');
  await taskDraft.fill('Child Task draft');
  await child.getByRole('tab', { name: 'Overview' }).click();
  fixture.moveOtherTaskToGoal();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const link = child.getByRole('region', { name: 'Current Goal' }).getByRole('link', { name: 'Goal reading' });
  await expect(link).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
  await link.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(child).toBeVisible();
  await expect(taskDraft).toHaveValue('Child Task draft');
  await expect(goalDraft).toHaveValue('External Goal draft');
  if (attachmentBacked) await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}/attachments/notes\\.txt\\?tab=description$`));
  await link.click();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(child).toHaveCount(0);
  await expect(external).toHaveCount(0);
  await expect(page.locator('.goal-detail-surface.task-detail-page .task-detail-title')).toHaveText('Goal reading');
  await expect(page).toHaveURL(new RegExp(`/tasks/${goalId}$`));
  await expect.poll(() => goalPage.evaluate(element => element.contains(document.activeElement))).toBe(true);
  expect(writes).toEqual([]);
});

test('history retains an external Goal draft when its old witness moves', async ({ page }) => {
  const fixture = await install(page); fixture.addTwoExternalTasks();
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const goalPage = page.locator('.goal-detail-surface');
  await restoreGoalGraph(page, goalPage);
  await page.locator('.task-chain-dialog').getByRole('button', { name: 'Other task, Details' }).click();
  const external = page.getByRole('dialog', { name: 'Other goal' });
  await page.getByRole('dialog', { name: 'Other task', exact: true }).getByRole('button', { name: 'Close task details' }).click();
  const previousGoalEntry = await page.evaluate(() => history.state.__daynightNavigation.index as number);
  await external.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await external.getByRole('button', { name: 'Close task details' }).click();
  await restoreGoalGraph(page, goalPage);
  await page.locator('.task-chain-dialog').getByRole('button', { name: 'Other second task, Details' }).click();
  await expect(external.locator('[data-goal-task-id]')).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Other second task', exact: true }).getByRole('button', { name: 'Close task details' }).click();
  await external.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await external.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('alertdialog', { name: 'Edit Goal' });
  const draft = edit.getByRole('textbox', { name: 'Description', exact: true });
  await draft.fill('Keep this Goal draft');
  const original = await external.elementHandle();
  fixture.moveOtherTask();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(external.locator('[data-goal-task-id]')).toHaveCount(0);
  await page.evaluate(previous => history.go(previous - history.state.__daynightNavigation.index), previousGoalEntry);
  await expect(external.locator('[role="tab"][aria-selected="true"]')).toHaveText('Description');
  await expect(edit).toBeVisible();
  await expect(draft).toHaveValue('Keep this Goal draft');
  expect(await external.evaluate((element, previous) => element === previous, original)).toBe(true);
});

// Exercise the shared FormDialog through its real project and Goal consumers.
async function expectFormSkin(page: Page, dialog: Locator) {
  const geometry = await dialog.evaluate(element => {
    const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect(), title = rect('.dialog-header h2'), close = rect('.dialog-header .close-button');
    const body = element.querySelector<HTMLElement>('.dialog-body')!;
    const footer = rect('.dialog-footer');
    const button = element.querySelector<HTMLElement>('.dialog-footer .primary')!.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body), closeStyle = getComputedStyle(element.querySelector('.close-button')!);
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
      titleTop: title.top, titleBottom: title.bottom, titleRight: title.right, closeTop: close.top, closeBottom: close.bottom, closeLeft: close.left,
      paddingLeft: parseFloat(bodyStyle.paddingLeft), paddingTop: parseFloat(bodyStyle.paddingTop),
      footerRight: footer.right, buttonRight: button.right, closeBorder: closeStyle.borderTopStyle,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, pageWidth: document.documentElement.scrollWidth, baselineWidth: Number(document.documentElement.dataset.formBaseWidth), viewportWidth: innerWidth, viewportHeight: innerHeight };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  for (const body of await dialog.locator('.dialog-body').all()) {
    expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(geometry.pageWidth).toBeLessThanOrEqual(Math.max(geometry.viewportWidth, geometry.baselineWidth));
  expect(geometry.titleTop).toBeLessThan(geometry.closeBottom);
  expect(geometry.closeTop).toBeLessThan(geometry.titleBottom);
  expect(geometry.titleRight).toBeLessThanOrEqual(geometry.closeLeft);
  expect(geometry.paddingLeft).toBeGreaterThan(0);
  expect(geometry.paddingTop).toBeGreaterThan(0);
  expect(geometry.footerRight - geometry.buttonRight).toBeLessThan(30);
  expect(geometry.closeBorder).toBe('none');
  const field = dialog.locator('.task-organization-fields input, .task-organization-fields textarea, .task-organization-fields select').first();
  if (await field.count()) {
    const style = await field.evaluate(element => { const s = getComputedStyle(element); return { padding: parseFloat(s.paddingLeft), radius: parseFloat(s.borderTopLeftRadius), border: s.borderTopStyle }; });
    expect(style.padding).toBeGreaterThan(0);
    expect(style.radius).toBeGreaterThan(0);
    expect(style.border).toBe('solid');
  }
  await expectHit(dialog.locator('.dialog-header .close-button'));
  await expectHit(dialog.locator('.dialog-footer button').first());
  await expectHit(dialog.locator('.dialog-footer .primary'));
  expect(await page.locator('.task-organization-dialog select[aria-label*="language" i]').count()).toBe(0);
  return geometry;
}

const projectFormOpener = async (page: Page, entry: FormEntry, locale: 'en' | 'zh-CN') => {
  const zh = locale === 'zh-CN';
  const trigger = page.locator('.project-actions-trigger');
  await trigger.waitFor({ state: 'attached' });
  return await trigger.isVisible()
    ? trigger
    : page.locator('.project-title-actions').getByRole('button', { name: entry === 'project-task' ? (zh ? '新建 Task' : 'New Task') : (zh ? '新建 Goal' : 'New Goal'), exact: true });
};
async function openProjectFormEntry(page: Page, entry: FormEntry, locale: 'en' | 'zh-CN') {
  const zh = locale === 'zh-CN', opener = await projectFormOpener(page, entry, locale);
  const compact = await opener.evaluate(element => element.classList.contains('project-actions-trigger'));
  await opener.click();
  if (compact) await page.getByRole('menuitem', { name: entry === 'project-task' ? (zh ? '新建 Task' : 'New Task') : (zh ? '新建 Goal' : 'New Goal'), exact: true }).click();
}

type FormEntry = 'project-task' | 'project-goal';
async function openForm(page: Page, entry: FormEntry, locale: 'en' | 'zh-CN') {
  await page.goto(`/projects/${projectId}`);
  if (entry === 'project-task') {
    await page.evaluate(() => { document.documentElement.dataset.formBaseWidth = String(document.documentElement.scrollWidth); });
    await openProjectFormEntry(page, entry, locale);
  } else {
    await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
    await page.getByRole('tab', { name: /^Goal/ }).click();
    await page.evaluate(() => { document.documentElement.dataset.formBaseWidth = String(document.documentElement.scrollWidth); });
    await openProjectFormEntry(page, entry, locale);
  }
  return page.locator('.task-organization-dialog');
}

for (const width of [320, 390]) test(`project Task opens from the mobile menu after delayed identity at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await install(page);
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  await page.route('**/api/v1/me', async route => { started.resolve(); await release.promise; await route.fallback(); });
  try {
    await page.goto(`/projects/${projectId}`);
    await started.promise;
    let selected = false;
    const selecting = projectFormOpener(page, 'project-task', 'en').then(opener => { selected = true; return opener; });
    await expect(page.locator('.project-actions-trigger')).toHaveCount(0);
    expect(selected).toBe(false);
    release.resolve();
    await expect(await selecting).toHaveClass(/project-actions-trigger/);
    await openProjectFormEntry(page, 'project-task', 'en');
    const dialog = page.locator('.task-organization-dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Project actions', exact: true })).toBeFocused();
  } finally { release.resolve(); }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
  for (const entry of ['project-task', 'project-goal'] as const) test(`shared form skin: ${entry} at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const fixture = await install(page);
    fixture.addCrossGoal(); fixture.setGoalTitle('LongGoal名称'.repeat(30));
    const dialog = await openForm(page, entry, 'en');
    await expect(dialog).toBeVisible();
    const geometry = await expectFormSkin(page, dialog);
    await writeFile(testInfo.outputPath('geometry.json'), JSON.stringify({ entry, viewport, geometry }, null, 2));
    await page.screenshot({ path: testInfo.outputPath('form.png') });
  });
}

for (const width of [1440, 320]) test(`native Task form menu cancels before its dialog at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const fixture = await install(page);
  const longGoal = 'Long Goal name '.repeat(24);
  fixture.setGoalTitle(longGoal);
  const dialog = await openForm(page, 'project-task', 'en');
  const opener = await projectFormOpener(page, 'project-task', 'en');
  const title = dialog.getByLabel('Title', { exact: true });
  const goal = dialog.getByRole('combobox', { name: 'Goal', exact: true });
  const assignee = dialog.getByRole('combobox', { name: 'Assignee', exact: true });
  await title.fill('Retained draft'); await goal.selectOption(goalId);
  await expect(goal.locator('option:checked')).toContainText('Long Goal name');
  await expect(goal.locator('option:checked')).toContainText(goalId);
  for (const select of [goal, assignee]) {
    expect(await select.evaluate(node => node.getBoundingClientRect().height)).toBe(38);
    await select.click();
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
    await expect(dialog).toBeVisible(); await expect(title).toHaveValue('Retained draft');
    await expect(goal).toHaveValue(goalId); await expect(select).toBeFocused();
  }
  await expectFormSkin(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await openProjectFormEntry(page, 'project-task', 'en'); await expect(title).toHaveValue('Retained draft');
  expect(fixture.creates()).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`Project Task short viewport keeps errors, recovery and draft accessible in ${locale}`, async ({ page }, testInfo) => {
  const zh = locale === 'zh-CN';
  await page.setViewportSize({ width: 320, height: 320 });
  const fixture = await install(page, locale);
  fixture.setGoalTitle('LongGoal名称'.repeat(30)); fixture.failPeople();
  const dialog = await openForm(page, 'project-task', locale);
  const opener = await projectFormOpener(page, 'project-task', locale);
  const title = dialog.getByLabel(zh ? '标题' : 'Title', { exact: true });
  await title.fill('Retained Task draft');
  await dialog.getByRole('combobox', { name: 'Goal', exact: true }).selectOption(goalId);
  await expect(dialog.getByRole('combobox', { name: zh ? '负责人' : 'Assignee', exact: true })).toBeVisible();
  await expect(dialog.getByText(zh ? '无法读取负责人列表。' : 'Could not load assignees.', { exact: false })).toBeVisible();
  await expectHit(dialog.getByRole('button', { name: zh ? '重试' : 'Retry' }));
  await expectFormSkin(page, dialog);
  const body = dialog.locator('.dialog-body');
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await title.focus();
  // Native field focus must have a visible outline, reached by keyboard rather than a synthetic focus.
  await dialog.locator('.close-button').focus(); await page.keyboard.press('Tab');
  await expect(title).toBeFocused();
  const outline = await title.evaluate(element => { const s = getComputedStyle(element); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
  expect(outline.style).not.toBe('none'); expect(outline.width).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await openProjectFormEntry(page, 'project-task', locale);
  await expect(title).toHaveValue('Retained Task draft');
  await expect(dialog.getByRole('combobox', { name: 'Goal', exact: true })).toHaveValue(goalId);
  await dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true }).click();
  await expect.poll(() => fixture.creates().length).toBe(1);
  await expect(dialog.getByText(zh ? '结果尚未确认，请先检查任务列表，再创建其他 Task。' : 'The result is unknown. Check the task list before creating another Task.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true })).toBeDisabled();
  await expectHit(dialog.getByRole('button', { name: zh ? '查看当前状态' : 'Check current state' }));
  await expectHit(dialog.getByRole('button', { name: zh ? '我已检查列表，开始新建 Task' : 'I checked the list; start a new Task' }));
  const geometry = await expectFormSkin(page, dialog);
  await writeFile(testInfo.outputPath('geometry.json'), JSON.stringify({ locale, viewport: { width: 320, height: 320 }, geometry }, null, 2));
  expect(fixture.creates()).toEqual([{ title: 'Retained Task draft', description: '', parentId: goalId, tagIds: [] }]);
  await page.screenshot({ path: testInfo.outputPath('short-unknown.png') });
});

test('account refresh notice keeps the shared form header and close accessible', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 }); await install(page);
  const dialog = await openForm(page, 'project-task', 'en');
  await page.evaluate(() => {
    localStorage.setItem('daynight.activeUser', JSON.stringify('00000000-0000-4000-8000-000000000999'));
    window.dispatchEvent(new StorageEvent('storage', { key: 'daynight.activeUser' }));
  });
  const notice = dialog.locator('.account-refresh-notice[data-active="true"]');
  await expect(notice.getByText('Account changed', { exact: true })).toBeVisible();
  const positions = await dialog.evaluate(element => {
    const title = element.querySelector('h2')!.getBoundingClientRect(), close = element.querySelector('.close-button')!.getBoundingClientRect(), notice = element.querySelector('.account-refresh-notice')!.getBoundingClientRect();
    return { titleTop: title.top, titleBottom: title.bottom, closeTop: close.top, closeBottom: close.bottom, noticeTop: notice.top, noticeRight: notice.right, boundsRight: element.getBoundingClientRect().right };
  });
  expect(positions.titleTop).toBeLessThan(positions.closeBottom); expect(positions.closeTop).toBeLessThan(positions.titleBottom);
  expect(positions.noticeTop).toBeGreaterThanOrEqual(Math.max(positions.titleBottom, positions.closeBottom)); expect(positions.noticeRight).toBeLessThanOrEqual(positions.boundsRight);
  await expectHit(dialog.locator('.close-button')); await expectHit(notice.getByRole('button', { name: 'Refresh page' }));
  await expect(dialog.locator('.language-selector')).toHaveCount(0);
});

for (const width of [1440, 320, 390]) for (const locale of ['en', 'zh-CN'] as const) test(`Progress surfaces agree for mixed chains at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale); fixture.progressChains();
  const zh = locale === 'zh-CN';
  await page.goto(`/projects/${projectId}`);
  const overall = page.getByRole('region', { name: zh ? '整体进度' : 'Overall progress' });
  const overviewRow = overall.getByRole('button', { name: /Overview progress chain/ });
  await expect(overviewRow).toContainText('4 / 6');
  await expect(overviewRow).toContainText('66%');
  await expect(overviewRow).toHaveAttribute('aria-label', zh ? /4.*6.*66%/ : /4 \/ 6 completed, 66%/);
  await expect(overviewRow.locator('.root-progress-track i')).toHaveCSS('background-color', 'rgb(37, 106, 72)');
  await overviewRow.click();
  const ordinary = page.locator('[data-chain-id="00000000-0000-4000-8000-000000000500"]');
  await expect(ordinary.locator('.root-progress-label')).toHaveText(zh ? '4/6 已完成' : '4/6 completed');
  await expect(ordinary.locator('.root-progress-track i')).toHaveCSS('background-color', 'rgb(37, 106, 72)');
  expect(parseFloat(await ordinary.locator('.root-progress-track i').evaluate(node => node.style.width))).toBeCloseTo(66.6667, 3);
  await ordinary.locator('.goal-graph-button').click();
  await expect(page.locator('.task-chain-dialog .task-chain-meta')).toContainText(zh ? '4/6 已完成' : '4/6 completed');
  await page.locator('.task-chain-dialog .task-chain-close').click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await expect(card.locator('.goal-list-progress')).toHaveText(zh ? '4/6 已完成' : '4/6 completed');
  await expect(card.locator('.goal-list-track i')).toHaveCSS('background-color', 'rgb(37, 106, 72)');
  await card.locator('.goal-list-toggle').click();
  await expect(card.locator('.goal-task-list > li')).toHaveCount(9);
  await expect(card.locator('[data-chain-id]')).toHaveCount(0);
  expect(parseFloat(await card.locator('.goal-list-track i').evaluate(node => node.style.width))).toBeCloseTo(66.6667, 3);
  await card.locator(`#project-goal-graph-${goalId}`).click();
  const goalGraph = page.locator(`#task-graph-${goalId}`);
  await expect(goalGraph.locator('.task-chain-meta')).toContainText(zh ? '4/6 已完成' : '4/6 completed');
  await expect(goalGraph.locator('.task-node')).toHaveCount(9);
  await goalGraph.locator('.task-chain-close').click();
  await card.locator('.goal-list-detail').click();
  const info = page.locator('.goal-information');
  await expect(info.locator('.goal-information-progress')).toHaveText(zh ? '4/6 已完成' : '4/6 completed');
  await expect(info.locator('.goal-information-track i')).toHaveCSS('background-color', 'rgb(37, 106, 72)');
  expect(parseFloat(await info.locator('.goal-information-track i').evaluate(node => node.style.width))).toBeCloseTo(66.6667, 3);
  await expect(info.locator('.goal-information-counts').first()).toContainText('9');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 320, 390]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal progress excludes cancellations at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale);
  fixture.setGoalTitle('LongGoal名称'.repeat(12));
  fixture.setGoalStatusFixture('todo', true);
  fixture.setMixedChildren();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const progress = card.locator('.goal-list-progress');
  await expect(progress).toHaveText(locale === 'en' ? '2/2 completed' : '2/2 已完成');
  await expect(progress.locator('i')).toHaveCount(1);
  expect(await progress.locator('i').evaluate(node => node.style.width)).toBe('100%');
  const toggle = card.locator('.goal-list-toggle');
  await toggle.click(); await toggle.focus();
  fixture.cancelChildren();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(progress).toHaveText(locale === 'en' ? '0/0 completed' : '0/0 已完成');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  await expect(card.locator('.goal-list-empty')).toHaveCount(0);
  expect(await progress.locator('i').evaluate(node => node.style.width)).toBe('0%');
  await card.locator(`#project-goal-graph-${goalId}`).click();
  const goalGraph = page.locator(`#task-graph-${goalId}`);
  await expect(goalGraph.locator('.task-chain-meta')).toContainText(locale === 'en' ? '0/0 completed' : '0/0 已完成');
  await expect(goalGraph.locator('.task-node')).toHaveCount(3);
  await goalGraph.locator('.task-chain-close').click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal list uses its own status colors at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale);
  fixture.setGoalTitle('LongGoal名称'.repeat(12));
  fixture.setGoalStatusFixture('todo', true);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const row = card.locator('.goal-list-row');
  const palette = roleColors;
  let progress = '';
  for (const status of ['todo', 'in_progress', 'done', 'cancelled'] as const) {
    if (status !== 'todo') {
      fixture.setGoalStatusFixture(status, true);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    }
    await expect(row).toHaveAttribute('data-task-status', status);
    await page.mouse.move(0, 0);
    await expect(row).toHaveCSS('background-color', palette[status][0]);
    await expect(card).toHaveCSS('border-top-color', palette[status][2]);
    await expect(row.locator('.root-status')).toHaveCSS('color', palette[status][3]);
    await expect(row).toHaveCSS('opacity', '1');
    const text = await row.locator('.goal-list-progress').innerText();
    if (status === 'todo') progress = text;
    expect(text).toBe(progress);
    for (const hover of [false, true]) {
      if (hover) await row.hover();
      await expect(row).toHaveCSS('background-color', palette[status][hover ? 1 : 0]);
      for (const selector of ['.goal-list-title', '.goal-list-meta', '.task-assignee-identity', '.goal-list-progress', '.root-status']) {
        await expectTextContrast(row.locator(selector));
      }
    }
  }
  fixture.setGoalStatusFixture('done', false);
  fixture.setMixedChildren();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(row).toHaveAttribute('data-task-status', 'done');
  await expect(row.locator('.goal-list-progress')).not.toHaveText(progress);
  await card.locator('.goal-list-toggle').click();
  for (const [id, status] of [[firstId, 'todo'], [singleId, 'cancelled']] as const) {
    const member = card.locator(`#chain-task-goal-${goalId}-${id}`).locator('..').locator('..').locator('..');
    await page.mouse.move(0, 0);
    await expect(member).toHaveCSS('background-color', palette[status][0]);
    await member.hover();
    await expect(member).toHaveCSS('background-color', palette[status][1]);
  }
  await card.locator('.goal-list-toggle').click();
  fixture.setGoalStatusFixture('cancelled', false);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(row).toHaveAttribute('data-task-status', 'cancelled');
  const detail = card.locator(`#project-goal-detail-${goalId}`);
  await card.locator('.goal-list-toggle').focus();
  await page.keyboard.press('Tab');
  await expect(card.locator('.goal-list-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: locale === 'en' ? 'Copy Goal ID' : '复制 Goal ID' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detail).toBeFocused();
  await expect(detail).toHaveCSS('outline-color', 'rgb(52, 64, 84)');
  await page.keyboard.press('Enter');
  await expect(page.locator('.goal-detail-surface')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.goal-detail-surface')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(detail).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card.locator(`#project-goal-graph-${goalId}`)).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
});

test('Goal and task-chain headers remain compact with an assigned owner on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const fixture = await install(page, 'en', 'Owner');
  fixture.setGoalStatusFixture('todo', false);
  fixture.assignChainRoot();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Task chains/ }).click();
  const chain = page.locator(`[data-chain-id="${outsideId}"]`);
  const chainHeader = chain.locator('.goal-header');
  await expect(chainHeader.locator('.assignee-avatar')).toBeVisible();
  await expect(chainHeader.locator('.assignee-name')).toHaveText('Owner');
  const chainHeight = await chainHeader.evaluate(element => element.getBoundingClientRect().height);
  const chainCardHeight = await chain.evaluate(element => element.getBoundingClientRect().height);
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await expect(card.locator('.assignee-avatar')).toBeVisible();
  await expect(card.locator('.assignee-name')).toHaveText('Owner');
  const row = card.locator('.goal-list-row');
  const goalHeight = await row.evaluate(element => element.getBoundingClientRect().height);
  const cardHeight = await card.evaluate(element => element.getBoundingClientRect().height);
  expect(chainHeight).toBe(62);
  await expect(card.locator('.task-tag-list')).toHaveCount(0);
  expect(goalHeight).toBe(chainHeight);
  expect(cardHeight - goalHeight).toBe(chainCardHeight - chainHeight);
  await card.locator('.goal-list-toggle').click();
  expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBe(goalHeight);
});

for (const { viewport, contentWidth } of [
  { viewport: 320 }, { viewport: 390 }, { viewport: 1440 },
  { viewport: 739 }, { viewport: 740 }, { viewport: 741 },
  { viewport: 1440, contentWidth: 599 }, { viewport: 1440, contentWidth: 600 }, { viewport: 1440, contentWidth: 601 },
  { viewport: 1440, contentWidth: 739 }, { viewport: 1440, contentWidth: 740 }, { viewport: 1440, contentWidth: 741 },
]) test(`Goal prefix aligns with the task chain at viewport ${viewport}, card ${contentWidth ?? 'natural'}`, async ({ page }) => {
  await page.setViewportSize({ width: viewport, height: 800 });
  const fixture = await install(page, 'en', 'Owner');
  fixture.setGoalStatusFixture('todo', false);
  fixture.assignChainRoot();
  await page.goto(`/projects/${projectId}`);
  await page.addStyleTag({ content: `.goal-disclosure { transition: none !important; }${contentWidth === undefined ? '' : ` [data-goal-id="${goalId}"], [data-chain-id="${outsideId}"] { width: ${contentWidth + 2}px !important; }`}` });
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Task chains/ }).click();
  const chain = page.locator(`[data-chain-id="${outsideId}"]`);
  const chainToggle = chain.locator('.goal-toggle');
  const arrow = (card: Locator) => card.evaluate(element => {
    const svg = element.querySelector<SVGSVGElement>('.goal-disclosure')!;
    const path = svg.querySelector<SVGGraphicsElement>('path')!;
    const bounds = path.getBBox(), matrix = path.getScreenCTM()!;
    const xs = [bounds.x, bounds.x + bounds.width].flatMap(x => [bounds.y, bounds.y + bounds.height].map(y => new DOMPoint(x, y).matrixTransform(matrix).x));
    const origin = element.getBoundingClientRect().left + element.clientLeft;
    const box = svg.getBoundingClientRect();
    return { width: element.clientWidth, left: box.left - origin, pathLeft: Math.min(...xs) - origin, svgWidth: box.width, svgHeight: box.height };
  });
  const chainCollapsed = await arrow(chain);
  await chainToggle.click();
  await expect(chainToggle).toHaveAttribute('aria-expanded', 'true');
  const chainExpanded = await arrow(chain);
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const toggle = card.locator('.goal-list-toggle');
  const compare = async (reference: Awaited<ReturnType<typeof arrow>>) => {
    const actual = await arrow(card);
    expect(actual.width).toBe(reference.width);
    if (contentWidth !== undefined) expect(actual.width).toBe(contentWidth);
    expect(Math.abs(actual.left - reference.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(actual.pathLeft - reference.pathLeft)).toBeLessThanOrEqual(1);
    expect(actual.left).toBeCloseTo(actual.width <= 600 ? 11 : 15, 1);
    expect(actual.svgWidth).toBeCloseTo(14, 1);
    expect(actual.svgHeight).toBeCloseTo(14, 1);
  };
  await compare(chainCollapsed);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await compare(chainExpanded);
  await toggle.scrollIntoViewIfNeeded();
  await page.keyboard.press('Tab');
  await toggle.focus();
  const geometry = await card.evaluate(element => {
    const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
    const cardBox = element.getBoundingClientRect(), button = box('.goal-list-toggle'), disclosure = box('.goal-disclosure');
    const icon = box('.goal-list-icon'), main = box('.goal-list-main'), progress = box('.goal-list-progress');
    const control = element.querySelector<HTMLElement>('.goal-list-toggle')!;
    const style = getComputedStyle(control);
    const hit = (x: number) => { const target = document.elementFromPoint(x, button.top + button.height / 2); return target === control || control.contains(target); };
    return { origin: cardBox.left + element.clientLeft, buttonLeft: button.left, buttonWidth: button.width, buttonHeight: button.height,
      iconWidth: icon.width, iconHeight: icon.height, iconGap: icon.left - disclosure.right, buttonGap: icon.left - button.right, titleGap: main.left - icon.right, mainWidth: main.width,
      titleLeft: main.left, progressLeft: progress.left, progressTop: progress.top, mainBottom: main.bottom,
      inside: button.left >= cardBox.left + element.clientLeft && button.right <= icon.left && icon.right <= main.left,
      hits: [hit(button.left + 1), hit(button.right - 1)], outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 };
  });
  expect(geometry.buttonWidth).toBeCloseTo(22, 1);
  expect(geometry.buttonHeight).toBeGreaterThanOrEqual(34);
  expect(geometry.mainWidth).toBeGreaterThanOrEqual(40);
  expect(geometry.hits).toEqual([true, true]);
  expect(geometry.outline).toBe(true);
  if (chainCollapsed.width <= 740) {
    expect(geometry.iconWidth).toBe(0);
    expect(geometry.iconHeight).toBe(0);
    expect(geometry.titleLeft - geometry.origin).toBeCloseTo(chainCollapsed.width <= 600 ? 33 : 37, 1);
    expect(geometry.progressTop).toBeGreaterThanOrEqual(geometry.mainBottom - 1);
    expect(Math.abs(geometry.progressLeft - geometry.titleLeft)).toBeLessThanOrEqual(1);
  } else {
    expect(geometry.iconWidth).toBeCloseTo(20, 1);
    expect(geometry.iconHeight).toBeCloseTo(20, 1);
    expect(geometry.iconGap).toBeCloseTo(8, 1);
    expect(geometry.buttonGap).toBeCloseTo(4, 1);
    expect(geometry.titleGap).toBeCloseTo(8, 1);
    expect(geometry.titleLeft - geometry.origin).toBeCloseTo(65, 1);
    expect(geometry.inside).toBe(true);
    expect(geometry.progressTop).toBeLessThan(geometry.mainBottom - 1);
  }
  const icon = card.locator('svg.goal-list-icon');
  await expect(icon).toHaveAttribute('aria-hidden', 'true');
  await expect(icon.locator('circle')).toHaveCount(3);
  await expect(icon.locator('circle').nth(0)).toHaveAttribute('r', '6');
  await expect(icon.locator('circle').nth(1)).toHaveAttribute('r', '3');
});

for (const constrained of [false, true]) test(`Goal header reflows at narrow desktop width (${constrained ? 'constrained' : 'natural'})`, async ({ page }) => {
  await page.setViewportSize({ width: 864, height: 900 });
  const fixture = await install(page, 'en', 'Owner');
  fixture.compactDesktopGoal();
  await page.goto(`/projects/${projectId}`);
  if (constrained) await page.addStyleTag({ content: `[data-goal-id="${goalId}"] { width: 620px !important; }` });
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await expect(card.locator('.goal-list-title')).toHaveText('Goal reading');
  await expect(card.locator('.task-row-id')).toHaveText(goalId);
  await expect(card.locator('.assignee-name')).toHaveText('Owner');
  await expect(card.locator('.goal-in-progress')).toHaveText('1 in progress');
  await expect(card.locator('.task-pause-count')).toHaveText('1 blocked');
  await expect(card.locator('.chain-worker-active')).toBeVisible();
  await expect(card.locator('.session-status-annotation')).toHaveText('working');
  await expect(card.locator('.goal-list-progress')).toHaveText('79/80 completed');
  await expect(card.locator('.goal-list-meta')).toContainText('81');
  const geometry = await card.evaluate(element => {
    const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const main = box('.goal-list-main'), progress = box('.goal-list-progress');
    const session = box('.goal-list-session'), detail = box('.goal-list-detail'), graph = box('.goal-list-graph');
    const id = element.querySelector<HTMLElement>('.goal-list-id .task-row-id')!;
    const range = document.createRange(); range.selectNodeContents(id);
    const idRects = [...range.getClientRects()];
    const copy = box('.task-copy-button');
    return { width: element.clientWidth, outerWidth: element.getBoundingClientRect().width,
      mainBottom: main.bottom, mainLeft: main.left, progressTop: progress.top, progressLeft: progress.left, progressBottom: progress.bottom,
      sessionTop: session.top, sessionBottom: session.bottom, sessionRight: session.right,
      detailTop: detail.top, detailBottom: detail.bottom, detailLeft: detail.left, detailWidth: detail.width, detailHeight: detail.height,
      graphTop: graph.top, graphBottom: graph.bottom, graphLeft: graph.left, graphWidth: graph.width, graphHeight: graph.height,
      idLines: idRects.length, idTop: idRects[0]!.top, idBottom: idRects[0]!.bottom, copyTop: copy.top, copyBottom: copy.bottom };
  });
  if (constrained) {
    expect(geometry.outerWidth).toBe(620);
    expect(geometry.width).toBeGreaterThan(600);
  }
  expect(geometry.width).toBeLessThanOrEqual(740);
  expect(geometry.progressTop).toBeGreaterThanOrEqual(geometry.mainBottom - 1);
  expect(Math.abs(geometry.progressLeft - geometry.mainLeft)).toBeLessThanOrEqual(1);
  expect(geometry.sessionTop).toBeGreaterThanOrEqual(geometry.progressBottom - 1);
  expect(geometry.detailTop).toBeGreaterThanOrEqual(geometry.progressBottom - 1);
  expect(geometry.graphTop).toBeGreaterThanOrEqual(geometry.progressBottom - 1);
  expect(geometry.sessionBottom).toBeGreaterThan(geometry.detailTop);
  expect(geometry.sessionTop).toBeLessThan(geometry.detailBottom);
  expect(geometry.graphBottom).toBeGreaterThan(geometry.detailTop);
  expect(geometry.graphTop).toBeLessThan(geometry.detailBottom);
  expect(geometry.sessionRight).toBeLessThanOrEqual(geometry.detailLeft + 1);
  expect(geometry.detailLeft).toBeLessThan(geometry.graphLeft);
  expect([geometry.detailWidth, geometry.detailHeight, geometry.graphWidth, geometry.graphHeight]).toEqual([32, 32, 32, 32]);
  expect(geometry.idLines).toBe(1);
  expect(geometry.copyBottom).toBeGreaterThan(geometry.idTop);
  expect(geometry.copyTop).toBeLessThan(geometry.idBottom);
});

for (const locale of ['en', 'zh-CN'] as const) for (const scenario of ['desktop-620', 'phone', 'very-narrow', 'wide'] as const) test(`Goal ID and progress layout at ${scenario} in ${locale}`, async ({ page, context }) => {
  const phone = scenario === 'phone' || scenario === 'very-narrow';
  await page.setViewportSize({ width: phone ? 320 : scenario === 'wide' ? 1440 : 864, height: 900 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page, locale, 'Owner'); fixture.compactDesktopGoal();
  await page.goto(`/projects/${projectId}`);
  const outerWidth = scenario === 'desktop-620' ? 620 : scenario === 'very-narrow' ? 180 : null;
  if (outerWidth !== null) await page.addStyleTag({ content: `[data-goal-id="${goalId}"] { width: ${outerWidth}px !important; }` });
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const id = card.locator('.goal-list-id .task-row-id');
  const copy = card.getByRole('button', { name: locale === 'en' ? 'Copy Goal ID' : '复制 Goal ID' });
  const toggle = card.locator('.goal-list-toggle');
  await expect(id).toHaveText(goalId);
  await expect(copy).toBeVisible();
  const layout = await card.evaluate(element => {
    const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const id = element.querySelector<HTMLElement>('.goal-list-id .task-row-id')!;
    const range = document.createRange(); range.selectNodeContents(id);
    const lines = [...range.getClientRects()]; const last = lines.at(-1)!;
    const copy = box('.task-copy-button'), track = box('.goal-list-track'), progress = box('.goal-list-progress');
    const main = box('.goal-list-main'), icon = box('.goal-list-icon'), card = element.getBoundingClientRect();
    return { contentWidth: element.clientWidth, outerWidth: card.width, idLines: lines.length,
      lastTop: last.top, lastBottom: last.bottom, idRight: id.getBoundingClientRect().right,
      copyTop: copy.top, copyBottom: copy.bottom, copyLeft: copy.left, copyRight: copy.right,
      trackLeft: track.left, trackWidth: track.width, progressLeft: progress.left, mainLeft: main.left,
      mainBottom: main.bottom, progressTop: progress.top, iconWidth: icon.width,
      contained: copy.right <= card.right && track.right <= card.right && element.scrollWidth <= element.clientWidth };
  });
  if (outerWidth !== null) expect(layout.outerWidth).toBe(outerWidth);
  expect(layout.contained).toBe(true);
  expect(layout.trackWidth).toBeLessThanOrEqual(145);
  if (scenario === 'wide') {
    expect(layout.contentWidth).toBeGreaterThan(740);
    expect(layout.iconWidth).toBe(20);
    expect(layout.progressTop).toBeLessThan(layout.mainBottom - 1);
    expect(layout.trackWidth).toBeCloseTo(145, 1);
  } else {
    expect(layout.contentWidth).toBeLessThanOrEqual(740);
    expect(layout.iconWidth).toBe(0);
    expect(layout.progressTop).toBeGreaterThanOrEqual(layout.mainBottom - 1);
    expect(Math.abs(layout.trackLeft - layout.mainLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.progressLeft - layout.mainLeft)).toBeLessThanOrEqual(1);
    expect(layout.copyBottom).toBeGreaterThan(layout.lastTop);
    expect(layout.copyTop).toBeLessThan(layout.lastBottom);
    expect(layout.copyLeft - layout.idRight).toBeGreaterThanOrEqual(0);
    expect(layout.copyLeft - layout.idRight).toBeLessThanOrEqual(5);
    if (scenario === 'desktop-620') expect(layout.idLines).toBe(1);
    if (scenario === 'very-narrow') { expect(layout.idLines).toBeGreaterThan(1); expect(layout.trackWidth).toBeLessThan(145); }
  }
  const copyPosition = () => copy.evaluate(element => {
    const button = element.getBoundingClientRect(), card = element.closest('.goal-list-card')!.getBoundingClientRect();
    return { left: button.left - card.left, top: button.top - card.top };
  });
  const initialPosition = await copyPosition();
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(goalId);
  await expect(card.getByRole('status')).toHaveText(locale === 'en' ? 'Copied' : '已复制');
  if (scenario !== 'wide') expect(await copyPosition()).toEqual(initialPosition);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
  await copy.click();
  const alert = card.getByRole('alert');
  await expect(alert).toHaveText(locale === 'en' ? 'Could not copy the Goal ID. Select and copy it manually.' : '无法复制 Goal ID，请选中并手动复制。');
  if (scenario !== 'wide') {
    expect(await copyPosition()).toEqual(initialPosition);
    expect(await alert.evaluate(element => {
      const bounds = element.getBoundingClientRect(), card = element.closest('.goal-list-card')!.getBoundingClientRect();
      const button = element.parentElement!.querySelector('.task-copy-button')!.getBoundingClientRect();
      return bounds.left >= card.left && bounds.right <= card.right && bounds.top >= button.bottom - 1
        && element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1;
    })).toBe(true);
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => { delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText; });
  await copy.focus(); await page.keyboard.press('Enter');
  await expect(card.getByRole('status')).toHaveText(locale === 'en' ? 'Copied' : '已复制');
  if (scenario !== 'wide') expect(await copyPosition()).toEqual(initialPosition);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal header parts toggle independently of reading actions at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale, 'Owner');
  fixture.setGoalStatusFixture('todo', false);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const toggle = card.locator('.goal-list-toggle');
  const title = card.locator('.goal-list-title');
  const detail = card.locator(`#project-goal-detail-${goalId}`);
  const graph = card.locator(`#project-goal-graph-${goalId}`);
  const content = card.locator(`#project-goal-children-${goalId}`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(content).toBeHidden();
  const icon = card.locator('.goal-list-icon');
  const compact = await card.evaluate(element => element.clientWidth <= 740);
  if (compact) await expect(icon).toBeHidden();
  else await expect(icon).toBeVisible();
  const targets = ['.goal-disclosure', '.assignee-name', '.goal-list-meta > span:last-child', '.goal-list-progress', '.root-status'];
  if (!compact) targets.push('.goal-list-icon');
  for (const selector of targets) {
    const target = card.locator('.goal-list-row').locator(selector);
    await target.click();
    await expect(toggle, selector).toHaveAttribute('aria-expanded', 'true');
    await expect(content).toBeVisible();
    await expect(page.locator('.goal-detail-surface')).toHaveCount(0);
    await target.click();
    await expect(toggle, selector).toHaveAttribute('aria-expanded', 'false');
    await expect(content).toBeHidden();
  }
  const blank = await card.locator('.goal-list-row').evaluate(element => {
    const r = element.getBoundingClientRect();
    for (let y = r.top + 2; y < r.bottom - 2; y += 3) for (let x = r.left + 2; x < r.right - 2; x += 3) {
      if (document.elementFromPoint(x, y) === element) return { x, y };
    }
    return null;
  });
  expect(blank).not.toBeNull();
  await page.mouse.click(blank!.x, blank!.y);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await card.locator(`#chain-task-goal-${goalId}-${firstId}`).focus();
  await card.locator('.goal-list-row .root-status').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  for (const expanded of ['true', 'false'] as const) {
    for (const activation of ['click', 'Enter', 'Space'] as const) {
      if (activation === 'click') await title.click();
      else { await title.focus(); await page.keyboard.press(activation); }
      const surface = page.locator('.goal-detail-surface');
      await expect(surface).toBeVisible();
      await expect(surface.locator('.task-detail-title')).toHaveText('Goal reading');
      await expect(toggle).toHaveAttribute('aria-expanded', expanded);
      await page.keyboard.press('Escape');
      await expect(surface).toHaveCount(0);
      await expect(title).toBeFocused();
      await expect(toggle).toHaveAttribute('aria-expanded', expanded);
    }
    await detail.click();
    await expect(page.locator('.goal-detail-surface')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detail).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', expanded);
    await graph.click();
    await expect(page.locator(`#task-graph-${goalId}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(graph).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', expanded);
    if (expanded === 'true') await toggle.click();
  }
  await title.click();
  await expect(page.locator('.goal-detail-surface')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.goForward();
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  await page.keyboard.press('Escape');
  await expect(page.locator('#project-goal-list')).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('button button, button a, a button').count()).toBe(0);
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal Session summary stays readable and operable at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale, 'Owner');
  fixture.setGoalSessionFixture('todo', 'working');
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const row = card.locator('.goal-list-row');
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const toggle = row.locator('.goal-list-toggle');
  const status = row.locator('.session-status-action');
  const annotation = row.locator('.session-status-annotation');
  const pausedCount = row.locator('.task-pause-count');
  const labels = locale === 'en'
    ? { todo: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' }
    : { todo: '待处理', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
  let initialHeight = 0;
  const cases = [
    ['todo', 'working'], ['todo', 'notice'], ['todo', 'warning'],
    ['in_progress', 'notice'], ['done', 'warning'], ['cancelled', 'working'],
  ] as const;
  for (const rootSize of [16, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    for (const selector of ['.goal-list-meta .assignee-name', '.goal-list-meta .chain-worker-active', '.goal-list-meta > span:last-child', '.session-status-label', '.session-status-annotation']) {
      await expect(row.locator(selector)).toHaveCSS('font-size', `${rootSize * 0.75}px`);
    }
    await expect(row.locator('.goal-list-title')).toHaveCSS('font-size', `${rootSize * 0.875}px`);
    await expect(row.locator('.task-pause-count')).toHaveCSS('font-size', `${rootSize * 0.875}px`);
    await expect(row.locator('.goal-list-progress')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
    expect(await row.evaluate(element => {
      const selectors = ['.goal-list-title', '.task-pause-count', '.goal-list-meta', '.goal-list-progress', '.session-status-label', '.goal-list-detail', '.goal-list-graph'];
      const parts = selectors.map(selector => element.querySelector<HTMLElement>(selector)!);
      const boxes = parts.map(part => part.getBoundingClientRect());
      const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
      return document.documentElement.scrollWidth <= innerWidth && parts.every(part => part.scrollWidth <= part.clientWidth + 1 && part.scrollHeight <= part.clientHeight + 1) &&
        boxes.every((box, index) => boxes.slice(index + 1).every(other => separate(box, other)));
    })).toBe(true);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  for (const [index, [goalStatus, indicator]] of cases.entries()) {
    if (index > 0) {
      fixture.setGoalSessionFixture(goalStatus, indicator);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    }
    await expect(row).toHaveAttribute('data-task-status', goalStatus);
    await expect(annotation).toHaveText(indicator);
    await expect(pausedCount).toHaveText(locale === 'en' ? '1 blocked' : '1 受阻');
    await expect(toggle).toHaveAccessibleDescription(locale === 'en' ? /1 blocked/ : /1 受阻/);
    await expect(row.locator('.root-status')).toContainText(labels[goalStatus]);
    await expect(row).toHaveCSS('background-color', roleColors[goalStatus][0]);
    await expect(annotation).toHaveCSS('color', indicator === 'working' ? 'rgb(40, 91, 159)' : 'rgb(128, 91, 39)');
    const geometry = await row.evaluate(element => {
      const box = (selector: string) => {
        const part = element.querySelector<HTMLElement>(selector)!;
        if (selector !== '.root-status') return part.getBoundingClientRect();
        const text = document.createRange(); text.selectNodeContents(part.firstChild!);
        return text.getBoundingClientRect();
      };
      const bounds = element.getBoundingClientRect();
      const selectors = ['.goal-list-title', '.task-pause-count', '.goal-list-meta', '.goal-list-progress', '.root-status', '.session-status-annotation', '.goal-list-detail', '.goal-list-graph'];
      const parts = selectors.map(box);
      const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
      return {
        height: bounds.height,
        titleWidth: parts[0]!.width,
        inside: parts.every(part => part.width > 0 && part.height > 0 && part.left >= bounds.left - 1 && part.right <= bounds.right + 1 && part.top >= bounds.top - 1 && part.bottom <= bounds.bottom + 1),
        overlaps: parts.flatMap((part, index) => parts.slice(index + 1).flatMap((other, offset) => separate(part, other) ? [] : [`${selectors[index]} / ${selectors[index + offset + 1]}`])),
        clipped: [...element.querySelectorAll<HTMLElement>('.goal-list-title, .task-pause-count, .goal-list-meta, .goal-list-progress, .session-status-annotation')].filter(part => part.scrollWidth > part.clientWidth + 1 || part.scrollHeight > part.clientHeight + 1).map(part => part.className),
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(geometry.inside).toBe(true);
    expect(geometry.titleWidth).toBeGreaterThanOrEqual(80);
    expect(geometry.overlaps).toEqual([]);
    expect(geometry.clipped).toEqual([]);
    expect(geometry.noOverflow).toBe(true);
    if (goalStatus === 'todo' && indicator === 'working') initialHeight = geometry.height;
    if (goalStatus === 'todo') expect(geometry.height).toBe(initialHeight);
    await status.hover();
    await page.mouse.down();
    await expect(row.locator('.root-status')).toHaveCSS('color', roleColors[goalStatus][3]);
    await page.mouse.up();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await page.mouse.move(0, 0);
  }
  await toggle.focus();
  await page.keyboard.press('Tab');
  await expect(row.locator('.goal-list-title')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(row.getByRole('button', { name: locale === 'en' ? 'Copy Goal ID' : '复制 Goal ID' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(status).toBeFocused();
  await expect(status).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(status).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('button button, button a, a button').count()).toBe(0);
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal list ID remains selectable and independently copyable at ${width}px in ${locale}`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await install(page, locale);
  fixture.setGoalTitle('LongGoal名称'.repeat(20));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const toggle = card.locator('.goal-list-toggle');
  const id = card.locator('.goal-list-id .task-row-id');
  const copy = card.getByRole('button', { name: locale === 'en' ? 'Copy Goal ID' : '复制 Goal ID' });
  const initialUrl = page.url();
  await expect(id).toHaveText(goalId);
  await expect(id).toHaveCSS('font-size', '12px');
  await expectCopyButtonSkin(page, copy);
  await card.locator('.goal-list-title').focus(); await page.keyboard.press('Tab');
  await expect(copy).toBeFocused();
  await id.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await id.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const box = await id.evaluate(element => { const range = document.createRange(); range.setStart(element.firstChild!, 1); range.setEnd(element.firstChild!, 10); const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
  await page.mouse.move(box.x, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.length).toBeGreaterThan(0); expect(goalId).toContain(selected);
  await page.keyboard.press('ControlOrMeta+C');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await copy.focus(); await page.keyboard.press('Enter');
  await expect(card.getByRole('status')).toHaveText(locale === 'en' ? 'Copied' : '已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(goalId);
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    const original = clipboard.writeText.bind(clipboard);
    Object.defineProperty(clipboard, 'writeText', { configurable: true, value: () => { Object.defineProperty(clipboard, 'writeText', { configurable: true, value: original }); return Promise.reject(new Error('denied')); } });
  });
  await copy.focus(); await page.keyboard.press('Space');
  await expect(card.getByRole('alert')).toHaveText(locale === 'en' ? 'Could not copy the Goal ID. Select and copy it manually.' : '无法复制 Goal ID，请选中并手动复制。');
  expect(await card.locator('.goal-list-row').evaluate(row => {
    const bounds = row.getBoundingClientRect();
    return ['.goal-list-id .task-row-id', '.task-copy-button', '[role=alert]'].every(selector => {
      const rect = row.querySelector(selector)!.getBoundingClientRect();
      return rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    }) && document.documentElement.scrollWidth <= innerWidth;
  })).toBe(true);
  await copy.click(); await expect(card.getByRole('status')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(goalId);
  const end = await card.locator('.goal-list-progress').boundingBox();
  const start = await id.boundingBox();
  await page.mouse.move(start!.x + 2, start!.y + start!.height / 2); await page.mouse.down();
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 8 }); await page.mouse.up();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await card.locator('.goal-list-progress').click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.goal-detail-surface, .task-chain-dialog')).toHaveCount(0);
  expect(page.url()).toBe(initialUrl);
  expect(fixture.statusWrites()).toEqual([]); expect(fixture.edits()).toEqual([]);
});

for (const width of [1440, 740, 600, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`project Goal list expands scoped work at ${width}px in ${locale}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale);
  fixture.addCrossGoal(); fixture.setGoalTitle('LongGoal名称'.repeat(20)); fixture.setGoalStatusFixture('todo', false); fixture.addLongGoalListWorker();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const firstGoal = page.locator(`[data-goal-id="${goalId}"]`);
  const otherGoal = page.locator(`[data-goal-id="${otherGoalId}"]`);
  await expect(firstGoal.locator('.assignee-name')).toContainText('Long owner name');
  const firstHeader = firstGoal.locator('.goal-list-toggle');
  const count = locale === 'zh-CN' ? '1 进行中' : '1 in progress';
  const active = locale === 'zh-CN' ? '自动执行中' : 'Automatic execution active';
  await expect(firstGoal.locator('.goal-in-progress')).toHaveText(count);
  await expect(firstGoal.locator('.chain-worker-active')).toHaveText(active);
  await expect(firstHeader).toHaveAccessibleDescription(new RegExp(`${count}.*${active}`));
  await expect(firstGoal.locator('.chain-worker-active-dot')).toHaveAttribute('aria-hidden', 'true');
  await expect(firstGoal.locator('.chain-worker-active button, .chain-worker-active a')).toHaveCount(0);
  await expect(otherGoal.locator('.goal-in-progress')).toHaveText(locale === 'zh-CN' ? '0 进行中' : '0 in progress');
  await expect(otherGoal.locator('.chain-worker-active')).toHaveCount(0);
  for (const selector of ['.goal-in-progress', '.chain-worker-active']) {
    expect(await firstGoal.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  }

  const geometry = await firstGoal.locator('.goal-list-row').evaluate(row => {
    const rect = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const bounds = rect(row);
    const elements = ['.goal-list-title', '.goal-in-progress', '.goal-list-meta', '.goal-list-progress', '.root-status'].map(selector => rect(row.querySelector(selector)!));
    return { bounds, elements };
  });
  for (const [index, box] of geometry.elements.entries()) {
    expect(box.left).toBeGreaterThanOrEqual(geometry.bounds.left - 1);
    expect(box.right).toBeLessThanOrEqual(geometry.bounds.right + 1);
    expect(box.top).toBeGreaterThanOrEqual(geometry.bounds.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(geometry.bounds.bottom + 1);
    for (const other of geometry.elements.slice(index + 1)) {
      expect(box.right <= other.left + 1 || other.right <= box.left + 1 || box.bottom <= other.top + 1 || other.bottom <= box.top + 1).toBe(true);
    }
  }
  const firstToggle = firstGoal.locator('.goal-list-toggle');
  const otherToggle = otherGoal.locator('.goal-list-toggle');
  await expect(firstToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(otherToggle).toHaveAttribute('aria-expanded', 'false');
  const checkOutline = async (card: Locator, expanded: boolean) => {
    await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
    const topCorner = await card.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.left + 0.5, bounds.top + 0.5));
    });
    await card.evaluate(element => element.scrollIntoView({ block: 'end' }));
    const shape = await card.evaluate((element, open) => {
      const bounds = element.getBoundingClientRect();
      const header = element.querySelector('.goal-list-row')!.getBoundingClientRect();
      const contents = element.querySelector('.goal-list-contents')!.getBoundingClientRect();
      const last = element.querySelector('.goal-task-list > li:last-child')?.getBoundingClientRect();
      const hit = (x: number, y: number) => element.contains(document.elementFromPoint(x, y));
      return {
        radius: getComputedStyle(element).borderRadius,
        headerRadius: getComputedStyle(element.querySelector('.goal-list-row')!).borderBottomLeftRadius,
        bottomCorner: hit(bounds.left + 0.5, bounds.bottom - 0.5),
        bottomInside: hit(bounds.left + 9, bounds.bottom - 2),
        headerBottom: header.bottom,
        contentTop: contents.top,
        lastBottom: open ? last!.bottom : header.bottom,
        innerBottom: bounds.bottom - 1,
      };
    }, expanded);
    expect(shape.radius).toBe('8px');
    expect(shape.headerRadius).toBe('0px');
    expect(topCorner).toBe(false);
    expect(shape.bottomCorner).toBe(false);
    expect(shape.bottomInside).toBe(true);
    expect(shape.lastBottom).toBeCloseTo(shape.innerBottom, 1);
    if (expanded) expect(shape.contentTop).toBeCloseTo(shape.headerBottom, 1);
  };
  await checkOutline(firstGoal, false);
  await firstToggle.focus(); await page.keyboard.press('Space');
  await otherToggle.focus(); await page.keyboard.press('Enter');
  await expect(firstGoal.locator('.goal-task-list > li')).toHaveCount(3);
  await expect(otherGoal.locator('.goal-task-list > li')).toHaveCount(1);
  const title = firstGoal.locator('.goal-list-title');
  await title.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('LongGoal名称'.repeat(20));
  await page.keyboard.press('Escape');
  await expect(title).toBeFocused();
  await expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
  await checkOutline(firstGoal, true);
  await checkOutline(otherGoal, true);
  await expect(firstGoal.locator('.goal-list-contents')).toHaveCSS('border-top-width', '1px');
  await expect(firstGoal.locator('..')).toHaveCSS('row-gap', '8px');
  for (const control of [firstGoal.locator('.goal-list-toggle'), firstGoal.locator('.goal-list-title'), firstGoal.locator(`#project-goal-detail-${goalId}`), firstGoal.locator(`#project-goal-graph-${goalId}`), firstGoal.locator('.task-row-title').first(), firstGoal.locator('.task-row-title').last()]) {
    await control.scrollIntoViewIfNeeded();
    await control.focus();
    const visibleOutline = await control.evaluate(element => {
      const bounds = element.closest('.goal-list-card')!.getBoundingClientRect();
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      const extent = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
        && box.left - extent >= bounds.left + 1 && box.right + extent <= bounds.right - 1
        && box.top - extent >= bounds.top + 1 && box.bottom + extent <= bounds.bottom - 1;
    });
    expect(visibleOutline).toBe(true);
  }
  await expect(firstGoal.locator('.goal-row, .standalone-row, [data-chain-id]')).toHaveCount(0);
  await expect(firstGoal.getByText('Standalone task', { exact: true })).toBeVisible();
  await expect(firstGoal.getByText('First task', { exact: true })).toBeVisible();
  await expect(otherGoal.getByText('Other task', { exact: true })).toBeVisible();
  await expect(otherGoal.locator(`#chain-task-goal-${otherGoalId}-${firstId}`)).toHaveCount(0);
  const ids = await page.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  await firstToggle.focus(); await page.keyboard.press('Space');
  await expect(firstGoal.locator('.goal-task-list')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(firstGoal.locator('.goal-task-list > li')).toHaveCount(3);
  const taskButton = firstGoal.locator(`#chain-task-goal-${goalId}-${firstId}`);
  await taskButton.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'First task', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(taskButton).toBeFocused();
  const graphButton = firstGoal.locator(`#project-goal-graph-${goalId}`);
  await graphButton.focus(); await page.keyboard.press('Enter');
  const graphDialog = page.locator('.task-chain-dialog');
  await expect(graphDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(graphDialog).toHaveCount(0);
  await expect(graphButton).toBeFocused();
  await firstGoal.locator(`#project-goal-detail-${goalId}`).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.goal-detail-surface')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0);
  await expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
  const overflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth, scrollX: window.scrollX, elements: [...document.querySelectorAll("body *")].map(element => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right + window.scrollX })).filter(element => element.right > window.innerWidth + 1).slice(0, 30) }));
  expect(overflow, JSON.stringify(overflow)).toMatchObject({ width: width, viewport: width });
  await page.screenshot({ path: testInfo.outputPath('goal-list.png') });
  await page.reload();
  await expect(page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`)).toHaveAttribute('aria-expanded', 'false');
  expect(errors).toEqual([]);
});

test('Goal empty and filtered states retain their padding and restore members', async ({ page }) => {
  const fixture = await install(page); fixture.taggedAndEmptyGoals();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const empty = page.locator(`[data-goal-id="${otherGoalId}"]`);
  await card.locator('.goal-list-toggle').click();
  await empty.locator('.goal-list-toggle').click();
  await expect(empty.locator('.goal-list-empty')).toHaveText('No tasks in this Goal.');
  const emptyTitle = empty.locator('.goal-list-title');
  await emptyTitle.click();
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Empty goal');
  await page.keyboard.press('Escape');
  await expect(emptyTitle).toBeFocused();
  await expect(empty.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'true');
  const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').nth(1);
  await filter.locator('summary').click();
  await filter.getByLabel('Untagged only').check();
  await expect(card.locator('.goal-list-empty')).toHaveText('No tasks match the filters');
  for (const target of [card, empty]) {
    await expect(target.locator('.goal-list-empty')).toHaveCSS('padding', '16px 18px');
    expect(await target.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return Math.abs(element.querySelector('.goal-list-empty')!.getBoundingClientRect().bottom - bounds.bottom + 1) < 0.1;
    })).toBe(true);
  }
  await filter.getByLabel('Untagged only').uncheck();
  await expect(card.locator('.goal-task-list > li')).toHaveCount(3);
  await expect(card.locator('.goal-list-empty')).toHaveCount(0);
});

test('Goal child history and attachment navigation make no Steps requests', async ({ page }) => {
  const stepsRequests: string[] = [];
  page.on('request', request => { if (/\/tasks\/[^/]+\/steps(?:\/|$)/.test(new URL(request.url()).pathname)) stepsRequests.push(`${request.method()} ${request.url()}`); });
  await install(page);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  await restoreGoalChild(page, singleId);
  const child = page.getByRole('dialog', { name: 'Standalone task' });
  await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(child.getByRole('tab', { name: 'Steps', exact: true })).toHaveCount(0);
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await child.getByRole('button', { name: /^notes\.txt/ }).click();
  await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goForward(); await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  expect(stepsRequests).toEqual([]);
});

test('flat Goal member preserves history, draft protection, and its source focus', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const toggle = card.locator('.goal-list-toggle');
  await toggle.click();
  const entry = card.locator(`#chain-task-goal-${goalId}-${firstId}`);
  await entry.focus(); await page.keyboard.press('Enter');
  const child = page.getByRole('dialog', { name: 'First task', exact: true });
  await expect(child).toBeVisible();
  await child.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await child.getByRole('button', { name: /^notes\.txt/ }).click();
  await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(child.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goForward(); await expect(child.locator('.attachment-file-selected')).toContainText('notes.txt');
  await page.goBack(); await expect(child.locator('.attachment-file-selected')).toHaveCount(0);
  await page.goBack(); await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack(); await expect(child).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(entry).toBeFocused();
  await page.goForward(); await expect(child).toBeVisible();
  await expect(child.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await child.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = child.locator('.thread-composer textarea');
  await draft.fill('Flat member draft');
  await child.getByRole('button', { name: 'Close task details' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(draft).toHaveValue('Flat member draft');
  await child.getByRole('button', { name: 'Close task details' }).click();
  await confirm.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(child).toHaveCount(0);
  await expect(entry).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(fixture.statusWrites()).toEqual([]);
  expect(fixture.edits()).toEqual([]);
});

test('Goal summary follows snapshot membership without resetting disclosure or focus', async ({ page }) => {
  const fixture = await install(page); fixture.addCrossGoal(); fixture.addLongGoalListWorker();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const other = page.locator(`[data-goal-id="${otherGoalId}"]`);
  const toggle = card.locator('.goal-list-toggle');
  await toggle.click(); await toggle.focus();
  await toggle.evaluate(element => { (element as HTMLElement).dataset.testIdentity = 'retained'; });
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().includes('/task-sync') && response.ok());
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await response;
  };
  await refresh();
  await expect(toggle).toHaveAttribute('data-test-identity', 'retained');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleDescription(/1 in progress.*Automatic execution active/);
  fixture.moveActiveGoalChild(); await refresh();
  await expect(card.locator('.goal-in-progress')).toHaveText('0 in progress');
  await expect(card.locator('.chain-worker-active')).toHaveCount(0);
  await expect(other.locator('.goal-list-toggle')).toHaveAccessibleDescription(/1 in progress.*Automatic execution active/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
});

test('Goal list graph navigation and history retain the source and scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  const fixture = await install(page); fixture.addGoalExternalChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const goalRow = page.locator(`[data-goal-id="${goalId}"]`);
  const goalToggle = goalRow.locator('.goal-list-toggle'); await goalToggle.click();
  const open = goalRow.locator(`#project-goal-graph-${goalId}`); await open.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  await open.click();
  const graphDialog = page.locator(`#task-graph-${goalId}`);
  await expect(graphDialog).toBeVisible();
  const inspect = graphDialog.locator(`[data-id="${firstId}"] .task-node-body`);
  await inspect.click();
  const task = graphDialog.locator(`[data-id="${firstId}"] .task-node-details`);
  await task.click();
  const detail = page.getByRole('dialog', { name: 'First task', exact: true });
  await expect(detail).toBeVisible();
  await detail.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await page.goBack();
  await expect(detail.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
  await detail.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = detail.locator('.thread-composer textarea');
  await draft.fill('Goal graph Task draft');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(draft).toHaveValue('Goal graph Task draft');
  await detail.getByRole('button', { name: 'Close task details' }).click();
  await confirm.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(detail).toHaveCount(0); await expect(task).toBeFocused();
  await expect(inspect).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  await expect(goalToggle).toHaveAttribute('aria-expanded', 'true');
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await open.click(); await expect(graphDialog).toBeVisible();
  await page.goBack(); await expect(graphDialog).toHaveCount(0);
  await page.goForward(); await expect(graphDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(goalToggle).toHaveAttribute('aria-expanded', 'true');
});

test('Goal list graph restores visible focus when its source Goal is filtered out', async ({ page }) => {
  const fixture = await install(page); fixture.addCrossGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await selectStatus(page, 'todo');
  const source = page.locator(`[data-goal-id="${goalId}"]`);
  await source.locator('.goal-list-toggle').click();
  await source.locator(`#project-goal-graph-${goalId}`).click();
  const dialog = page.locator('.task-chain-dialog'); await expect(dialog).toBeVisible();
  fixture.finishGoal();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(source).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#project-goal-list')).toBeFocused();
  await expect(statusButton(page)).toHaveText('To do');
  await expect(page.locator(`[data-goal-id="${otherGoalId}"]`)).toBeVisible();
});

test('Goal list distinguishes loading failure from empty and retains expanded rows through failed refresh and retry', async ({ page }) => {
  const fixture = await install(page); fixture.failNextSync();
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: 'Project could not be loaded' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const goalRow = page.locator(`[data-goal-id="${goalId}"]`);
  const toggle = goalRow.locator('.goal-list-toggle'); await toggle.click();
  fixture.failNextSync(); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Refresh failed' })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(goalRow.getByText('Second task', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  await expect(page.getByRole('heading', { name: 'Refresh failed' })).toHaveCount(0);
  await expect(goalRow.getByText('Second task', { exact: true })).toBeVisible();
});

test('Goal list retires an old epoch and rejects its late background result', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const row = page.locator(`[data-goal-id="${goalId}"]`);
  await row.locator('.goal-list-toggle').click();
  fixture.holdNextSync(); await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(fixture.syncHeld).toBe(true);
  fixture.advanceEpoch(); fixture.setGoalTitle('Replacement Goal');
  await row.locator(`#project-goal-detail-${goalId}`).click();
  await expect.poll(fixture.goalReads).toBeGreaterThan(0);
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0);
  await expect(page.locator(`#project-goal-${goalId}`)).toHaveText('Replacement Goal');
  fixture.releaseSync();
  await expect.poll(fixture.heldSyncFinished).toBe(true);
  await expect(page.locator(`#project-goal-${goalId}`)).toHaveText('Replacement Goal');
  await expect(page.getByText('Goal reading', { exact: true })).toHaveCount(0);
});


for (const width of [1280, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`mixed Goal members remain readable at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale); fixture.mixedLayoutGoal();
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await card.locator('.goal-list-toggle').click();
  const rows = card.locator('.goal-task-list > li .task-row');
  await expect(rows).toHaveCount(5);
  for (const status of ['proposed', 'todo', 'in_progress', 'done', 'cancelled'] as const) {
    const row = card.locator(`.goal-task-list > li .task-row[data-task-status="${status}"]`);
    await page.mouse.move(0, 0);
    await expect(row).toHaveCSS('background-color', roleColors[status][0]);
    await row.hover();
    await expect(row).toHaveCSS('background-color', roleColors[status][1]);
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(row.locator('.task-row-id')).toBeVisible();
    await expect(row.locator('.task-tag')).toHaveCount(2);
    const starts = await row.evaluate(element => {
      const left = (selector: string) => element.querySelector(selector)!.getBoundingClientRect().left;
      return [left('.task-row-title'), left('.task-row-meta'), left('.task-tag-list')];
    });
    expect(starts[1]).toBeCloseTo(starts[0]!, 1);
    expect(starts[2]).toBeCloseTo(starts[0]!, 1);
    await row.locator('.task-row-title').focus();
    await expect(row.locator('.task-row-title')).toBeFocused();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [1280, 651, 650, 601, 600, 390, 320]) test(`expanded member rows align with their content edges at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page); fixture.completionGoal(true); fixture.layoutMemberEvidence();
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const ordinary = page.locator(`#standalone-task-${layoutStandaloneId}`).locator('..').locator('..').locator('..');
  await expect(ordinary).toHaveClass(/task-row/);
  const ordinaryPadding = await ordinary.evaluate(element => parseFloat(getComputedStyle(element).paddingInlineStart));
  expect(ordinaryPadding).toBe(width > 650 ? 15 : 11);
  const extraIndent = width > 600 ? 16 : 12;
  const verify = async (container: Locator, toggle: Locator, contentSelector: string, bottom: number) => {
    const headerBefore = await toggle.boundingBox();
    await toggle.click();
    const headerAfter = await toggle.boundingBox();
    expect(headerAfter!.x).toBeCloseTo(headerBefore!.x, 1);
    const content = container.locator(contentSelector);
    const list = content.locator(':scope > .goal-task-list');
    await expect(list.locator(':scope > li .task-row').first()).toBeVisible();
    const geometry = await list.evaluate(element => {
      const content = element.parentElement!.getBoundingClientRect();
      const listBox = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>(':scope > li .task-row')].map(row => {
        const box = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        const left = (selector: string) => row.querySelector(selector)!.getBoundingClientRect().left;
        return { left: box.left, right: box.right, padding: parseFloat(style.paddingInlineStart),
          rightPadding: parseFloat(style.paddingInlineEnd), border: parseFloat(style.borderInlineStartWidth),
          title: left('.task-row-title'), meta: left('.task-row-meta'), tags: left('.task-tag-list'),
          status: left('.task-row-status'), overflow: row.scrollWidth > row.clientWidth + 1 };
      });
      return { left: content.left, right: content.right, listBottom: listBox.bottom,
        lastBottom: element.lastElementChild!.getBoundingClientRect().bottom, rows,
        pageOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.rows.length).toBeGreaterThan(0);
    for (const row of geometry.rows) {
      expect(row.left).toBeCloseTo(geometry.left, 1);
      expect(row.right).toBeCloseTo(geometry.right, 1);
      expect(row.padding).toBe(ordinaryPadding + extraIndent);
      expect(row.rightPadding).toBe(ordinaryPadding);
      expect(row.title).toBeCloseTo(row.left + row.border + ordinaryPadding + extraIndent, 1);
      expect(row.meta).toBeCloseTo(row.title, 1);
      expect(row.tags).toBeCloseTo(row.title, 1);
      if (width <= 650) expect(row.status).toBeCloseTo(row.title, 1);
      expect(row.overflow).toBe(false);
    }
    expect(geometry.listBottom - geometry.lastBottom).toBeCloseTo(bottom, 1);
    expect(geometry.pageOverflow).toBe(false);
    const row = list.locator(':scope > li .task-row').first();
    const title = row.locator('.task-row-title');
    const titleText = await title.innerText();
    await row.scrollIntoViewIfNeeded();
    const box = (await row.boundingBox())!;
    const point = { x: box.x + 4, y: box.y + box.height / 2 };
    expect(await row.evaluate((element, p) => document.elementFromPoint(p.x, p.y) === element, point)).toBe(true);
    await page.mouse.click(point.x, point.y);
    const dialog = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
    await expect(dialog.locator('.task-detail-title')).toHaveText(titleText);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  };
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const goalRow = page.locator(`[data-goal-id="${goalId}"]`);
  await verify(goalRow, goalRow.locator('.goal-list-toggle'), '.goal-list-contents', 0);
  await expect(goalRow.locator('.goal-task-list')).toHaveCount(1);
  await expect(goalRow.locator('.goal-task-list > li')).toHaveCount(3);
  await page.getByRole('tab', { name: 'Task chains' }).click();
  for (const id of [otherTask2Id, outsideId]) {
    const chain = page.locator(`[data-chain-id="${id}"]`);
    await verify(chain, chain.locator('.goal-toggle'), '.goal-children', 5);
  }
  if (width === 320) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const scoped = page.locator(`[data-chain-id="${outsideId}"]`);
    const active = scoped.locator(`#chain-task-${outsideId}-${layoutWorkerId}`).locator('..').locator('..').locator('..');
    await page.mouse.move(0, 0);
    await expect(active).toHaveClass(/standalone-row-stuck/);
    await expect(active).toHaveCSS('background-color', roleColors.attention[0]);
    await active.hover();
    await expect(active).toHaveCSS('background-color', roleColors.attention[1]);
    await active.getByRole('button', { name: 'Copy task ID' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(layoutWorkerId);
    await expect(page.locator('.task-detail-dialog')).toHaveCount(0);
    const session = active.getByRole('button', { name: /Open Session/ });
    await session.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.task-detail-dialog [role=tab][aria-selected=true]')).toHaveText('Session');
    await page.keyboard.press('Escape'); await expect(session).toBeFocused();
    await expect(scoped.locator('.goal-toggle')).toHaveAttribute('aria-expanded', 'true');
  }
  expect(fixture.statusWrites()).toEqual([]);
  expect(fixture.edits()).toEqual([]);
});

for (const kind of ['goal', 'chain'] as const) for (const former of [false, true]) test(`${kind} summary retains ${former ? 'former' : 'unassigned'} assignee metadata size`, async ({ page }) => {
  const fixture = await install(page, 'en', 'Former member', !former);
  if (kind === 'chain') fixture.addActiveChain(former ? TEST_VIEWER_ID : null);
  else if (former) fixture.setGoalSessionFixture('todo', 'working');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: kind === 'goal' ? /^Goal/ : 'Task chains' }).click();
  const header = kind === 'goal' ? page.locator(`[data-goal-id="${goalId}"] .goal-list-row`) : page.locator(`[data-chain-id="${outsideId}"] .goal-header`);
  await expect(header.locator('.assignee-name')).toHaveText(former ? 'Former member' : 'Unassigned');
  await expect(header.locator('.assignee-former')).toHaveCount(former ? 1 : 0);
  for (const rootSize of [16, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    await expect(header.locator('.assignee-name')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
    if (former) await expect(header.locator('.assignee-former')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
  }
});

test('completed and incomplete full and scoped chains have compact desktop headers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fixture = await install(page, 'en', 'Owner'); fixture.compactChains();
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: 'Task chains' }).click();
  const heights: number[] = [];
  for (const [id, hasTime] of [[firstId, true], [otherTask2Id, false], [outsideId, true], [layoutWorkerId, false]] as const) {
    const row = page.locator(`[data-chain-id="${id}"]`);
    const header = row.locator('.goal-header');
    await expect(header.locator('.chain-completion-time')).toHaveCount(hasTime ? 1 : 0);
    if (hasTime) await expectChainTimeLayout(header);
    const sizes = await row.evaluate(element => ({
      card: element.getBoundingClientRect().height,
      header: element.querySelector('.goal-header')!.getBoundingClientRect().height,
      meta: element.querySelector('.chain-summary-meta')!.getBoundingClientRect().height,
    }));
    const scoped = id === outsideId || id === layoutWorkerId;
    expect(sizes.header).toBeCloseTo(scoped ? 63 : 63.6, 0);
    expect(sizes.card).toBeCloseTo(scoped ? 65 : 65.6, 0);
    expect(sizes.meta).toBeCloseTo(scoped ? 18 : 18.6, 0);
    heights.push(sizes.header);
  }
  expect(Math.abs(heights[0]! - heights[1]!)).toBeLessThanOrEqual(1);
  expect(Math.abs(heights[2]! - heights[3]!)).toBeLessThanOrEqual(1);
  fixture.clearCompactCompletion();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const updated = page.locator(`[data-chain-id="${firstId}"] .goal-header`);
  await expect(updated.locator('.chain-completion-time')).toHaveCount(0);
  expect(Math.abs(await updated.evaluate(element => element.getBoundingClientRect().height) - heights[0]!)).toBeLessThanOrEqual(1);
});

for (const width of [1440, 1280, 740, 600, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`long completed chain metadata remains readable at ${width}px in ${locale}`, async ({ page }) => {
  const fixture = await install(page, locale); fixture.completionGoal(true);
  await page.clock.install({ time: new Date('2055-01-01T00:00:00Z') });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
  const verify = async (row: Locator, scoped: boolean) => {
    const header = row.locator('.goal-header'), toggle = header.locator('.goal-toggle');
    const completion = header.locator('.chain-completion-time');
    await expect(header.locator('.root-title')).toHaveText(longChainTitle);
    if (scoped) await expect(header.locator('.chain-worker-active')).toBeVisible();
    if (!scoped) await expect(header.locator('.assignee-name')).toHaveText('Long owner name '.repeat(8).trim());
    await expect(completion.locator('time')).toContainText('2026');
    for (const rootSize of [16, 24]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
      for (const selector of ['.chain-completion-time', '.session-status-label', scoped ? '.chain-worker-active' : '.assignee-name']) {
        await expect(header.locator(selector)).toHaveCSS('font-size', `${rootSize * 0.75}px`);
      }
      await expect(header.locator('.root-title')).toHaveCSS('font-size', `${rootSize * 0.875}px`);
      await expect(header.locator('.root-progress-label')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
      await expectChainTimeLayout(header);
      expect(await header.locator('.session-status-label').evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await expectChainTimeLayout(header);
    expect(await header.evaluate(element => [...element.querySelectorAll<HTMLElement>('.root-title, .assignee-name, .chain-worker-active, .chain-completion-time, .root-progress-label, .root-status, .goal-graph-button')].every(part => part.scrollWidth <= part.clientWidth + 1 && part.scrollHeight <= part.clientHeight + 1))).toBe(true);
    await expectHit(completion);
    await completion.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(row.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expectChainTimeLayout(header);
    await expectHit(header.locator('.goal-graph-button'));
  };
  await verify(page.locator(`[data-chain-id="${otherTask2Id}"]`), false);
  await verify(page.locator(`[data-chain-id="${outsideId}"]`), true);
  expect(await page.locator('button button, button a, a button').count()).toBe(0);
  expect(fixture.statusWrites()).toEqual([]);
  expect(fixture.edits()).toEqual([]);
});

for (const width of [1280, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`chain graph icon matches Goal and preserves interaction at ${width}px in ${locale}`, async ({ page }) => {
  const fixture = await install(page, locale); fixture.completionGoal(true);
  await page.clock.install({ time: new Date('2055-01-01T00:00:00Z') });
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const reference = page.locator(`#project-goal-graph-${goalId}`);
  const style = (element: Element) => {
    const s = getComputedStyle(element), r = element.getBoundingClientRect();
    return { width: r.width, height: r.height, color: s.color, background: s.backgroundColor, border: s.borderColor, radius: s.borderRadius, outline: s.outline, offset: s.outlineOffset };
  };
  const normal = await reference.evaluate(style);
  await reference.hover(); const hover = await reference.evaluate(style);
  await page.keyboard.press('Tab'); await reference.focus(); const focus = await reference.evaluate(style);
  await page.getByRole('tab', { name: locale === 'en' ? 'Task chains' : '任务链' }).click();
  const action = locale === 'en' ? 'View dependencies' : '查看依赖关系';
  for (const id of [otherTask2Id, outsideId]) {
    const row = page.locator(`[data-chain-id="${id}"]`), toggle = row.locator('.goal-toggle'), button = row.locator('.goal-graph-button');
    await expect(button).toHaveAccessibleName(`${longChainTitle}${locale === 'en' ? ', ' : '，'}${action}`);
    await expect(button).toHaveAttribute('title', action);
    await expect(button).toHaveText('');
    await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    expect(await button.evaluate(style)).toEqual(normal);
    await button.hover(); expect(await button.evaluate(style)).toEqual(hover);
    await toggle.focus();
    for (let i = 0; i < 5 && !(await button.evaluate(element => element === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(button).toBeFocused(); expect(await button.evaluate(style)).toEqual(focus);
    await expectHit(button);
    for (const key of ['Enter', 'Space']) {
      await page.keyboard.press(key);
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Escape');
      await expect(button).toBeFocused();
    }
    await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await button.click(); await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused(); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.statusWrites()).toEqual([]); expect(fixture.edits()).toEqual([]);
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal completion is readable in its list and detail at ${width}px in ${locale}`, async ({ page }) => {
  const fixture = await install(page, locale); fixture.completionGoal();
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
  await page.setViewportSize({ width, height: 800 });
  const zh = locale === 'zh-CN';
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  const detail = card.locator(`#project-goal-detail-${goalId}`);
  const label = card.locator('.goal-list-meta time');
  await expect(label).toHaveAttribute('datetime', '2026-10-22T09:59:40Z');
  for (const rootSize of [16, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    await expect(label).toHaveCSS('font-size', `${rootSize * 0.75}px`);
    await expect(card.locator('.goal-list-session .session-status-label')).toHaveCSS('font-size', `${rootSize * 0.75}px`);
    await expect(card.locator('.goal-list-session .session-status-annotation')).toHaveCount(0);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await label.hover();
  const hint = card.getByRole('tooltip');
  const toggle = card.locator('.goal-list-toggle');
  await expect(hint).toBeVisible();
  await hint.hover();
  await expect(hint).toBeVisible();
  await hint.click({ clickCount: 3 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await detail.focus();
  await expect(card.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('tooltip')).toBeHidden();
  await toggle.click();
  await expect(card.locator('.task-row').filter({ hasText: 'Standalone task' })).toContainText(zh ? '待处理' : 'To do');
  const row = card.locator(`#chain-task-goal-${goalId}-${firstId}`);
  await expect(row.locator('..').locator('..').locator('..').locator('time.completion-time-label')).toHaveAttribute('datetime', '2026-10-22T09:59:10Z');
  await row.focus(); await expect(row).toHaveAttribute('aria-describedby', /.+/);
  await page.keyboard.press('Tab'); await expect(row).not.toBeFocused();
  expect(await page.locator('button button, button a, a button').count()).toBe(0);
  await detail.click();
  const surface = page.locator('.goal-detail-surface');
  const check = async () => {
    const meta = surface.locator('.goal-detail-meta');
    await expect(meta.locator('time')).toHaveAttribute('datetime', '2026-10-22T09:59:40Z');
    await expect(surface.locator('.goal-information-general time').nth(1)).toHaveAttribute('datetime', '2026-10-22T09:59:40Z');
    await expect(meta).toContainText(zh ? '完成时间' : 'Completion time');
    await expect(meta.locator('time')).toContainText('2026');
    await expect(meta.locator('time')).toContainText('40');
    await expect(surface.getByRole('tab')).toHaveText(zh ? ['描述', '附件', '讨论'] : ['Description', 'Attachments', 'Discussion']);
    await expect(surface.locator('[data-goal-task-id]')).toHaveCount(0);
    await expect(surface.locator('.goal-information-statuses dt').filter({ hasText: zh ? /^未结束$/ : /^Unfinished$/ }).locator('..').locator('dd')).toHaveText('1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await check();
  await surface.getByRole('button', { name: zh ? '进入全屏' : 'Enter fullscreen' }).click();
  await check();
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  await check();
  await surface.getByRole('button', { name: zh ? '进入全屏' : 'Enter fullscreen' }).click();
  await check();
});

test('Goal member exact completion remains accessible from the focused link', async ({ page }) => {
  const fixture = await install(page); fixture.completionGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${otherGoalId}"]`);
  await card.locator('.goal-list-toggle').click();
  const member = card.locator(`#chain-task-goal-${otherGoalId}-${outsideId}`);
  await member.focus();
  await expect(member).toBeFocused();
  expect(await member.evaluate(element => (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent).join(' '))).toContain('2026');
});

test('touch opens a completed Goal member and reads its completion time', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 800 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    const fixture = await install(page); fixture.completionGoal();
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: 'Task list', exact: true }).click();
    await page.getByRole('tab', { name: /^Goal/ }).click();
    const card = page.locator(`[data-goal-id="${goalId}"]`);
    await card.locator('.goal-list-toggle').click();
    await card.locator(`#chain-task-goal-${goalId}-${firstId}`).tap();
    const detail = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
    await expect(detail.locator('time[datetime="2026-10-22T09:59:10Z"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'true');
  } finally { await context.close(); }
});

test('Goal list completion tick retains pinned hint and expansion while its detail retains a nested Task draft', async ({ page }) => {
  const fixture = await install(page); fixture.completionGoal();
  await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const card = page.locator(`[data-goal-id="${goalId}"]`);
  await card.locator('.goal-list-toggle').click();
  const disclosure = card.locator('.goal-list-toggle');
  const time = card.locator(`#chain-task-goal-${goalId}-${firstId}`);
  const label = time.locator('..').locator('..').locator('..').locator('time.completion-time-label');
  await time.focus();
  const text = await label.textContent();
  const node = await time.elementHandle();
  fixture.holdNextSync();
  await page.clock.fastForward(61_000);
  await expect(label).not.toHaveText(text!);
  fixture.releaseSync();
  await expect(time).toHaveAttribute('aria-describedby', /.+/);
  await expect(time).toBeFocused();
  expect(await time.evaluate((element, old) => element === old, node)).toBe(true);
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await card.locator(`#project-goal-detail-${goalId}`).click();
  const goalSurface = page.locator('.goal-detail-surface');
  await goalSurface.getByRole('tab', { name: 'Discussion' }).click();
  const draft = goalSurface.locator('.thread-composer textarea');
  await draft.fill('Keep completion draft');
  await goalSurface.getByRole('tab', { name: 'Description', exact: true }).click();
  await restoreGoalChild(page, firstId);
  const child = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
  await expect(child.locator('time[datetime="2026-10-22T09:59:10Z"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(goalSurface).toBeVisible();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await goalSurface.getByRole('tab', { name: 'Discussion' }).click();
  await expect(draft).toHaveValue('Keep completion draft');
});

test('nested Goal reads its own completion fact from a cross-Goal graph', async ({ page }) => {
  const fixture = await install(page); fixture.addOutsideChain(); fixture.completeOtherGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list' }).click();
  await page.getByRole('tab', { name: 'Task chains' }).click();
  await page.locator(`[data-chain-id="${outsideId}"]`).getByRole('button', { name: /View dependencies/ }).click();
  await page.getByRole('dialog', { name: 'Outside chain' }).getByRole('button', { name: 'First task, Details' }).click();
  const firstGoal = page.getByRole('dialog', { name: 'Goal reading' });
  await page.getByRole('dialog', { name: 'First task', exact: true }).getByRole('button', { name: 'Close task details' }).click();
  await restoreGoalGraph(page, firstGoal, outsideId);
  await page.locator('.task-chain-dialog').last().getByRole('button', { name: 'Other task, Details' }).click();
  const nested = page.getByRole('dialog', { name: 'Other goal' });
  await expect(nested.locator('.goal-detail-meta time')).toHaveAttribute('datetime', '2026-10-22T09:59:40Z');
  await expect(nested.locator('.goal-detail-meta')).toContainText('Completion time');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Other task', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(nested).toHaveCount(0);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 740, 390, 320]) for (const rootSize of [16, 20, 24, 32]) {
  test(`Goal graph fits complex external card at ${width}px, ${rootSize}px root in ${locale}`, async ({ page }) => {
    const title = locale === 'en' ? 'A long task title deliberately occupying three lines while the external marker and compact readings remain visible in this dense card' : '这是一个用于验证依赖图卡片三行标题与外部标记以及紧凑读数同时保持可读的非常长的任务标题';
    const fixture = await install(page, locale); fixture.addComplexExternalGoalTask(title);
    await page.route('**/api/usage/v1/capabilities', route => route.fulfill({ json: { protocol: 'daynight.usage.v1' }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
    await page.route('**/api/projects/*/usage/v1/task-summaries', route => {
      const { taskIds } = route.request().postDataJSON() as { taskIds: string[] };
      const summary = {
        metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: key === 'totalTokens' ? '9007199254740993' : null, contributingRecords: key === 'totalTokens' ? '1' : '0', unknownRecords: '0' }])),
        scope: 'registered_web_executions', completeness: 'partial', reasonCodes: [],
        coverage: { executions: '1', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '0' },
        measurementRecords: '1', lastMeasuredAt: null, observedAt: time, etag: 'external-usage',
      };
      return route.fulfill({ json: { items: taskIds.map(id => ({ taskId: id, summary })) }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
    });
    await page.clock.install({ time: new Date('2026-10-22T10:00:00Z') });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/projects/${projectId}`);
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
    await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
    await page.getByRole('tab', { name: /^Goal/ }).click();
    await page.locator(`#project-goal-graph-${goalId}`).click();
    const graph = page.locator(`#task-graph-${goalId}`);
    const external = graph.locator(`.react-flow__node[data-id="${otherTaskId}"] .task-node`);
    await expect(external.locator('.task-node-usage')).toBeVisible();
    await expect(external.locator('.task-node-owner')).toHaveCount(0);
    await expect(external.locator('.task-external-label')).toBeVisible();
    await expect(external.locator('.task-node-expansions')).toHaveCount(0);
    await expectGraphCardBadges(external);
    const measure = async () => external.evaluate(element => {
      const card = element as HTMLElement, box = card.getBoundingClientRect();
      const title = card.querySelector<HTMLElement>('.task-node-title')!;
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
      const parts = ['.task-node-meta', '.task-node-title', '.task-node-usage', '.task-duration', '.task-node-state', '.task-node-details']
        .flatMap(selector => [...card.querySelectorAll(selector)].map(part => ({ selector, box: part.getBoundingClientRect() })));
      const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
      return { width: card.offsetWidth, height: card.offsetHeight, threeLines: title.offsetHeight >= lineHeight * 2.8 && title.offsetHeight <= lineHeight * 3.1,
        inside: parts.every(({ box: part }) => part.left >= box.left - 1 && part.right <= box.right + 1 && part.top >= box.top - 1 && part.bottom <= box.bottom + 1),
        overlaps: parts.flatMap((part, index) => parts.slice(index + 1).filter(other => !separate(part.box, other.box)).map(other => ({ a: part.selector, b: other.selector, aBox: part.box.toJSON(), bBox: other.box.toJSON() }))) };
    });
    expect(await measure()).toEqual({ width: 300 * rootSize / 16, height: 124 * rootSize / 16, threeLines: true, inside: true, overlaps: [] });
    expect(await graph.locator('.graph-orientation').evaluate(element => {
      const box = element.getBoundingClientRect(), dialog = element.closest('[role="dialog"]')!.getBoundingClientRect();
      return box.left >= dialog.left && box.right <= dialog.right;
    })).toBe(true);
    await graph.locator('[data-direction="vertical"]').click();
    await expect(graph.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
    expect(await measure()).toEqual({ width: 300 * rootSize / 16, height: 124 * rootSize / 16, threeLines: true, inside: true, overlaps: [] });
  });
}

for (const width of [1280, 768, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) for (const rootSize of [16, 32]) test(`Goal compact graph frames independent tasks at ${width}px, ${rootSize}px root in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const fixture = await install(page, locale); fixture.independentGoalTasks();
  await page.goto(`/projects/${projectId}`);
  await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, rootSize);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-graph-${goalId}`).click();
  const dialog = page.locator(`#task-graph-${goalId}`);
  const nodes = dialog.locator('.react-flow__node');
  const viewport = dialog.locator('.react-flow__viewport');
  await expect(nodes).toHaveCount(30);
  expect(await nodes.evaluateAll((elements, scale) => elements.every(element => {
    const card = element.querySelector<HTMLElement>('.task-node')!;
    return card.offsetWidth === 300 * scale && card.offsetHeight === 124 * scale;
  }), rootSize / 16)).toBe(true);
  expect(await nodes.first().evaluate(element => {
    const node = element.querySelector('.task-node')!.getBoundingClientRect();
    const details = element.querySelector('.task-node-details')!.getBoundingClientRect();
    const statuses = [...element.querySelectorAll('.task-node-bottom > *')].map(item => item.getBoundingClientRect());
    const title = element.querySelector('.task-node-title')!.getBoundingClientRect();
    const inside = (box: DOMRect) => box.left >= node.left - 1 && box.right <= node.right + 1 && box.top >= node.top - 1 && box.bottom <= node.bottom + 1;
    const separate = (a: DOMRect, b: DOMRect) => a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
    return [details, ...statuses, title].every(inside) && statuses.every(status => separate(details, status)) && separate(details, title);
  })).toBe(true);

  const grid = async () => nodes.evaluateAll(elements => elements.map(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform);
    return { x: matrix.e, y: matrix.f };
  }));
  const zoom = async () => viewport.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).a);
  const allInView = async () => dialog.locator('.react-flow').evaluate(element => {
    const pane = element.getBoundingClientRect();
    return [...element.querySelectorAll('.react-flow__node')].every(node => {
      const box = node.getBoundingClientRect();
      return box.left >= pane.left - 1 && box.top >= pane.top - 1 && box.right <= pane.right + 1 && box.bottom <= pane.bottom + 1;
    });
  });
  const expectGrid = async () => {
    const positions = await grid();
    expect(new Set(positions.map(point => point.x)).size).toBeGreaterThan(1);
    expect(new Set(positions.map(point => point.y)).size).toBeGreaterThan(1);
  };
  await expectGrid();
  const minimumZoom = await dialog.locator('.react-flow').evaluate((element, scale) => Math.max(0.2, Math.min(0.8, (element.clientWidth - 40) / (300 * scale))), rootSize / 16);
  await expect.poll(zoom).toBeGreaterThanOrEqual(minimumZoom - 0.001);
  expect(await zoom()).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const topFit = dialog.locator('.graph-reset-overview');
  await topFit.focus(); await page.keyboard.press('Enter');
  await expect(topFit).toBeFocused();
  await expect.poll(allInView).toBe(true);
  await dialog.locator('[data-direction="vertical"]').click();
  await expect(dialog.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
  await expectGrid();
  await expect.poll(zoom).toBeGreaterThanOrEqual(minimumZoom - 0.001);
  const bottomFit = dialog.getByRole('button', { name: locale === 'en' ? 'Fit to canvas' : '适应画布', exact: true });
  await bottomFit.click();
  await expect(bottomFit).toBeFocused();
  await expect.poll(allInView).toBe(true);
  if (width === 1280 && locale === 'en') {
    const positions = await grid();
    const transform = await viewport.getAttribute('style');
    await dialog.locator('.graph-fullscreen-toggle').click();
    expect(await grid()).toEqual(positions);
    await expect(viewport).toHaveAttribute('style', transform!);
    await page.setViewportSize({ width: 1100, height: 800 });
    expect(await grid()).toEqual(positions);
    await expect(viewport).toHaveAttribute('style', transform!);
  }
});

test.describe('Goal compact graph on touch screens', () => {
  test.use({ hasTouch: true });
  test('pans and opens a Task with touch', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const fixture = await install(page); fixture.independentGoalTasks();
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: 'Task list', exact: true }).click();
    await page.getByRole('tab', { name: /^Goal/ }).click();
    await page.locator(`#project-goal-graph-${goalId}`).click();
    const dialog = page.locator(`#task-graph-${goalId}`);
    const viewport = dialog.locator('.react-flow__viewport');
    const task = dialog.locator('[data-id="00000000-0000-4000-8000-000000000800"] .task-node-details');
    await expect(task).toBeVisible();
    const box = await task.boundingBox();
    expect(box).not.toBeNull();
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByRole('dialog', { name: /^Long task/ })).toBeVisible();
    await page.keyboard.press('Escape');
    const pane = await dialog.locator('.react-flow__pane').boundingBox();
    expect(pane).not.toBeNull();
    const before = await viewport.getAttribute('style');
    const cdp = await context.newCDPSession(page);
    const x = pane!.x + 10, y = pane!.y + pane!.height / 2;
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane'), { x, y })).toBe(true);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 60, y: y + 40 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
    await cdp.detach();
  });
});

for (const width of [1440, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal overview graph preserves reading and keyboard focus at ${width}px in ${locale}`, async ({ page, context }, info) => {
  await page.setViewportSize({ width, height: 800 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page, locale); fixture.addGoalInspectionGraph();
  const title = 'Long Goal 长标题 '.repeat(16).trim(); fixture.setGoalTitle(title);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const row = page.locator(`[data-goal-id="${goalId}"]`);
  const opener = row.locator(`#project-goal-graph-${goalId}`);
  await opener.focus(); await page.keyboard.press('Enter');
  const dialog = page.locator(`#task-graph-${goalId}`);
  await expect(dialog).toBeVisible();
  await expect(row.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.locator('.task-node')).toHaveCount(4);
  for (const id of [firstId, secondId, singleId, otherTaskId]) await expect(dialog.locator(`[data-id="${id}"] .task-node-body`)).toHaveCount(1);
  await expect(dialog.locator(`[data-id="${otherTask2Id}"]`)).toHaveCount(0);
  await expect(dialog.locator('.task-node-details')).toHaveCount(4);
  await expect(dialog.locator('.task-node-expand')).toHaveCount(0);
  const topology = { nodes: [firstId, secondId, singleId, otherTaskId].map(id => ({ id })), edges: [
    { id: `${otherTaskId}->${firstId}`, source: otherTaskId, target: firstId, external: true },
    { id: `${otherTaskId}->${singleId}`, source: otherTaskId, target: singleId, external: true },
    { id: `${firstId}->${secondId}`, source: firstId, target: secondId, external: false },
    { id: `${singleId}->${secondId}`, source: singleId, target: secondId, external: false },
  ] };
  if (width === 1440 && locale === 'en') expect(await checkDependencyGeometry(page, topology, info)).toEqual({ total: 0, examples: [] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const viewport = dialog.locator('.react-flow__viewport');
  const positions = () => dialog.locator('.react-flow__node').evaluateAll(elements => elements.map(element => [element.getAttribute('data-id'), (element as HTMLElement).style.transform]));
  const selected = dialog.locator(`[data-id="${secondId}"] .task-node-body`);
  await selected.focus();
  const before = await viewport.getAttribute('style'), beforePositions = await positions();
  await page.keyboard.press(' ');
  await expect(selected).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('.task-node-prerequisite')).toHaveCount(3);
  await expect(dialog.locator('.task-dependency-edge[data-inspection="highlighted"]')).toHaveCount(4);
  await expect(dialog.locator('.graph-hidden-prerequisites')).toHaveText(locale === 'en' ? '2 additional upstream tasks are hidden' : '另有2个上游未展开');
  await page.screenshot({ path: info.outputPath(`goal-inspection-${width}-${locale}.png`) });
  await expect(page.getByRole('dialog', { name: 'Second task', exact: true })).toHaveCount(0);
  await expect(viewport).toHaveAttribute('style', before!);
  expect(await positions()).toEqual(beforePositions);
  const externalBody = dialog.locator(`[data-id="${otherTaskId}"] .task-node-body`);
  await externalBody.focus(); await page.keyboard.press('Enter');
  await expect(externalBody).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('.task-node-selected')).toHaveCount(1);
  const external = dialog.locator(`[data-id="${otherTaskId}"] .task-node-details`);
  await external.focus(); await page.keyboard.press('Enter');
  const detail = page.getByRole('dialog', { name: 'Other task', exact: true });
  await expect(detail).toBeVisible();
  const transform = await viewport.evaluate(el => (el as HTMLElement).style.transform);
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await viewport.evaluate(el => (el as HTMLElement).style.transform)).toBe(transform);
  await expect(external).toBeFocused();
  await expect(externalBody).toHaveAttribute('aria-pressed', 'true');
  await dialog.locator('[data-direction="vertical"]').click();
  await expect(dialog.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
  await expect(externalBody).toHaveAttribute('aria-pressed', 'true');
  if (width === 1440 && locale === 'en') expect(await checkDependencyGeometry(page, topology, info, undefined, 'vertical')).toEqual({ total: 0, examples: [] });
  const goalDetails = dialog.getByRole('button', { name: locale === 'en' ? 'Goal details' : 'Goal 详情', exact: true });
  const readGoal = async (fullscreen: boolean) => {
    await expect(goalDetails).toHaveAttribute('aria-haspopup', 'dialog');
    await expectHit(goalDetails);
    const layout = await dialog.evaluate(element => {
      const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      const header = box('.task-chain-header'), heading = box('.task-chain-heading'), close = box('.task-chain-close'), details = box('.goal-graph-header-actions .button'), copy = box('.goal-graph-copy'), toolbar = box('.graph-toolbar');
      return { belowClose: details.top >= close.bottom, aboveToolbar: details.bottom <= toolbar.top, rightOfHeading: details.left >= heading.right || details.top >= heading.bottom, copyBeforeDetails: copy.right <= details.left, sameRow: copy.top === details.top || Math.abs(copy.top - details.top) < 5,
        insideHeader: details.left >= header.left && details.right <= header.right && details.top >= header.top && details.bottom <= header.bottom,
        noOverflow: element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth };
    });
    expect(layout).toEqual({ belowClose: true, aboveToolbar: true, rightOfHeading: true, copyBeforeDetails: true, sameRow: true, insideHeader: true, noOverflow: true });
    const copy = dialog.getByRole('button', { name: locale === 'en' ? 'Copy link' : '复制链接', exact: true });
    const beforeCopy = await viewport.getAttribute('style');
    if (fullscreen) { await copy.focus(); await page.keyboard.press('Enter'); } else await copy.click();
    await expect(copy).toBeFocused();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
    await expect(copy).toHaveText(locale === 'en' ? 'Copied' : '已复制');
    await expect(viewport).toHaveAttribute('style', beforeCopy!);
    await expect(externalBody).toHaveAttribute('aria-pressed', 'true');
    if (!fullscreen && width === 1440 && locale === 'en') {
      const target = await page.evaluate(() => navigator.clipboard.readText());
      const recipient = await context.newPage(); const recipientFixture = await install(recipient, locale); recipientFixture.addGoalInspectionGraph(); recipientFixture.setGoalTitle(title); await recipient.goto(target);
      await expect(recipient.locator(`#task-graph-${goalId}`)).toBeVisible(); await recipient.close();
    }
    await dialog.getByRole('button', { name: locale === 'en' ? 'Zoom in' : '放大', exact: true }).click();
    const transform = await viewport.getAttribute('style');
    const nodePositions = await positions();
    if (fullscreen) { await goalDetails.focus(); await page.keyboard.press('Enter'); } else await goalDetails.click();
    const goalDetail = page.locator('.goal-detail-surface');
    await expect(goalDetail).toBeVisible();
    await expect(goalDetail.locator('.task-detail-title')).toHaveText(title);
    await expect(goalDetail.getByRole('tab', { name: locale === 'en' ? 'Description' : '描述', exact: true })).toHaveAttribute('aria-selected', 'true');
    if (fullscreen) await page.keyboard.press('Escape');
    else await goalDetail.getByRole('button', { name: locale === 'en' ? 'Close task details' : '关闭任务详情', exact: true }).click();
    await expect(goalDetail).toHaveCount(0);
    await expect(dialog).toBeVisible(); await expect(goalDetails).toBeFocused();
    await expect(viewport).toHaveAttribute('style', transform!); expect(await positions()).toEqual(nodePositions);
    await expect(externalBody).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
    expect(await dialog.evaluate(element => element.classList.contains('task-chain-dialog-fullscreen'))).toBe(fullscreen);
    await expect(row.locator('.goal-list-toggle')).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: info.outputPath(`goal-header-details-${width}-${locale}-${fullscreen ? 'fullscreen' : 'normal'}.png`) });
  };
  await readGoal(false);
  await dialog.locator('.graph-fullscreen-toggle').click();
  await expect(dialog.locator('.task-node')).toHaveCount(4);
  await expect(externalBody).toHaveAttribute('aria-pressed', 'true');
  await readGoal(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  expect(fixture.statusWrites()).toEqual([]); expect(fixture.edits()).toEqual([]);
});

test('Goal graph header details retain browser history and protect an unsaved Goal draft', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-graph-${goalId}`).click();
  const graphDialog = page.locator(`#task-graph-${goalId}`);
  const details = graphDialog.getByRole('button', { name: 'Goal details', exact: true });
  await details.click();
  const goalDetail = page.locator('.goal-detail-surface');
  await expect(goalDetail).toBeVisible();
  await page.goBack(); await expect(goalDetail).toHaveCount(0); await expect(details).toBeFocused();
  await page.goForward(); await expect(goalDetail).toBeVisible();
  await goalDetail.getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(goalDetail).toHaveCount(0);
  await expect(graphDialog.getByRole('button', { name: 'Close dependency graph', exact: true })).toBeFocused();
  await details.click(); await expect(goalDetail).toBeVisible();
  await goalDetail.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = goalDetail.locator('.thread-composer textarea');
  await draft.fill('Goal graph header reading draft');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(draft).toHaveValue('Goal graph header reading draft');
  await goalDetail.getByRole('button', { name: 'Close task details', exact: true }).click();
  await confirm.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(goalDetail).toHaveCount(0); await expect(details).toBeFocused();
  await expect(graphDialog).toBeVisible();
  expect(fixture.statusWrites()).toEqual([]); expect(fixture.edits()).toEqual([]);
});

test('linked Goal graph keeps its URL through Back and Forward and protects nested drafts', async ({ page }) => {
  const fixture = await install(page);
  const writes: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/') && !['GET', 'HEAD'].includes(request.method())) writes.push(request.method()); });
  await page.goto(`/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
  const graphDialog = page.locator(`#task-graph-${goalId}`);
  await expect(graphDialog).toBeVisible();
  const target = new URL(page.url()).pathname + new URL(page.url()).search;
  expect(target).toBe(`/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
  await graphDialog.getByRole('button', { name: 'Goal details', exact: true }).click();
  const detail = page.locator('.goal-detail-surface');
  await detail.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = detail.locator('.thread-composer textarea');
  await draft.fill('Linked graph draft');
  await page.goBack();
  await expect(detail.getByRole('tab', { name: 'Description', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await detail.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(draft).toHaveValue('Linked graph draft');
  await page.goBack();
  await page.goBack();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(detail).toHaveCount(0);
  await expect(graphDialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`goalGraph=${goalId}$`));
  await page.goForward();
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`goalGraph=${goalId}$`));
  await page.goBack();
  await expect(detail).toHaveCount(0);
  await graphDialog.getByRole('button', { name: 'Close dependency graph', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=tasks$`));
  await page.reload();
  await expect(graphDialog).toHaveCount(0);
  expect(fixture.statusWrites()).toEqual([]); expect(fixture.edits()).toEqual([]); expect(writes).toEqual([]);
});

for (const [kind, leave] of [['revocation', false], ['revocation', true], ['history replacement', true]] as const) test(`${kind} ${leave ? 'preserves an arrived Back destination' : 'clears the linked Goal on its original entry'}`, async ({ page }) => {
  const fixture = await install(page);
  await page.goto('/projects');
  await page.evaluate(({ projectId, goalId }) => window.openGoalGraphAddress(projectId, goalId), { projectId, goalId });
  const graphDialog = page.locator(`#task-graph-${goalId}`);
  await expect(graphDialog).toBeVisible();
  await graphDialog.getByRole('button', { name: 'Goal details', exact: true }).click();
  const detail = page.locator('.goal-detail-surface');
  await detail.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await detail.locator('.thread-composer textarea').fill('Private draft');
  if (kind === 'revocation') fixture.holdDeniedSync();
  else fixture.holdLatestSync();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(fixture.syncHeld).toBe(true);
  if (leave) {
    await page.evaluate(() => history.go(-3));
    await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  }
  if (kind === 'history replacement') { fixture.retireGoal(); fixture.advanceEpoch(); }
  fixture.releaseSync();
  await expect.poll(fixture.heldSyncFinished).toBe(true);
  await expect(page).toHaveURL(leave ? /\/projects$/ : new RegExp(`/projects/${projectId}\\?tab=tasks$`));
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0);
  await expect(page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toHaveCount(0);
});

test('revocation clears a linked Goal in its original unindexed native entry', async ({ page }) => {
  const fixture = await install(page);
  await page.goto('/projects');
  await page.evaluate(({ projectId, goalId }) => window.openNativeGoalGraphAddress(projectId, goalId), { projectId, goalId });
  await expect(page.locator(`#task-graph-${goalId}`)).toBeVisible();
  expect(await page.evaluate(() => history.state)).toEqual({ nativeMarker: 'retained' });
  fixture.holdDeniedSync();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(fixture.syncHeld).toBe(true);
  fixture.releaseSync();
  await expect.poll(fixture.heldSyncFinished).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=tasks$`));
  expect(await page.evaluate(() => history.state)).toEqual({ nativeMarker: 'retained' });
});

test('Empty Goal opens a graph without manufacturing nodes or a loading failure', async ({ page }) => {
  const fixture = await install(page); fixture.emptyGoal();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-graph-${goalId}`).click();
  const dialog = page.locator(`#task-graph-${goalId}`);
  await expect(dialog).toContainText(/no tasks/i);
  await expect(dialog.locator('.task-node')).toHaveCount(0);
  await expect(dialog.locator('[role="alert"]')).toHaveCount(0);
  const details = dialog.getByRole('button', { name: 'Goal details', exact: true });
  await details.click();
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  await page.keyboard.press('Escape');
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0); await expect(details).toBeFocused();
  await expect(dialog.locator('.task-node')).toHaveCount(0);
});


test('Goal graph preserves viewport on refresh and reports background failure while retaining content', async ({ page }) => {
  const fixture = await install(page); fixture.addExternalGoalChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-graph-${goalId}`).click();
  const dialog = page.locator(`#task-graph-${goalId}`);
  const viewport = dialog.locator('.react-flow__viewport');
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const transform = await viewport.getAttribute('style');
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().includes('/task-sync'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await response;
  };
  await refresh();
  await expect(viewport).toHaveAttribute('style', transform!);
  fixture.setMixedChildren(); await refresh();
  await expect(dialog.locator(`[data-id="${singleId}"] .task-node`)).toHaveAttribute('data-task-status', 'cancelled');
  await expect(viewport).toHaveAttribute('style', transform!);
  fixture.moveOtherTaskToGoal(); await refresh();
  await expect(dialog.locator(`[data-id="${otherTaskId}"] .task-node`)).not.toHaveClass(/task-node-external/);
  await expect(dialog.locator('.task-node')).toHaveCount(4);
  fixture.failNextSync(); await refresh();
  const error = dialog.locator('[role="alert"]');
  await expect(error).toBeVisible();
  await expect(dialog.locator('.task-node')).toHaveCount(4);
  const details = dialog.getByRole('button', { name: 'Goal details', exact: true });
  await details.click();
  await expect(page.locator('.goal-detail-surface .task-detail-title')).toHaveText('Goal reading');
  await page.keyboard.press('Escape');
  await expect(page.locator('.goal-detail-surface')).toHaveCount(0); await expect(details).toBeFocused();
  await expect(viewport).toHaveAttribute('style', transform!);
  await expect(error).toBeVisible();
  await error.getByRole('button').click();
  await expect(error).toHaveCount(0);
  await expect(dialog.locator('.task-node')).toHaveCount(4);
});

test('Goal graph history and direction remain independent of other Goals and chains', async ({ page }) => {
  const fixture = await install(page); fixture.addExternalGoalChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const firstOpener = page.locator(`#project-goal-graph-${goalId}`);
  const firstDialog = page.locator(`#task-graph-${goalId}`);
  await firstOpener.click();
  await firstDialog.locator('[data-direction="vertical"]').click();
  await page.goBack(); await expect(firstDialog).toHaveCount(0);
  await page.goForward(); await expect(firstDialog).toBeVisible();
  await expect(firstDialog.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape'); await expect(firstOpener).toBeFocused();
  await page.locator(`#project-goal-graph-${otherGoalId}`).click();
  const secondDialog = page.locator(`#task-graph-${otherGoalId}`);
  await expect(secondDialog.locator('[data-direction="horizontal"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.locator(`#project-goal-detail-${goalId}`).click();
  const sourceGoal = page.getByRole('dialog', { name: 'Goal reading' });
  await restoreGoalGraph(page, sourceGoal);
  const chainDialog = page.locator('.task-chain-dialog');
  await expect(chainDialog.locator('[data-direction="horizontal"]')).toHaveAttribute('aria-checked', 'true');
  await expect(chainDialog.getByRole('button', { name: 'Goal details', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await sourceGoal.getByRole('button', { name: 'Close task details' }).click();
  await firstOpener.click();
  await expect(firstDialog.locator('[data-direction="vertical"]')).toHaveAttribute('aria-checked', 'true');
});

test('Goal overview retires an invalidated Goal and cancels its old sync', async ({ page }) => {
  const fixture = await install(page); fixture.addExternalGoalChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-graph-${goalId}`).click();
  const dialog = page.locator(`#task-graph-${goalId}`);
  await expect(dialog.locator('.task-node')).toHaveCount(4);
  let heldRequest: Request | null = null;
  const requestOutcome = new Promise<'finished' | 'failed'>((resolve) => {
    page.on('request', request => { if (heldRequest === null && request.url().includes('/task-sync')) heldRequest = request; });
    page.on('requestfinished', request => { if (request === heldRequest) resolve('finished'); });
    page.on('requestfailed', request => { if (request === heldRequest) resolve('failed'); });
  });
  fixture.holdNextSync();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(fixture.syncHeld).toBe(true);
  fixture.advanceEpoch(); fixture.retireGoal();
  await dialog.locator(`[data-id="${firstId}"] .task-node-details`).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[data-goal-id="${goalId}"]`)).toHaveCount(0);
  fixture.releaseSync();
  await expect.poll(fixture.heldSyncFinished).toBe(true);
  expect(await requestOutcome).toBe('failed');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[data-goal-id="${goalId}"]`)).toHaveCount(0);
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal description card in page and dialog at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale);
  const code = 'x'.repeat(400);
  fixture.setGoalDescription(`# Reading\n\n- Item\n\n[Read notes](notes.txt)\n\n\`\`\`\n${code}\n\`\`\`\n\n| Column | Wide |\n| --- | --- |\n| Value | ${code} |\n\n\`\`\`mermaid\nflowchart LR\nA[Start] --> B[Middle] --> C[Review] --> D[Finish]\n\`\`\``);
  const check = async (surface: Locator) => {
    const card = surface.locator('.description-card');
    await expectDescriptionCard(page, card, width);
    await expect(card.getByRole('heading', { name: 'Reading' })).toBeVisible();
    await expect(card.getByText('Item', { exact: true })).toBeVisible();
    await expect(card.locator('.mermaid-diagram img')).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
    if (width === 320) for (const item of [card.locator('pre').first(), card.locator('.markdown-table'), card.locator('.mermaid-diagram')]) expect(await item.evaluate(element => { element.scrollLeft = 30; return element.scrollLeft; })).toBeGreaterThan(0);
  };
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const surface = page.locator('.goal-detail-surface');
  await check(surface);
  await surface.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
  await check(surface);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  await check(surface);
  await surface.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
  await check(surface);
  const link = surface.getByRole('link', { name: 'Read notes' });
  await link.focus(); await expect(link).toBeFocused(); await page.keyboard.press('Enter');
  await expect(surface.getByRole('tab', { name: locale === 'en' ? 'Attachments' : '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(surface.locator('.attachment-file-selected')).toContainText('notes.txt');
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Task description card in dialog at ${width}px in ${locale}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const fixture = await install(page, locale);
  const code = 'x'.repeat(400);
  fixture.setTaskDescription(`# Task reading\n\n- Item\n\n[Read notes](notes.txt)\n\n\`\`\`\n${code}\n\`\`\`\n\n| Column | Wide |\n| --- | --- |\n| Value | ${code} |\n\n\`\`\`mermaid\nflowchart LR\nA[Start] --> B[Middle] --> C[Review] --> D[Finish]\n\`\`\``);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`[data-goal-id="${goalId}"] .goal-list-toggle`).click();
  await page.locator(`#chain-task-goal-${goalId}-${singleId}`).click();
  const dialog = page.locator('.task-detail-dialog:not(.goal-detail-surface)');
  const check = async () => {
    await expectDescriptionCard(page, dialog.locator('.description-card'), width);
    await expect(dialog.getByRole('heading', { name: 'Task reading' })).toBeVisible();
    await expect(dialog.locator('.description-card .mermaid-diagram img')).toHaveAttribute('src', /^blob:/, { timeout: 45_000 });
    if (width === 320) for (const item of [dialog.locator('.description-card pre').first(), dialog.locator('.description-card .markdown-table'), dialog.locator('.description-card .mermaid-diagram')]) expect(await item.evaluate(element => { element.scrollLeft = 30; return element.scrollLeft; })).toBeGreaterThan(0);
  };
  await check();
  await dialog.getByRole('button', { name: locale === 'en' ? 'Enter fullscreen' : '进入全屏' }).click();
  await check();
  const link = dialog.getByRole('link', { name: 'Read notes' });
  await link.focus(); await page.keyboard.press('Enter');
  await expect(dialog.getByRole('tab', { name: locale === 'en' ? 'Attachments' : '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('.attachment-file-selected')).toContainText('notes.txt');
});

for (const width of [1440, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal link copies from each reading surface at ${width}px in ${locale}`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: 800 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page, locale);
  fixture.setGoalTitle('Long Goal 标题 '.repeat(12));
  const zh = locale === 'zh-CN';
  const target = () => `${new URL(page.url()).origin}/projects/${projectId}/tasks/${goalId}`;
  const surface = page.locator('.goal-detail-surface');
  const more = () => surface.getByRole('button', { name: zh ? '更多 Goal 操作' : 'More Goal actions' });
  const copy = () => surface.getByRole('menuitem', { name: zh ? '复制链接' : 'Copy link' });
  const check = async (tab: string) => {
    await surface.getByRole('tab', { name: tab, exact: true }).click();
    await more().focus(); await page.keyboard.press('ArrowDown');
    await expect(copy()).toBeFocused();
    await page.keyboard.press('End'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowUp');
    await expect(copy()).toBeFocused();
    await page.keyboard.press('Escape'); await expect(more()).toBeFocused();
    await expect(surface).toBeVisible();
    await more().click(); await copy().click();
    await expect(more()).toBeFocused();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target());
    await expect(surface.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(surface.locator('.task-detail-notifications').getByRole('status')).toHaveText(zh ? '已复制链接' : 'Link copied');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  };
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: zh ? '任务列表' : 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  await check(zh ? '附件' : 'Attachments');
  await surface.getByRole('button', { name: zh ? '进入全屏' : 'Enter fullscreen' }).click();
  await surface.getByRole('tab', { name: zh ? '讨论' : 'Discussion', exact: true }).click();
  const draft = surface.locator('.thread-composer textarea');
  await draft.fill('Retained Goal draft');
  await check(zh ? '讨论' : 'Discussion');
  await expect(draft).toHaveValue('Retained Goal draft');
  await page.goto(`/projects/${projectId}/tasks/${goalId}?tab=discussion`);
  await check(zh ? '讨论' : 'Discussion');
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
  await more().click(); await copy().click();
  await expect(surface.locator('.task-detail-notifications').getByRole('alert')).toHaveText(zh ? '无法复制链接，请重试。' : 'Could not copy the link. Try again.');
  await page.evaluate(() => { delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText; });
  await more().click(); await copy().click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target());
  const recipient = await context.newPage();
  await install(recipient, locale);
  await recipient.goto(target());
  await expect(recipient.locator('.goal-detail-surface').getByRole('tab', { name: zh ? '描述' : 'Description', exact: true })).toHaveAttribute('aria-selected', 'true');
  await recipient.close();
  expect(fixture.edits()).toEqual([]); expect(fixture.statusWrites()).toEqual([]);
});


test('touch copies an empty terminal Goal', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4209', viewport: { width: 320, height: 800 }, hasTouch: true });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const page = await context.newPage();
    const fixture = await install(page); fixture.emptyGoal(); fixture.setGoalStatusFixture('done', false);
    await page.goto(`/projects/${projectId}/tasks/${goalId}`);
    const surface = page.locator('.goal-detail-surface');
    await surface.getByRole('button', { name: 'More Goal actions' }).tap();
    await surface.getByRole('menuitem', { name: 'Copy link' }).tap();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:4209/projects/${projectId}/tasks/${goalId}`);
    await expect(surface.locator('.task-detail-notifications').getByRole('status')).toHaveText('Link copied');
  } finally { await context.close(); }
});

test('shares the ordinary chain inside a Goal using its readable member', async ({ page, context }) => {
  const state = await install(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  await restoreGoalGraph(page, page.locator('.goal-detail-surface'));
  const graphDialog = page.locator('.task-chain-dialog');
  await graphDialog.getByRole('button', { name: 'More task chain actions' }).click();
  await graphDialog.getByRole('menuitem', { name: 'Copy link' }).click();
  const target = `${new URL(page.url()).origin}/projects/${projectId}?tab=tasks&chain=${firstId}`;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(target);
  await expect(graphDialog).toBeVisible();
  await page.goto(target);
  await expect(page.locator('.task-chain-dialog .react-flow__node')).toHaveCount(2);
  await expect(page).toHaveURL(`${new URL(target).origin}/projects/${projectId}?tab=tasks`);
  expect(state.statusWrites()).toEqual([]); expect(state.edits()).toEqual([]);
});

test('Goal graph copy retries and retires pending and settled results across A to B to A', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page); fixture.addExternalGoalChain();
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  const open = async (id: string) => { await page.locator(`#project-goal-graph-${id}`).click(); await expect(page.locator(`#task-graph-${id}`)).toBeVisible(); };
  const close = async () => { await page.keyboard.press('Escape'); await expect(page.locator('.task-chain-dialog')).toHaveCount(0); };
  const graph = (id: string) => page.locator(`#task-graph-${id}`);
  const copy = (id: string) => graph(id).getByRole('button', { name: 'Copy link', exact: true });
  await open(goalId);
  await page.evaluate(() => {
    const state = window as typeof window & { releaseCopy?: () => void; writes?: number };
    state.writes = 0;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => { state.writes!++; return new Promise<void>(resolve => { state.releaseCopy = resolve; }); } });
  });
  await copy(goalId).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  await expect(copy(goalId)).toHaveAttribute('aria-disabled', 'true'); await expect(copy(goalId)).toBeFocused();
  expect(await page.evaluate(() => (window as typeof window & { writes: number }).writes)).toBe(1);
  await close(); await open(otherGoalId); await close(); await open(goalId);
  await page.evaluate(() => (window as typeof window & { releaseCopy: () => void }).releaseCopy());
  await expect(copy(goalId)).toHaveText('Copy link'); await expect(copy(goalId)).not.toHaveAttribute('aria-disabled', 'true');
  await page.evaluate(() => { delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText; });
  await copy(goalId).click(); await expect(copy(goalId)).toHaveText('Copied');
  await close(); await open(otherGoalId); await close(); await open(goalId);
  await expect(copy(goalId)).toHaveText('Copy link');
  await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) }); });
  const canvas = graph(goalId).locator('.task-graph-canvas'); const before = await canvas.boundingBox();
  await copy(goalId).click();
  await expect(graph(goalId).getByRole('alert')).toHaveText('Could not copy the link. Try again.');
  await expect(copy(goalId)).toBeFocused(); expect(await canvas.boundingBox()).toEqual(before);
  await page.evaluate(() => { delete (navigator.clipboard as unknown as { writeText?: unknown }).writeText; });
  await copy(goalId).click(); await expect(copy(goalId)).toHaveText('Copied');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:4209/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
});

test('readable empty Goal graph copies its link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const fixture = await install(page); fixture.emptyGoal();
  await page.goto(`/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
  const dialog = page.locator(`#task-graph-${goalId}`);
  await expect(dialog).toBeVisible(); await expect(dialog.locator('.task-node')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:4209/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
  expect(fixture.edits()).toEqual([]); expect(fixture.statusWrites()).toEqual([]);
});

test('Goal graph account refresh notice stays reachable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await install(page);
  await page.goto(`/projects/${projectId}?tab=tasks&goalGraph=${goalId}`);
  const dialog = page.locator(`#task-graph-${goalId}`); await expect(dialog).toBeVisible();
  await page.evaluate(() => { localStorage.setItem('daynight.activeUser', JSON.stringify('00000000-0000-4000-8000-000000000999')); window.dispatchEvent(new Event('focus')); });
  const notice = dialog.locator('.account-refresh-notice');
  await expect(notice.getByText('Account changed', { exact: true })).toBeVisible();
  await expect(notice.getByRole('button', { name: 'Refresh page' })).toBeVisible();
  const fits = await notice.evaluate(element => {
    const noticeBox = element.getBoundingClientRect(), header = element.parentElement!.getBoundingClientRect();
    return noticeBox.left >= header.left && noticeBox.right <= header.right && element.scrollWidth <= element.clientWidth;
  });
  expect(fits).toBe(true);
});

test('Goal tag editor keeps content sizes and touch input minimums', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.goto(`/projects/${projectId}/tasks/${goalId}`);
  const aside = page.locator('.goal-information');
  const edit = aside.getByRole('button', { name: 'Edit tags' });
  await edit.click();
  const picker = aside.locator('.tag-picker');
  for (const root of [12, 16, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
    await expect(picker.locator('label').first()).toHaveCSS('font-size', `${root * 0.75}px`);
    await expect(aside.locator('.tag-picker-actions .button').last()).toHaveCSS('font-size', `${root * 0.75}px`);
    for (const selector of ['input[type=search]', '.tag-picker-create input', '.tag-color-custom input[type=text]']) {
      await expect(picker.locator(selector)).toHaveCSS('font-size', `${Math.max(root, 16)}px`);
    }
  }
  await picker.locator('input[type=search]').fill('search');
  await page.keyboard.press('Escape');
  await expect(edit).toBeFocused();
  await expect(picker).toHaveCount(0);
});
