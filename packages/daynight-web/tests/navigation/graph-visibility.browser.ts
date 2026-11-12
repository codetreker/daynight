import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, taskSyncEpoch, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { progressiveGraph } from '../helpers/graphData';

const projectId = progressiveGraph.project.id, personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-20T09:00:00Z';
const rootId = progressiveGraph.tasks.find(task => task.titlePreview === '渐进展开 · 主链交付起点')!.id;
const joinId = progressiveGraph.tasks.find(task => task.titlePreview === '合流任务 · 40 个外部前置')!.id;
async function install(page: Page) {
  const epoch = taskSyncEpoch(projectId);
  const state = { fail: false, tasks: progressiveGraph.tasks.map(task => detailFixture(projectId, task.id, {
    title: task.titlePreview, status: task.status, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn,
    blockedBy: task.blockedBy, ready: task.ready, createdAt: task.createdAt, updatedAt: task.updatedAt,
    startedAt: task.startedAt, completedAt: task.completedAt, cancelledAt: task.cancelledAt, version: 1n,
  })) };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, graph = graphFixture(state.tasks);
    const send = (body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...headers } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({
      items: [...new Set(state.tasks.flatMap(task => task.assignedTo === null ? [] : [task.assignedTo]))].map(userId => ({ userId, version: TEST_PROFILE_VERSION, name: 'Other assignee', avatarUrl: null, hasProjectAccess: true })), unresolvedUserIds: [],
    });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return state.fail ? send({ error: { code: 'internal_error', message: 'Fixture failure', requestId: 'graph-refresh' } }, 500) : send(taskSyncFixture(graph, { epoch, query: taskSyncQuery(url), versionForTask: task => state.tasks.find(item => item.id === task.id)!.version, propertiesForTask: task => state.tasks.find(item => item.id === task.id)!.properties }));
    const base = `/api/v1/projects/${projectId}/tasks/`;
    if (path.startsWith(base)) {
      const parts = path.slice(base.length).split('/'), detail = state.tasks.find(item => item.id === parts[0]);
      if (detail && parts.length === 1) return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
      if (detail && (parts[1] === 'sessions' || parts[1] === 'attachments')) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}
const visible = (page: Page) => page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort());

test('bounded graph expansion preserves focus and resets the visible set and viewport', async ({ page }) => {
  await install(page); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${rootId}`).click();
  const graph = page.locator('.task-graph'), viewport = page.locator('.react-flow__viewport');
  await expect(graph).toHaveAttribute('data-visible-task-count', '50');
  await expect(page.locator('.react-flow__node')).toHaveCount(50); await expect(page.locator('.react-flow__edge')).toHaveCount(49);
  const ids = await visible(page), transform = await viewport.getAttribute('style');
  const join = page.locator(`.react-flow__node[data-id="${joinId}"]`), body = join.locator('.task-node-body');
  const expand = join.locator('.task-node-expand[data-direction="prerequisites"]');
  await expect(expand).toHaveAttribute('data-added-tasks', '20'); await expect(expand).toHaveAttribute('data-added-edges', '20'); await expect(expand).toHaveAttribute('data-remaining', '20');
  await expand.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__node')).toHaveCount(70); await expect(page.locator('.react-flow__edge')).toHaveCount(69); await expect(body).toBeFocused();
  const root = page.locator(`.react-flow__node[data-id="${rootId}"]`), downstream = root.locator('.task-node-expand[data-direction="successors"]');
  await expect(downstream).toHaveAttribute('data-added-tasks', '11'); await expect(downstream).toHaveAttribute('data-added-edges', '11'); await expect(downstream).toHaveAttribute('data-remaining', '0');
  await downstream.click(); await expect(page.locator('.react-flow__node')).toHaveCount(81); await expect(page.locator('.react-flow__edge')).toHaveCount(80); await expect(root.locator('.task-node-body')).toBeFocused();
  await expand.focus(); await page.keyboard.press('Enter'); await expect(page.locator('.react-flow__node')).toHaveCount(101); await expect(page.locator('.react-flow__edge')).toHaveCount(100); await expect(body).toBeFocused();
  const reset = page.getByRole('button', { name: 'Reset overview', exact: true }); await reset.click();
  await expect(page.locator('.react-flow__node')).toHaveCount(50); await expect(page.locator('.react-flow__edge')).toHaveCount(49); await expect(reset).toBeFocused();
  expect(await visible(page)).toEqual(ids); await expect(viewport).toHaveAttribute('style', transform!);
});

test('expanded graph survives failed refresh and content updates without stealing detail focus', async ({ page }) => {
  // Keep the periodic refresh from racing this explicit failure and retry.
  await page.addInitScript(() => Reflect.set(globalThis, Symbol.for('daynight.pollingIntervals'), { taskSync: 300_000 }));
  const state = await install(page); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${rootId}`).click();
  const join = page.locator(`.react-flow__node[data-id="${joinId}"]`), body = join.locator('.task-node-body');
  await body.click(); await join.locator('.task-node-expand[data-direction="prerequisites"]').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(70); const ids = await visible(page);
  const viewport = page.locator('.react-flow__viewport'), transform = await viewport.getAttribute('style');
  await join.locator('.task-node-details').click(); const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.locator('.task-detail-title')).toHaveText('合流任务 · 40 个外部前置');
  const close = dialog.getByRole('button', { name: 'Close task details', exact: true }); await expect(close).toBeFocused();
  const refresh = page.locator('.project-title-actions>button'); state.fail = true;
  const failure = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 500);
  await refresh.evaluate((element: HTMLButtonElement) => element.click()); await failure;
  await expect(page.locator('.snapshot-error')).toContainText('graph-refresh'); await expect(close).toBeFocused(); expect(await visible(page)).toEqual(ids);
  await expect(viewport).toHaveAttribute('style', transform!);
  const revised = state.tasks.find(task => task.title === '主链后续 2')!;
  state.tasks = state.tasks.map(task => task.id === revised.id ? { ...task, title: 'Updated successor', version: 2n, updatedAt: '2027-01-01T10:00:00Z' } : task);
  state.fail = false;
  const success = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
  await page.locator('.snapshot-error button').filter({ hasText: 'Retry refresh' }).evaluate((element: HTMLButtonElement) => element.click()); await success;
  await expect(page.locator('.snapshot-error')).toHaveCount(0); await expect(close).toBeFocused();
  await expect(page.locator(`.react-flow__node[data-id="${revised.id}"]`)).toContainText('Updated successor');
  expect(await visible(page)).toEqual(ids); await expect(body).toHaveAttribute('aria-pressed', 'true'); await expect(viewport).toHaveAttribute('style', transform!);
});


test('refresh prunes a disconnected visible prerequisite without adding hidden nodes', async ({ page }) => {
  const state = await install(page); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${rootId}`).click();
  const join = page.locator(`.react-flow__node[data-id="${joinId}"]`);
  await join.locator('.task-node-expand[data-direction="prerequisites"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__node')).toHaveCount(70); const before = await visible(page);
  const target = state.tasks.find(task => task.id === joinId)!;
  const removed = target.externalDependsOn.find(id => before.includes(id))!; expect(removed).toBeTruthy();
  state.tasks = state.tasks.map(task => task.id === joinId ? { ...task, dependsOn: task.dependsOn.filter(id => id !== removed), externalDependsOn: task.externalDependsOn.filter(id => id !== removed), version: 2n, updatedAt: '2027-01-01T10:00:00Z' } : task);
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && item.status() === 200);
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click()); await response;
  await expect(page.locator(`.react-flow__node[data-id="${removed}"]`)).toHaveCount(0);
  const after = await visible(page); expect(after).toEqual(before.filter(id => id !== removed));
  await expect(page.locator('.react-flow__edge')).toHaveCount(68);
});


for (const [status, assignee] of [['all', 'Everyone'], ['todo', 'Everyone'], ['all', 'Unassigned']] as const) test(`external navigation retains page, scroll and disclosure with ${status} status and ${assignee}`, async ({ page }) => {
  const state = await install(page);
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const finished = Array.from({ length: 21 }, (_, position) => {
    const root = id(position * 2 + 1), child = id(position * 2 + 2);
    const assignedTo = assignee === 'Unassigned' ? id(900) : null;
    return [detailFixture(projectId, root, { title: `Goal ${position + 1}`, status: 'done', ready: false, assignedTo }),
      detailFixture(projectId, child, { title: `Result ${position + 1}`, status: 'done', ready: false, assignedTo,
        dependsOn: position === 0 ? [root, id(4)] : [root], externalDependsOn: position === 0 ? [id(4)] : [] })];
  }).flat();
  const waiting = Array.from({ length: 21 }, (_, position) => {
    const root = id(2000 + position * 2);
    return [detailFixture(projectId, root, { title: `Waiting Goal ${position}` }),
      detailFixture(projectId, id(2001 + position * 2), { title: `Waiting child ${position}`, dependsOn: [root], blockedBy: [root], ready: false })];
  }).flat();
  const source = id(1000), child = id(1001), singleton = id(1002);
  state.tasks = [...finished, ...waiting, detailFixture(projectId, singleton, { title: 'Standalone prerequisite', status: 'done', ready: false }),
    detailFixture(projectId, source, { title: 'Consumer Goal', createdAt: '2026-10-01T10:00:00Z' }),
    detailFixture(projectId, child, { title: 'Consumer task', dependsOn: [source, id(2), singleton], externalDependsOn: [id(2), singleton], blockedBy: [source], ready: false }),
    ...Array.from({ length: 8 }, (_, position) => detailFixture(projectId, id(1100 + position), { title: `Consumer child ${position}`, dependsOn: [source], blockedBy: [source], ready: false }))];
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption(status);
  if (assignee === 'Unassigned') {
    await page.getByRole('button', { name: 'Assignee: Everyone', exact: true }).click();
    await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
  }
  await page.getByRole('navigation', { name: 'Task chains pagination' }).getByRole('button', { name: 'Next', exact: true }).click();
  const original = page.locator(`#task-root-${source}`), trigger = page.locator(`#task-chain-graph-${source}`);
  await original.click(); await expect(original).toHaveAttribute('aria-expanded', 'true');
  await trigger.evaluate(element => { window.scrollTo(0, 320); element.focus({ preventScroll: true }); });
  expect(await page.evaluate(() => scrollY)).toBe(320);
  await page.evaluate(source => {
    const list = document.getElementById('project-chain-list')!, rows = [...list.querySelectorAll('.root-toggle')];
    const pagination = list.querySelector('.list-pagination'), pageText = pagination!.textContent;
    const status = document.querySelector<HTMLSelectElement>('.task-status-filter select')!;
    const assignee = document.querySelector('.task-assignee-filter .assignee-trigger')!, assigneeName = assignee.getAttribute('aria-label');
    const statusValue = status.value, original = document.getElementById(`task-root-${source}`)!, top = scrollY;
    const violations: string[] = [];
    const check = () => {
      const current = [...list.querySelectorAll('.root-toggle')];
      if (current.length !== rows.length || current.some((row, position) => row !== rows[position])) violations.push('list rows changed');
      if (list.querySelector('.list-pagination') !== pagination || pagination!.textContent !== pageText) violations.push('pagination changed');
      if (status.value !== statusValue || assignee.getAttribute('aria-label') !== assigneeName) violations.push('filters changed');
      if (original.getAttribute('aria-expanded') !== 'true') violations.push('disclosure changed');
      if (scrollY !== top) violations.push('scroll changed');
    };
    const observer = new MutationObserver(check);
    observer.observe(list, { childList: true, attributes: true, characterData: true, subtree: true });
    window.addEventListener('scroll', check);
    Reflect.set(window, Symbol.for('external-navigation-state'), { check, violations, finish: () => { observer.disconnect(); window.removeEventListener('scroll', check); } });
  }, source);
  const stable = () => page.evaluate(() => {
    const saved = Reflect.get(window, Symbol.for('external-navigation-state')) as { check: () => void; violations: string[] };
    saved.check(); return saved.violations;
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__node')).toHaveCount(12);
  await expect(page.locator(`.react-flow__node[data-id="${id(1)}"]`)).toHaveCount(0);
  const external = page.locator(`.react-flow__node[data-id="${id(2)}"]`);
  await external.locator('.task-node-navigate').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`#task-graph-${id(1)}`)).toBeVisible();
  await expect(page.locator(`#task-graph-${source}`)).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  expect(await stable()).toEqual([]);
  await page.locator(`.react-flow__node[data-id="${id(4)}"] .task-node-navigate`).click();
  await expect(page.locator(`#task-graph-${id(3)}`)).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  expect(await stable()).toEqual([]);
  await page.locator('.task-chain-close').click();
  await expect(trigger).toBeFocused(); expect(await stable()).toEqual([]);
  await expect(original).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue(status);
  await expect(page.getByRole('button', { name: `Assignee: ${assignee}`, exact: true })).toBeVisible();
  await expect(page.locator('#project-chain-list .list-pagination-page')).toHaveText(`Page 2 of ${status === 'all' && assignee === 'Everyone' ? 3 : 2}`);
  await page.evaluate(() => { (Reflect.get(window, Symbol.for('external-navigation-state')) as { finish: () => void }).finish(); });
  await trigger.evaluate(element => element.focus({ preventScroll: true })); await page.keyboard.press('Enter');
  await expect(page.locator('.react-flow__node')).toHaveCount(12);
  await page.locator(`.react-flow__node[data-id="${singleton}"] .task-node-navigate`).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.task-detail-title')).toHaveText('Standalone prerequisite');
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
  await page.locator('.task-detail-dialog').getByRole('button', { name: 'Close task details', exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(320);
  await expect(original).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue(status);
  await expect(page.getByRole('button', { name: `Assignee: ${assignee}`, exact: true })).toBeVisible();
  await expect(page.locator('#project-chain-list .list-pagination-page')).toHaveText(`Page 2 of ${status === 'all' && assignee === 'Everyone' ? 3 : 2}`);
});
