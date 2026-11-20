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
  const projectGate = Promise.withResolvers<void>();
  const revalidationGate = Promise.withResolvers<void>();
  const state = { viewer: TEST_VIEWER_ID, tasks: initial, writes: [] as string[], revoked: false, holdRevalidation: false, heldReads: 0, releaseRevalidation: revalidationGate.resolve, graphMode: 'normal' as 'normal' | 'pending' | 'error', releaseGraph: gate.resolve, projectMode: 'normal' as 'normal' | 'pending', releaseProject: projectGate.resolve, epoch: taskSyncEpoch(projectId), deletions: 0, holdReplacement: false, replacementHeld: false };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, targetProject = /^\/api\/v1\/projects\/([^/]+)/.exec(path)?.[1] ?? projectId, graph = graphFixture(state.tasks.map(task => ({ ...task, projectId: targetProject })));
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': state.viewer, ...extra } });
    if (state.holdRevalidation && (path === `/api/v1/projects/${targetProject}` || path === `/api/v1/projects/${targetProject}/access` || path === `/api/v1/projects/${targetProject}/task-sync`)) { state.heldReads++; await revalidationGate.promise; }
    if (state.revoked && (path === `/api/v1/projects/${targetProject}` || path === `/api/v1/projects/${targetProject}/access` || path === `/api/v1/projects/${targetProject}/task-sync`)) return send({ error: { code: 'not_found', message: 'Access removed', requestId: 'revoked' } }, 404);
    if (path === '/api/v1/me') return send({ id: state.viewer, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${targetProject}`) { if (state.projectMode === 'pending') await projectGate.promise; return send(graph.project); }
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: state.viewer, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${targetProject}/access`) return send(directAccessFixture(targetProject, state.viewer));
    if (path === `/api/v1/projects/${targetProject}/task-sync`) {
      if (state.graphMode === 'pending') await gate.promise;
      if (state.holdReplacement && taskSyncQuery(url).epoch === undefined) { state.replacementHeld = true; await gate.promise; }
      if (state.graphMode === 'error') return send({ error: { code: 'internal_error', message: 'unavailable', requestId: 'graph-failure' } }, 500);
      return send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch: targetProject === projectId ? state.epoch : taskSyncEpoch(targetProject), actorAccess: directAccessFixture(targetProject, state.viewer), versionForTask: task => state.tasks.find(item => item.id === task.id)!.version, propertiesForTask: task => state.tasks.find(item => item.id === task.id)!.properties }));
    }
    const base = `/api/v1/projects/${targetProject}/tasks/`;
    if (path.startsWith(base)) {
      const parts = path.slice(base.length).split('/'), detail = state.tasks.find(item => item.id === parts[0]);
      if (detail && parts.length === 1 && request.method() === 'DELETE') {
        state.tasks = state.tasks.filter(item => item.id !== detail.id).map(item => ({ ...item, dependsOn: item.dependsOn.filter(dep => dep !== detail.id), externalDependsOn: item.externalDependsOn.filter(dep => dep !== detail.id), blockedBy: item.blockedBy.filter(dep => dep !== detail.id), ready: item.status === 'todo' && item.blockedBy.filter(dep => dep !== detail.id).length === 0 }));
        state.epoch = id(900 + ++state.deletions);
        return route.fulfill({ status: 204, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
      }
      if (detail && parts.length === 1) return send(detail, 200, { 'Daynight-Task-Epoch': state.epoch });
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

test.describe('project settings navigation', () => {
  test.use({ hasTouch: true });
  for (const input of ['touch', 'keyboard', 'pointer'] as const) test(`opens the settings link with ${input}`, async ({ page }) => {
    await install(page, [row(10, 'Task')]);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/projects/${projectId}?tab=tasks`);
    const trigger = page.getByRole('button', { name: 'Project actions', exact: true });
    if (input === 'touch') await trigger.tap();
    else if (input === 'keyboard') { await trigger.focus(); await page.keyboard.press('Enter'); }
    else await trigger.click();
    const settings = page.getByRole('menuitem', { name: 'Project settings', exact: true });
    await expect(settings).toBeVisible();
    if (input === 'touch') await settings.tap();
    else if (input === 'keyboard') { await settings.focus(); await page.keyboard.press('Enter'); }
    else await settings.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`));
  });
});

for (const input of ['modified', 'middle'] as const) test(`project settings keeps native ${input} navigation`, async ({ page, context }) => {
  await install(page, [row(10, 'Task')]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('button', { name: 'Project actions', exact: true }).click();
  const settings = page.getByRole('menuitem', { name: 'Project settings', exact: true });
  const opened = context.waitForEvent('page');
  if (input === 'modified') await settings.click({ modifiers: ['Meta'] });
  else await settings.click({ button: 'middle' });
  const destination = await opened;
  try { await expect(destination).toHaveURL(new RegExp(`/projects/${projectId}/settings$`)); }
  finally { await destination.close(); }
  expect(new URL(page.url()).pathname).toBe(`/projects/${projectId}`);
});

test('omits settings from the narrow menu until the project loads', async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  state.projectMode = 'pending';
  await page.setViewportSize({ width: 320, height: 640 });
  try {
    await page.goto(`/projects/${projectId}?tab=tasks`);
    const trigger = page.getByRole('button', { name: 'Project actions', exact: true });
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Project settings', exact: true })).toHaveCount(0);
    state.projectMode = 'normal'; state.releaseProject();
    await expect(page.getByRole('menuitem', { name: 'Project settings', exact: true })).toBeVisible();
  } finally { state.releaseProject(); }
});

test('keeps the open menu during a background check and withdraws it after access is lost', async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  await page.setViewportSize({ width: 320, height: 640 });
  try {
    await page.goto(`/projects/${projectId}?tab=tasks`);
    const trigger = page.getByRole('button', { name: 'Project actions', exact: true });
    await trigger.click();
    const settings = page.getByRole('menuitem', { name: 'Project settings', exact: true });
    await expect(settings).toBeFocused();
    state.holdRevalidation = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.heldReads).toBeGreaterThan(0);
    await expect(settings).toBeVisible(); await expect(settings).toBeFocused();
    state.revoked = true; state.releaseRevalidation();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByText('https://github.com/example/project', { exact: true })).toHaveCount(0);
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Project settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'New Task', exact: true })).toBeDisabled();
    expect(state.writes).toEqual([]);
  } finally { state.releaseRevalidation(); }
});

for (const locale of ['en', 'zh-CN'] as const) test(`project heading menu fits narrow containers and preserves interactions in ${locale}`, async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  await page.setViewportSize({ width: 320, height: 640 });
  try {
    await page.goto(`/projects/${projectId}?tab=tasks`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    const labels = locale === 'en' ? { actions: 'Project actions', settings: 'Project settings', refresh: 'Refresh', refreshing: 'Refreshing…', task: 'New Task', goal: 'New Goal' } : { actions: '项目操作', settings: '项目设置', refresh: '刷新', refreshing: '正在刷新…', task: '新建 Task', goal: '新建 Goal' };
    const trigger = page.getByRole('button', { name: labels.actions, exact: true });
    const menu = page.getByRole('menu');
    const item = (name: string) => menu.getByRole('menuitem', { name, exact: true });
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(trigger).toBeVisible();
      const box = (await trigger.boundingBox())!;
      expect(box.width).toBe(44); expect(box.height).toBe(44);
      await trigger.click();
      await expect(menu.getByRole('menuitem')).toHaveText([labels.settings, labels.refresh, labels.task, labels.goal]);
      for (const name of [labels.settings, labels.refresh, labels.task, labels.goal]) {
        const bounds = (await item(name).boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await trigger.focus(); await page.keyboard.press('Space');
    const settings = item(labels.settings);
    await expect(settings).toHaveAttribute('href', `/projects/${projectId}/settings`);
    expect(await settings.evaluate(link => {
      let prevented = true;
      const observe = (event: Event) => { prevented = event.defaultPrevented; event.preventDefault(); };
      document.addEventListener('click', observe, { once: true });
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      return prevented;
    })).toBe(false);
    await trigger.click();
    await page.keyboard.press('End'); await expect(item(labels.goal)).toBeFocused();
    await page.keyboard.press('Home'); await expect(item(labels.settings)).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(item(labels.refresh)).toBeFocused();
    await page.keyboard.press('ArrowUp'); await expect(item(labels.settings)).toBeFocused();
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await trigger.click(); await page.locator('.project-heading h1').click();
    await expect(menu).toHaveCount(0);
    for (const key of ['Tab', 'Shift+Tab']) {
      await trigger.focus(); await page.keyboard.press(key);
      const expected = await page.evaluateHandle(() => document.activeElement);
      await trigger.focus(); await page.keyboard.press('Enter'); await page.keyboard.press(key);
      await expect(menu).toHaveCount(0);
      expect(await expected.evaluate(element => element === document.activeElement)).toBe(true);
      await expected.dispose();
    }
    for (const name of [labels.task, labels.goal]) {
      await trigger.click(); await item(name).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    }
    state.graphMode = 'pending'; await trigger.click(); await item(labels.refresh).click();
    await trigger.click();
    const busy = item(labels.refreshing);
    await expect(busy).toBeDisabled(); await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(item(labels.task)).toBeEnabled(); await expect(item(labels.goal)).toBeEnabled();
    state.graphMode = 'normal'; state.releaseGraph(); await expect(item(labels.refresh)).toBeEnabled();
    await page.keyboard.press('Escape');
    await trigger.click(); await item(labels.task).focus();
    for (const [width, compact] of [[420, true], [421, false]] as const) {
      await page.locator('.project-heading-container').evaluate((el, value) => { (el as HTMLElement).style.width = `${value}px`; }, width);
      if (compact) await expect(trigger).toBeVisible();
      else {
        await expect(trigger).toBeHidden(); await expect(menu).toHaveCount(0);
        await expect(page.getByRole('button', { name: labels.task, exact: true })).toBeFocused();
        for (const name of [labels.settings, labels.refresh, labels.task, labels.goal]) await expect(page.getByRole(name === labels.settings ? 'link' : 'button', { name, exact: true })).toBeVisible();
      }
    }
    await page.locator('.project-heading-container').evaluate(el => { (el as HTMLElement).style.width = '420px'; });
    await expect(trigger).toBeFocused();
    await page.locator('.project-heading-container').evaluate(el => { (el as HTMLElement).style.width = ''; });
    for (const width of [768, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(trigger).toBeHidden();
      await expect(page.getByRole('link', { name: labels.settings, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: labels.refresh, exact: true })).toBeVisible();
    }
    await page.setViewportSize({ width: 320, height: 640 });
    await page.locator('.project-heading h1').evaluate(el => { el.textContent = 'A very long project name '.repeat(5); });
    await page.locator('.project-repository-value').evaluate(el => { el.textContent = 'https://example.com/' + 'long-repository-name-'.repeat(10); });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await trigger.click();
    for (const name of [labels.settings, labels.refresh, labels.task, labels.goal]) {
      const bounds = (await item(name).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      expect(await item(name).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(state.writes).toEqual([]);
  } finally { state.releaseGraph(); }
});

for (const kind of ['Task', 'Goal'] as const) test(`keeps the ${kind} draft across the heading breakpoint`, async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/projects/${projectId}`);
  const trigger = page.getByRole('button', { name: 'Project actions', exact: true });
  await trigger.click(); await page.getByRole('menuitem', { name: `New ${kind}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const field = dialog.getByRole('textbox', { name: kind === 'Task' ? 'Title' : 'Name', exact: true }).first();
  await field.fill('A retained draft'); await field.focus();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(field).toHaveValue('A retained draft'); await expect(field).toBeFocused();
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(field).toHaveValue('A retained draft'); await expect(field).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  expect(state.writes).toEqual([]);
});

test('menu refresh exposes a failure and retry restores the graph', async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('button', { name: 'Project actions', exact: true })).toBeVisible();
  state.graphMode = 'error';
  await page.getByRole('button', { name: 'Project actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('graph-failure');
  state.graphMode = 'normal';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) {
  test(`project task category labels preserve word boundaries at narrow widths in ${locale}`, async ({ page }) => {
    const root = row(10, 'Chain root'), child = row(11, 'Chain child', [root.id]);
    const goal = detailFixture(projectId, id(12), { type: 'goal', title: 'Goal' });
    const state = await install(page, [root, child, row(13, 'Standalone'), goal]);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    const tabs = page.locator('.project-task-tabs');
    for (const view of ['standalone', 'chains', 'goals']) await expect(page.locator(`#project-task-tab-${view} .graph-count-pill`)).toHaveText('1');
    const names = locale === 'en' ? ['Standalone tasks', 'Task chains', 'Goals'] : ['独立任务', '任务链', 'Goal'];
    for (const width of [320, 375, 390, 768, 1360]) {
      await page.setViewportSize({ width, height: 800 });
      const geometry = await tabs.evaluate((element, labels) => {
        const bounds = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll<HTMLElement>('[role="tab"]')];
        return buttons.map((button, index) => {
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          while ((node = walker.nextNode()) && !node.textContent?.includes(labels[index]!)) { /* find the label, not its count */ }
          if (!node) throw new Error(`Missing label ${labels[index]}`);
          const start = node.textContent!.indexOf(labels[index]!);
          const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + labels[index]!.length);
          const labelLines = range.getClientRects().length;
          range.setEnd(node, start + labels[index]!.split(' ')[0]!.length);
          const firstWordLines = range.getClientRects().length;
          const rect = button.getBoundingClientRect(), pill = button.querySelector<HTMLElement>('.graph-count-pill')!;
          const pillRect = pill.getBoundingClientRect();
          return { labelLines, firstWordLines, top: rect.top, bottom: rect.bottom, width: rect.width,
            inStrip: rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
            pillFits: pill.scrollWidth <= pill.clientWidth + 1 && pillRect.left >= rect.left - 1 && pillRect.right <= rect.right + 1 };
        });
      }, names);
      expect(geometry).toHaveLength(3);
      for (const item of geometry) {
        expect(item.firstWordLines).toBe(1);
        if (width !== 320 || locale === 'zh-CN') expect(item.labelLines).toBe(1);
        expect(item.inStrip && item.pillFits && item.width > 0).toBe(true);
        expect(Math.abs(item.top - geometry[0]!.top)).toBeLessThan(1);
        expect(Math.abs(item.bottom - geometry[0]!.bottom)).toBeLessThan(1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // Keep the viewport wide while changing only the task content width.
    const gaps: number[] = [];
    for (const width of [420, 421]) {
      await tabs.evaluate((element, value) => { element.parentElement!.style.width = `${value}px`; }, width);
      gaps.push(await tabs.evaluate(element => Number.parseFloat(getComputedStyle(element).columnGap)));
      expect(await tabs.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    expect(gaps[0]).toBeLessThan(gaps[1]!);
    expect(state.writes).toEqual([]);
  });
}

test.describe('touch task tabs', () => {
  test.use({ hasTouch: true });
  test('tap selects each category on a narrow project page', async ({ page }) => {
    const state = await install(page, [row(1, 'Standalone')]);
    await page.setViewportSize({ width: 320, height: 800 }); await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').tap();
    for (const view of ['standalone', 'goals', 'chains']) {
      const tab = page.locator(`#project-task-tab-${view}`);
      await tab.tap(); await expect(tab).toHaveAttribute('aria-selected', 'true');
    }
    expect(state.writes).toEqual([]);
  });
});

test('project task tabs keep counts and focused selection visible in an overflowing strip', async ({ page }) => {
  const root = row(100, 'Chain root'), child = row(101, 'Chain child', [root.id]);
  const goals = Array.from({ length: 12 }, (_, i) => detailFixture(projectId, id(200 + i), { type: 'goal', title: `Goal ${i}` }));
  const state = await install(page, [root, child, ...goals]);
  await page.setViewportSize({ width: 320, height: 800 }); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const tabs = page.locator('.project-task-tabs'), first = page.locator('#project-task-tab-standalone'), last = page.locator('#project-task-tab-goals');
  await expect(first.locator('.graph-count-pill')).toHaveText('0');
  await expect(last.locator('.graph-count-pill')).toHaveText('12');
  // A larger browser font and narrow content exercise overflow without changing the viewport.
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await tabs.evaluate(element => { element.parentElement!.style.width = '200px'; });
  expect(await tabs.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await tabs.hover(); await page.mouse.wheel(500, 0);
  await expect.poll(() => tabs.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await first.focus(); const pageScroll = await position(page);
  await page.keyboard.press('End'); await expect(last).toBeFocused(); await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => tabs.evaluate(element => {
    const strip = element.getBoundingClientRect(), item = element.querySelector<HTMLElement>('#project-task-tab-goals')!.getBoundingClientRect();
    return item.left >= strip.left - 1 && item.right <= strip.right + 1;
  })).toBe(true);
  expect(await position(page)).toBe(pageScroll);
  await page.keyboard.press('Home'); await expect(first).toBeFocused(); await expect(first).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => tabs.evaluate(element => {
    const strip = element.getBoundingClientRect(), item = element.querySelector<HTMLElement>('#project-task-tab-standalone')!.getBoundingClientRect();
    return item.left >= strip.left - 1 && item.right <= strip.right + 1;
  })).toBe(true);
  expect(await position(page)).toBe(pageScroll);
  await page.keyboard.press('ArrowLeft'); await expect(last).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await tabs.evaluate(element => !element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab'); await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await tabs.evaluate(element => !element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab'); await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`unfinished Goal tab count and keyboard navigation at ${width}px in ${locale}`, async ({ page }) => {
    const goal = (n: number, changes: Partial<TaskDetail>) => detailFixture(projectId, id(n), { type: 'goal', title: `Goal ${n}`, ...changes });
    const state = await install(page, [
      goal(1, { status: 'todo' }),
      goal(2, { status: 'in_progress', startedAt: time }),
      goal(3, { status: 'done', completedAt: time }),
      goal(4, { status: 'cancelled', cancelledAt: time }),
    ]);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    await page.locator('#project-section-tab-tasks').click();
    const chain = page.locator('#project-task-tab-chains');
    const goalTab = page.locator('#project-task-tab-goals');
    const pill = goalTab.locator('.graph-count-pill');
    await expect(pill).toHaveText('2');
    await expect(pill).toHaveAttribute('title', locale === 'en' ? 'Unfinished Goal count' : '未完成 Goal 数');
    await expect(page.locator('#project-task-tab-standalone .graph-count-pill')).toHaveText('0');
    await expect(chain.locator('.graph-count-pill')).toHaveText('0');
    expect(await page.locator('.project-task-tabs').evaluate(tabs => {
      const box = tabs.getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && [...tabs.querySelectorAll<HTMLElement>('[role="tab"]')].every(tab => {
        const bounds = tab.getBoundingClientRect();
        return bounds.width > 0 && bounds.left >= box.left - 1 && bounds.right <= box.right + 1 && tab.scrollWidth <= tab.clientWidth + 1;
      });
    })).toBe(true);
    await chain.focus(); await page.keyboard.press('ArrowRight');
    await expect(goalTab).toBeFocused(); await expect(goalTab).toHaveAttribute('aria-selected', 'true');
    for (const n of [1, 2, 3, 4]) await expect(page.locator(`[data-goal-id="${id(n)}"]`)).toBeVisible();
    expect(state.writes).toEqual([]);
  });
}

for (const width of [1100, 390]) test(`project header and navigation survive a pending and failed graph at ${width}px`, async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  state.graphMode = 'pending';
  await page.setViewportSize({ width, height: 700 });
  try {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('heading', { name: '任务项目', exact: true })).toBeVisible();
    await expect(page.getByText('https://github.com/example/project', { exact: true })).toBeVisible();
    if (width === 390) await page.getByRole('button', { name: 'Project actions', exact: true }).click();
    await expect(page.getByRole(width === 390 ? 'menuitem' : 'link', { name: 'Project settings', exact: true })).toBeVisible();
    await expect(page.getByRole(width === 390 ? 'menuitem' : 'button', { name: 'New Task', exact: true })).toBeDisabled();
    if (width === 390) await page.keyboard.press('Escape');
    const overview = page.getByRole('tab', { name: 'Overview', exact: true });
    const tasks = page.getByRole('tab', { name: 'Task list', exact: true });
    await expect(page.locator('.project-section-tabs [role="tab"]')).toHaveCount(5);
    await expect(page.getByRole('status', { name: 'Loading task graph' })).toBeVisible();
    await tasks.click();
    await expect(tasks).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('textbox', { name: /search/i })).toBeVisible();
    state.graphMode = 'error'; state.releaseGraph();
    await expect(page.getByRole('alert')).toContainText('graph-failure');
    await expect(page.getByRole('heading', { name: '任务项目', exact: true })).toBeVisible();
    if (width === 390) await page.getByRole('button', { name: 'Project actions', exact: true }).click();
    await expect(page.getByRole(width === 390 ? 'menuitem' : 'link', { name: 'Project settings', exact: true })).toBeVisible();
    if (width === 390) await page.keyboard.press('Escape');
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

for (const width of [1100, 390]) test(`deleting a Goal member keeps the graph and viewport mounted at ${width}px`, async ({ page }) => {
  const goal = detailFixture(projectId, id(1), { type: 'goal', title: 'Release goal', ready: false });
  const first = { ...row(2, 'Deleted member'), parentId: goal.id };
  const second = { ...row(3, 'Remaining member', [first.id]), parentId: goal.id };
  const state = await install(page, [goal, first, second]);
  await page.setViewportSize({ width, height: 700 });
  try {
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    await page.locator('#project-task-tab-goals').click();
    await page.locator(`#project-goal-graph-${goal.id}`).click();
    const dialog = page.locator(`#task-graph-${goal.id}`), viewport = dialog.locator('.react-flow__viewport');
    const fullscreen = dialog.locator('.graph-fullscreen-toggle');
    await expect(dialog.locator('.react-flow__node')).toHaveCount(2);
    await expect(dialog.locator('.task-dependency-edge')).toHaveCount(1);
    const selected = dialog.locator(`.react-flow__node[data-id="${second.id}"] .task-node-body`);
    await selected.click(); await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await fullscreen.click(); await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
    const transform = await viewport.getAttribute('style');
    const trace = await page.evaluateHandle(() => {
      const graph = document.querySelector('.task-chain-dialog')!, canvas = graph.querySelector('.react-flow')!, viewport = graph.querySelector('.react-flow__viewport')!, workspace = document.querySelector('.project-tasks')!;
      const removed: Node[] = []; let loading = false;
      const observer = new MutationObserver(records => records.forEach(record => {
        removed.push(...record.removedNodes);
        for (const node of record.addedNodes) if (node.textContent?.includes('Loading task graph') || node.textContent?.includes('Refreshing')) loading = true;
      }));
      observer.observe(document.body, { childList: true, subtree: true });
      return { graph, canvas, viewport, workspace, intact: () => [graph, canvas, viewport, workspace].every(node => node.isConnected && !removed.some(removedNode => removedNode === node || removedNode.contains(node))), loading: () => loading, stop: () => observer.disconnect() };
    });
    await dialog.getByRole('button', { name: `${first.title}, Details` }).click();
    const detail = page.getByRole('dialog', { name: first.title });
    await detail.getByRole('button', { name: 'More task actions' }).click();
    await detail.getByRole('menuitem', { name: 'Delete task' }).click();
    state.holdReplacement = true;
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete and remove dependencies' }).click();
    await expect.poll(() => state.replacementHeld).toBe(true);
    await expect(detail).toHaveCount(0);
    await expect(dialog).toBeVisible(); await expect(viewport).toHaveAttribute('style', transform!);
    await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await fullscreen.focus(); const scroll = await position(page);
    state.releaseGraph();
    await expect(dialog.locator('.react-flow__node')).toHaveCount(1);
    await expect(dialog.locator('.task-dependency-edge')).toHaveCount(0);
    await expect(dialog.locator(`.react-flow__node[data-id="${first.id}"]`)).toHaveCount(0);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    await expect(fullscreen).toBeFocused(); await expect(viewport).toHaveAttribute('style', transform!);
    expect(await position(page)).toBe(scroll);
    state.holdReplacement = false;
    await dialog.getByRole('button', { name: `${second.title}, Details` }).click();
    const remaining = page.getByRole('dialog', { name: second.title });
    await remaining.getByRole('button', { name: 'More task actions' }).click();
    await remaining.getByRole('menuitem', { name: 'Delete task' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete and remove dependencies' }).click();
    await expect(dialog.locator('.react-flow__node')).toHaveCount(0);
    await expect(dialog.getByText('This Goal has no tasks.')).toBeVisible();
    await expect(viewport).toHaveAttribute('style', transform!);
    await expect(dialog).toHaveClass(/task-chain-dialog-fullscreen/);
    expect(await trace.evaluate(value => value.intact())).toBe(true);
    expect(await trace.evaluate(value => value.loading())).toBe(false);
    await trace.evaluate(value => value.stop()); await trace.dispose();
    expect(state.writes).toEqual([`DELETE /api/v1/projects/${projectId}/tasks/${first.id}`, `DELETE /api/v1/projects/${projectId}/tasks/${second.id}`]);
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

for (const width of [1100, 390]) test(`top-level project tabs share the painted scroll position at ${width}px`, async ({ page }) => {
  const chains = Array.from({ length: 25 }, (_, i) => [row(100 + i * 2, `Chain ${i}`), row(101 + i * 2, `Chain child ${i}`, [id(100 + i * 2)])]).flat();
  await install(page, chains);
  // The retired key would restore a different position in the old implementation.
  await page.addInitScript(project => localStorage.setItem(`daynight:task-list-scroll:${project}`, '320'), projectId);
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(400);
  const trace = await page.evaluateHandle(() => {
    let positions: number[] = [], active = false;
    const sample = () => { if (active) { positions.push(scrollY); requestAnimationFrame(sample); } };
    return {
      start: () => { positions = [scrollY]; active = true; requestAnimationFrame(sample); },
      stop: () => new Promise<number[]>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { positions.push(scrollY); active = false; resolve(positions); }))),
    };
  });
  const begin = () => trace.evaluate(value => value.start());
  const end = () => trace.evaluate(value => value.stop());
  const clickWithoutScrolling = (section: string) => page.locator(`#project-section-tab-${section}`).evaluate((element: HTMLElement) => element.click());
  const expectStable = (samples: number[], expected: number) => expect(samples).toEqual(samples.map(() => expected));
  try {
    await page.evaluate(() => scrollTo(0, 90)); await expect.poll(() => page.evaluate(() => scrollY)).toBe(90);
    await begin(); await clickWithoutScrolling('tasks'); await expect(page.locator('#project-section-tab-tasks')).toHaveAttribute('aria-selected', 'true');
    expectStable(await end(), 90);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(400);
    await page.evaluate(() => scrollTo(0, 400)); await expect.poll(() => page.evaluate(() => scrollY)).toBe(400);
    await page.locator('#project-section-tab-overview').evaluate((element: HTMLElement) => element.focus({ preventScroll: true }));
    await begin(); await page.keyboard.press('Enter'); await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expectStable(await end(), 400);
    await begin(); await page.goBack(); await expect(page.locator('#project-section-tab-tasks')).toHaveAttribute('aria-selected', 'true');
    expectStable(await end(), 400);
    await begin(); await page.goForward(); await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expectStable(await end(), 400);
    await page.evaluate(() => scrollTo(0, 90));
    await begin(); await clickWithoutScrolling('prs'); await expect(page.locator('#project-section-tab-prs')).toHaveAttribute('aria-selected', 'true');
    const prSamples = await end();
    expect(prSamples.every(value => value <= 90)).toBe(true);
    const prPosition = prSamples.at(-1)!;
    await begin(); await clickWithoutScrolling('overview'); await expect(page.locator('#project-section-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expectStable(await end(), prPosition);
    await page.evaluate(() => scrollTo(0, 400));
    await begin(); await clickWithoutScrolling('tags'); await expect(page.locator('#project-section-tab-tags')).toHaveAttribute('aria-selected', 'true');
    const shortSamples = await end(), clamped = shortSamples.at(-1)!;
    expect(clamped).toBeLessThan(400);
    expect(shortSamples.every(value => value >= clamped && value <= 400)).toBe(true);
    await begin(); await clickWithoutScrolling('tasks'); await expect(page.locator('#project-section-tab-tasks')).toHaveAttribute('aria-selected', 'true');
    expectStable(await end(), clamped);
  } finally { await trace.dispose(); }
});

test('project position survives reload and stays separate across projects and accounts', async ({ page }) => {
  const chains = Array.from({ length: 25 }, (_, i) => [row(100 + i * 2, `Chain ${i}`), row(101 + i * 2, `Chain child ${i}`, [id(100 + i * 2)])]).flat();
  const state = await install(page, chains), otherProject = id(32), otherViewer = id(998);
  const key = (project: string, user: string) => `daynight:project-scroll:${JSON.stringify([project, user])}`;
  await page.goto(`/projects/${projectId}`);
  await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
  await page.evaluate(() => scrollTo(0, 200));
  await expect.poll(() => page.evaluate(name => localStorage.getItem(name), key(projectId, TEST_VIEWER_ID))).toBe('200');
  await page.reload();
  await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
  await expect.poll(() => position(page)).toBe(200);
  await page.goto(`/projects/${otherProject}`);
  await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
  await page.evaluate(() => scrollTo(0, 300));
  await expect.poll(() => page.evaluate(name => localStorage.getItem(name), key(otherProject, TEST_VIEWER_ID))).toBe('300');
  await page.goto(`/projects/${projectId}`);
  await expect.poll(() => position(page)).toBe(200);
  state.viewer = otherViewer;
  await page.reload();
  await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
  await page.evaluate(() => scrollTo(0, 250));
  await expect.poll(() => page.evaluate(name => localStorage.getItem(name), key(projectId, otherViewer))).toBe('250');
  expect(await page.evaluate(name => localStorage.getItem(name), key(projectId, TEST_VIEWER_ID))).toBe('200');
  state.viewer = TEST_VIEWER_ID;
  await page.reload();
  await expect.poll(() => position(page)).toBe(200);
});

test('loading and preference failures do not replace a saved position', async ({ page }) => {
  const chains = Array.from({ length: 25 }, (_, i) => [row(100 + i * 2, `Chain ${i}`), row(101 + i * 2, `Chain child ${i}`, [id(100 + i * 2)])]).flat();
  const state = await install(page, chains);
  const key = `daynight:project-scroll:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
  await page.addInitScript(name => localStorage.setItem(name, '320'), key);
  state.graphMode = 'pending';
  try {
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByRole('status', { name: 'Loading task graph' })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(await page.evaluate(name => localStorage.getItem(name), key)).toBe('320');
    state.releaseGraph();
    await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
    await expect.poll(() => position(page)).toBe(320);
  } finally { state.releaseGraph(); }
});

test('an unreadable scroll preference reports the failure and leaves navigation usable', async ({ page }) => {
  await install(page, [row(10, 'Task')]);
  await page.addInitScript(() => {
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (name.startsWith('daynight:project-scroll:')) throw new DOMException('Denied', 'SecurityError');
      return read.call(this, name);
    };
  });
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByText('The saved project browsing position could not be read. You can continue browsing.')).toBeVisible();
  await page.locator('#project-section-tab-tasks').evaluate((element: HTMLElement) => element.click());
  await expect(page.locator('#project-section-tab-tasks')).toHaveAttribute('aria-selected', 'true');
});

test('explicit overview location takes precedence over the shared position', async ({ page }) => {
  const chains = Array.from({ length: 25 }, (_, i) => [row(100 + i * 2, `Chain ${i}`), row(101 + i * 2, `Chain child ${i}`, [id(100 + i * 2)])]).flat();
  await install(page, chains);
  await page.goto(`/projects/${projectId}`);
  await expect(page.locator('#project-overview-progress .overview-progress-row')).toHaveCount(20);
  await page.evaluate(() => scrollTo(0, 90));
  const target = page.locator('#project-overview-progress .overview-progress-row').last();
  const targetTitle = await target.locator('.overview-progress-title').innerText();
  await target.evaluate((element: HTMLElement) => element.click());
  const selected = page.locator('#project-section-tab-tasks');
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  const located = page.locator('.overview-progress-target');
  await expect(located).toContainText(targetTitle);
  expect(await position(page)).not.toBe(90);
  await expect(located).toBeFocused();
});

for (const navigation of ['category', 'history'] as const) test(`cached task preview cancels a pending scroll restore on ${navigation} navigation`, async ({ page }) => {
  const chains = Array.from({ length: 25 }, (_, i) => [row(100 + i * 2, `Chain ${i}`), row(101 + i * 2, `Chain child ${i}`, [id(100 + i * 2)])]).flat();
  const standalone = Array.from({ length: 20 }, (_, i) => row(300 + i, `Standalone ${i}`));
  const state = await install(page, [...chains, ...standalone]);
  const key = `daynight:project-scroll:${JSON.stringify([projectId, TEST_VIEWER_ID])}`;
  try {
    await page.goto(`/projects/${projectId}?tab=tasks`);
    await expect(page.getByRole('tab', { name: 'Task chains', exact: true })).toBeVisible();
    if (navigation === 'history') {
      await select(page, 'Standalone tasks');
      await page.locator('.project-navigation a[href="/projects"]').click();
      await expect(page).toHaveURL(/\/projects$/);
    }
    await page.evaluate(name => { scrollTo(0, 0); localStorage.setItem(name, '320'); }, key);
    state.graphMode = 'pending';
    if (navigation === 'history') await page.goBack();
    else await page.reload();
    await expect(page.getByRole('tab', { name: navigation === 'history' ? 'Standalone tasks' : 'Task chains', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(await position(page)).toBe(0);
    if (navigation === 'history') await page.goBack();
    else await select(page, 'Standalone tasks');
    await expect(page.getByRole('tab', { name: navigation === 'history' ? 'Task chains' : 'Standalone tasks', exact: true })).toHaveAttribute('aria-selected', 'true');
    expect(await position(page)).toBe(0);
    const completed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
    state.releaseGraph();
    await completed;
    await expect(page.locator('.snapshot-time time')).toBeVisible();
    expect(await position(page)).toBe(0);
  } finally { state.releaseGraph(); }
});

test('project history restores native mode when leaving for other routes', async ({ page }) => {
  await install(page, [row(10, 'Task')]);
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.locator('.project-management-nav a')).toBeVisible();
  await page.reload();
  await expect(page.locator('.project-management-nav a')).toBeVisible();
  await page.locator('a[href="/projects"]').first().click();
  await expect(page).toHaveURL(/\/projects$/);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.locator('.project-management-nav a')).toBeVisible();
  await page.locator('.project-management-nav a').click();
  await expect(page.locator('#project-section-tab-overview')).toBeVisible();
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
  await page.reload();
  await expect(page.locator('#project-section-tab-overview')).toBeVisible();
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
  await page.getByRole('link', { name: 'Project settings', exact: true }).click();
  await expect(page.locator('.project-management-nav a')).toBeVisible();
  await page.locator('.project-management-nav a').click();
  await expect(page.locator('#project-section-tab-overview')).toBeVisible();
  await page.locator('.project-navigation a[href="/projects"]').click();
  await expect(page).toHaveURL(/\/projects$/);
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
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
      await expect(page.locator('#project-standalone-list .task-row-title')).toHaveCount(2);
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
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.locator('#project-standalone-list .task-row-title').first()).toBeFocused();
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
  await chain.click();
  await expect(chainTarget).toBeFocused(); await expect(chainTarget).toBeInViewport(); await expect(chainTarget).toHaveClass(/overview-progress-target/);
  await select(page, 'Overview');
  const independent = progress.getByRole('button', { name: /^Standalone tasks, / });
  await independent.focus(); await page.keyboard.press('Space');
  const panel = page.getByRole('tabpanel', { name: 'Standalone tasks', exact: true });
  await expect(panel).toBeFocused(); await expect(panel).toBeInViewport(); await expect(panel).toHaveClass(/overview-progress-target/);
  await expect(page.locator('.task-chain-dialog')).toHaveCount(0); expect(state.writes).toEqual([]);
});

test('overview progress rows fit their content at desktop and narrow widths', async ({ page }) => {
  const short = row(10, 'Short chain'), shortChild = row(11, 'Short child', [short.id]);
  const longEnglish = { ...row(20, 'A long English title that wraps naturally when the available width becomes narrow and remains readable'), status: 'done' as const, ready: false, completedAt: '2026-10-22T10:00:00Z' };
  const englishChild = { ...row(21, 'English child', [longEnglish.id]), blockedBy: [], ready: true };
  const longChinese = row(30, '这是一个较长的中文任务链标题需要在窄屏中自然换行并且保持完整可读而不能被裁切');
  const chineseChild = row(31, '中文子任务', [longChinese.id]);
  const complete = { ...row(40, 'Complete chain'), status: 'done' as const, ready: false, completedAt: '2026-10-22T10:00:00Z' };
  const completeChild = { ...row(41, 'Complete child', [complete.id]), status: 'done' as const, ready: false, completedAt: '2026-10-22T10:00:00Z' };
  const state = await install(page, [short, shortChild, longEnglish, englishChild, longChinese, chineseChild, complete, completeChild, row(50, 'Independent')]);
  await page.goto(`/projects/${projectId}`);
  for (const locale of ['en', 'zh-CN']) {
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
    for (const width of [1280, 740, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const rows = page.locator('.overview-progress-row');
      await expect(rows).toHaveCount(5);
      const shortRow = rows.filter({ hasText: 'Short chain' });
      if (width === 1280) expect((await shortRow.boundingBox())!.height).toBeCloseTo(60, 0);
      await expect(rows.filter({ hasText: 'Short chain' }).locator('.overview-progress-percent')).toHaveText('0%');
      await expect(rows.filter({ hasText: 'A long English title' }).locator('.overview-progress-percent')).toHaveText('50%');
      await expect(rows.filter({ hasText: 'Complete chain' }).locator('.overview-progress-percent')).toHaveText('100%');
      await expect(rows.locator('.overview-progress-scope')).toBeVisible();
      expect(await rows.evaluateAll(elements => elements.every(element => {
        const rowBox = element.getBoundingClientRect();
        const children = [...element.children].filter(child => getComputedStyle(child).display !== 'none') as HTMLElement[];
        const boxes = children.map(child => child.getBoundingClientRect());
        return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1 &&
          children.every((child, i) => child.scrollWidth <= child.clientWidth + 1 && child.scrollHeight <= child.clientHeight + 1 &&
            boxes[i]!.left >= rowBox.left - 1 && boxes[i]!.right <= rowBox.right + 1 && boxes[i]!.top >= rowBox.top - 1 && boxes[i]!.bottom <= rowBox.bottom + 1 &&
            boxes.every((other, j) => i === j || boxes[i]!.right <= other.left + 1 || other.right <= boxes[i]!.left + 1 ||
              boxes[i]!.bottom <= other.top + 1 || other.bottom <= boxes[i]!.top + 1));
      }))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await rows.first().locator('.overview-progress-title').evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
      expect(await page.locator('.project-overview .stat-label').first().evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
      if (width === 320) {
        expect((await rows.filter({ hasText: 'A long English title' }).boundingBox())!.height).toBeGreaterThan(60);
        expect((await rows.filter({ hasText: '这是一个较长的中文' }).boundingBox())!.height).toBeGreaterThan(60);
      }
    }
  }
  expect(state.writes).toEqual([]);
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

test('refreshing from the narrow heading updates project statistics', async ({ page }) => {
  const state = await install(page, [row(10, 'Task')]);
  let statisticsReads = 0, graphReads = 0;
  await page.route('**/pull-request-repositories*', route => route.fulfill({ json: { currentRepositoryId: '10', items: [{ repositoryId: '10', fullName: 'codetreker/daynight' }], nextCursor: null }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
  await page.route('**/pull-request-statistics?*', route => {
    statisticsReads++;
    return route.fulfill({ json: { projectId, repository: { repositoryId: '10', fullName: 'codetreker/daynight' }, endDate: new URL(route.request().url()).searchParams.get('endDate'), revision: '1', projectTotal: '5', availability: 'ready', hasAuthors: false, daily: Array(30).fill('0'), authorId: null, author: null, authorDaily: null }, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } });
  });
  page.on('request', request => { if (new URL(request.url()).pathname === `/api/v1/projects/${projectId}/task-sync`) graphReads++; });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/projects/${projectId}`);
  await select(page, 'Statistics');
  await expect.poll(() => statisticsReads).toBeGreaterThan(0);
  await expect(page.getByText('PRs created daily')).toBeVisible();
  const previousStatistics = statisticsReads, previousGraph = graphReads;
  await page.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => statisticsReads).toBeGreaterThan(previousStatistics);
  await expect.poll(() => graphReads).toBeGreaterThan(previousGraph);
  expect(state.writes).toEqual([]);
});
