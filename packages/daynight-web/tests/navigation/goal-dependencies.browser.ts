import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000100';
const externalProjectId = '00000000-0000-4000-8000-000000000101';
const goalId = '00000000-0000-4000-8000-000000000300';
const prerequisiteId = '00000000-0000-4000-8000-000000000301';
const localGoalId = '00000000-0000-4000-8000-000000000302';
const successorId = '00000000-0000-4000-8000-000000000303';
const secondSuccessorId = '00000000-0000-4000-8000-000000000304';
const sourceChildId = '00000000-0000-4000-8000-000000000305';
const otherChildId = '00000000-0000-4000-8000-000000000306';
const teamId = '00000000-0000-4000-8000-000000000701';
const edgeId = '00000000-0000-4000-8000-000000000801';
const localEdgeId = '00000000-0000-4000-8000-000000000802';
const time = '2026-10-22T10:00:00Z';
const externalTitle = 'Upgrade authentication / 升级身份验证 ' + 'Release acceptance criteria '.repeat(5);
const sourceUrl = `/projects/${projectId}/tasks/${goalId}`;
const dependencyUrl = `/api/v1/projects/${projectId}/tasks/${goalId}/goal-dependencies`;
const panel = (page: Page) => page.locator('.goal-information .goal-dependencies');

const target = (id: string, title: string, external = false, status = 'todo') => ({
  projectId: external ? externalProjectId : projectId, projectName: external ? 'Identity / 身份服务' : 'Client', goalId: id, title, status, kind: external ? 'external' : 'internal',
});
const relationships = (cursor: string | null = null) => ({
  goalId, canEdit: true, revision: '9007199254740993', completionBlocked: true,
  prerequisites: [{ edgeId, target: target(prerequisiteId, externalTitle, true, 'in_progress') }, { edgeId: localEdgeId, target: target(localGoalId, 'Acceptance criteria', false, 'done') }] as { edgeId: string; target: ReturnType<typeof target> | null }[],
  successors: [target(cursor === null ? successorId : secondSuccessorId, cursor === null ? 'Staged rollout' : 'Second rollout')],
  nextCursor: cursor === null ? 'second-page' : null,
});
type Mode = 'ready' | 'failure' | 'old-router' | 'forbidden';

const install = async (page: Page, locale: 'en' | 'zh-CN' = 'en', crossGoal = false) => {
  const source = detailFixture(projectId, goalId, { type: 'goal', title: 'Release the new client', status: 'in_progress', startedAt: time, ready: false, description: 'Deliver the client after authentication acceptance.' });
  const local = detailFixture(projectId, localGoalId, { type: 'goal', title: 'Acceptance criteria', status: 'done', completedAt: time, ready: false });
  const external = detailFixture(externalProjectId, prerequisiteId, { type: 'goal', title: externalTitle, status: 'in_progress', startedAt: time, ready: false, description: 'Authentication upgrade details.' });
  const firstSuccessor = detailFixture(projectId, successorId, { type: 'goal', title: 'Staged rollout', ready: false });
  const secondSuccessor = detailFixture(projectId, secondSuccessorId, { type: 'goal', title: 'Second rollout', ready: false });
  const children = crossGoal ? [
    detailFixture(projectId, sourceChildId, { parentId: goalId, title: 'Client child' }),
    detailFixture(projectId, otherChildId, { parentId: localGoalId, title: 'Acceptance child', dependsOn: [sourceChildId], blockedBy: [sourceChildId], ready: false }),
  ] : [];
  const graphs = [graphFixture([source, local, firstSuccessor, secondSuccessor, ...children]), graphFixture([external])];
  const details = [source, local, external, firstSuccessor, secondSuccessor, ...children];
  let mode: Mode = 'ready';
  const revokedProjects = new Set<string>();
  let hidden = false;
  let reads = 0;
  let writes = 0;
  let holdNext = false;
  let release: (() => void) | null = null;
  const cursors: (string | null)[] = [];
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, principal = true, headers: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', ...(principal ? { 'Daynight-User-ID': TEST_VIEWER_ID } : {}), ...headers } });
    const fail = (status: number, code: string, principal = true) => send({ error: { code, message: 'Unavailable', requestId: goalId } }, status, principal);
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: teamId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: graphs.map(graph => graph.project), nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ id: teamId, kind: 'personal', name: null, version: 1n, createdAt: time, updatedAt: time, membership: { teamId, userId: TEST_VIEWER_ID, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === dependencyUrl) {
      reads++;
      const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
      if (mode === 'old-router') return fail(404, 'not_found', false);
      if (mode === 'failure') return fail(503, 'unavailable');
      if (mode === 'forbidden') return fail(403, 'forbidden');
      const data = relationships(cursor);
      if (hidden) data.prerequisites = [{ edgeId, target: null }];
      if (holdNext) {
        holdNext = false;
        await new Promise<void>(resolve => { release = resolve; }); release = null;
      }
      return send(data);
    }
    if (crossGoal && path === `/api/v1/projects/${projectId}/tasks/${localGoalId}/goal-dependencies`) {
      const laterPage = url.searchParams.has('cursor');
      return send({ goalId: localGoalId, canEdit: false, completionBlocked: false, prerequisites: [], successors: [laterPage ? target(goalId, source.title) : target(successorId, firstSuccessor.title)], nextCursor: laterPage ? null : 'dialog-second-page' });
    }
    if (path.endsWith('/goal-dependencies')) return send({ goalId: path.split('/').at(-2), canEdit: false, completionBlocked: false, prerequisites: [], successors: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}/status`) {
      writes++;
      return fail(409, 'goal_dependency_unsatisfied');
    }
    for (const graph of graphs) {
      const base = `/api/v1/projects/${graph.project.id}`;
      if (revokedProjects.has(graph.project.id) && [base, `${base}/access`, `${base}/task-sync`].includes(path)) return fail(404, 'not_found');
      if (path === base) return send(graph.project);
      if (path === `${base}/access`) return send(directAccessFixture(graph.project.id));
      if (path === `${base}/tags`) return send({ items: [], catalogEpoch: taskSyncEpoch(graph.project.id), nextCursor: null });
      if (path === `${base}/task-assignees`) return send({ items: [], unresolvedUserIds: [] });
      if (path === `${base}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: task => details.find(detail => detail.id === task.id)!.version, propertiesForTask: task => details.find(detail => detail.id === task.id)!.properties, tagsForTask: task => details.find(detail => detail.id === task.id)!.tags }));
    }
    const detail = details.find(detail => path === `/api/v1/projects/${detail.projectId}/tasks/${detail.id}`);
    if (detail !== undefined) return revokedProjects.has(detail.projectId) ? fail(404, 'not_found') : send(detail, 200, true, { 'Daynight-Task-Epoch': taskSyncEpoch(detail.projectId) });
    if (path.endsWith('/steps')) {
      const taskId = path.split('/').at(-2)!;
      return send({ projectId, taskId, version: details.find(item => item.id === taskId)!.version, steps: [] });
    }
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
    return fail(404, 'not_found');
  });
  return {
    mode: (value: Mode) => { mode = value; }, hidden: () => { hidden = true; }, reads: () => reads, writes: () => writes, cursors: () => cursors,
    holdNext: () => { holdNext = true; }, held: () => release !== null, release: () => release?.(),
    revoke: () => { revokedProjects.add(projectId); }, revokeExternal: () => { revokedProjects.add(externalProjectId); },
  };
};

const refresh = async (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1440, 390, 320]) {
  test(`Goal dependencies preserve the information-column layout at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await install(page, locale);
    await page.goto(sourceUrl);
    const dependencies = panel(page);
    await expect(dependencies.getByRole('link', { name: externalTitle, exact: true })).toBeVisible();
    await expect(dependencies).toContainText(locale === 'en' ? 'External' : '外部');
    await expect(dependencies).toContainText(locale === 'en' ? 'Same project' : '项目内');
    await expect(dependencies).toContainText(locale === 'en' ? 'Completion blocked' : '完成受阻');
    await expect(dependencies).toContainText(locale === 'en' ? 'In progress' : '进行中');
    await expect(dependencies).toContainText(locale === 'en' ? 'Done' : '已完成');
    const geometry = await dependencies.evaluate(element => {
      const aside = element.closest('.goal-information')!;
      const body = document.querySelector('.goal-detail-description-body')!;
      const a = aside.getBoundingClientRect(), b = body.getBoundingClientRect();
      return { first: aside.firstElementChild === element, stacked: a.top >= b.bottom - 1, right: a.left >= b.right - 1, overflow: document.documentElement.scrollWidth > innerWidth, fits: element.scrollWidth <= element.clientWidth };
    });
    expect(geometry).toEqual({ first: true, stacked: width < 741, right: width >= 741, overflow: false, fits: true });
    const link = dependencies.getByRole('link', { name: externalTitle, exact: true });
    await link.focus(); await expect(link).toBeFocused();
    expect(await link.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await page.screenshot({ path: test.info().outputPath(`dependencies-${locale}-${width}.png`), fullPage: true });
  });
}

test('dependency links use the real Project and Goal, protect drafts, and restore keyboard focus on return', async ({ page }) => {
  await install(page);
  await page.goto(sourceUrl);
  const surface = page.locator('.goal-detail-surface');
  await surface.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = surface.locator('.thread-composer textarea');
  await draft.fill('Retain the acceptance discussion draft');
  await surface.getByRole('tab', { name: 'Description', exact: true }).click();
  const link = panel(page).getByRole('link', { name: externalTitle, exact: true });
  await expect(link).toHaveAttribute('href', new RegExp(`/projects/${externalProjectId}/tasks/${prerequisiteId}`));
  await link.focus(); await page.keyboard.press('Enter');
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(new RegExp(sourceUrl));
  await surface.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(draft).toHaveValue('Retain the acceptance discussion draft');
  await surface.getByRole('tab', { name: 'Description', exact: true }).click();
  await link.click();
  await confirmation.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${externalProjectId}/tasks/${prerequisiteId}`));
  await expect(surface.locator('.task-detail-title')).toHaveText(externalTitle);
  await page.goBack();
  await expect(link).toBeFocused();
});

test('relationship pagination reads the selected cursor and returns to the preceding page', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  const dependencies = panel(page);
  await expect(dependencies.getByRole('link', { name: 'Staged rollout', exact: true })).toBeVisible();
  await expect(dependencies.getByRole('button', { name: /Next/ })).toHaveCSS('font-size', '12px');
  await dependencies.getByRole('button', { name: /Next/ }).click();
  await expect(dependencies.getByRole('link', { name: 'Second rollout', exact: true })).toBeVisible();
  await expect(dependencies.getByRole('link', { name: 'Staged rollout', exact: true })).toHaveCount(0);
  await dependencies.getByRole('button', { name: /Previous/ }).click();
  await expect(dependencies.getByRole('link', { name: 'Staged rollout', exact: true })).toBeVisible();
  expect(fixture.cursors()).toEqual([null, 'second-page', null]);
});

for (const failedReturn of [false, true]) test(`returning from a later-page dependent Goal restores cursor and link focus${failedReturn ? ' after retrying the return read' : ''}`, async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  const origin = panel(page).getByRole('link', { name: 'Second rollout', exact: true });
  await expect(origin).toBeVisible();
  await expect(origin).toHaveAttribute('href', new RegExp(`/projects/${projectId}/tasks/${secondSuccessorId}`));
  await origin.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${secondSuccessorId}`));
  await expect(page.locator('.task-detail-title')).toHaveText('Second rollout');
  if (failedReturn) fixture.mode('failure');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(sourceUrl));
  if (failedReturn) {
    await expect(panel(page).getByRole('alert')).toContainText('Could not load');
    await expect(origin).toHaveCount(0);
    expect(fixture.cursors().at(-1)).toBe('second-page');
    fixture.mode('ready');
    await panel(page).getByRole('button', { name: 'Retry', exact: true }).click();
  }
  await expect(origin).toBeVisible();
  await expect(origin).toBeFocused();
  await expect(panel(page).getByRole('link', { name: 'Staged rollout', exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
  await expect(panel(page).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  expect(fixture.cursors().at(-1)).toBe('second-page');
  await page.screenshot({ path: test.info().outputPath('later-page-return.png'), fullPage: true });
  fixture.mode('failure'); await refresh(page);
  await expect(panel(page).getByRole('alert')).toContainText('Could not refresh');
  await expect(origin).toBeVisible(); await expect(origin).toBeFocused();
  fixture.mode('ready');
  await panel(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(origin).toBeVisible();
  expect(fixture.cursors().at(-1)).toBe('second-page');
});

test('repeated browser Back and Forward retain the later-page dependent Goal and its link focus', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  const origin = panel(page).getByRole('link', { name: 'Second rollout', exact: true });
  await expect(origin).toBeVisible();
  await origin.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${secondSuccessorId}`));
  await expect(page.locator('.task-detail-title')).toHaveText('Second rollout');
  for (let cycle = 0; cycle < 3; cycle++) {
    fixture.holdNext();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(sourceUrl));
    await expect.poll(fixture.held).toBe(true);
    await expect(panel(page).getByRole('status')).toBeVisible();
    await expect(origin).toHaveCount(0);
    expect(fixture.cursors().at(-1)).toBe('second-page');
    fixture.release();
    await expect(origin).toBeVisible(); await expect(origin).toBeFocused();
    await expect(panel(page).getByRole('link', { name: 'Staged rollout', exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
    await expect(panel(page).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    if (cycle === 2) break;
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${secondSuccessorId}`));
    await expect(page.locator('.task-detail-title')).toHaveText('Second rollout');
  }
  await page.screenshot({ path: test.info().outputPath('later-page-repeated-history.png'), fullPage: true });
});

test('pagination after a return updates the source entry restored by later Forward and Back', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  const origin = panel(page).getByRole('link', { name: 'Second rollout', exact: true });
  await origin.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${secondSuccessorId}`));
  await expect(page.locator('.task-detail-title')).toHaveText('Second rollout');
  await page.goBack();
  await expect(origin).toBeFocused();
  await panel(page).getByRole('button', { name: 'Previous', exact: true }).click();
  const firstPage = panel(page).getByRole('link', { name: 'Staged rollout', exact: true });
  await expect(firstPage).toBeVisible(); await expect(origin).toHaveCount(0);
  expect(fixture.cursors().at(-1)).toBeNull();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/tasks/${secondSuccessorId}`));
  await expect(page.locator('.task-detail-title')).toHaveText('Second rollout');
  fixture.holdNext();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(sourceUrl));
  await expect.poll(fixture.held).toBe(true);
  await expect(panel(page).getByRole('status')).toBeVisible();
  await expect(firstPage).toHaveCount(0); await expect(origin).toHaveCount(0);
  expect(fixture.cursors().at(-1)).toBeNull();
  fixture.release();
  await expect(firstPage).toBeVisible(); await expect(origin).toHaveCount(0);
  await expect(page.locator('.task-detail-title')).toBeFocused();
  await expect(panel(page).getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
  await expect(panel(page).getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('updated-source-history-page.png'), fullPage: true });
});

test('known Description history entries restore their own dependency page while new tabs preserve continuity', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  const secondPage = panel(page).getByRole('link', { name: 'Second rollout', exact: true });
  await expect(secondPage).toBeVisible();
  const entryA = await page.evaluate(() => history.state.__daynightNavigation.entryId as string);
  await page.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await page.getByRole('tab', { name: 'Description', exact: true }).click();
  await expect(secondPage).toBeVisible();
  expect(await page.evaluate(() => history.state.__daynightNavigation.entryId)).not.toBe(entryA);
  await panel(page).getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(panel(page).getByRole('link', { name: 'Staged rollout', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Discussion', exact: true })).toHaveAttribute('aria-selected', 'true');
  fixture.holdNext();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Description', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => history.state.__daynightNavigation.entryId)).toBe(entryA);
  await expect.poll(fixture.held).toBe(true);
  expect(fixture.cursors().at(-1)).toBe('second-page');
  fixture.release();
  await expect(secondPage).toBeVisible();
  await expect(panel(page).getByRole('link', { name: 'Staged rollout', exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
  await expect(panel(page).getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
});

test('a project-summary Goal dialog reads its own acceptance dependencies', async ({ page }) => {
  await install(page);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Task list', exact: true }).click();
  await page.getByRole('tab', { name: /^Goal/ }).click();
  await page.locator(`#project-goal-detail-${goalId}`).click();
  await expect(page.getByRole('dialog', { name: 'Release the new client', exact: true })).toBeVisible();
  await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toBeVisible();
});

test('an external Goal dialog dependency returns to its underlying Goal and Back restores the dialog page and focus', async ({ page }) => {
  await install(page, 'en', true);
  await page.goto(sourceUrl);
  const root = page.locator('.goal-detail-surface.task-detail-page');
  await expect(root.locator('.goal-information-counts').first()).toBeAttached();
  await root.getByRole('tab', { name: 'Attachments', exact: true }).click();
  await root.getByRole('tab', { name: 'Description', exact: true }).click();
  await page.evaluate(({ goalId, sourceChildId }) => window.selectGoalReading(goalId, { graphRootId: sourceChildId, task: null }), { goalId, sourceChildId });
  await page.locator('.task-chain-dialog').getByRole('button', { name: 'Acceptance child, Details', exact: true }).click();
  const external = page.getByRole('dialog', { name: 'Acceptance criteria', exact: true });
  await expect(external).toBeVisible();
  await page.getByRole('dialog', { name: 'Acceptance child', exact: true }).getByRole('button', { name: 'Close task details', exact: true }).click();
  await external.getByRole('tab', { name: 'Discussion', exact: true }).click();
  const draft = external.locator('.thread-composer textarea');
  await draft.fill('Retain the external Goal discussion draft');
  await external.getByRole('tab', { name: 'Description', exact: true }).click();
  const dependencies = external.locator('.goal-dependencies');
  await dependencies.getByRole('button', { name: 'Next', exact: true }).click();
  const origin = dependencies.getByRole('link', { name: 'Release the new client', exact: true });
  await expect(origin).toBeVisible();
  await origin.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(external).toBeVisible(); await expect(origin).toBeVisible();
  await external.getByRole('tab', { name: 'Discussion', exact: true }).click();
  await expect(draft).toHaveValue('Retain the external Goal discussion draft');
  await external.getByRole('tab', { name: 'Description', exact: true }).click();
  await expect(origin).toBeVisible();
  const sourceEntry = await page.evaluate(() => history.state.__daynightNavigation.entryId as string);
  await origin.click();
  await confirmation.getByRole('button', { name: 'Discard and leave', exact: true }).click();
  await expect(external).toHaveCount(0);
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${sourceUrl}\\?tab=description$`));
  await expect(root.locator('.task-detail-title')).toHaveText('Release the new client');
  expect(await page.evaluate(() => history.state.__daynightNavigation.entryId)).not.toBe(sourceEntry);
  await page.goBack();
  await expect(external).toBeVisible();
  expect(await page.evaluate(() => history.state.__daynightNavigation.entryId)).toBe(sourceEntry);
  await expect(origin).toBeVisible(); await expect(origin).toBeFocused();
  await expect(dependencies.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled();
  await expect(dependencies.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('external-dialog-return.png'), fullPage: true });
});

test('hidden description tabs stop relationship reads and resume on their original cursor', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await panel(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel(page).getByRole('link', { name: 'Second rollout', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const before = fixture.reads();
  await refresh(page);
  await expect(page.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(fixture.reads()).toBe(before);
  await page.getByRole('tab', { name: 'Description', exact: true }).click();
  await expect.poll(fixture.reads).toBeGreaterThan(before);
  expect(fixture.cursors().at(-1)).toBe('second-page');
  await expect(panel(page).getByRole('link', { name: 'Second rollout', exact: true })).toBeVisible();
});

test('first read, failure, retry and refresh failure retain the source and admitted relationship DOM', async ({ page }) => {
  const fixture = await install(page);
  fixture.holdNext();
  await page.goto(sourceUrl);
  await expect.poll(fixture.held).toBe(true);
  await expect(panel(page).getByRole('status')).toBeVisible();
  await expect(panel(page).getByRole('status')).toHaveCSS('font-size', '12px');
  await expect(page.locator('.goal-detail-description-body')).toContainText('Deliver the client');
  fixture.release();
  const link = panel(page).getByRole('link', { name: externalTitle, exact: true });
  await expect(link).toBeVisible();
  const original = await link.elementHandle();
  await link.focus();
  fixture.mode('failure'); await refresh(page);
  await expect(panel(page).getByRole('alert')).toContainText(/refresh/i);
  await expect(panel(page).getByRole('alert')).toHaveCSS('font-size', '12px');
  await expect(panel(page).getByRole('button', { name: 'Retry', exact: true })).toHaveCSS('font-size', '12px');
  await expect(link).toBeVisible(); await expect(link).toBeFocused();
  expect(await link.evaluate((element, previous) => element === previous, original)).toBe(true);
  fixture.mode('ready');
  await panel(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(link).toBeVisible();
});

test('a failed initial relationship read is recoverable without replacing Goal details', async ({ page }) => {
  const fixture = await install(page); fixture.mode('failure');
  await page.goto(sourceUrl);
  await expect(panel(page).getByRole('alert')).toBeVisible();
  await expect(page.locator('.task-detail-title')).toHaveText('Release the new client');
  await expect(panel(page).getByRole('link')).toHaveCount(0);
  fixture.mode('ready');
  await panel(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toBeVisible();
});

test('the actual legacy router JSON 404 without a principal leaves the Goal readable', async ({ page }) => {
  const fixture = await install(page); fixture.mode('old-router');
  await page.goto(sourceUrl);
  await expect(panel(page)).toContainText(/unavailable|not available|not support/i);
  await expect(page.locator('.task-detail-title')).toHaveText('Release the new client');
  await expect(page.locator('.goal-detail-description-body')).toContainText('Deliver the client');
  await expect(page.locator('.goal-detail-meta .task-status-trigger')).toBeEnabled();
});

test('hidden prerequisite projection withdraws its identity while preserving authoritative blocking', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toBeVisible();
  fixture.hidden(); await refresh(page);
  await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toHaveCount(0);
  await expect(panel(page)).toContainText(/cannot access|inaccessible/i);
  await expect(panel(page)).toContainText('Completion blocked');
  await expect(panel(page)).not.toContainText('Identity / 身份服务');
});

test('project revocation retires dependencies and a held response cannot republish their identities', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  const link = page.getByRole('link', { name: externalTitle, exact: true });
  await expect(link).toBeVisible();
  fixture.holdNext(); await refresh(page);
  await expect.poll(fixture.held).toBe(true);
  fixture.revoke();
  await refresh(page);
  await expect(link).toHaveCount(0);
  fixture.release();
  await expect(page.locator('.goal-dependencies')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(externalTitle);
});

test('peer revocation while Description is hidden remains withdrawn when its next relationship read fails', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const peer = await page.context().newPage();
  try {
    const external = await install(peer);
    await peer.goto(`/projects/${externalProjectId}/tasks/${prerequisiteId}`);
    await expect(peer.locator('.task-detail-title')).toHaveText(externalTitle);
    external.revokeExternal();
    await refresh(peer);
    await expect(peer.locator('.goal-detail-surface .goal-information')).toHaveCount(0);
    // Both tabs use the production cache's shared revocation transport.
    await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toHaveCount(0);
    fixture.mode('failure');
    await page.bringToFront();
    await page.getByRole('tab', { name: 'Description', exact: true }).click();
    await expect(panel(page).getByRole('alert')).toBeVisible();
    await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toHaveCount(0);
    await expect(panel(page)).not.toContainText('Identity / 身份服务');
  } finally { await peer.close(); }
});

test('a dependency refusal preserves Goal status and refreshes the independent relationship read', async ({ page }) => {
  const fixture = await install(page);
  await page.goto(sourceUrl);
  await expect(panel(page).getByRole('link', { name: externalTitle, exact: true })).toBeVisible();
  const before = fixture.reads();
  await page.locator('.goal-detail-meta .task-status-trigger').click();
  await page.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Complete this Goal?' }).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(fixture.writes).toBe(1);
  await expect.poll(fixture.reads).toBeGreaterThan(before);
  await expect(page.locator('.goal-detail-meta .task-status-trigger')).toContainText('In progress');
  await expect(panel(page)).toContainText(/cannot complete|could not complete|completion blocked|unfinished/i);
});
