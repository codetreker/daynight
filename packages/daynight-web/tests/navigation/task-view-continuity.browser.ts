import { expect, test, type Page } from '@playwright/test';
import type { TaskDetail } from '../../src/api/types';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { completeContextGraph } from '../helpers/graphData';
import { captureStableDependencyGeometry, checkDependencyGeometry, expectedDependencyTopology } from '../helpers/dependency-geometry';

const projectId = '00000000-0000-4000-8000-000000000031', personalId = '00000000-0000-4000-8000-000000000701';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-20T09:00:00Z';
const row = (n: number, title: string, dependsOn: string[] = []) => detailFixture(projectId, id(n), { title, version: 1n, dependsOn, blockedBy: dependsOn, ready: dependsOn.length === 0 });

async function install(page: Page, initial: TaskDetail[]) {
  const gate = Promise.withResolvers<void>();
  const state = { tasks: initial, writes: [] as string[], graphMode: 'normal' as 'normal' | 'pending' | 'error', releaseGraph: gate.resolve };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, graph = graphFixture(state.tasks);
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) {
      if (state.graphMode === 'pending') await gate.promise;
      if (state.graphMode === 'error') return send({ error: { code: 'internal_error', message: 'unavailable', requestId: 'graph-failure' } }, 500);
      return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: task => state.tasks.find(item => item.id === task.id)!.version, propertiesForTask: task => state.tasks.find(item => item.id === task.id)!.properties }));
    }
    const base = `/api/v1/projects/${projectId}/tasks/`;
    if (path.startsWith(base)) {
      const parts = path.slice(base.length).split('/'), detail = state.tasks.find(item => item.id === parts[0]);
      if (detail && parts.length === 1) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
      if (detail && (parts[1] === 'sessions' || parts[1] === 'attachments')) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}
const select = async (page: Page, name: string) => {
  await page.getByRole('tab', { name, exact: true }).evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
};
const position = (page: Page) => page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(scrollY)))));

for (const width of [1100, 390]) test(`project header and navigation survive a pending and failed graph at ${width}px`, async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  state.graphMode = 'pending';
  await page.setViewportSize({ width, height: 700 });
  try {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: '任务项目', exact: true })).toBeVisible();
    await expect(page.getByText('https://github.com/example/project', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Project settings', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Project members', exact: true })).toBeVisible();
    const overview = page.getByRole('tab', { name: 'Overview', exact: true });
    const tasks = page.getByRole('tab', { name: 'Task list', exact: true });
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.getByRole('status', { name: 'Loading task graph' })).toBeVisible();
    await tasks.click();
    await expect(tasks).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: /search/i })).toBeVisible();
    state.graphMode = 'error'; state.releaseGraph();
    await expect(page.getByRole('alert')).toContainText('graph-failure');
    await expect(page.getByRole('heading', { name: '任务项目', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Project settings', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /search/i })).toBeVisible();
    await page.goBack();
    await expect(overview).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('alert')).toContainText('graph-failure');
    await page.goForward();
    await expect(tasks).toHaveAttribute('aria-selected', 'true');
    state.graphMode = 'normal';
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Task chains', exact: true })).toBeVisible();
    expect(state.writes).toEqual([]);
  } finally { state.releaseGraph(); }
});

test('project management remains available when the task cache cannot open', async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (name, version) {
      if (name === 'daynight-task-cache') throw new DOMException('Unavailable', 'InvalidStateError');
      return open.call(this, name, version);
    };
  });
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: '任务项目', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Project settings', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Project members', exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test('category switching preserves real scroll and only the browser clamps shorter content', async ({ page }) => {
  const chains = Array.from({ length: 25 }, (_, i) => [row(100 + i * 2, `Chain ${i}`), row(101 + i * 2, `Chain child ${i}`, [id(100 + i * 2)])]).flat();
  const standalone = Array.from({ length: 22 }, (_, i) => row(300 + i, `Standalone ${i}`));
  await install(page, [...chains, ...standalone]); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await expect(page.getByRole('tab', { name: 'Task chains', exact: true })).toBeVisible();
  const trace = await page.evaluateHandle(() => {
    const original = window.scrollTo; let calls = 0;
    window.scrollTo = new Proxy(original, { apply(target, receiver, args) { calls++; return Reflect.apply(target, receiver, args); } });
    return { reset: () => { calls = 0; }, count: () => calls, restore: () => { window.scrollTo = original; } };
  });
  try {
    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 700 }); await page.evaluate(() => window.scrollTo(0, 120));
      for (const name of ['Task chains', 'Standalone tasks', 'Task chains', 'Standalone tasks']) {
        await trace.evaluate(value => value.reset()); await select(page, name);
        expect(await position(page)).toBe(120); expect(await trace.evaluate(value => value.count())).toBe(0);
      }
      const pagination = page.getByRole('navigation', { name: 'Standalone task list pagination' });
      await pagination.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.locator('.standalone-row')).toHaveCount(2);
      const shortExtent = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      await select(page, 'Task chains'); const longExtent = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      expect(longExtent).toBeGreaterThan(shortExtent);
      await page.evaluate(top => window.scrollTo(0, top), longExtent); await expect.poll(() => page.evaluate(() => scrollY)).toBe(longExtent);
      await trace.evaluate(value => value.reset()); await select(page, 'Standalone tasks');
      expect(await position(page)).toBe(shortExtent); expect(await trace.evaluate(value => value.count())).toBe(0);
      await select(page, 'Task chains'); expect(await position(page)).toBe(shortExtent); expect(await trace.evaluate(value => value.count())).toBe(0);
      await select(page, 'Standalone tasks'); await pagination.getByRole('button', { name: 'Previous', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await trace.evaluate(value => value.reset());
      await select(page, 'Task chains'); expect(await position(page)).toBe(0);
      await select(page, 'Standalone tasks'); expect(await position(page)).toBe(0);
      expect(await trace.evaluate(value => value.count())).toBe(0);
    }
  } finally { await trace.evaluate(value => value.restore()); await trace.dispose(); }
});

test('a task stays open through merge and split, then focus falls back to the surviving owner', async ({ page }) => {
  const root = row(10, 'Chain root'), child = row(11, 'Moving task'), sibling = row(12, 'Remaining child', [root.id]), remaining = row(13, 'Remaining standalone');
  const state = await install(page, [root, child, sibling, remaining]); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await select(page, 'Standalone tasks');
  await page.locator(`#standalone-task-${child.id}`).click(); const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.locator('.task-detail-title')).toHaveText(child.title);
  state.tasks = [root, { ...child, dependsOn: [root.id], blockedBy: [root.id], ready: false, version: 2n, updatedAt: '2026-10-22T10:00:01Z' }, sibling, remaining];
  const refresh = page.locator('.project-title-actions>button');
  const joined = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
  await refresh.evaluate((element: HTMLButtonElement) => element.click()); await joined;
  await expect(page.locator(`#standalone-task-${child.id}`)).toHaveCount(0); await expect(dialog.locator('.task-detail-title')).toHaveText(child.title);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.locator('.standalone-row').first()).toBeFocused();
  await select(page, 'Task chains'); await page.locator(`#task-chain-graph-${root.id}`).click();
  const graph = page.locator('.task-chain-dialog'), details = page.locator(`.react-flow__node[data-id="${child.id}"] .task-node-details`);
  await expect(details).toBeVisible(); await details.click(); await expect(dialog.locator('.task-detail-title')).toHaveText(child.title);
  state.tasks = [root, { ...child, version: 3n, updatedAt: '2026-10-22T10:00:02Z' }, sibling, remaining];
  const split = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
  await refresh.evaluate((element: HTMLButtonElement) => element.click()); await split;
  await expect(page.locator(`.react-flow__node[data-id="${child.id}"]`)).toHaveCount(0);
  await expect(dialog.locator('.task-detail-title')).toHaveText(child.title);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(graph.locator('.task-chain-close')).toBeFocused();
  await graph.locator('.task-chain-close').click(); await expect(page.locator(`#task-chain-graph-${root.id}`)).toBeFocused();
  expect(state.writes).toEqual([]);
});


test('overview progress navigates to highlighted chain and standalone targets in the viewport', async ({ page }) => {
  const root = row(10, 'Overview chain'), child = row(11, 'Overview child', [root.id]), standalone = row(12, 'Standalone target');
  const state = await install(page, [root, child, standalone]); await page.setViewportSize({ width: 390, height: 360 });
  await page.goto(`/projects/${projectId}`);
  const progress = page.getByRole('region', { name: 'Overall progress', exact: true });
  const chain = progress.getByRole('button', { name: /^Overview chain, / });
  await expect(chain).toBeVisible(); await chain.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Task chains', exact: true })).toHaveAttribute('aria-selected', 'true');
  const chainTarget = page.locator(`#task-root-${root.id}`); await expect(chainTarget).toBeFocused(); await expect(chainTarget).toBeInViewport(); await expect(chainTarget).toHaveClass(/overview-progress-target/);
  await select(page, 'Overview');
  const independent = progress.getByRole('button', { name: /^Standalone tasks, / });
  await independent.focus(); await page.keyboard.press('Enter');
  const panel = page.getByRole('tabpanel', { name: 'Standalone tasks', exact: true });
  await expect(panel).toBeFocused(); await expect(panel).toBeInViewport(); await expect(panel).toHaveClass(/overview-progress-target/);
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0); expect(state.writes).toEqual([]);
});

test('merging chains replaces the representative without stealing an open detail focus', async ({ page }) => {
  const survivor = { ...row(20, 'Surviving root'), createdAt: '2026-10-20T11:59:00Z' };
  const survivorChild = { ...row(21, 'Surviving child', [survivor.id]), createdAt: '2026-10-20T11:59:01Z' };
  const root = { ...row(22, 'Replaced root'), createdAt: '2026-10-20T11:59:02Z' };
  const selected = { ...row(23, 'Selected detail', [root.id]), createdAt: '2026-10-20T11:59:03Z' };
  const state = await install(page, [survivor, survivorChild, root, selected]); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${root.id}`).click();
  const trigger = page.locator(`.react-flow__node[data-id="${selected.id}"] .task-node-details`);
  await trigger.click(); const originalTrigger = await trigger.elementHandle(), dialog = page.locator('.task-detail-dialog');
  await expect(dialog.locator('.task-detail-title')).toHaveText(selected.title);
  const close = dialog.getByRole('button', { name: 'Close task details', exact: true }); await expect(close).toBeFocused();
  state.tasks = [survivor, survivorChild, root, { ...selected, dependsOn: [root.id, survivor.id], blockedBy: [root.id, survivor.id], version: 2n, updatedAt: '2026-10-22T10:00:01Z' }];
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && item.status() === 200);
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click()); await response;
  await expect(page.locator(`#task-root-${root.id}`)).toHaveCount(0);
  expect(await originalTrigger!.evaluate(element => element.isConnected)).toBe(false);
  await expect(dialog).toBeVisible(); await expect(close).toBeFocused();
  await expect(page.locator('#root')).toHaveAttribute('inert', ''); await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await close.click(); const graph = page.locator('.task-chain-dialog');
  await expect(graph.locator('.task-chain-close')).toBeFocused(); await expect(graph).toBeVisible();
  await graph.locator('.task-chain-close').click(); await expect(page.locator(`#task-root-${survivor.id}`)).toBeFocused();
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  await originalTrigger!.dispose(); expect(state.writes).toEqual([]);
});


test('narrow graph preserves full dependency geometry and keyboard detail focus', async ({ page }, info) => {
  const tasks = completeContextGraph.tasks.map(task => detailFixture(projectId, task.id, { title: task.titlePreview, status: task.status,
    dependsOn: task.id === id(31) ? [...task.dependsOn, id(15), id(14)].sort() : task.dependsOn,
    externalDependsOn: task.id === id(31) ? [...task.externalDependsOn, id(15), id(14)].sort() : task.externalDependsOn,
    blockedBy: task.blockedBy, ready: task.ready, createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt, completedAt: task.completedAt, cancelledAt: task.cancelledAt, version: 1n }));
  const state = await install(page, tasks); const root = id(30), prerequisite = id(15), ancestor = id(14);
  const topology = expectedDependencyTopology(graphFixture(tasks).tasks, root);
  await page.setViewportSize({ width: 320, height: 800 }); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${root}`).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(topology.nodes.length);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await checkDependencyGeometry(page, topology, info)).toEqual({ total: 0, examples: [] });
  const horizontal = page.getByRole('radio', { name: 'Horizontal', exact: true }); await horizontal.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Vertical', exact: true })).toBeFocused();
  expect(await checkDependencyGeometry(page, topology, info, undefined, 'vertical')).toEqual({ total: 0, examples: [] });
  const card = page.locator(`.react-flow__node[data-id="${prerequisite}"]`), body = card.locator('.task-node-body'), details = card.locator('.task-node-details');
  await body.focus(); const before = (await page.evaluate(captureStableDependencyGeometry)).geometry; await page.keyboard.press('Enter');
  await expect(body).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.react-flow__node[data-id="${ancestor}"] .task-node`)).toHaveAttribute('data-inspection', 'prerequisite');
  expect((await page.evaluate(captureStableDependencyGeometry)).geometry).toEqual(before);
  await details.focus(); const beforeDetail = (await page.evaluate(captureStableDependencyGeometry)).geometry; await page.keyboard.press('Enter');
  const dialog = page.locator('.task-detail-dialog'); await expect(dialog.locator('.task-detail-title')).toHaveText('外部前置 · 实现共享接口');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(details).toBeFocused();
  await expect(body).toHaveAttribute('aria-pressed', 'true'); expect((await page.evaluate(captureStableDependencyGeometry)).geometry).toEqual(beforeDetail);
  expect(await checkDependencyGeometry(page, topology, info, undefined, 'vertical')).toEqual({ total: 0, examples: [] });
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) {
  test(`narrow graph controls fit in ${locale} while language storage failure stays on the page`, async ({ page }) => {
    const root = row(10, 'A long graph title 需要完整读取的任务链 '.repeat(5)), child = row(11, 'Graph child', [root.id]);
    const state = await install(page, [root, child]);
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      const control = { fail: true }; (window as unknown as { languageStorageFault: typeof control }).languageStorageFault = control;
      Storage.prototype.setItem = function (key, value) { if (key === 'daynight.web.locale' && control.fail) throw new DOMException('Denied', 'QuotaExceededError'); return original.call(this, key, value); };
    });
    await page.setViewportSize({ width: 320, height: 800 }); await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const notice = page.locator('.topbar .locale-notice');
    await expect(notice).toContainText(locale === 'en' ? 'The language could not be saved.' : '语言无法保存到浏览器');
    await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${root.id}`).click();
    const graph = page.locator('.task-chain-dialog'), viewport = page.locator('.react-flow__viewport'), fullscreen = graph.locator('.graph-fullscreen-toggle');
    const body = page.locator(`.react-flow__node[data-id="${root.id}"] .task-node-body`); await body.focus(); await page.keyboard.press('Enter');
    const horizontal = graph.getByRole('radio', { name: locale === 'en' ? 'Horizontal' : '水平', exact: true });
    const vertical = graph.getByRole('radio', { name: locale === 'en' ? 'Vertical' : '垂直', exact: true });
    await horizontal.focus(); await page.keyboard.press('ArrowRight'); await expect(vertical).toBeFocused(); await expect(vertical).toHaveAttribute('aria-checked', 'true');
    await expect(body).toHaveAttribute('aria-pressed', 'true');
    const layout = async () => {
      await expect(graph.locator('.locale-preference,.locale-notice')).toHaveCount(0);
      for (const element of [graph.locator('.task-chain-heading h2'), graph.locator('.task-chain-close'), fullscreen]) await expect(element).toBeInViewport({ ratio: 1 });
      const header = await graph.locator('.task-chain-header').evaluate(element => { const heading = element.querySelector<HTMLElement>('.task-chain-heading')!.getBoundingClientRect(), close = element.querySelector<HTMLElement>('.task-chain-close')!.getBoundingClientRect(), bounds = element.getBoundingClientRect(); return { heading: { width: heading.width, right: heading.right, top: heading.top, height: heading.height }, close: { left: close.left, right: close.right, top: close.top }, right: bounds.right }; });
      expect(header.heading.width).toBeGreaterThan(0); expect(header.heading.right).toBeLessThanOrEqual(header.close.left); expect(header.close.right).toBeLessThanOrEqual(header.right); expect(Math.abs(header.heading.top - header.close.top)).toBeLessThan(header.heading.height);
      const bounds = (await graph.boundingBox())!;
      for (const control of [horizontal, vertical, fullscreen, graph.locator('.graph-reset-overview')]) { const rect = (await control.boundingBox())!; expect(rect.x).toBeGreaterThanOrEqual(bounds.x); expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width); }
      expect(await graph.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await layout(); const transform = await viewport.getAttribute('style'), graphHandle = await graph.elementHandle(), viewportHandle = await viewport.elementHandle();
    await fullscreen.click(); await expect(graph).toHaveClass(/task-chain-dialog-fullscreen/); await expect(fullscreen).toBeFocused();
    await expect(vertical).toHaveAttribute('aria-checked', 'true'); await expect(body).toHaveAttribute('aria-pressed', 'true');
    expect(await graphHandle!.evaluate(element => element === document.querySelector('.task-chain-dialog'))).toBe(true);
    expect(await viewportHandle!.evaluate(element => element === document.querySelector('.react-flow__viewport'))).toBe(true);
    await expect(viewport).toHaveAttribute('style', transform!); await layout();
    const zoom = () => viewport.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
    const beforeZoom = await zoom(); await graph.getByRole('button', { name: locale === 'en' ? 'Zoom in' : '放大', exact: true }).click();
    await expect.poll(zoom).toBeGreaterThan(beforeZoom);
    for (let i = 0; i < 2; i++) { const previous = await zoom(); await graph.getByRole('button', { name: locale === 'en' ? 'Zoom out' : '缩小', exact: true }).click(); await expect.poll(zoom).toBeLessThan(previous); }
    const beforeFit = await viewport.getAttribute('style'); await graph.getByRole('button', { name: locale === 'en' ? 'Fit to canvas' : '适应画布', exact: true }).click();
    await expect(viewport).not.toHaveAttribute('style', beforeFit!); const fitted = await viewport.getAttribute('style');
    await page.keyboard.press('Escape'); await expect(graph).not.toHaveClass(/task-chain-dialog-fullscreen/); await expect(fullscreen).toBeFocused();
    await expect(viewport).toHaveAttribute('style', fitted!); await expect(body).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape'); await expect(graph).toHaveCount(0); await expect(notice).toBeVisible();
    await page.evaluate(() => { (window as unknown as { languageStorageFault: { fail: boolean } }).languageStorageFault.fail = false; });
    await notice.getByRole('button', { name: locale === 'en' ? 'Retry saving language' : '重试保存语言', exact: true }).click();
    await expect(notice).toHaveCount(0); expect(await page.evaluate(() => localStorage.getItem('daynight.web.locale'))).toBe(locale);
    await graphHandle!.dispose(); await viewportHandle!.dispose(); expect(state.writes).toEqual([]);
  });
}
