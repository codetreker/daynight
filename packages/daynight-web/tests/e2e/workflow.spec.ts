import { closeChain, expectClosedChain, expectOpenChain, openChain } from './chain-dialog';
import { selectOverview, selectTaskList } from './project-view';
import { decodeTaskGraphJson } from '../../src/api/project-json';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, createProject, createTask, updateTask, startTask, finishTask, executeTask, seedExternalDependencies, type Task, withDependencyFailure, withProjectsFailure } from './fixtures';
import { authenticatedAPI } from './authentication';
import { parseTaskGraph } from '../../src/api/parse';
import type { PullRequestProperty } from '../../src/api/types';
import { attachmentDownloadUrl, attachmentPreviewUrl } from '../../src/api/client';
import { captureStableDependencyGeometry, checkDependencyGeometry, expectedDependencyTopology } from './dependency-geometry';
import { expectedNodeHeights } from './visible-topology';
import { expectCenteredTaskDetail, expectTaskDetailScroll } from './detail-dialog';
import { expectStableAutomaticDetailRefresh } from './detail-refresh';
import { panPoint } from './graph-pan';
import { verifyPublicExternalDependencyWrites } from './external-dependency-writes';

const scenario = (description: string) => ({ annotation: { type: 'scenario', description } });
const card = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"] .task-node`);
const inspectTask = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"] button.task-node-body`);
const details = (page: Page, id: string): Locator => card(page, id).locator('button.task-node-details');
const root = (page: Page, id: string): Locator => page.locator(`#task-root-${id}`);
const standalone = (page: Page, id: string): Locator => page.locator(`#standalone-task-${id}`);
const viewTab = (page: Page, name: '独立任务' | '任务链'): Locator => page.getByRole('tab', { name, exact: true });
const activateViewWithoutScrolling = async (page: Page, name: '独立任务' | '任务链' | '概览' | '任务列表'): Promise<void> => {
  await page.getByRole('tab', { name, exact: true }).evaluate((button: HTMLElement) => button.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
};
const stat = (page: Page, label: string): Locator => page.locator('.stat').filter({ has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.stat-number');
const screenshot = async (page: Page, info: TestInfo, slug: string): Promise<void> => {
  const path = info.outputPath(`${slug}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};
const checkPullRequests = async (dialog: Locator, pullRequests: readonly PullRequestProperty[], page = 0): Promise<Locator> => {
  const region = dialog.getByRole('region', { name: '关联 PR', exact: true });
  await expect(region.getByRole('heading')).toHaveText(`关联 PR · ${pullRequests.length}`);
  const visible = pullRequests.slice(page * 100, (page + 1) * 100);
  const items = region.locator('.task-detail-pr');
  await expect(items).toHaveCount(visible.length);
  expect(await items.locator('.task-detail-pr-title').allTextContents()).toEqual(visible.map(({ title }) => title === '' ? '（空字符串）' : title));
  expect(await items.locator('.task-detail-pr-value').allTextContents()).toEqual(visible.map(({ url }) => url === '' ? '（空字符串）' : url));
  if (pullRequests.length > 100) {
    await expect(region.getByRole('status')).toHaveText(`第 ${page * 100 + 1}–${page * 100 + visible.length} 项，共 ${pullRequests.length} 项`);
    await expect(region.getByRole('combobox', { name: '关联 PR 页码' })).toHaveValue(String(page));
  }
  await expect(region.locator('img,script,iframe,object')).toHaveCount(0);
  return region;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const within = async <T,>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
};
const holdProjectSync = async (page: Page, projectId: string) => {
  const path = `/api/v1/projects/${projectId}/task-sync`;
  const pattern = (url: URL) => url.pathname === path;
  const fetched = deferred<void>();
  const release = deferred<void>();
  const active = new Set<Promise<void>>();
  const handler: Parameters<Page['route']>[1] = (route) => {
    let pending!: Promise<void>;
    pending = (async () => {
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(200);
      fetched.resolve();
      await within(release.promise, 'project sync admission release');
      if (route.request().failure() !== null) await route.abort('aborted');
      else await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
    })().finally(() => { active.delete(pending); });
    active.add(pending);
    return pending;
  };
  await page.route(pattern, handler);
  return {
    requested: () => within(fetched.promise, 'project sync requested by detail admission'),
    release: () => release.resolve(),
    close: async () => {
      release.resolve();
      await within(Promise.all([...active]), 'project sync route cleanup');
      await page.unroute(pattern, handler);
    },
  };
};
const loadAllProjects = async (page: Page): Promise<void> => {
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: '正在加载项目' })).toHaveCount(0);
  const more = page.getByRole('button', { name: '加载更多', exact: true });
  for (let count = 0; count < 200; count++) {
    if (!await more.isVisible()) {
      await expect(page.getByText('已加载全部项目')).toBeVisible();
      return;
    }
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/projects' && url.searchParams.has('cursor');
    });
    await more.click();
    expect((await response).status()).toBe(200);
    await expect(page.getByRole('button', { name: '正在加载更多…', exact: true })).toHaveCount(0);
  }
  throw new Error('Project pagination did not terminate within the acceptance bound.');
};
const openProject = async (page: Page, id: string, name: string): Promise<void> => {
  const response = await page.goto(`/projects/${id}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-type']).toContain('text/html');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
};
const openTaskProject = async (page: Page, id: string, name: string): Promise<void> => {
  await openProject(page, id, name);
  await selectTaskList(page);
};
const pauseRefreshClock = async (page: Page): Promise<void> => {
  await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'));
  await expect(page.locator('.snapshot-time time')).toHaveAttribute('datetime', /^2030-/);
};
const nextAutomaticRefresh = async (page: Page, projectId: string): Promise<number> => {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync`);
  await page.clock.fastForward(5_000);
  return (await response).status();
};

test('project-list', scenario('project-list'), async ({ page, api: request }, info) => {
  const prefix = `Pagination ${randomUUID()}`;
  const projects = [];
  for (let index = 0; index < 51; index++) {
    projects.push(await createProject(request, { name: `${prefix} ${String(index).padStart(2, '0')}` }));
  }
  const listRequests: string[] = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/v1/projects') listRequests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('status', { name: '正在加载项目' })).toHaveCount(0);
  await expect(page.locator('a.project-card')).toHaveCount(50);
  const firstPage = await page.locator('a.project-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')));
  let failedCursor: string | null = null;
  await withProjectsFailure(async () => {
    const continuation = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/projects' && url.searchParams.has('cursor');
    });
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    const response = await continuation;
    expect(response.status()).toBe(500);
    failedCursor = new URL(response.url()).searchParams.get('cursor');
    expect(failedCursor).not.toBeNull();
    await expect(page.getByRole('alert')).toContainText('更多项目加载失败，已加载的项目仍可查看。');
    await expect(page.getByRole('button', { name: '重试加载更多', exact: true })).toBeVisible();
    expect(await page.locator('a.project-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')))).toEqual(firstPage);
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
  });
  const retried = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/projects' && url.searchParams.has('cursor');
  });
  await page.getByRole('button', { name: '重试加载更多', exact: true }).click();
  const successfulContinuation = await retried;
  expect(successfulContinuation.status()).toBe(200);
  expect(new URL(successfulContinuation.url()).searchParams.get('cursor')).toBe(failedCursor);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await loadAllProjects(page);
  for (const project of projects) {
    const card = page.locator(`a.project-card[href="/projects/${project.id}"]`);
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await expect(card).toContainText(project.repoUrl);
  }
  const hrefs = await page.locator('a.project-card').evaluateAll((cards) => cards.map((card) => card.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(hrefs.length);
  expect(listRequests.some((value) => new URL(value).searchParams.has('cursor'))).toBe(true);
  expect(listRequests.every((value) => new URL(value).searchParams.get('limit') === '50')).toBe(true);
  await screenshot(page, info, 'project-list');
  await page.locator(`a.project-card[href="/projects/${projects[50]!.id}"]`).click();
  await expect(page.getByRole('heading', { name: projects[50]!.name, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(stat(page, '任务总数')).toHaveText('0');
});

test('project-graph', scenario('project-graph'), async ({ page, api: request, baseURL }, info) => {
  const project = await createProject(request, { name: `Shared graph ${randomUUID()}` });
  const a = await createTask(request, project.id, { title: 'A 已完成根' });
  const b = await createTask(request, project.id, { title: 'B 进行中根' });
  const c = await createTask(request, project.id, { title: 'C 已完成根' });
  await executeTask(request, project.id, a);
  await startTask(request, project.id, b);
  await executeTask(request, project.id, c);
  const d = await createTask(request, project.id, { title: 'D 菱形分支', dependsOn: [a.id] });
  const e = await createTask(request, project.id, { title: 'E 菱形分支', dependsOn: [a.id] });
  await executeTask(request, project.id, d);
  await executeTask(request, project.id, e);
  const f = await createTask(request, project.id, { title: 'F 三个普通起点合流', dependsOn: [d.id, e.id, b.id, c.id] });
  const g = await createTask(request, project.id, { title: 'G 普通后续', dependsOn: [f.id] });
  const completed = await createTask(request, project.id, { title: '已完成独立任务' });
  await executeTask(request, project.id, completed);
  const independent = await createTask(request, project.id, { title: '独立待处理任务' });
  await openProject(page, project.id, project.name);
  await expect(page.getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
  for (const [label, value] of [['任务总数', '9'], ['已完成', '5'], ['待处理', '3'], ['进行中', '1'], ['可开始', '1'], ['被阻塞', '2']] as const) {
    await expect(stat(page, label)).toHaveText(value);
  }
  await expect(page.locator('.stats .stat')).toHaveCount(6);
  await expect(page.locator('.stats .stat-label').filter({ hasText: /^待审批$/ })).toHaveCount(0);
  await expect(page.getByText('完成比例 56%')).toBeVisible();
  await selectTaskList(page);
  await expect(viewTab(page, '任务链')).toHaveAttribute('aria-selected', 'true');
  await expect(viewTab(page, '任务链').locator('.graph-count-pill')).toHaveText('3');
  await expect(viewTab(page, '独立任务').locator('.graph-count-pill')).toHaveText('1');
  expect(await page.locator('.root-toggle').evaluateAll((items) => items.map((item) => item.id))).toEqual(
    [a].map(({ id }) => `task-root-${id}`),
  );
  await expectClosedChain(page, a.id);
  const listPosition = await root(page, a.id).boundingBox();
  const listScroll = await page.evaluate(() => window.scrollY);
  await openChain(page, a.id);
  await expect.poll(async () => await page.locator('.task-chain-dialog').boundingBox()).toEqual({ x: 160, y: 110, width: 1280, height: 880 });
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  const dragStart = await panPoint(page);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(5, 5, { steps: 4 });
  await page.mouse.up();
  await expectOpenChain(page, a.id);
  await page.locator('.task-chain-backdrop').click({ position: { x: 5, y: 5 } });
  await expectClosedChain(page, a.id);
  await expect(root(page, a.id)).toBeFocused();
  expect(await root(page, a.id).boundingBox()).toEqual(listPosition);
  expect(await page.evaluate(() => window.scrollY)).toBe(listScroll);
  await openChain(page, a.id);
  await page.keyboard.press('Escape');
  await expectClosedChain(page, a.id);
  await openChain(page, a.id);
  await expect(root(page, b.id)).toHaveCount(0);
  await expect(root(page, c.id)).toHaveCount(0);
  await expect(root(page, a.id).locator('.root-status')).toHaveText('进行中');
  await expect(root(page, a.id).locator('.root-progress-label')).toHaveText('4/7 已完成');
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  const completedVisibility = page.getByRole('checkbox', { name: '显示已完成任务链（0）', includeHidden: true });
  await expect(completedVisibility).not.toBeChecked();
  await expect(root(page, completed.id)).toHaveCount(0);
  await expect(root(page, independent.id)).toHaveCount(0);
  await expect(page.getByLabel('显示 1 条，共 1 条任务链')).toBeVisible();
  await closeChain(page);
  await viewTab(page, '独立任务').click();
  await expect(standalone(page, independent.id)).toBeVisible();
  await expect(standalone(page, independent.id)).toContainText('待处理');
  const completedStandaloneVisibility = page.getByRole('checkbox', { name: '显示已完成独立任务（1）' });
  await expect(completedStandaloneVisibility).not.toBeChecked();
  await expect(standalone(page, completed.id)).toHaveCount(0);
  await completedStandaloneVisibility.check();
  await expect(standalone(page, completed.id)).toBeVisible();
  await expect(viewTab(page, '任务链').locator('.graph-count-pill')).toHaveText('3');
  await expect(viewTab(page, '独立任务').locator('.graph-count-pill')).toHaveText('1');
  await expect(standalone(page, completed.id)).toContainText('已完成');
  await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('tab', { name: '任务列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(viewTab(page, '独立任务')).toHaveAttribute('aria-selected', 'true');
  await expect(completedStandaloneVisibility).toBeChecked();
  expect(await page.locator('.standalone-row').evaluateAll((items) => items.map((item) => item.id))).toEqual(
    [independent, completed].map(({ id }) => `standalone-task-${id}`),
  );
  await completedStandaloneVisibility.uncheck();
  await expect(standalone(page, completed.id)).toHaveCount(0);
  await viewTab(page, '任务链').click();
  await expect(completedVisibility).not.toBeChecked();
  await expectClosedChain(page, a.id);
  await openChain(page, a.id);
  await expect(root(page, a.id).locator('.root-status')).toHaveText('进行中');
  await expect(root(page, a.id).locator('.root-progress-label')).toHaveText('4/7 已完成');
  await expect(inspectTask(page, a.id).locator('.graph-status')).toHaveText('已完成');
  await expect(page.locator('.task-graph-canvas')).toHaveCount(1);
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await expect(page.locator('.react-flow__edge')).toHaveCount(7);
  const graphResponse = await request.get(`/api/v1/projects/${project.id}/task-graph`);
  expect(graphResponse.status()).toBe(200);
  const graphSnapshot = parseTaskGraph(await decodeTaskGraphJson(new Response(await graphResponse.text())), project.id);
  const checkEdges = async (rootId: string): Promise<void> => {
    const expected = expectedDependencyTopology(graphSnapshot.tasks, rootId);
    const heights = expectedNodeHeights(expected, expected.nodes.map(({ id }) => id)).map(({ id, height }) => ({ id, height: `${height}px` })).sort((a, b) => a.id.localeCompare(b.id));
    expect(await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => ({ id: (node as HTMLElement).dataset.id!, height: (node as HTMLElement).style.height })).sort((a, b) => a.id.localeCompare(b.id))), 'Every visible card uses its API-derived compact or expandable height').toEqual(heights);
    expect(await checkDependencyGeometry(page, expected, info), 'Every visible API dependency preserves complete native geometry').toEqual({ total: 0, examples: [] });
  };
  await test.step('keeps every static dependency aligned with task nodes through zoom and pan', async () => {
    await checkEdges(a.id);
    const viewport = page.locator('.react-flow__viewport');
    const beforeZoom = await viewport.getAttribute('style');
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforeZoom);
    await checkEdges(a.id);
    const point = await panPoint(page);
    const beforePan = await viewport.getAttribute('style');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 60, point.y + 35, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan);
    await checkEdges(a.id);
  });
  await test.step('fills the viewport without replacing the active graph or resetting its view', async () => {
    const viewport = page.locator('.react-flow__viewport');
    const beforeFullscreen = await viewport.getAttribute('style');
    const viewportElement = await viewport.elementHandle();
    const taskElement = await inspectTask(page, a.id).elementHandle();
    expect(viewportElement).not.toBeNull();
    expect(taskElement).not.toBeNull();
    const enter = page.getByRole('button', { name: '全屏查看', exact: true });
    await enter.click();
    const fullscreen = page.locator('.task-chain-dialog-fullscreen');
    await expect(fullscreen).toHaveAttribute('aria-modal', 'true');
    await expect.poll(async () => {
      const bounds = await fullscreen.boundingBox();
      return bounds !== null && Math.abs(bounds.x) <= 0.5 && Math.abs(bounds.y) <= 0.5
        && Math.abs(bounds.width - 1600) <= 0.5 && Math.abs(bounds.height - 1100) <= 0.5;
    }).toBe(true);
    await expect(viewport).toHaveAttribute('style', beforeFullscreen!);
    expect(await viewportElement!.evaluate((element) => element === document.querySelector('.react-flow__viewport'))).toBe(true);
    expect(await taskElement!.evaluate((element, id) => element === document.querySelector(`.react-flow__node[data-id="${id}"] button.task-node-body`), a.id)).toBe(true);
    await checkEdges(a.id);
    await fullscreen.getByRole('button', { name: '退出全屏', exact: true }).click();
    await expect(fullscreen).toHaveCount(0);
    await expect(enter).toBeFocused();
    await expect(viewport).toHaveAttribute('style', beforeFullscreen!);
    expect(await viewportElement!.evaluate((element) => element === document.querySelector('.react-flow__viewport'))).toBe(true);
    expect(await taskElement!.evaluate((element, id) => element === document.querySelector(`.react-flow__node[data-id="${id}"] button.task-node-body`), a.id)).toBe(true);
    await checkEdges(a.id);
    await viewportElement!.dispose();
    await taskElement!.dispose();
  });
  await expect(page.locator('.task-node-external')).toHaveCount(0);
  await expect(page.locator('.task-external-label')).toHaveCount(0);
  await expect(page.locator('.task-shared-label')).toHaveCount(0);
  await expect(inspectTask(page, f.id).locator('.graph-blocked-badge')).toHaveText('被阻塞');
  const colors = await Promise.all([a.id, b.id, f.id].map((id) => card(page, id).evaluate((shell) => getComputedStyle(shell).borderLeftColor)));
  expect(new Set(colors).size).toBe(3);
  for (const [source, target] of [[a.id, d.id], [a.id, e.id], [d.id, f.id], [e.id, f.id], [b.id, f.id], [c.id, f.id], [f.id, g.id]]) {
    const from = await card(page, source!).boundingBox();
    const to = await card(page, target!).boundingBox();
    expect(from).not.toBeNull(); expect(to).not.toBeNull();
    expect(from!.x + from!.width / 2).toBeLessThan(to!.x + to!.width / 2);
  }
  const paths = page.locator('.task-dependency-edges path.react-flow__edge-path');
  expect(await paths.evaluateAll((items) => items.every((path) => (path.getAttribute('marker-end') ?? '').startsWith('url(')))).toBe(true);
  expect(await paths.evaluateAll((items) => items.filter((path) => path.getAttribute('data-external') === 'true').length)).toBe(0);
  await page.evaluate(({ key, witness }) => localStorage.setItem(key, JSON.stringify({ expandedRootId: witness })), {
    key: `daynight:project-view:${project.id}`, witness: b.id,
  });
  await page.reload();
  await expect(page.getByRole('tab', { name: '任务列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expectClosedChain(page, a.id);
  await expect(root(page, b.id)).toHaveCount(0);
  await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).expandedRootId, `daynight:project-view:${project.id}`),
    'The retired inline-expansion preference neither opens the modal nor changes on browsing').toBe(b.id);
  await openChain(page, a.id);
  await checkEdges(a.id);
  await closeChain(page);
  await page.reload();
  await expect(page.getByRole('tab', { name: '任务列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expectClosedChain(page, a.id);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).expandedRootId, `daynight:project-view:${project.id}`)).toBe(b.id);
  await openChain(page, a.id);
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await checkEdges(a.id);
  await screenshot(page, info, 'project-graph');
  await test.step('completes recursive external ancestry without following unrelated successors at desktop and 320px', async () => {
    const contextProject = await createProject(request, { name: `Complete prerequisites ${randomUUID()}` });
    const ancestor = await createTask(request, contextProject.id, { title: 'B completed external ancestor' });
    await executeTask(request, contextProject.id, ancestor);
    const prerequisite = await createTask(request, contextProject.id, { title: 'C completed external prerequisite', dependsOn: [ancestor.id] });
    await executeTask(request, contextProject.id, prerequisite);
    const unrelated = await createTask(request, contextProject.id, { title: 'X unrelated successor', dependsOn: [prerequisite.id] });
    const source = await createTask(request, contextProject.id, { title: 'A chain source' });
    const sink = await createTask(request, contextProject.id, { title: 'D chain sink', dependsOn: [source.id, prerequisite.id] });
    await seedExternalDependencies(request, contextProject.id, sink, [prerequisite.id]);
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await openTaskProject(page, contextProject.id, contextProject.name);
      await openChain(page, source.id);
      await expectOpenChain(page, source.id);
      await expect(root(page, source.id).locator('.root-progress-label')).toHaveText('0/2 已完成');
      await expect(page.locator('.react-flow__node')).toHaveCount(4);
      await expect(page.locator('.task-dependency-edge')).toHaveCount(3);
      await expect(page.locator(`.task-dependency-edge[data-id="${ancestor.id}->${prerequisite.id}"]`)).toHaveAttribute('data-external', 'false');
      await expect(page.locator(`.task-dependency-edge[data-id="${prerequisite.id}->${sink.id}"]`)).toHaveAttribute('data-external', 'true');
      await expect(page.locator('.task-node-external')).toHaveCount(2);
      expect(await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.height))).toEqual(['96px', '96px', '96px', '96px']);
      await expect(card(page, prerequisite.id).locator('.task-node-expansions')).toHaveCount(0);
      await expect(page.getByText('链内 2 · 外部 2 · 任务 4/4 · 依赖 3/3')).toBeVisible();
      await expect(card(page, unrelated.id)).toHaveCount(0);
      await expect(inspectTask(page, ancestor.id)).toHaveAccessibleName('B completed external ancestor，已完成，外部前置');
      await expect(inspectTask(page, prerequisite.id)).toHaveAccessibleName('C completed external prerequisite，已完成，外部前置');
      expect(await page.locator('.task-dependency-edge').evaluateAll((edges) => edges.map((edge) => edge.getAttribute('data-id')).sort())).toEqual([
        `${source.id}->${sink.id}`, `${ancestor.id}->${prerequisite.id}`, `${prerequisite.id}->${sink.id}`,
      ].sort());
      const visibleInCanvas = (taskId: string) => page.evaluate((id) => {
        const bounds = document.querySelector('.task-graph-canvas')!.getBoundingClientRect();
        const task = document.querySelector(`.react-flow__node[data-id="${id}"] .task-node`)!.getBoundingClientRect();
        return task.left >= bounds.left && task.top >= bounds.top && task.right <= bounds.right && task.bottom <= bounds.bottom;
      }, taskId);
      await expect.poll(() => visibleInCanvas(ancestor.id)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const appearance = async () => (await page.evaluate(captureStableDependencyGeometry)).geometry;
      await page.keyboard.press('Tab');
      await inspectTask(page, prerequisite.id).focus();
      await expect.poll(() => visibleInCanvas(prerequisite.id)).toBe(true);
      const beforeSelection = await appearance();
      await page.keyboard.press('Enter');
      await expect(inspectTask(page, prerequisite.id)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator(`.react-flow__node[data-id="${ancestor.id}"] .task-node`)).toHaveAttribute('data-inspection', 'prerequisite');
      for (const task of [source, sink]) await expect(page.locator(`.react-flow__node[data-id="${task.id}"] .task-node`)).toHaveAttribute('data-inspection', 'unrelated');
      await expect(page.locator('.task-dependency-edge[data-inspection="highlighted"]')).toHaveCount(1);
      await expect(page.locator('.task-detail-backdrop')).toHaveCount(0);
      expect(await appearance()).toEqual(beforeSelection);
      await page.keyboard.press('Space');
      await expect(page.locator('.task-node-selected')).toHaveCount(0);
      await inspectTask(page, prerequisite.id).click();
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
      await expect(page.locator('.task-node-selected')).toHaveCount(0);
      await page.keyboard.press('Tab');
      await details(page, sink.id).focus();
      await expect.poll(() => visibleInCanvas(sink.id)).toBe(true);
      const beforeDetail = await appearance();
      await inspectTask(page, sink.id).click();
      await expect(page.locator('.task-node-prerequisite')).toHaveCount(3);
      await expect(page.locator('.task-dependency-edge[data-inspection="highlighted"]')).toHaveCount(3);
      await details(page, sink.id).click();
      const inspectionDetail = page.locator('.task-detail-backdrop').getByRole('dialog');
      await expect(inspectionDetail.locator('.task-detail-title')).toHaveText(sink.title);
      await inspectionDetail.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${prerequisite.title}，外部依赖`, exact: true }).click();
      await expect(inspectionDetail.locator('.task-detail-title')).toHaveText(prerequisite.title);
      await page.keyboard.press('Escape');
      await expect(details(page, sink.id)).toBeFocused();
      await expect(inspectTask(page, sink.id)).toHaveAttribute('aria-pressed', 'true');
      expect(await appearance()).toEqual(beforeDetail);
      await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
      await expect(page.locator('.task-node-selected')).toHaveCount(0);
      await page.keyboard.press('Tab');
      for (const task of [ancestor, prerequisite, source, sink]) {
        await inspectTask(page, task.id).focus();
        await expect.poll(() => visibleInCanvas(task.id)).toBe(true);
        await page.keyboard.press('Enter');
        await expect(inspectTask(page, task.id)).toHaveAttribute('aria-pressed', 'true');
        await details(page, task.id).focus();
        await expect.poll(() => visibleInCanvas(task.id)).toBe(true);
        await page.keyboard.press('Enter');
        const detail = page.locator('.task-detail-backdrop').getByRole('dialog');
        await expect(detail.locator('.task-detail-title')).toHaveText(task.title);
        await page.keyboard.press('Escape');
        await expect(detail).toHaveCount(0);
        await expect(details(page, task.id)).toBeFocused();
      }
      await page.getByRole('button', { name: '适应画布', exact: true }).click();
      for (const task of [ancestor, prerequisite, source, sink]) await expect.poll(() => visibleInCanvas(task.id)).toBe(true);
      await screenshot(page, info, `complete-prerequisites-${width}`);
      await page.keyboard.press('Tab');
      await inspectTask(page, source.id).focus();
      await page.keyboard.press('Enter');
      await expect(inspectTask(page, source.id)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.task-node-prerequisite')).toHaveCount(0);
      await closeChain(page);
      await viewTab(page, '独立任务').click();
      await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
      await viewTab(page, '任务链').click();
      await expectClosedChain(page, source.id);
      await openChain(page, source.id);
      await expect(page.locator('.task-node-selected')).toHaveCount(0);
    }
  });
  await test.step('separates historical worker prerequisites and retains its member witness through merge and split', async () => {
    const regression = await createProject(request, { name: `Historical worker boundaries ${randomUUID()}` });
    const completedSequence = async (prefix: string, length: number): Promise<Task[]> => {
      const result: Task[] = [];
      for (let index = 0; index < length; index++) {
        const created = await createTask(request, regression.id, { title: `${prefix} ${index + 1}`, dependsOn: index === 0 ? [] : [result[index - 1]!.id] });
        result.push(await executeTask(request, regression.id, created));
      }
      return result;
    };
    const auth = await completedSequence('认证交付', 7);
    const statusDelivery = await completedSequence('状态交付', 3);
    const goal = await createTask(request, regression.id, { title: 'Worker 交付目标 · 历史回归样本' });
    await executeTask(request, regression.id, goal);
    const design = await createTask(request, regression.id, { title: 'Worker 架构设计', dependsOn: [goal.id] });
    await startTask(request, regression.id, design);
    let role = await createTask(request, regression.id, { title: 'Worker 处理角色', dependsOn: [design.id, auth[5]!.id, statusDelivery[1]!.id] });
    const platform = await createTask(request, regression.id, { title: 'Worker 执行平台', dependsOn: [role.id] });
    const claim = await createTask(request, regression.id, { title: 'Worker 认领', dependsOn: [platform.id] });
    const agent = await createTask(request, regression.id, { title: 'Worker agent 管理', dependsOn: [design.id] });
    const workspace = await createTask(request, regression.id, { title: 'Worker 工作区', dependsOn: [design.id] });
    const loop = await createTask(request, regression.id, { title: 'Worker 执行循环', dependsOn: [claim.id, agent.id, workspace.id] });
    const handoff = await createTask(request, regression.id, { title: 'Worker 人工接管', dependsOn: [loop.id] });
    await createTask(request, regression.id, { title: 'Worker 验收', dependsOn: [handoff.id] });
    role = await seedExternalDependencies(request, regression.id, role, [auth[5]!.id, statusDelivery[1]!.id]);
    await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
    await openTaskProject(page, regression.id, regression.name);
    await openChain(page, goal.id);
    await expectOpenChain(page, goal.id);
    await pauseRefreshClock(page);
    await expect(root(page, goal.id).locator('.root-progress-label')).toHaveText('1/10 已完成');
    await expect(page.locator('.react-flow__node')).toHaveCount(18);
    await expect(page.locator('.task-node-external')).toHaveCount(8);
    await expect(card(page, auth[6]!.id)).toHaveCount(0);
    await expect(card(page, statusDelivery[2]!.id)).toHaveCount(0);
    await expect(page.locator('.root-toggle')).toHaveCount(1);
    await closeChain(page);
    const completed = page.getByRole('checkbox', { name: /显示已完成任务链/ });
    await expect(completed).toHaveAccessibleName('显示已完成任务链（2）');
    await completed.check();
    await expect(page.locator('.root-toggle')).toHaveCount(3);
    await expect(root(page, auth[0]!.id).locator('.root-progress-label')).toHaveText('7/7 已完成');
    await expect(root(page, statusDelivery[0]!.id).locator('.root-progress-label')).toHaveText('3/3 已完成');
    await expect(stat(page, '任务总数')).toHaveText('20');
    await expect(stat(page, '已完成')).toHaveText('11');
    await openChain(page, goal.id);
    await details(page, role.id).focus(); await page.keyboard.press('Enter');
    const roleDetail = page.locator('.task-detail-backdrop').getByRole('dialog');
    const prerequisites = roleDetail.getByRole('region', { name: '前置依赖', exact: true });
    await expect(prerequisites.locator('.task-detail-relation-external')).toHaveCount(2);
    await expect(prerequisites.getByRole('button', { name: `${design.title}，普通依赖`, exact: true })).toBeVisible();
    await prerequisites.getByRole('button', { name: `${auth[5]!.title}，外部依赖`, exact: true }).click();
    await expect(roleDetail.locator('.task-detail-title')).toHaveText(auth[5]!.title);
    await expect(roleDetail.getByRole('region', { name: '任务图快照中的直接后续', exact: true })
      .getByRole('button', { name: `${role.title}，外部依赖`, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const key = `daynight:project-view:${regression.id}`;
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    const refresh = async () => { expect(await nextAutomaticRefresh(page, regression.id)).toBe(200); };
    const dependencies = [...role.dependsOn];
    role = await seedExternalDependencies(request, regression.id, role, []);
    expect(role.dependsOn).toEqual(dependencies);
    await inspectTask(page, role.id).focus();
    await expect(inspectTask(page, role.id)).toBeFocused();
    await refresh();
    await expectOpenChain(page, auth[0]!.id);
    await expect(page.locator('.task-chain-close')).toBeFocused();
    await expect(root(page, goal.id)).toHaveCount(0);
    await expect(root(page, auth[0]!.id).locator('.root-progress-label')).toHaveText('11/20 已完成');
    await expect(page.locator('.task-node-external')).toHaveCount(0);
    await expect(page.locator('.react-flow__node')).toHaveCount(20);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    role = await seedExternalDependencies(request, regression.id, role, [auth[5]!.id, statusDelivery[1]!.id]);
    expect(role.dependsOn).toEqual(dependencies);
    await inspectTask(page, role.id).focus();
    await expect(inspectTask(page, role.id)).toBeFocused();
    await refresh();
    await expectOpenChain(page, goal.id);
    await expect(page.locator('.task-chain-close')).toBeFocused();
    await expect(root(page, auth[0]!.id)).not.toHaveAttribute('aria-controls');
    await expect(root(page, goal.id).locator('.root-progress-label')).toHaveText('1/10 已完成');
    await expect(page.locator('.task-node-external')).toHaveCount(8);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    await details(page, role.id).focus(); await page.keyboard.press('Enter');
    await expect(roleDetail.locator('.task-detail-title')).toHaveText(role.title);
    const close = roleDetail.getByRole('button', { name: '关闭任务详情', exact: true });
    await expect(close).toBeFocused();
    role = await seedExternalDependencies(request, regression.id, role, []);
    await refresh();
    await expectOpenChain(page, auth[0]!.id);
    await expect(roleDetail.locator('.task-detail-title')).toHaveText(role.title);
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.task-chain-close')).toBeFocused();
    role = await seedExternalDependencies(request, regression.id, role, [auth[5]!.id, statusDelivery[1]!.id]);
    await refresh();
    await expectOpenChain(page, goal.id);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    await page.clock.resume();
    await page.reload();
    await expect(page.getByRole('tab', { name: '任务列表', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expectClosedChain(page, goal.id);
    await openChain(page, goal.id);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
    const response = await request.get(`/api/v1/projects/${regression.id}/task-graph`);
    const snapshot = parseTaskGraph(await decodeTaskGraphJson(new Response(await response.text())), regression.id);
    const expected = expectedDependencyTopology(snapshot.tasks, goal.id);
    expect(expected.memberIds).toHaveLength(10); expect(expected.nodes).toHaveLength(18);
    expect(expected.edges.filter((edge) => edge.external)).toHaveLength(2);
    expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
    await screenshot(page, info, 'external-worker-classification');
  });
  await test.step('refreshes a classified shortcut without changing component membership, inspection or viewport', async () => {
    const shortcut = await createProject(request, { name: `Classified internal shortcut ${randomUUID()}` });
    const first = await createTask(request, shortcut.id, { title: '普通链起点' });
    await executeTask(request, shortcut.id, first);
    const middle = await createTask(request, shortcut.id, { title: '普通链中间任务', dependsOn: [first.id] });
    await executeTask(request, shortcut.id, middle);
    let last = await createTask(request, shortcut.id, { title: '同时拥有普通路径与外部捷径', dependsOn: [first.id, middle.id] });
    await openTaskProject(page, shortcut.id, shortcut.name);
    await openChain(page, first.id);
    await expectOpenChain(page, first.id);
    await expect(root(page, first.id).locator('.root-progress-label')).toHaveText('2/3 已完成');
    await inspectTask(page, last.id).focus(); await page.keyboard.press('Enter');
    await expect(inspectTask(page, last.id)).toHaveAttribute('aria-pressed', 'true');
    const appearance = () => page.evaluate(() => ({
      viewport: (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform,
      nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => ({ id: node.dataset.id, transform: node.style.transform, width: node.style.width, height: node.style.height })).sort((a, b) => a.id!.localeCompare(b.id!)),
    }));
    const before = await appearance();
    last = await seedExternalDependencies(request, shortcut.id, last, [first.id]);
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${shortcut.id}/task-sync`);
    await page.clock.fastForward(5_000); expect((await response).status()).toBe(200);
    await expect(page.locator(`.task-dependency-edge[data-id="${first.id}->${last.id}"]`)).toHaveAttribute('data-external', 'true');
    await expect(page.locator(`.task-dependency-edge[data-id="${middle.id}->${last.id}"]`)).toHaveAttribute('data-external', 'false');
    await expect(page.locator('.task-node-external')).toHaveCount(0);
    await expect(root(page, first.id).locator('.root-progress-label')).toHaveText('2/3 已完成');
    await expect(inspectTask(page, last.id)).toHaveAttribute('aria-pressed', 'true');
    expect(await appearance()).toEqual(before);
    const graphResponse = await request.get(`/api/v1/projects/${shortcut.id}/task-graph`);
    const graph = parseTaskGraph(await decodeTaskGraphJson(new Response(await graphResponse.text())), shortcut.id);
    const expected = expectedDependencyTopology(graph.tasks, first.id);
    expect(expected.memberIds).toHaveLength(3); expect(expected.edges.filter((edge) => edge.external)).toHaveLength(1);
    expect(await checkDependencyGeometry(page, expected, info)).toEqual({ total: 0, examples: [] });
    await screenshot(page, info, 'external-shortcut-within-component');
  });
  await test.step('keeps external-only consumers standalone and blocked, including all relation directions', async () => {
    const isolated = await createProject(request, { name: `External-only dependencies ${randomUUID()}` });
    const prerequisite = await createTask(request, isolated.id, { title: '尚未完成的外部成果' });
    let consumer = await createTask(request, isolated.id, { title: '依赖外部成果的独立任务', dependsOn: [prerequisite.id] });
    await openTaskProject(page, isolated.id, isolated.name);
    await openChain(page, prerequisite.id);
    await expectOpenChain(page, prerequisite.id);
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 60_000));
    await inspectTask(page, consumer.id).focus();
    await expect(inspectTask(page, consumer.id)).toBeFocused();
    consumer = await seedExternalDependencies(request, isolated.id, consumer, [prerequisite.id]);
    const refusal = await request.put(`/api/v1/projects/${isolated.id}/tasks/${consumer.id}/status`, { data: { version: consumer.version, status: 'in_progress' } });
    expect(refusal.status()).toBe(409); expect((await refusal.json()).error.code).toBe('dependency_unsatisfied');
    const unchanged = await request.get(`/api/v1/projects/${isolated.id}/tasks/${consumer.id}`);
    expect(await unchanged.json()).toEqual(consumer);
    expect(await nextAutomaticRefresh(page, isolated.id)).toBe(200);
    await expect(page.locator('.root-toggle')).toHaveCount(0);
    await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '暂无任务链', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '任务链列表', exact: true })).toBeFocused();
    await viewTab(page, '独立任务').click();
    await expect(standalone(page, consumer.id)).toBeVisible();
    await expect(standalone(page, consumer.id).locator('.graph-blocked-badge')).toHaveText('被阻塞');
    await expect(standalone(page, consumer.id).locator('.task-ready')).toHaveCount(0);
    await standalone(page, consumer.id).click();
    const dialog = page.locator('.task-detail-backdrop').getByRole('dialog');
    for (const region of ['前置依赖', '当前未完成的前置']) {
      await expect(dialog.getByRole('region', { name: region, exact: true }).getByRole('button', { name: `${prerequisite.title}，外部依赖`, exact: true })).toBeVisible();
      await expect(dialog.getByRole('region', { name: region, exact: true }).locator('.task-detail-relation-external')).toHaveCount(1);
    }
    await dialog.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${prerequisite.title}，外部依赖`, exact: true }).click();
    await expect(dialog.getByRole('region', { name: '任务图快照中的直接后续', exact: true }).getByRole('button', { name: `${consumer.title}，外部依赖`, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(standalone(page, consumer.id)).toBeFocused();
    await screenshot(page, info, 'external-only-blocked-task');
    await page.clock.resume();
  });

  await test.step('writes external classifications through the installed CLI and public API into the same production Web', async () => {
    if (baseURL === undefined) throw new Error('Public dependency acceptance requires the actual service origin.');
    await verifyPublicExternalDependencyWrites(page, request, baseURL, info);
  });

});

test('project-view-tabs', scenario('project-view-tabs'), async ({ page, api: request }, info) => {
  await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
  await page.setViewportSize({ width: 1100, height: 700 });
  const project = await createProject(request, { name: `Task views ${randomUUID()}` });
  const predecessor = await createTask(request, project.id, { title: '已经完成但仍属于任务链的前置' });
  await executeTask(request, project.id, predecessor);
  const dependent = await createTask(request, project.id, { title: '前置完成后的待处理链任务', dependsOn: [predecessor.id] });
  const completedRoot = await createTask(request, project.id, { title: '全部完成的链根' });
  await executeTask(request, project.id, completedRoot);
  const completedChild = await createTask(request, project.id, { title: '全部完成的链后续', dependsOn: [completedRoot.id] });
  await executeTask(request, project.id, completedChild);
  let independent = await createTask(request, project.id, { title: '直接查看详情的独立任务', description: '独立任务无需展开单节点图。' });
  const completedIndependent = await createTask(request, project.id, { title: '已经完成的独立任务' });
  await executeTask(request, project.id, completedIndependent);
  for (let index = 0; index < 20; index++) await createTask(request, project.id, { title: `独立浏览位置 ${index}` });
  for (let index = 0; index < 12; index++) {
    const source = await createTask(request, project.id, { title: `链浏览位置 ${index}` });
    await createTask(request, project.id, { title: `链后续 ${index}`, dependsOn: [source.id] });
  }
  const syncPath = `/api/v1/projects/${project.id}/task-sync`;
  let syncReads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === syncPath) syncReads += 1; });
  await openTaskProject(page, project.id, project.name);
  await pauseRefreshClock(page);
  await expect(viewTab(page, '任务链')).toHaveAttribute('aria-selected', 'true');
  await expect(viewTab(page, '独立任务')).toHaveAttribute('aria-selected', 'false');
  await expect(viewTab(page, '独立任务').locator('.graph-count-pill')).toHaveText('21');
  await expect(viewTab(page, '任务链').locator('.graph-count-pill')).toHaveText('25');
  await viewTab(page, '任务链').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(viewTab(page, '独立任务')).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: '独立任务', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(viewTab(page, '任务链')).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: '任务链', exact: true })).toBeVisible();
  const statistics = await page.locator('.stats .stat').allTextContents();
  await expect(stat(page, '任务总数')).toHaveText('50');
  await expect(stat(page, '已完成')).toHaveText('4');
  await expect(root(page, predecessor.id)).toBeVisible();
  await expect(root(page, predecessor.id).locator('.root-progress-label')).toHaveText('1/2 已完成');
  await expect(root(page, independent.id)).toHaveCount(0);
  await expect(root(page, completedRoot.id)).toHaveCount(0);
  const chainsCompleted = page.getByRole('checkbox', { name: '显示已完成任务链（1）' });
  await chainsCompleted.check();
  await expect(root(page, completedRoot.id)).toBeVisible();
  await expect(viewTab(page, '任务链').locator('.graph-count-pill')).toHaveText('25');
  await root(page, predecessor.id).click();
  await expect(inspectTask(page, predecessor.id)).toBeVisible();
  await expect(inspectTask(page, dependent.id)).toBeVisible();
  await expect(inspectTask(page, dependent.id).locator('.graph-blocked-badge')).toHaveCount(0);
  await test.step('isolates the graph modal and restores list scrolling across outer project views', async () => {
    const beforeResize = await page.locator('.react-flow__viewport').getAttribute('style');
    const canvas = await page.locator('.task-graph-canvas').elementHandle();
    const viewportElement = await page.locator('.react-flow__viewport').elementHandle();
    const listRow = await root(page, predecessor.id).elementHandle();
    expect(canvas).not.toBeNull();
    expect(viewportElement).not.toBeNull();
    expect(listRow).not.toBeNull();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(() => page.locator('.react-flow__viewport').getAttribute('style')).not.toBe(beforeResize);
    const chosenViewport = await page.locator('.react-flow__viewport').getAttribute('style');
    await page.setViewportSize({ width: 1100, height: 360 });
    await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', chosenViewport!);
    expect(await canvas!.evaluate((element) => element === document.querySelector('.task-graph-canvas'))).toBe(true);
    expect(await viewportElement!.evaluate((element) => element === document.querySelector('.react-flow__viewport'))).toBe(true);
    expect(await page.locator('.sidebar').evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    const lockedScroll = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 200);
    expect(await page.evaluate(() => window.scrollY)).toBe(lockedScroll);
    await closeChain(page);
    await expect(root(page, predecessor.id)).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(lockedScroll);
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    const beforeSidebarReads = syncReads;
    const sidebar = page.locator('.sidebar');
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(190);
    await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(68);
    expect(await listRow!.evaluate((element, id) => element === document.getElementById(`task-root-${id}`), predecessor.id)).toBe(true);
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(190);
    expect(syncReads).toBe(beforeSidebarReads);
    const beforeSwitchReads = syncReads;
    await page.evaluate(() => window.scrollTo(0, 540));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(540);
    await activateViewWithoutScrolling(page, '概览');
    await expect(page.getByRole('tabpanel', { name: '概览', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '项目任务统计', exact: true })).toBeVisible();
    await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
    const overviewExtent = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(overviewExtent).toBeGreaterThan(30);
    const overviewTop = Math.min(120, overviewExtent);
    await page.evaluate((top) => window.scrollTo(0, top), overviewTop);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(overviewTop);
    expect(await page.evaluate((id) => JSON.parse(localStorage.getItem(`daynight:task-view-scroll:${id}`)!).chains, project.id)).toBe(540);
    await activateViewWithoutScrolling(page, '任务列表');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(540);
    await expectClosedChain(page, predecessor.id);
    expect(await listRow!.evaluate((element, id) => element === document.getElementById(`task-root-${id}`), predecessor.id)).toBe(true);
    await activateViewWithoutScrolling(page, '概览');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(overviewTop);
    await activateViewWithoutScrolling(page, '任务列表');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(540);
    expect(syncReads).toBe(beforeSwitchReads);
    await canvas!.dispose();
    await viewportElement!.dispose();
    await listRow!.dispose();
    await page.setViewportSize({ width: 1100, height: 700 });
  });
  await test.step('navigates from whole-project progress without restoring stale task positions', async () => {
    const beforeProgressReads = syncReads;
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await activateViewWithoutScrolling(page, '独立任务');
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);
    await activateViewWithoutScrolling(page, '概览');
    const progress = page.getByRole('region', { name: '整体进度', exact: true });
    const progressRows = progress.getByRole('button');
    const chainProgress = progress.getByRole('button', { name: `${predecessor.title}，已完成 1 / 2，50%，前往任务列表`, exact: true });
    const standaloneProgress = progress.getByRole('button', { name: '独立任务，已完成 1 / 22，4%，前往任务列表', exact: true });
    await expect(progressRows).toHaveCount(14);
    await expect(chainProgress).toBeVisible();
    await expect(progress.getByText(completedRoot.title, { exact: true })).toHaveCount(0);
    await expect(progressRows.last()).toHaveAccessibleName('独立任务，已完成 1 / 22，4%，前往任务列表');
    await expect(standaloneProgress).toContainText('未完成任务 + 最近 7 天完成的任务');
    expect(await page.locator('.stats .stat').allTextContents()).toEqual(statistics);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(chainProgress.locator('.overview-progress-metric')).toContainText('1 / 2');
      await expect(standaloneProgress.locator('.overview-progress-percent')).toHaveText('4%');
    }
    await screenshot(page, info, 'project-overview-progress-narrow');
    await page.setViewportSize({ width: 1100, height: 700 });
    await chainProgress.evaluate((button: HTMLElement) => button.focus({ preventScroll: true }));
    const overviewPosition = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Enter');
    await expect(viewTab(page, '任务链')).toHaveAttribute('aria-selected', 'true');
    await expect(root(page, predecessor.id)).toBeFocused();
    await expect(root(page, predecessor.id)).toBeInViewport();
    await expect(root(page, predecessor.id)).toHaveClass(/overview-progress-target/);
    await expectClosedChain(page, predecessor.id);
    const chainPosition = await page.evaluate(() => window.scrollY);
    expect(chainPosition).toBeGreaterThan(0);
    await activateViewWithoutScrolling(page, '概览');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(overviewPosition);
    await activateViewWithoutScrolling(page, '任务列表');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(chainPosition);
    await activateViewWithoutScrolling(page, '概览');
    await standaloneProgress.evaluate((button: HTMLElement) => button.focus({ preventScroll: true }));
    const standaloneOverviewPosition = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Enter');
    await expect(viewTab(page, '独立任务')).toHaveAttribute('aria-selected', 'true');
    const standalonePanel = page.getByRole('tabpanel', { name: '独立任务', exact: true });
    await expect(standalonePanel).toBeFocused();
    await expect(standalonePanel).toBeInViewport();
    await expect(standalonePanel).toHaveClass(/overview-progress-target/);
    await expect(page.locator('.task-chain-dialog')).toHaveCount(0);
    const standalonePosition = await page.evaluate(() => window.scrollY);
    expect(standalonePosition).not.toBe(600);
    await activateViewWithoutScrolling(page, '概览');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(standaloneOverviewPosition);
    await activateViewWithoutScrolling(page, '任务列表');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(standalonePosition);
    expect(syncReads).toBe(beforeProgressReads);
    await activateViewWithoutScrolling(page, '任务链');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await viewTab(page, '独立任务').click();
  await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
  await expect(page.locator('.root-toggle')).toHaveCount(0);
  await expect(standalone(page, predecessor.id)).toHaveCount(0);
  await expect(standalone(page, dependent.id)).toHaveCount(0);
  await expect(standalone(page, independent.id)).toBeVisible();
  await expect(page.locator('.standalone-row')).toHaveCount(21);
  const standaloneCompleted = page.getByRole('checkbox', { name: '显示已完成独立任务（1）' });
  await expect(standaloneCompleted).not.toBeChecked();
  await standaloneCompleted.check();
  await expect(standalone(page, completedIndependent.id)).toBeVisible();
  await expect(viewTab(page, '独立任务').locator('.graph-count-pill')).toHaveText('21');
  const trigger = standalone(page, independent.id);
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.locator('.task-detail-title')).toHaveText(independent.title);
  await expect(dialog.getByRole('button', { name: '关闭任务详情', exact: true })).toBeFocused();
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  const retainedDetail = await dialog.elementHandle();
  for (const width of [390, 1100]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(dialog.locator('.task-detail-title')).toHaveText(independent.title);
    expect(await retainedDetail!.evaluate((element) => element === document.querySelector('.task-detail-dialog'))).toBe(true);
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  }
  await retainedDetail!.dispose();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  expect(await page.locator('.stats .stat').allTextContents()).toEqual(statistics);

  await page.evaluate(() => window.scrollTo(0, 320));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(320);
  await activateViewWithoutScrolling(page, '任务链');
  await expect(chainsCompleted).toBeChecked();
  await expectClosedChain(page, predecessor.id);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await openChain(page, predecessor.id);
  await expect(inspectTask(page, dependent.id)).toBeVisible();
  await closeChain(page);
  await page.evaluate(() => window.scrollTo(0, 540));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(540);
  await activateViewWithoutScrolling(page, '独立任务');
  await expect(standaloneCompleted).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(320);
  await standaloneCompleted.evaluate((checkbox: HTMLInputElement) => checkbox.focus({ preventScroll: true }));
  await page.keyboard.press('Space');
  await activateViewWithoutScrolling(page, '任务链');
  await expect(chainsCompleted).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(540);
  await activateViewWithoutScrolling(page, '独立任务');
  await expect(standaloneCompleted).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(320);
  const membersUrl = `**/api/v1/projects/${project.id}/members`;
  let releaseMembers!: () => void;
  let markMembersRequestStarted!: () => void;
  const membersResponseGate = new Promise<void>((resolve) => { releaseMembers = resolve; });
  const membersRequestStarted = new Promise<void>((resolve) => { markMembersRequestStarted = resolve; });
  await page.route(membersUrl, async (route) => {
    markMembersRequestStarted();
    await membersResponseGate;
    await route.continue();
  });
  try {
    await page.reload();
    await expect(page.getByRole('tab', { name: '任务列表', exact: true })).toHaveAttribute('aria-selected', 'true');
    await membersRequestStarted;
    await expect(viewTab(page, '独立任务')).toHaveAttribute('aria-selected', 'true');
    await expect(standaloneCompleted).not.toBeChecked();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(320);
    const projectHeading = page.locator('.project-heading');
    const headingBeforeMembership = await projectHeading.boundingBox();
    expect(headingBeforeMembership).not.toBeNull();
    releaseMembers();
    await expect(page.getByRole('link', { name: '项目设置', exact: true })).toBeVisible();
    expect(await projectHeading.boundingBox()).toEqual(headingBeforeMembership);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(320);
  } finally {
    releaseMembers();
    await page.unroute(membersUrl);
  }

  const other = await createProject(request, { name: `Other task views ${randomUUID()}` });
  await createTask(request, other.id, { title: '另一项目的独立任务' });
  await openTaskProject(page, other.id, other.name);
  await expect(viewTab(page, '任务链')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: '暂无任务链', exact: true })).toBeVisible();
  await openProject(page, project.id, project.name);
  await expect(page.getByRole('tab', { name: '任务列表', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(viewTab(page, '独立任务')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(320);

  independent = await updateTask(request, project.id, independent.id, { version: independent.version, dependsOn: [predecessor.id] });
  const joinedSync = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
  await standalone(page, independent.id).click();
  expect((await joinedSync).status()).toBe(200);
  await expect(dialog.locator('.task-detail-title')).toHaveText(independent.title);
  await expect(standalone(page, independent.id)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.standalone-row').first()).toBeFocused();
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  await expect(viewTab(page, '任务链').locator('.graph-count-pill')).toHaveText('26');
  await expect(viewTab(page, '独立任务').locator('.graph-count-pill')).toHaveText('20');
  await viewTab(page, '任务链').click();
  await openChain(page, predecessor.id);
  await expect(inspectTask(page, independent.id)).toBeVisible();
  independent = await updateTask(request, project.id, independent.id, { version: independent.version, dependsOn: [] });
  const splitSync = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
  await details(page, independent.id).click();
  expect((await splitSync).status()).toBe(200);
  await expect(dialog.locator('.task-detail-title')).toHaveText(independent.title);
  await expect(inspectTask(page, independent.id)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.task-chain-close')).toBeFocused();
  await closeChain(page);
  await expect(root(page, predecessor.id)).toBeFocused();
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  await expect(viewTab(page, '任务链').locator('.graph-count-pill')).toHaveText('25');
  await expect(viewTab(page, '独立任务').locator('.graph-count-pill')).toHaveText('21');
  await viewTab(page, '独立任务').click();
  await expect(standalone(page, independent.id)).toBeVisible();
  await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
  await screenshot(page, info, 'project-view-tabs');
  await test.step('restores the desktop sidebar preference after reload, project navigation and reopening', async () => {
    await page.getByRole('button', { name: '折叠侧栏', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'))).toBe('true');
    await page.reload();
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(68);
    await page.locator('.sidebar a.nav-button[href="/"]').click();
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await loadAllProjects(page);
    await page.locator(`a.project-card[href="/projects/${other.id}"]`).click();
    await expect(page.getByRole('heading', { name: other.name, exact: true })).toBeVisible();
    await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(68);
    const reopened = await page.context().newPage();
    try {
      await reopened.setViewportSize({ width: 1440, height: 900 });
      await reopened.goto(`/projects/${project.id}`);
      await expect(reopened.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
      await expect.poll(async () => (await reopened.locator('.sidebar').boundingBox())?.width).toBe(68);
    } finally { await reopened.close(); }
  });
});

test('detail-navigation', scenario('detail-navigation'), async ({ page, api: request }, info) => {
  await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
  const project = await createProject(request, { name: `Details ${randomUUID()}` });
  const a = await createTask(request, project.id, { title: '前置 <script>文本</script>', description: '前置说明' });
  await executeTask(request, project.id, a);
  const title = '完整标题 😀 '.repeat(24);
  const description = '第一行\n<img src=x onerror=alert(1)>\n<script>window.leaked=true</script>\n最后一行';
  const ownURL = new URL(`/projects/${project.id}`, info.project.use.baseURL as string).href;
  const pullRequests = [
    { title: '服务端关联', url: ownURL },
    { title: '', url: '' },
    { title: '  标题\n\t\0保留  ', url: '  arbitrary\n\t\0address  ' },
    { title: '<img src=x onerror=window.leaked=true>', url: '<script>window.leaked=true</script>' },
    { title: '脚本字符串', url: 'javascript:window.leaked=true' },
    { title: '数据字符串', url: 'data:text/html,<script>window.leaked=true</script>' },
    { title: '自定义协议', url: 'review:example/123' },
    { title: '相对引用', url: '/pull/123' },
    { title: '损坏地址', url: 'https://[' },
    { title: '服务端关联', url: ownURL },
    ...Array.from({ length: 190 }, (_, index) => ({ title: `保留序号 ${index + 11}`, url: `reference ${index + 11}` })),
    { title: '', url: '' },
    { title: '  后页\n\t\0原值  ', url: '  late arbitrary\0URL  ' },
    { title: '后页重复关联', url: ownURL },
    { title: '后页重复关联', url: ownURL },
    { title: '<img src=x onerror=window.leaked=true>', url: 'javascript:window.leaked=true' },
  ];
  const b = await createTask(request, project.id, { title, description, dependsOn: [a.id], properties: { pullRequests } });
  expect(b.properties.pullRequests).toEqual(pullRequests);
  const c = await createTask(request, project.id, { title: '快照中的后续', description: '后续描述', dependsOn: [b.id] });
  await openTaskProject(page, project.id, project.name);
  await openChain(page, a.id);
  await pauseRefreshClock(page);
  const graphResponse = await request.get(`/api/v1/projects/${project.id}/task-graph`);
  expect(graphResponse.status()).toBe(200);
  const graph = await graphResponse.json() as { tasks: Record<string, unknown>[] };
  expect(graph.tasks.every((task) => !Object.hasOwn(task, 'properties'))).toBe(true);
  const unknown = await createTask(request, project.id, { title: '图快照外的新任务', description: '最新详情可读取' });
  await updateTask(request, project.id, b.id, { version: b.version, dependsOn: [a.id, unknown.id] });
  let detailReads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/v1/projects/${project.id}/tasks/${b.id}`) detailReads++; });
  const admission = await holdProjectSync(page, project.id);
  const admittedSync = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
  await details(page, b.id).click();
  const dialog = page.locator('.task-detail-dialog');
  try {
    await admission.requested();
    await expect(dialog.locator('.task-detail-title')).toHaveText('正在加载任务详情');
    await expect(dialog.locator('.task-description')).toHaveCount(0);
    await expect(dialog.locator('.task-detail-status-row .task-status-trigger')).toHaveCount(0);
    await expect(stat(page, '任务总数')).toHaveText('3');
    admission.release();
    expect((await admittedSync).status()).toBe(200);
    await expect(stat(page, '任务总数')).toHaveText('4');
  } finally { await admission.close(); }
  await expect(dialog.locator('.task-detail-title')).toHaveText(title);
  expect(await dialog.getByRole('region', { name: '描述', exact: true }).locator('.task-description').textContent()).toBe(description);
  await expect(dialog.locator('.task-detail-full-id > span').first()).toHaveText(b.id);
  await expect(dialog.locator('time')).toHaveCount(2);
  await expect(dialog.locator('img,script')).toHaveCount(0);
  const properties = await checkPullRequests(dialog, pullRequests);
  const links = properties.getByRole('link');
  await expect(links).toHaveCount(2);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute('href', ownURL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  const opened = page.waitForEvent('popup');
  await links.first().click();
  const popup = await opened;
  try {
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toBe(ownURL);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  } finally { await popup.close(); }
  expect(await page.evaluate(() => 'leaked' in window)).toBe(false);
  const pageSelection = properties.getByRole('combobox', { name: '关联 PR 页码' });
  const nextPage = properties.getByRole('button', { name: '下一页' });
  const previousPage = properties.getByRole('button', { name: '上一页' });
  await expect(previousPage).toBeDisabled();
  await nextPage.click();
  await checkPullRequests(dialog, pullRequests, 1);
  await nextPage.click();
  await checkPullRequests(dialog, pullRequests, 2);
  await expect(nextPage).toBeDisabled();
  await expect(pageSelection).toBeFocused();
  await previousPage.click();
  await checkPullRequests(dialog, pullRequests, 1);
  await pageSelection.selectOption('2');
  await checkPullRequests(dialog, pullRequests, 2);
  await pageSelection.selectOption('0');
  await checkPullRequests(dialog, pullRequests);
  expect(detailReads, 'Local pagination reads no additional task data').toBe(1);
  await pageSelection.selectOption('2');
  await checkPullRequests(dialog, pullRequests, 2);
  await page.keyboard.press('Tab');
  await expect(properties.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(pageSelection).toBeFocused();
  await expect(dialog.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${a.title}，普通依赖`, exact: true })).toBeVisible();
  const unknownReference = dialog.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${unknown.title}，普通依赖`, exact: true });
  await expect(unknownReference).toBeVisible();
  await expect(dialog.getByRole('region', { name: '任务图快照中的直接后续', exact: true }).getByRole('button', { name: `${c.title}，普通依赖`, exact: true })).toBeVisible();
  await dialog.getByRole('region', { name: '任务图快照中的直接后续', exact: true }).getByRole('button', { name: `${c.title}，普通依赖`, exact: true }).click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(c.title);
  await checkPullRequests(dialog, []);
  await expect(dialog.getByText('暂无关联 PR', { exact: true })).toBeVisible();
  await dialog.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${Array.from(title).slice(0, 160).join('')}…，普通依赖`, exact: true }).click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(title);
  await checkPullRequests(dialog, pullRequests);
  await dialog.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${unknown.title}，普通依赖`, exact: true }).click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(unknown.title);
  await expect(dialog.getByText('当前任务尚未包含在任务图中，请刷新任务图以查看后续关系。')).toHaveCount(0);
  await expect(stat(page, '任务总数')).toHaveText('4');
  await screenshot(page, info, 'detail-navigation');
});

test('refresh-staleness', scenario('refresh-staleness'), async ({ page, api: request, baseURL, allowAttachmentWrites }, info) => {
  await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
  const project = await createProject(request, { name: `Freshness ${randomUUID()}` });
  const predecessor = await createTask(request, project.id, { title: '完成后解除阻塞的前置' });
  const dependent = await createTask(request, project.id, {
    title: '版本和时间保持不变的后续', dependsOn: [predecessor.id],
    description: Array.from({ length: 24 }, (_, index) => `阅读记录 ${index + 1}：后台读取期间持续保留正文滚动位置、当前页签、键盘焦点和附件工作区。`).join('\n\n'),
  });
  await openTaskProject(page, project.id, project.name);
  await openChain(page, predecessor.id);
  await expect(stat(page, '已完成')).toHaveText('0');
  await expect(stat(page, '被阻塞')).toHaveText('1');
  await expect(root(page, predecessor.id).locator('.root-status')).toHaveText('待处理');
  await expect(root(page, predecessor.id).locator('.root-progress-label')).toHaveText('0/2 已完成');
  await expect(inspectTask(page, dependent.id).locator('.graph-blocked-badge')).toBeVisible();
  await pauseRefreshClock(page);
  await executeTask(request, project.id, predecessor);
  const currentResponse = await request.get(`/api/v1/projects/${project.id}/tasks/${dependent.id}`);
  expect(currentResponse.status()).toBe(200);
  const current = await currentResponse.json() as typeof dependent;
  expect(current.version).toBe(dependent.version);
  expect(current.updatedAt).toBe(dependent.updatedAt);
  expect(current.ready).toBe(true);
  expect(current.blockedBy).toEqual([]);
  await inspectTask(page, dependent.id).click();
  await expect(inspectTask(page, dependent.id)).toHaveAttribute('aria-pressed', 'true');
  const derivedSync = await holdProjectSync(page, project.id);
  const derivedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
  await details(page, dependent.id).click();
  const dialog = page.locator('.task-detail-dialog');
  try {
    await derivedSync.requested();
    await expect(dialog.locator('.task-detail-title')).toHaveText(dependent.title);
    await expect(dialog.locator('.task-detail-blocked')).toHaveText('被阻塞');
    await expect(dialog.getByText('任务详情与当前任务图不同，刷新后可查看一致的进度和关系。')).toBeVisible();
    await expect(dialog.locator('.task-detail-status-row .task-status-trigger')).toBeDisabled();
    await expect(stat(page, '已完成')).toHaveText('0');
    await expect(stat(page, '被阻塞')).toHaveText('1');
    await expect(root(page, predecessor.id).locator('.root-status')).toHaveText('待处理');
    derivedSync.release();
    expect((await derivedResponse).status()).toBe(200);
  } finally { await derivedSync.close(); }
  await expect(stat(page, '已完成')).toHaveText('1');
  await expect(stat(page, '被阻塞')).toHaveText('0');
  await expect(root(page, predecessor.id).locator('.root-status')).toHaveText('进行中');
  await expect(root(page, predecessor.id).locator('.root-progress-label')).toHaveText('1/2 已完成');
  await expect(inspectTask(page, predecessor.id).locator('.graph-status')).toHaveText('已完成');
  await expect(dialog.locator('.task-detail-title')).toHaveText(dependent.title);
  await expect(dialog.locator('.task-detail-ready')).toHaveText('可开始');
  await expect(dialog.locator('.task-detail-stale')).toHaveCount(0);
  await expect(inspectTask(page, dependent.id).locator('.graph-blocked-badge')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const pullRequests = Array.from({ length: 205 }, (_, index) => ({ title: `刷新前关联 ${index + 1}`, url: '  new arbitrary URL\0  ' }));
  let changed = await updateTask(request, project.id, dependent.id, { version: current.version, properties: { pullRequests } });
  expect(changed.properties.pullRequests).toEqual(pullRequests);
  const propertiesSync = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
  await details(page, dependent.id).click();
  expect((await propertiesSync).status()).toBe(200);
  await checkPullRequests(dialog, pullRequests);
  await expect(dialog.locator('.task-detail-stale')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: '关联 PR 页码' }).selectOption('2');
  await dialog.getByRole('combobox', { name: '关联 PR 页码' }).focus();
  await checkPullRequests(dialog, pullRequests, 2);
  const graphTransform = await page.locator('.react-flow__viewport').getAttribute('style');
  const pagePosition = await page.evaluate(() => window.scrollY);
  changed = await startTask(request, project.id, changed);
  expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
  await expect(stat(page, '进行中')).toHaveText('1');
  await expect(stat(page, '待处理')).toHaveText('0');
  await expect(inspectTask(page, dependent.id).locator('.graph-status')).toHaveText('进行中');
  await expect(inspectTask(page, dependent.id)).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('.task-detail-status-row .task-status-trigger')).toHaveAccessibleName('进行中');
  await expect(dialog.locator('.task-detail-stale')).toHaveCount(0);
  await checkPullRequests(dialog, pullRequests, 2);
  await expect(dialog.getByRole('combobox', { name: '关联 PR 页码' })).toBeFocused();
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', graphTransform!);
  expect(await page.evaluate(() => window.scrollY)).toBe(pagePosition);

  const originalViewport = page.viewportSize();
  if (originalViewport === null) throw new Error('Refresh acceptance requires a controlled viewport.');
  const viewports = [{ width: 1440, height: 900 }, { width: 320, height: 800 }, { width: 844, height: 390 }];
  const geometryEvidence: { panel: string; cycle: number; reading: Awaited<ReturnType<typeof expectStableAutomaticDetailRefresh>> }[] = [];
  const repeatedRefresh = async (panel: string, retained: () => Promise<void>): Promise<void> => {
    // The CSS opening animation is awaited separately from the mocked polling clock.
    await dialog.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    const unchanged = await expectStableAutomaticDetailRefresh(page, project.id, dependent.id, async () => {
      expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
    }, retained, false);
    geometryEvidence.push({ panel, cycle: 0, reading: unchanged });
    for (let cycle = 1; cycle <= 3; cycle++) {
      const reading = await expectStableAutomaticDetailRefresh(page, project.id, dependent.id, async () => {
        const previousVersion = changed.version;
        changed = await updateTask(request, project.id, dependent.id, { version: previousVersion,
          description: `${dependent.description}\n\n后台正文更新 ${panel}/${geometryEvidence.length}/${cycle}。` });
        expect(changed.version).toBe(previousVersion + 1);
        expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
      }, retained);
      geometryEvidence.push({ panel, cycle, reading });
    }
  };
  const overview = dialog.locator('.task-detail-panel-overview');
  const pagination = dialog.getByRole('combobox', { name: '关联 PR 页码' });
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.clock.runFor(250);
      const scrollTop = await overview.evaluate((element) => { element.scrollTop = 140; return element.scrollTop; });
      expect(scrollTop).toBeGreaterThan(0);
      await pagination.evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
      await repeatedRefresh('overview', async () => {
        await expect(pagination).toHaveValue('2');
        await expect(pagination).toBeFocused();
        expect(await overview.evaluate((element) => element.scrollTop)).toBe(scrollTop);
      });
    }
  } finally { await page.setViewportSize(originalViewport); }

  const previewPath = 'stable-preview.html';
  const previewResponse = await request.put(attachmentDownloadUrl(project.id, dependent.id, previewPath), {
    headers: { 'content-type': 'text/html' },
    data: '<!doctype html><html><body><button id="counter">0</button><script>document.querySelector("#counter").onclick = (event) => { event.target.textContent = String(Number(event.target.textContent) + 1); };</script></body></html>',
  });
  expect(previewResponse.status()).toBe(201);
  const attachmentTab = dialog.getByRole('tab', { name: '附件', exact: true });
  const attachmentPath = dialog.getByRole('textbox', { name: '目标相对路径', exact: true });
  await attachmentTab.click();
  await dialog.getByRole('button', { name: '刷新附件', exact: true }).click();
  await dialog.locator('.attachment-file').filter({ hasText: previewPath }).click();
  const frame = dialog.locator('.task-attachments iframe');
  await expect(frame).toHaveAttribute('src', attachmentPreviewUrl(project.id, dependent.id, previewPath));
  await frame.contentFrame().locator('#counter').click();
  await expect(frame.contentFrame().locator('#counter')).toHaveText('1');
  const frameElement = await frame.elementHandle();
  if (frameElement === null) throw new Error('The active attachment preview is absent.');
  await dialog.locator('.attachment-upload-disclosure>summary').click();
  const fileInput = dialog.getByLabel('选择一个文件', { exact: true });
  await fileInput.setInputFiles({ name: 'retained.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsubmitted attachment draft') });
  await attachmentPath.fill('draft/retained.txt');
  changed = await updateTask(request, project.id, dependent.id, { version: changed.version, title: '自动刷新后的任务标题' });
  expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
  await expect(dialog.locator('.task-detail-title')).toHaveText(changed.title);
  await expect(attachmentTab).toHaveAttribute('aria-selected', 'true');
  await expect(attachmentPath).toHaveValue('draft/retained.txt');
  await expect(attachmentPath).toBeFocused();
  expect(await fileInput.evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('retained.txt');
  const expectAttachmentRetained = async (uploadPending = false): Promise<void> => {
    await expect(attachmentTab).toHaveAttribute('aria-selected', 'true');
    await expect(uploadPending ? attachmentTab : attachmentPath).toBeFocused();
    await expect(attachmentPath).toHaveValue('draft/retained.txt');
    expect(await fileInput.evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('retained.txt');
    await expect(frame.contentFrame().locator('#counter')).toHaveText('1');
    expect(await frameElement.evaluate((element) => element.isConnected && element === document.querySelector('.task-attachments iframe'))).toBe(true);
    if (uploadPending) {
      await expect(fileInput).toBeDisabled();
      await expect(attachmentPath).toBeDisabled();
      await expect(dialog.getByRole('button', { name: '正在上传…', exact: true })).toBeDisabled();
    } else {
      expect(await attachmentPath.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 7]);
    }
  };
  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.clock.runFor(250);
      await attachmentPath.evaluate((input: HTMLInputElement) => { input.focus({ preventScroll: true }); input.setSelectionRange(2, 7); });
      await repeatedRefresh('attachments', expectAttachmentRetained);
    }
  } finally { await page.setViewportSize(originalViewport); }

  if (baseURL === undefined) throw new Error('Pending upload acceptance requires the exact product origin.');
  const uploadPath = 'draft/retained.txt';
  const uploadUrl = new URL(attachmentDownloadUrl(project.id, dependent.id, uploadPath), baseURL).href;
  allowAttachmentWrites([{ origin: new URL(baseURL).origin, method: 'PUT', projectId: project.id, taskId: dependent.id, path: uploadPath, count: 1 }]);
  const uploadFetched = deferred<void>();
  const uploadRelease = deferred<void>();
  const uploadFinished = deferred<void>();
  const uploadFailures: string[] = [];
  let uploadRequests = 0;
  page.on('requestfailed', (request) => { if (request.url() === uploadUrl) uploadFailures.push(request.failure()!.errorText); });
  const holdUpload: Parameters<Page['route']>[1] = async (route) => {
    if (route.request().method() !== 'PUT') { await route.fallback(); return; }
    uploadRequests++;
    try {
      const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      expect(response.status()).toBe(201);
      uploadFetched.resolve();
      await within(uploadRelease.promise, 'pending upload during automatic refresh', 60_000);
      await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
    } finally { uploadFinished.resolve(); }
  };
  await page.route(uploadUrl, holdUpload);
  try {
    const response = page.waitForResponse((response) => response.url() === uploadUrl && response.request().method() === 'PUT');
    await dialog.getByRole('button', { name: '上传文件', exact: true }).click();
    await within(uploadFetched.promise, 'real upload commit before retained pending response');
    await attachmentTab.focus();
    await repeatedRefresh('attachments-pending-upload', () => expectAttachmentRetained(true));
    expect(uploadRequests).toBe(1);
    expect(uploadFailures).toEqual([]);
    uploadRelease.resolve();
    expect((await response).status()).toBe(201);
    await expect(fileInput).toBeEnabled();
    await expect(fileInput).toHaveValue('');
    await expect(attachmentPath).toHaveValue('');
    await expect(dialog.getByRole('button', { name: '上传文件', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('heading', { name: uploadPath, exact: true })).toBeVisible();
  } finally {
    uploadRelease.resolve();
    if (uploadRequests > 0) await within(uploadFinished.promise, 'pending upload route cleanup');
    await page.unroute(uploadUrl, holdUpload);
    await frameElement.dispose();
  }
  await info.attach('automatic-detail-refresh-geometry', { body: Buffer.from(JSON.stringify(geometryEvidence)), contentType: 'application/json' });
  await dialog.getByRole('tab', { name: '概览', exact: true }).click();
  await checkPullRequests(dialog, pullRequests, 2);

  const successfulReceipt = await page.locator('.snapshot-time time').getAttribute('datetime');
  await withDependencyFailure(async () => {
    expect(await nextAutomaticRefresh(page, project.id)).toBe(500);
    await expect(page.getByRole('heading', { name: '刷新失败', includeHidden: true })).toBeVisible();
    await expect(page.locator('.snapshot-time time')).toHaveAttribute('datetime', successfulReceipt!);
    await expect(stat(page, '进行中')).toHaveText('1');
    await expect(dialog.locator('.task-detail-title')).toHaveText(changed.title);
    await checkPullRequests(dialog, pullRequests, 2);
  });
  expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
  await expect(page.locator('.snapshot-error')).toHaveCount(0);
  await expect(dialog.locator('.task-detail-title')).toHaveText(changed.title);
  await checkPullRequests(dialog, pullRequests, 2);
  const replacement = Array.from({ length: 101 }, (_, index) => ({ title: `刷新后关联 ${index + 1}`, url: 'arbitrary' }));
  const replaced = await updateTask(request, project.id, dependent.id, { version: changed.version, properties: { pullRequests: replacement } });
  expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
  await checkPullRequests(dialog, replacement);
  await expect(dialog.locator('.task-detail-stale')).toHaveCount(0);
  await expect(dialog.getByRole('tab', { name: '概览', exact: true })).toBeFocused();
  await screenshot(page, info, 'refresh-staleness');
  await page.keyboard.press('Escape');
  await finishTask(request, project.id, replaced);
  await expect(root(page, predecessor.id).locator('.root-status')).toHaveText('进行中');
  expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
  await expect(page.getByRole('heading', { name: '所有任务链已完成' })).toBeVisible();
  await expect(root(page, predecessor.id)).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '显示已完成任务链（1）' })).not.toBeChecked();
  await page.getByRole('button', { name: '显示已完成任务链', exact: true }).click();
  await expect(root(page, predecessor.id).locator('.root-status')).toHaveText('已完成');
  await expect(root(page, predecessor.id).locator('.root-progress-label')).toHaveText('2/2 已完成');
  await openChain(page, predecessor.id);
  await expect(inspectTask(page, predecessor.id).locator('.graph-status')).toHaveText('已完成');
  await expect(inspectTask(page, dependent.id).locator('.graph-status')).toHaveText('已完成');
  await screenshot(page, info, 'refresh-chain-complete');
});

test('failure-recovery', scenario('failure-recovery'), async ({ page, api: request }, info) => {
  await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
  const project = await createProject(request, { name: `Recovery ${randomUUID()}` });
  await openTaskProject(page, project.id, project.name);
  await expect(page.getByRole('heading', { name: '还没有任务' })).toBeVisible();
  await expect(stat(page, '任务总数')).toHaveText('0');
  const task = await createTask(request, project.id, { title: '已经全部完成' });
  await executeTask(request, project.id, task);
  const successor = await createTask(request, project.id, { title: '已经完成的后续', dependsOn: [task.id] });
  await executeTask(request, project.id, successor);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(stat(page, '任务总数')).toHaveText('2');
  await expect(stat(page, '已完成')).toHaveText('2');
  await selectOverview(page);
  await expect(page.getByText('完成比例 100%')).toBeVisible();
  await selectTaskList(page);
  await expect(page.getByRole('heading', { name: '所有任务链已完成' })).toBeVisible();
  await page.getByRole('button', { name: '显示已完成任务链', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '显示已完成任务链（1）' })).toBeFocused();
  await openChain(page, task.id);
  await expect(root(page, task.id).locator('.root-status')).toHaveText('已完成');
  await expect(inspectTask(page, task.id)).toBeVisible();
  await pauseRefreshClock(page);
  const receipt = await page.locator('.snapshot-time time').getAttribute('datetime');
  const dialog = page.locator('.task-detail-dialog');
  await withDependencyFailure(async () => {
    const failedDetail = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/tasks/${task.id}`);
    await details(page, task.id).click();
    const response = await failedDetail;
    expect(response.status()).toBe(500);
    await expect(dialog.getByRole('heading', { name: '任务详情加载失败' })).toBeVisible();
    await expectCenteredTaskDetail(page, dialog);
    await expect(dialog.getByRole('button', { name: '重试详情', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '关闭任务详情', exact: true })).toBeFocused();
    await expect(page.locator('.task-graph-canvas')).toBeVisible();
    await expect(stat(page, '任务总数')).toHaveText('2');
    await expect(stat(page, '已完成')).toHaveText('2');
    await expect(page.locator('.snapshot-time time')).toHaveAttribute('datetime', receipt!);
    await expect(page.locator('.snapshot-error')).toHaveCount(0);
  });
  const retriedDetail = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/tasks/${task.id}`);
  await dialog.getByRole('button', { name: '重试详情', exact: true }).click();
  expect((await retriedDetail).status()).toBe(200);
  await expect(dialog.locator('.task-detail-title')).toHaveText(task.title);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '关闭任务详情', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(details(page, task.id)).toBeFocused();
  await page.getByRole('button', { name: '放大', exact: true }).click();
  await withDependencyFailure(async () => {
    const failed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
    await page.clock.fastForward(5_000);
    const response = await failed;
    expect(response.status()).toBe(500);
    const body = await response.json() as { error: { requestId: string; code: string } };
    expect(body.error.code).toBe('internal_error');
    expect(response.headers()['x-request-id']).toBe(body.error.requestId);
    await info.attach('failure-request', { body: Buffer.from(JSON.stringify({ projectId: project.id, requestId: body.error.requestId, status: response.status() })), contentType: 'application/json' });
    await expect(page.getByRole('heading', { name: '刷新失败', includeHidden: true })).toBeVisible();
    await expect(page.getByText('仍显示上次成功读取的数据。')).toBeVisible();
    await expect(page.getByRole('alert', { includeHidden: true })).toContainText(body.error.requestId);
    await expect(stat(page, '任务总数')).toHaveText('2');
    await expect(stat(page, '已完成')).toHaveText('2');
    await expect(page.locator('.snapshot-time time')).toHaveAttribute('datetime', receipt!);
    await expect(page.getByRole('alert', { includeHidden: true })).not.toContainText('task_dependencies');
    await page.reload();
    await expect(page.getByRole('heading', { name: '项目加载失败' })).toBeVisible();
    await expect(page.getByRole('region', { name: '项目任务统计' })).toHaveCount(0);
  });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  await expect(stat(page, '已完成')).toHaveText('2');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await screenshot(page, info, 'failure-recovery');
  await page.goto(`/projects/${randomUUID()}`);
  await expect(page.getByRole('heading', { name: '项目不存在' })).toBeVisible();
  await expect(page.getByRole('region', { name: '项目任务统计' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回项目列表' })).toBeVisible();
});

test('deep-links', scenario('deep-links'), async ({ page, api: request }, info) => {
  const first = await createProject(request, { name: `Route first ${randomUUID()}` });
  const second = await createProject(request, { name: `Route second ${randomUUID()}` });
  await createTask(request, first.id, { title: '首项目任务' });
  await createTask(request, second.id, { title: '次项目任务' });
  await openProject(page, first.id, first.name);
  const reload = await page.reload();
  expect(reload?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
  await page.getByRole('link', { name: '← 项目', exact: true }).click();
  await loadAllProjects(page);
  await page.locator(`a.project-card[href="/projects/${second.id}"]`).click();
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();

  const fetched = deferred<void>();
  const release = deferred<void>();
  const pattern = (url: URL) => url.pathname === `/api/v1/projects/${first.id}/task-sync`;
  const aborted: string[] = [];
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname === `/api/v1/projects/${first.id}/task-sync`) aborted.push(request.failure()?.errorText ?? 'missing-error');
  });
  await page.route(pattern, async (route) => {
    const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    expect(response.status()).toBe(200);
    fetched.resolve();
    await within(release.promise, 'delayed graph response release', 30_000);
    if (route.request().failure() !== null) await route.abort('aborted');
    else await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
  });
  try {
    await page.evaluate((path) => { history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); }, `/projects/${first.id}`);
    await within(fetched.promise, 'real graph response fetch');
    await expect(page.getByRole('status', { name: '正在加载任务图' })).toBeVisible();
    await expect(page.getByRole('heading', { name: second.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '项目任务统计' })).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
    await expect.poll(() => aborted.length).toBe(1);
    expect(aborted[0]).toMatch(/ABORT|cancel/i);
    await info.attach('navigation-cancellation', { body: Buffer.from(JSON.stringify({ projectId: first.id, nextProjectId: second.id, failure: aborted[0] })), contentType: 'application/json' });
  } finally {
    release.resolve();
    await within(page.unrouteAll({ behavior: 'wait' }), 'delayed graph route cleanup');
  }
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toHaveCount(0);
  await page.goto('/projects/not-a-uuid');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
  await page.goto(`/projects/${second.id}`);
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  await screenshot(page, info, 'deep-links');
});

test('keyboard-focus', scenario('keyboard-focus'), async ({ page, api: request }, info) => {
  await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
  const project = await createProject(request, { name: `Keyboard ${randomUUID()}` });
  const a = await createTask(request, project.id, { title: '键盘前置任务' });
  await executeTask(request, project.id, a);
  const b = await createTask(request, project.id, { title: '键盘选择任务', dependsOn: [a.id], properties: {
    pullRequests: [{ title: '键盘可访问的 PR', url: 'https://example.com/pull/123' }],
  } });
  const c = await createTask(request, project.id, { title: '键盘后续任务', dependsOn: [b.id] });
  const branch = await createTask(request, project.id, { title: '保留原链根的另一分支', dependsOn: [a.id] });
  await openTaskProject(page, project.id, project.name);
  await pauseRefreshClock(page);
  const originalOverflow = await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }));
  await openChain(page, a.id);
  const trigger = details(page, b.id);
  let detailReads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/v1/projects/${project.id}/tasks/${b.id}`) detailReads++; });
  const enterFullscreen = page.getByRole('button', { name: '全屏查看', exact: true });
  await enterFullscreen.focus();
  await page.keyboard.press('Enter');
  const fullscreen = page.locator('.task-chain-dialog-fullscreen');
  const exitFullscreen = fullscreen.getByRole('button', { name: '退出全屏', exact: true });
  await expect(exitFullscreen).toBeFocused();
  expect(await root(page, a.id).evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
  expect(await page.getByRole('button', { name: '刷新', exact: true, includeHidden: true }).evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await fullscreen.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(exitFullscreen).toBeFocused();
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press('Tab');
    expect(await fullscreen.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.task-detail-dialog');
  const close = dialog.getByRole('button', { name: '关闭任务详情', exact: true });
  await expect(dialog.locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
  await expect(dialog.locator('.task-detail-title')).toHaveText(b.title);
  expect(detailReads).toBe(1);
  await expect(close).toBeFocused();
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  const taskTitle = dialog.locator('.task-detail-title');
  const statusAction = dialog.getByRole('button', { name: '待处理', exact: true });
  const moreActions = dialog.getByRole('button', { name: '更多任务操作', exact: true });
  const deleteTaskAction = dialog.getByRole('menuitem', { name: '删除任务', exact: true });
  const detailFullscreen = dialog.locator('.task-detail-fullscreen-toggle');
  const automation = dialog.getByRole('switch', { name: '自动执行', exact: true });
  const overviewTab = dialog.getByRole('tab', { name: '概览', exact: true });
  const executionPlatform = dialog.getByRole('combobox', { name: '执行平台', exact: true });
  await expect(dialog.getByRole('button', { name: '保存平台', exact: true })).toHaveCount(0);
  const copyTaskId = dialog.getByRole('button', { name: '复制任务 ID', exact: true });
  await page.keyboard.press('Tab');
  await expect(statusAction).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(executionPlatform).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(automation).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(overviewTab).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('link', { name: b.properties.pullRequests[0]!.url, exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(overviewTab).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(automation).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(executionPlatform).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(statusAction).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(moreActions).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(detailFullscreen).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(taskTitle).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(copyTaskId).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('region', { name: '任务图快照中的直接后续', exact: true }).getByRole('button', { name: `${c.title}，普通依赖`, exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(copyTaskId).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(taskTitle).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(detailFullscreen).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(moreActions).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  for (let index = 0; index < 9; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await detailFullscreen.click();
  await expect(detailFullscreen).toHaveAttribute('aria-pressed', 'true');
  await moreActions.click();
  await deleteTaskAction.click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(moreActions).toBeFocused();
  await expect(detailFullscreen).toHaveAttribute('aria-pressed', 'true');
  await statusAction.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(detailFullscreen).toHaveAttribute('aria-pressed', 'true');
  await statusAction.click();
  await page.getByRole('menuitemradio', { name: '已完成', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(detailFullscreen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(detailFullscreen).toHaveAttribute('aria-pressed', 'false');
  await expect(detailFullscreen).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(fullscreen).toBeVisible();
  await expect(trigger).toBeFocused();
  const reopenedDetail = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/tasks/${b.id}`);
  await page.keyboard.press('Space');
  expect((await reopenedDetail).status()).toBe(200);
  expect(await (await reopenedDetail).finished()).toBeNull();
  await expect(dialog.locator('.task-detail-title')).toHaveText(b.title);
  expect(detailReads).toBe(2);
  await close.click();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(fullscreen).toHaveCount(0);
  await expect(enterFullscreen).toBeFocused();
  expect(await root(page, a.id).evaluate((element) => element.closest('[inert]') !== null)).toBe(true);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.keyboard.press('Escape');
  await expectClosedChain(page, a.id);
  await expect(root(page, a.id)).toBeFocused();
  expect(await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }))).toEqual(originalOverflow);
  await openChain(page, a.id);

  await trigger.click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(b.title);
  const fetched = deferred<void>();
  const release = deferred<void>();
  const pattern = `**/api/v1/projects/${project.id}/tasks/${a.id}`;
  await page.route(pattern, async (route) => {
    const response = await authenticatedAPI(page.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
    expect(response.status()).toBe(200);
    fetched.resolve();
    await within(release.promise, 'delayed task response release', 30_000);
    if (route.request().failure() !== null) await route.abort('aborted');
    else await route.fulfill({ status: response.status(), headers: response.headers(), body: await response.body() });
  });
  try {
    await dialog.getByRole('region', { name: '前置依赖', exact: true }).getByRole('button', { name: `${a.title}，普通依赖`, exact: true }).click();
    await within(fetched.promise, 'real task response fetch');
    await expect(dialog.getByText('正在加载任务详情', { exact: true })).toBeVisible();
    await expectCenteredTaskDetail(page, dialog);
    await expect(close).toBeFocused();
    expect(await trigger.evaluate((button) => button === document.activeElement)).toBe(false);
    release.resolve();
    await expect(dialog.locator('.task-detail-title')).toHaveText(a.title);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  } finally {
    release.resolve();
    await within(page.unrouteAll({ behavior: 'wait' }), 'delayed task route cleanup');
  }
  await trigger.click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(b.title);
  await page.locator('.task-detail-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await closeChain(page);
  const completedVisibility = page.getByRole('checkbox', { name: '显示已完成任务链（0）' });
  await completedVisibility.check();
  await expect(completedVisibility).toBeChecked();
  let currentTask = b;
  for (const fullscreenMode of [false, true]) {
    await openChain(page, a.id);
    if (fullscreenMode) {
      currentTask = await updateTask(request, project.id, b.id, { version: currentTask.version, dependsOn: [a.id] });
      expect(await nextAutomaticRefresh(page, project.id)).toBe(200);
      // Changing ordinary membership rebuilds the bounded overview; this complete
      // four-task component has no hidden neighbor that needs an expansion footer.
      await expect(page.locator('.task-graph')).toHaveAttribute('data-visible-task-count', '4');
      await expect(page.locator('.task-graph')).toHaveAttribute('data-total-task-count', '4');
      await expect(page.locator('.react-flow__node')).toHaveCount(4);
      expect(await page.locator('.react-flow__node').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.id!).sort()))
        .toEqual([a.id, b.id, c.id, branch.id].sort());
      await expect(page.locator('.task-dependency-edge')).toHaveCount(3);
      await expect(page.locator('.task-node-expand')).toHaveCount(0);
      await expect(trigger).toBeVisible();
      await expect(inspectTask(page, c.id)).toBeVisible();
      await enterFullscreen.focus();
      await expect(enterFullscreen).toBeFocused();
      await page.keyboard.press('Enter');
    }
    currentTask = await updateTask(request, project.id, b.id, { version: currentTask.version, dependsOn: [] });
    await inspectTask(page, b.id).click();
    await expect(inspectTask(page, b.id)).toHaveAttribute('aria-pressed', 'true');
    const repartitioned = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
    await trigger.click();
    expect((await repartitioned).status()).toBe(200);
    await expect(dialog.locator('.task-detail-title')).toHaveText(b.title);
    await expect(trigger).toHaveCount(0);
    await expect(page.locator('.task-node-selected')).toHaveCount(0);
    if (fullscreenMode) await expect(page.locator('.task-chain-dialog-fullscreen')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    if (fullscreenMode) {
      await expect(fullscreen).toBeVisible();
      await expect(page.locator('.task-chain-close')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(fullscreen).toHaveCount(0);
      await expect(enterFullscreen).toBeFocused();
    } else await expect(page.locator('.task-chain-close')).toBeFocused();
    await closeChain(page);
    await expect(root(page, a.id)).toBeFocused();
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
    expect(await page.evaluate(() => ({ document: document.documentElement.style.overflow, body: document.body.style.overflow }))).toEqual(originalOverflow);
  }
  await screenshot(page, info, 'keyboard-focus');
});

test('narrow-layout', scenario('narrow-layout'), async ({ page, api: request }, info) => {
  const project = await createProject(request, { name: `窄屏项目 ${'很长的项目名称😀'.repeat(12)}` });
  const pullRequests = [
    { title: '  多行标题\n第二行\t\0  ', url: `https://example.com/${'long-path-'.repeat(500)}` },
    { title: '很长的 PR 标题😀'.repeat(150), url: '   '.repeat(500) },
    { title: '', url: '' },
    ...Array.from({ length: 98 }, (_, index) => ({ title: `窄屏关联 ${index + 4}`, url: `reference ${index + 4}` })),
  ];
  const a = await createTask(request, project.id, { title: `窄屏根 ${'很长的任务标题😀'.repeat(30)}`, description: '长描述 <img src=x>\n'.repeat(40), properties: { pullRequests } });
  await createTask(request, project.id, { title: '后续任务', dependsOn: [a.id] });
  const independent = await createTask(request, project.id, { title: `窄屏独立任务 ${'很长的独立任务标题😀'.repeat(30)}` });
  await page.setViewportSize({ width: 320, height: 800 });
  await openTaskProject(page, project.id, project.name);
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.stats .stat')).toHaveCount(6);
  await test.step('keeps mobile navigation temporary, modal and reachable in short viewports', async () => {
    const sidebar = page.locator('.sidebar');
    const workspace = page.locator('.workspace');
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'))).toBeNull();
    for (const viewport of [{ width: 390, height: 700 }, { width: 320, height: 360 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(60);
      await expect(sidebar.locator('a.account-nav')).toBeInViewport();
      const opener = page.getByRole('button', { name: '展开侧栏', exact: true });
      await expect(opener).toBeInViewport();
      const background = await workspace.boundingBox();
      const originalOverflow = await page.locator('body').evaluate((element) => element.style.overflow);
      const originalScroll = await page.evaluate(() => window.scrollY);
      await opener.click();
      const drawer = page.getByRole('dialog', { name: '工作空间导航', exact: true });
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(220);
      await expect(workspace).toHaveAttribute('inert', '');
      await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
      expect(await workspace.boundingBox()).toEqual(background);
      const firstLink = drawer.locator('a').first();
      const toggle = drawer.locator('button[aria-expanded="true"]');
      await toggle.focus();
      await page.keyboard.press('Tab');
      await expect(firstLink).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(toggle).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.sidebar[role="dialog"]')).toHaveCount(0);
      await expect(opener).toBeFocused();
      await expect(workspace).not.toHaveAttribute('inert', '');
      expect(await page.locator('body').evaluate((element) => element.style.overflow)).toBe(originalOverflow);
      expect(await page.evaluate(() => window.scrollY)).toBe(originalScroll);
      await opener.click();
      await page.locator('.sidebar-backdrop').click({ position: { x: viewport.width - 12, y: 20 } });
      await expect(opener).toBeFocused();
      await expect(workspace).not.toHaveAttribute('inert', '');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'))).toBeNull();
    }
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 700 });
    await expect(page.locator('.sidebar[role="dialog"]')).toHaveCount(0);
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(190);
    await expect(workspace).not.toHaveAttribute('inert', '');
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await page.setViewportSize({ width: 390, height: 700 });
    await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await sidebar.locator('a.account-nav').click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.locator('.sidebar[role="dialog"]')).toHaveCount(0);
    await expect(workspace).not.toHaveAttribute('inert', '');
    await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
    await expect(page.locator('#main-content')).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'))).toBeNull();
    await page.setViewportSize({ width: 320, height: 800 });
    await openTaskProject(page, project.id, project.name);
  });
  await expectClosedChain(page, a.id);
  await openChain(page, a.id);
  await expect.poll(async () => await page.locator('.task-chain-dialog').boundingBox()).toEqual({ x: 12, y: 12, width: 296, height: 776 });
  await page.getByRole('button', { name: '全屏查看', exact: true }).click();
  const fullscreen = page.locator('.task-chain-dialog-fullscreen');
  for (const width of [320, 768, 1280, 1440, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(async () => {
      const bounds = await fullscreen.boundingBox();
      return bounds !== null && Math.abs(bounds.x) <= 0.5 && Math.abs(bounds.y) <= 0.5
        && Math.abs(bounds.width - width) <= 0.5 && Math.abs(bounds.height - 800) <= 0.5;
    }).toBe(true);
    await expect(fullscreen.getByRole('button', { name: '退出全屏', exact: true })).toBeVisible();
    expect(await fullscreen.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await details(page, a.id).focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.task-detail-dialog');
  await expect(dialog.locator('.task-detail-title')).toHaveText(a.title);
  await expect(dialog.locator('.task-description')).toHaveText(a.description);
  await checkPullRequests(dialog, pullRequests);
  await dialog.getByRole('combobox', { name: '关联 PR 页码' }).selectOption('1');
  await checkPullRequests(dialog, pullRequests, 1);
  await dialog.getByRole('button', { name: '上一页' }).click();
  await checkPullRequests(dialog, pullRequests);
  await expect(dialog.getByRole('combobox', { name: '关联 PR 页码' })).toBeFocused();
  for (const width of [320, 768, 1280, 1440, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expectCenteredTaskDetail(page, dialog);
    await expectTaskDetailScroll(page, dialog);
  }
  await dialog.getByRole('button', { name: '关闭任务详情', exact: true }).focus();
  await expect(dialog.getByRole('button', { name: '关闭任务详情', exact: true })).toBeFocused();
  await screenshot(page, info, 'narrow-layout');
  await dialog.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(fullscreen).toHaveCount(0);
  await closeChain(page);
  await viewTab(page, '独立任务').click();
  await expect(standalone(page, independent.id)).toContainText(independent.title.slice(0, 6));
  await expect(page.locator('.task-graph-canvas')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await standalone(page, independent.id).click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(independent.title);
  await expectCenteredTaskDetail(page, dialog);
  await screenshot(page, info, 'narrow-standalone');
  await page.keyboard.press('Escape');
  await expect(standalone(page, independent.id)).toBeFocused();
  await test.step('shows startup storage failures and preserves an explicit save retry on narrow screens', async () => {
    await page.addInitScript(() => {
      const state = window as unknown as { sidebarStorageBlocked: { read: boolean; write: boolean } };
      state.sidebarStorageBlocked = { read: true, write: false };
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key === 'daynight.web.sidebar.collapsed' && state.sidebarStorageBlocked.read) throw new DOMException('Controlled sidebar read denial.', 'SecurityError');
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === 'daynight.web.sidebar.collapsed' && state.sidebarStorageBlocked.write) throw new DOMException('Controlled sidebar write denial.', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    });
    await page.setViewportSize({ width: 320, height: 500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.reload();
    const notice = page.locator('.sidebar-preference-notice');
    await expect(notice).toContainText('无法读取侧栏偏好');
    const retry = notice.getByRole('button', { name: '重试保存侧栏偏好', exact: true });
    await expect(retry).toBeInViewport();
    await page.evaluate(() => {
      const state = window as unknown as { sidebarStorageBlocked: { read: boolean; write: boolean } };
      state.sidebarStorageBlocked = { read: false, write: true };
    });
    await retry.click();
    await expect(notice).toContainText('侧栏偏好尚未保存');
    await expect(retry).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => { (window as unknown as { sidebarStorageBlocked: { write: boolean } }).sidebarStorageBlocked.write = false; });
    await retry.click();
    await expect(notice).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.sidebar.collapsed'))).toBe('false');
  });
});
