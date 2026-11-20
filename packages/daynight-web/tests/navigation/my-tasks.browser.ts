import { expect, test } from '@playwright/test';
import { unsupportedSessionObservation } from '../../../daynight/src/api/task-observation';

const userId = '00000000-0000-4000-8000-000000000011';
const projectId = '00000000-0000-4000-8000-000000000031';
const otherProjectId = '00000000-0000-4000-8000-000000000032';
const teamId = '00000000-0000-4000-8000-000000000041';
const goalId = '00000000-0000-4000-8000-000000000051';
const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const longProject = 'ProjectWithAnUnbrokenLongName'.repeat(4);
const longTask = 'TaskWithAnUnbrokenLongName'.repeat(5);
const longGoal = 'GoalWithAnUnbrokenLongName'.repeat(5);
const longTag = 'LongTag'.repeat(9);
const longWorker = 'WorkerWithAnUnbrokenLongName'.repeat(5) + '中文机器名称'.repeat(10);
const project = { id: projectId, name: longProject, ownerTeam: { id: teamId, kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 16 };
const observation = { ...unsupportedSessionObservation(), observation: 'observed', registration: 'not_applicable', reason: 'no_execution', error: null, observedAt: '2026-11-13T10:00:00Z', freshUntil: '2026-11-13T11:00:00Z' };
const sessionRow = { taskVersion: '1', state: 'no_session', observedAt: observation.observedAt, freshUntil: observation.freshUntil, needsAttention: false, canOpen: false };
const registered = { ...observation, registration: 'registered', reason: 'working', sessionId: taskId(80), claimId: taskId(81), executionGeneration: '1', connectionEpoch: '1', agentControlMode: 'web', contentKind: 'native_timeline', indicator: 'working', activity: 'working', lifecycle: 'active', connectionState: 'connected' };
const row = (n: number) => ({ project, task: { id: taskId(n), version: '1', title: n === 1 ? longTask : `Task ${n}`, status: 'in_progress', startedAt: null, createdAt: '2026-11-13T09:00:00Z', requiredPlatform: n === 1 ? 'linux' : null, tags: n === 1 ? [{ id: taskId(90), name: longTag }] : [], blockedBy: n === 1 ? [taskId(91)] : [], ready: false, allowAgents: false, paused: false, worker: n === 1 ? { workerId: taskId(70), state: 'active', machine: { id: taskId(71), name: longWorker } } : null, goal: n === 1 ? { id: goalId, title: longGoal } : null }, session: observation, sessionRow: n === 1 ? { ...sessionRow, state: 'unavailable', observedAt: null, freshUntil: null, needsAttention: null } : sessionRow });
const payload = { observedAt: '2026-11-13T10:00:00Z', responseTaskAt: '2026-11-13T10:00:00Z', responseSessionAt: '2026-11-13T10:00:00Z', inventoryRevision: 'a'.repeat(64), totalTaskCount: 17, totalProjectCount: 2, sessionPartial: true,
  items: [...Array.from({ length: 16 }, (_, i) => row(i + 1)), { ...row(17), project: { ...project, id: otherProjectId, name: 'Other project', matchedTaskCount: 1 } }], nextCursor: null };

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`heading starts with the title in every task state at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let request = 0;
    let release!: () => void;
    await page.route('**/api/v1/me/in-progress-tasks?*', async route => {
      request++;
      if (request === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        await route.fulfill({ json: { ...payload, totalTaskCount: 0, totalProjectCount: 0, sessionPartial: false, items: [] }, headers: { 'Daynight-User-ID': userId } });
      } else if (request === 2) {
        await route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'Failed' } } });
      } else {
        await route.fulfill({ json: payload, headers: { 'Daynight-User-ID': userId } });
      }
    });
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByLabel('Language').selectOption(locale);
    const heading = page.locator('.my-tasks-page .page-heading');
    const title = heading.getByRole('heading', { level: 1, name: locale === 'en' ? 'In-progress tasks' : '进行中的任务' });
    const refresh = heading.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' });
    const checkHeading = async () => {
      await expect(title).toBeVisible();
      await expect(heading.locator('.subtitle')).toHaveText(locale === 'en' ? 'Tasks assigned to you across all your projects.' : '查看分配给你的所有项目中的任务。');
      await expect(refresh).toBeVisible();
      await expect(heading.locator('.eyebrow')).toHaveCount(0);
      expect(await title.evaluate(element => element.parentElement?.firstElementChild === element && element.getBoundingClientRect().top === element.parentElement.getBoundingClientRect().top)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await expect(page.getByText(locale === 'en' ? 'Loading tasks…' : '正在加载任务…')).toBeVisible();
    await checkHeading();
    release();
    await expect(page.getByText(locale === 'en' ? 'No in-progress tasks' : '没有进行中的任务')).toBeVisible();
    await checkHeading();
    await refresh.click();
    await expect(page.getByText(locale === 'en' ? 'Tasks could not be updated.' : '无法更新任务。')).toBeVisible();
    await checkHeading();
    await page.getByRole('button', { name: locale === 'en' ? 'Retry' : '重试' }).click();
    await expect(page.getByRole('link', { name: longTask, exact: true })).toBeVisible();
    await checkHeading();
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`manual empty Session leaves no space at ${width}px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let allowAgents = false;
    const example = row(1);
    await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ json: {
      ...payload, totalTaskCount: 1, totalProjectCount: 1, sessionPartial: false,
      items: [{ ...example, project: { ...project, matchedTaskCount: 1 }, task: { ...example.task, allowAgents, worker: null }, sessionRow }],
    }, headers: { 'Daynight-User-ID': userId } }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByLabel('Language').selectOption(locale);
    const task = page.getByRole('link', { name: longTask, exact: true }).locator('xpath=ancestor::li');
    await expect(task.locator('.task-row-primary-status')).toHaveText(locale === 'en' ? 'In progress' : '进行中');
    await expect(task).toContainText(locale === 'en' ? 'In progress' : '进行中');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    allowAgents = true;
    await page.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' }).click();
    await expect(task.locator('.task-row-primary-status')).toContainText(locale === 'en' ? 'No current session' : '无当前会话');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 390, 1280]) {
  test(`personal shared row preserves ID, profile and independent links at ${width}px in ${locale}`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    let projectReads = 0;
    await page.route('**/api/v1/projects/**/task-assignees*', route => { projectReads++; return route.abort(); });
    await page.route('**/api/v1/projects/**/tags/colors/resolve', route => route.fulfill({ json: { catalogEpoch: taskId(92), items: [{ id: taskId(90), state: 'found', color: '#123456', version: 1 }] }, headers: { 'Daynight-User-ID': userId } }));
    await page.route('**/reader-avatar.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17"><circle cx="8" cy="8" r="8" fill="blue"/></svg>' }));
    await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ json: payload, headers: { 'Daynight-User-ID': userId } }));
    await context.route('**/projects/**', route => route.fulfill({ contentType: 'text/html', body: 'Detail destination' }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByLabel('Language').selectOption(locale);
    const link = page.getByRole('link', { name: longTask, exact: true });
    const task = link.locator('xpath=ancestor::li');
    const id = task.locator('.task-row-id');
    const copy = task.getByRole('button', { name: locale === 'en' ? 'Copy task ID' : '复制任务 ID' });
    await expect(link).toHaveCSS('font-size', '14px');
    await expect(id).toHaveCSS('font-size', '12px');
    await expect(id).toHaveText(taskId(1));
    await expect(task.locator('.assignee-name')).toHaveText('Current Reader');
    await expect.poll(() => task.locator('.assignee-avatar img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    expect(projectReads).toBe(0);
    expect(await task.evaluate(element => element.querySelector('a a, a button, button a, button button') === null && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await copy.focus(); await page.keyboard.press('Enter');
    await expect(task.getByRole('status')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(taskId(1));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const box = await id.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const rect = range.getClientRects()[0]!; return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    await page.mouse.move(box.x + 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + Math.min(box.width - 2, 80), box.y + box.height / 2, { steps: 6 }); await page.mouse.up();
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    expect(selected.length).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+C');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(selected);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.evaluate(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: original }); return Promise.reject(new Error('denied')); } });
    });
    await copy.click(); await expect(task.getByRole('alert')).toBeVisible();
    await expect(id).toHaveText(taskId(1));
    await copy.click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(taskId(1));
    const goal = task.locator('.task-row-goal');
    for (const target of [link, goal]) {
      const metaHandled = await target.evaluate(element => { let prevented = true; window.addEventListener('click', event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true }); element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })); return prevented; });
      expect(metaHandled).toBe(false);
      const opened = context.waitForEvent('page'); await target.click({ modifiers: ['ControlOrMeta'] });
      const popup = await opened; await popup.waitForLoadState();
      expect(new URL(popup.url()).pathname).toBe(await target.getAttribute('href'));
      await popup.close();
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (locale === 'en') await page.screenshot({ path: `.tmp/personal-shared-row-${width}.png`, fullPage: true });
  });
}

test('refresh replaces and removes the current Worker even when Session observation is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  let current = row(1).task.worker;
  await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ json: {
    ...payload, totalTaskCount: 1, totalProjectCount: 1, sessionPartial: true,
    items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, task: { ...row(1).task, worker: current, paused: true }, session: unsupportedSessionObservation(), sessionRow: { ...sessionRow, state: 'unavailable', observedAt: null, freshUntil: null, needsAttention: null } }],
  }, headers: { 'Daynight-User-ID': userId } }));
  await page.goto('/tests/navigation/my-tasks-browser.html');
  await expect(page.getByText(`Claim machine: ${longWorker}`)).toBeVisible();
  await expect(page.getByText('Unavailable')).toBeVisible();
  const replacement = '机器  名称\nA\tB' + ' \t'.repeat(60);
  current = { workerId: taskId(72), state: 'active', machine: { id: taskId(73), name: replacement } };
  await page.getByRole('button', { name: 'Refresh' }).click();
  const worker = page.locator('.task-row-machine');
  await expect(worker).toBeVisible();
  await expect(worker).toHaveCSS('font-size', '12px');
  await expect.poll(() => worker.textContent()).toBe(`Claim machine: ${replacement}`);
  const layout = await worker.evaluate(el => {
    const node = el.firstChild!;
    const start = node.textContent!.indexOf('机器');
    const rect = (offset: number) => { const range = document.createRange(); range.setStart(node, start + offset); range.setEnd(node, start + offset + 1); return range.getBoundingClientRect(); };
    const tail = Array.from({ length: 120 }, (_, i) => rect(10 + i));
    return { firstSpace: rect(2).width, secondSpace: rect(3).width, firstLine: rect(4).top, secondLine: rect(7).top, tab: rect(8).width, overflow: document.documentElement.scrollWidth > innerWidth, tailRight: Math.max(...tail.map(r => r.right)), tailFirstTop: tail[0]!.top, tailLastTop: tail.at(-1)!.top };
  });
  expect(layout.firstSpace).toBeGreaterThan(0);
  expect(layout.secondSpace).toBeGreaterThan(0);
  expect(layout.secondLine).toBeGreaterThan(layout.firstLine);
  expect(layout.tab).toBeGreaterThan(0);
  expect(layout.overflow).toBe(false);
  expect(layout.tailRight).toBeLessThanOrEqual(320);
  expect(layout.tailLastTop).toBeGreaterThan(layout.tailFirstTop);
  await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
  await expect(worker).toHaveCSS('font-size', '18px');
  expect(await worker.evaluate(element => element.scrollWidth <= element.clientWidth && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await expect(page.getByText(`Claim machine: ${longWorker}`)).toHaveCount(0);
  current = { ...current, state: 'completed' };
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(worker).toHaveText(`Recorded machine: ${replacement}`);
  await expect(worker).toHaveCSS('font-size', '12px');
  await page.getByLabel('Language').selectOption('zh-CN');
  await expect(worker).toHaveText(`执行机器记录：${replacement}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  current = null;
  await page.getByRole('button', { name: '刷新' }).click();
  await expect(worker).toHaveText('暂无执行机器记录');
  await expect(worker).toHaveCSS('font-size', '12px');
});

for (const width of [320, 390, 1280]) {
  test(`startup warning appears without replacing the row at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.clock.install({ time: new Date('2026-11-13T10:00:00Z') });
    const warning = { ...observation, registration: 'registered', indicator: 'warning', reason: 'disconnected', connectionState: 'disconnected', needsAttention: true };
    const rows = [row(1), row(2), row(3)].map((item, index) => ({
      ...item, project: { ...item.project, matchedTaskCount: 3 },
      task: { ...item.task, worker: row(1).task.worker, startedAt: '2026-11-13T09:58:01Z' },
      session: { ...warning, indicator: index === 0 ? 'warning' : null, lifecycle: index === 2 ? 'archived' : 'active' }, sessionRow: { ...sessionRow, state: 'warning', needsAttention: true },
    }));
    await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ json: { ...payload, totalTaskCount: 3, totalProjectCount: 1, items: rows }, headers: { 'Daynight-User-ID': userId } }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    const task = page.getByRole('link', { name: longTask });
    const taskRow = task.locator('xpath=ancestor::li');
    const fallbackRow = page.getByRole('link', { name: 'Task 2' }).locator('xpath=ancestor::li');
    const archivedRow = page.getByRole('link', { name: 'Task 3' }).locator('xpath=ancestor::li');
    await expect(task).toBeVisible();
    await expect(taskRow.locator('[data-session-state]')).toHaveCount(0);
    await expect(fallbackRow.locator('[data-session-state]')).toHaveCount(0);
    await expect(archivedRow.locator('[data-session-state]')).toHaveCount(0);
    await page.getByLabel('Language').selectOption('zh-CN');
    await expect(taskRow.locator('[data-session-state]')).toHaveCount(0);
    await expect(fallbackRow.locator('[data-session-state]')).toHaveCount(0);
    await page.getByLabel('语言').selectOption('en');
    await task.focus();
    const originalRow = await taskRow.elementHandle();
    await page.clock.fastForward(2_000);
    await expect(taskRow.locator('.task-row-primary-status')).toContainText('Needs attention');
    await expect(fallbackRow.locator('.task-row-primary-status')).toContainText('Needs attention');
    await expect(archivedRow.locator('.task-row-primary-status')).toContainText('Needs attention');
    await expect(task).toBeFocused();
    expect(await originalRow!.evaluate(row => row === document.activeElement?.closest('li'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('Language').selectOption('zh-CN');
    await expect(taskRow.locator('.task-row-primary-status')).toContainText('需要关注');
    await expect(fallbackRow.locator('.task-row-primary-status')).toContainText('需要关注');
    await expect(archivedRow.locator('.task-row-primary-status')).toContainText('需要关注');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [320, 1280]) {
  test(`real overview retains layout, links and reading page at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 800 });
    let requests = 0, responses = 0;
    let release: (() => void) | null = null;
    await page.route('**/api/v1/me/in-progress-tasks?*', async route => {
      requests++;
      if (requests > 1) await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: payload, headers: { 'Daynight-User-ID': userId } });
      responses++;
    });
    await context.route('**/projects/**', route => route.fulfill({ contentType: 'text/html', body: 'Detail destination' }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    const group = page.getByRole('region', { name: `${longProject} · Team · ${projectId}` });
    await expect(group.getByText('16 in progress')).toBeVisible();
    const task = group.getByRole('link', { name: longTask });
    const goal = group.getByRole('link', { name: `View Goal: ${longGoal}` });
    await expect(task).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId(1)}`);
    await expect(goal).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
    await expect(goal).toBeVisible();
    const worker = group.getByText(`Claim machine: ${longWorker}`);
    await expect(worker).toBeVisible();
    expect(await worker.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const popupPromise = context.waitForEvent('page');
    await goal.click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect.poll(() => new URL(popup.url()).pathname).toBe(`/projects/${projectId}/tasks/${goalId}`);
    await popup.close();
    await page.getByLabel('Language').selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '进行中的任务' })).toBeVisible();
    await expect(group.getByRole('link', { name: `查看 Goal：${longGoal}` })).toBeVisible();
    await expect(group.getByText(`认领机器：${longWorker}`)).toBeVisible();
    await expect(group.getByText(longTag)).toBeVisible();
    await expect(group.getByText('未就绪')).toBeVisible();
    await expect(group.getByText('Linux')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('语言').selectOption('en');
    await group.getByRole('button', { name: 'Next' }).click();
    const secondPageTask = group.getByRole('link', { name: 'Task 16' });
    await expect(secondPageTask).toBeVisible();
    await secondPageTask.focus();
    const before = await secondPageTask.boundingBox();
    const element = await secondPageTask.elementHandle();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => requests).toBe(2);
    await expect(secondPageTask).toBeFocused();
    expect(await secondPageTask.boundingBox()).toEqual(before);
    release!();
    await expect.poll(() => responses).toBe(2);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(secondPageTask).toBeVisible();
    await expect(secondPageTask).toBeFocused();
    expect(await secondPageTask.boundingBox()).toEqual(before);
    expect(await element!.evaluate(el => el === document.activeElement)).toBe(true);
  });
}

for (const width of [320, 1280]) {
  test(`overview opens complete details and preserves them after filtering at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const { detailFixture, graphFixture } = await import('../helpers/taskDetail');
    const { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION } = await import('../helpers/taskSync');
    const { stringifyWireJson } = await import('../helpers/wireJson');
    const goalDetail = detailFixture(projectId, goalId, { type: 'goal', title: longGoal, description: 'Goal description', ready: false });
    const taskDetail = detailFixture(projectId, taskId(1), { title: longTask, parentId: goalId, description: 'Task description', status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', assignedTo: userId });
    const details = [goalDetail, taskDetail];
    const graph = graphFixture(details);
    const epoch = taskSyncEpoch(projectId);
    let listed = true, failGraph = false;
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, ...extra } });
      if (path === '/api/v1/me/in-progress-tasks') return send(listed ? { ...payload, totalTaskCount: 1, totalProjectCount: 1, items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, session: { ...registered, indicator: 'warning', activity: 'idle', reason: 'idle', needsAttention: true }, sessionRow: { ...sessionRow, state: 'warning', needsAttention: true, canOpen: true } }] } : { ...payload, totalTaskCount: 0, totalProjectCount: 0, items: [] });
      if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId, userId));
      if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId, name: 'Owner', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
      if (path === `/api/v1/projects/${projectId}/task-sync`) {
        if (failGraph) { failGraph = false; return send({ error: { code: 'unavailable', message: 'Unavailable', requestId: 'sync-error' } }, 503); }
        return send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch, actorAccess: directAccessFixture(projectId, userId), versionForTask: () => 1n, propertiesForTask: task => details.find(item => item.id === task.id)!.properties }));
      }
      const detail = details.find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
      if (detail) return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
      if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
      if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
      if (path.endsWith('/steps')) return send({ projectId, taskId: taskId(1), version: 1, steps: [] });
      if (path.endsWith('/sessions')) return send({ items: [{ sessionId: taskId(80), claimId: taskId(81), executionGeneration: '1', agentControlMode: 'web', contentKind: 'native_timeline', createdAt: '2026-10-22T09:00:00Z', endedAt: '2026-10-22T10:00:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } }], nextCursor: null });
      if (path.endsWith('/archive')) return send({ archive: { state: 'pending', sha256: null, byteLength: null, errorCode: null } });
      return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
    });
    await page.route('**/my-tasks', async route => route.fulfill({ response: await route.fetch({ url: 'http://127.0.0.1:14295/tests/navigation/my-tasks-browser.html' }) }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    const task = page.getByRole('link', { name: longTask });
    await task.click();
    const taskDialog = page.getByRole('dialog', { name: longTask });
    await expect(taskDialog).toBeVisible();
    await expect(taskDialog.getByText('Task description')).toBeVisible();
    await expect(taskDialog.getByRole('tab', { name: 'Attachments' })).toBeVisible();
    for (const name of ['Attachments', 'Steps', 'Discussion', 'Session']) {
      const tab = taskDialog.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(taskDialog.getByRole('tabpanel', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(taskDialog).toHaveCount(0);
    await expect(task).toBeFocused();
    const session = task.locator('xpath=ancestor::li').getByRole('button', { name: /Needs attention.*Open Session/ });
    await expect(session).toHaveText('Needs attention');
    await session.focus(); await page.keyboard.press('Enter');
    await expect(taskDialog.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape'); await expect(session).toBeFocused();
    const goal = page.getByRole('link', { name: `View Goal: ${longGoal}` });
    failGraph = true;
    await goal.click();
    const goalDialog = page.getByRole('dialog', { name: longGoal });
    await expect(goalDialog.getByText('Goal description')).toBeVisible();
    const information = goalDialog.getByRole('complementary', { name: 'Goal information' });
    await expect(information.getByRole('alert')).toBeVisible();
    await information.getByRole('button', { name: 'Retry refresh' }).click();
    await expect(information.getByText('Total tasks')).toBeVisible();
    await page.evaluate(id => window.selectMyTasksChild(id), taskId(1));
    await expect(taskDialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(taskDialog).toHaveCount(0);
    await expect(goalDialog).toBeVisible();
    for (const name of ['Discussion', 'Attachments']) {
      const tab = goalDialog.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(goalDialog.getByRole('tabpanel', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(goalDialog).toHaveCount(0);
    await expect(goal).toBeFocused();
    await goal.click();
    await goalDialog.getByRole('tab', { name: 'Attachments' }).click();
    await page.reload();
    await expect(goalDialog).toBeVisible();
    await expect(goalDialog.getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(goalDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'In-progress tasks', exact: true })).toBeFocused();
    await task.click();
    await expect(taskDialog).toBeVisible();
    listed = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText('No in-progress tasks')).toBeVisible();
    await expect(taskDialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(taskDialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'In-progress tasks', exact: true })).toBeFocused();
  });
}

for (const failedGraph of [false, true]) {
  test(`Task relation follows the actual target ${failedGraph ? 'when the project graph fails' : 'under its Goal'}`, async ({ page }) => {
    const { detailFixture, graphFixture } = await import('../helpers/taskDetail');
    const { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION } = await import('../helpers/taskSync');
    const { stringifyWireJson } = await import('../helpers/wireJson');
    const goalDetail = detailFixture(projectId, goalId, { type: 'goal', title: 'Target Goal', ready: false });
    const related = detailFixture(projectId, taskId(2), { title: 'Related task', parentId: goalId, status: 'done', ready: false, completedAt: '2026-10-22T10:00:00Z' });
    const source = detailFixture(projectId, taskId(1), { title: 'Source task', status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', dependsOn: [related.id], ready: false, assignedTo: userId });
    const details = [goalDetail, related, source], graph = graphFixture(details), epoch = taskSyncEpoch(projectId);
    await page.route('**/api/v1/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, ...extra } });
      if (path === '/api/v1/me/in-progress-tasks') return send({ ...payload, totalTaskCount: 1, totalProjectCount: 1, items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, task: { ...row(1).task, title: 'Source task', goal: null } }] });
      if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId, userId));
      if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId, name: 'Owner', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
      if (path === `/api/v1/projects/${projectId}/task-sync`) return failedGraph ? send({ error: { code: 'unavailable', message: 'Unavailable', requestId: 'sync-error' } }, 503) : send(taskSyncFixture(graph, { query: taskSyncQuery(url), epoch, actorAccess: directAccessFixture(projectId, userId), versionForTask: () => 1n, propertiesForTask: task => details.find(item => item.id === task.id)!.properties }));
      if (path === `/api/v1/projects/${projectId}/task-graph`) return send(graphFixture([related, source]));
      const detail = details.find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
      if (detail) return send(detail, 200, { 'Daynight-Task-Epoch': epoch });
      if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
      if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
      if (path.endsWith('/steps')) return send({ projectId, taskId: path.split('/').at(-2), version: 1, steps: [] });
      if (path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
      return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
    });
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByRole('link', { name: 'Source task' }).click();
    const sourceDialog = page.getByRole('dialog', { name: 'Source task' });
    await expect(sourceDialog).toBeVisible();
    if (!failedGraph) await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('task-sync')))).toBe(true);
    await sourceDialog.getByRole('button', { name: 'Related task, Ordinary dependency' }).click();
    if (failedGraph) {
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/projects/${projectId}/tasks/${related.id}`);
    } else {
      const child = page.getByRole('dialog', { name: 'Related task' });
      await expect(child).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(child).toHaveCount(0);
      const target = page.getByRole('dialog', { name: 'Target Goal' });
      await expect(target).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(target).toHaveCount(0);
    }
  });
}

test('Goal assignee receipt permits a write and refreshes both project graph and overview', async ({ page }) => {
  const { detailFixture, graphFixture } = await import('../helpers/taskDetail');
  const { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION } = await import('../helpers/taskSync');
  const { stringifyWireJson } = await import('../helpers/wireJson');
  let goalDetail = detailFixture(projectId, goalId, { type: 'goal', title: 'Assignment Goal', ready: false });
  const taskDetail = detailFixture(projectId, taskId(1), { title: 'Owned task', parentId: goalId, assignedTo: userId, status: 'in_progress', startedAt: '2026-10-22T10:00:00Z', ready: false });
  const epoch = taskSyncEpoch(projectId);
  let graphReads = 0, listReads = 0, writes = 0;
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId, ...extra } });
    if (path === '/api/v1/me/in-progress-tasks') { listReads++; return send({ ...payload, totalTaskCount: 1, totalProjectCount: 1, items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, task: { ...row(1).task, title: 'Owned task', goal: { id: goalId, title: 'Assignment Goal' } } }] }); }
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId, userId));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId, name: 'Owner', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/task-sync`) { graphReads++; const details = [goalDetail, taskDetail]; return send(taskSyncFixture(graphFixture(details), { query: taskSyncQuery(url), epoch, actorAccess: directAccessFixture(projectId, userId), versionForTask: task => details.find(item => item.id === task.id)!.version, propertiesForTask: task => details.find(item => item.id === task.id)!.properties })); }
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}` && route.request().method() === 'PATCH') {
      expect(route.request().postDataJSON()).toEqual({ assignedTo: userId, version: 1 });
      writes++; goalDetail = { ...goalDetail, assignedTo: userId, version: 2n, updatedAt: '2026-10-22T10:00:01Z' };
      return send(goalDetail, 200, { 'Daynight-Task-Epoch': epoch });
    }
    if (path === `/api/v1/projects/${projectId}/tasks/${goalId}`) return send(goalDetail, 200, { 'Daynight-Task-Epoch': epoch });
    if (path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  await page.goto('/tests/navigation/my-tasks-browser.html');
  await page.getByRole('link', { name: 'View Goal: Assignment Goal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assignment Goal' });
  await expect(dialog.getByRole('complementary', { name: 'Goal information' }).getByText('Total tasks')).toBeVisible();
  const assignee = dialog.getByRole('button', { name: 'Assignee: Unassigned' });
  await expect(assignee).toBeEnabled();
  await assignee.click();
  const owner = dialog.getByRole('option', { name: /Owner/ });
  await expect(owner).toBeEnabled();
  const before = { graph: graphReads, list: listReads };
  await owner.click();
  await expect.poll(() => writes).toBe(1);
  await expect(dialog.getByRole('button', { name: 'Assignee: Owner' })).toBeVisible();
  await expect.poll(() => graphReads).toBeGreaterThan(before.graph);
  await expect.poll(() => listReads).toBeGreaterThan(before.list);
  await expect(dialog).toBeVisible();
});


for (const locale of ['en', 'zh-CN']) for (const width of [320, 1280]) {
  test(`refreshes a Worker alias without replacing personal task history ${locale} ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let alias: string | null = '上海办公室跨页面识别的 Windows 工作站 '.repeat(2).trim(), version = 1;
    await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ json: {
      ...payload, totalTaskCount: 1, totalProjectCount: 1,
      items: [{ ...row(1), project: { ...project, matchedTaskCount: 1 }, task: { ...row(1).task, worker: { ...row(1).task.worker!, userId } } }],
    }, headers: { 'Daynight-User-ID': userId, 'Daynight-Worker-Identity': '1' } }));
    await page.route(`**/api/v1/me/workers/${taskId(70)}/alias`, route => route.fulfill({ json: { workerId: taskId(70), alias: { value: alias, version: String(version) } }, headers: { 'Daynight-User-ID': userId } }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByLabel('Language').selectOption(locale);
    const machine = page.locator('.task-row-machine');
    await expect(machine).toContainText(alias!);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await machine.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('personal-worker-alias.png') });
    alias = 'Changed office'; version++;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(machine).toContainText(alias);
    alias = null; version++;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(machine).toHaveText(`${locale === 'en' ? 'Claim machine: ' : '认领机器：'}${longWorker}`);
    await expect(page.getByRole('link', { name: longTask, exact: true })).toBeVisible();
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [320, 1280]) {
  test(`unified status preserves focused entrance until withdrawal at ${width}px in ${locale}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let state: 'working' | 'notice' | 'warning' = 'working';
    let needsAttention = false, canOpen = true;
    const example = row(1);
    await page.route('**/api/v1/me/in-progress-tasks?*', route => route.fulfill({ json: {
      ...payload, totalTaskCount: 1, totalProjectCount: 1, sessionPartial: false,
      items: [{ ...example, project: { ...project, matchedTaskCount: 1 },
        task: { ...example.task, paused: true, startedAt: '2026-11-13T07:00:00Z' },
        session: { ...registered, needsAttention, indicator: state }, sessionRow: { ...sessionRow, state, needsAttention, canOpen } }],
    }, headers: { 'Daynight-User-ID': userId } }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    await page.getByLabel('Language').selectOption(locale);
    const item = page.getByRole('link', { name: longTask, exact: true }).locator('xpath=ancestor::li');
    const title = item.locator('.task-row-title');
    const status = item.locator('.task-row-primary-status');
    const action = item.getByRole('button', { name: locale === 'en' ? /Open Session/ : /打开 Session/ });
    await expect(action).toHaveText(locale === 'en' ? 'Working' : '工作中');
    await expect(item.locator('.task-paused-badge')).toBeVisible();
    await expect(item.locator('.task-stuck-label')).toBeVisible();
    await expect(action).toHaveCSS('color', 'rgb(40, 91, 159)');
    await page.screenshot({ path: info.outputPath('unified-working-overdue.png') });
    await action.focus();
    const original = await action.elementHandle();
    const refresh = async () => {
      // A programmatic activation keeps focus on the observed control while the real refresh publishes the response.
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh' : '刷新' }).evaluate((element: HTMLButtonElement) => element.click());
    };
    for (const next of [
      { state: 'notice' as const, attention: true, en: 'Needs a response', zh: '需要响应' },
      { state: 'warning' as const, attention: true, en: 'Needs attention', zh: '需要关注' },
      { state: 'warning' as const, attention: false, en: 'Needs checking', zh: '需要检查' },
    ]) {
      state = next.state; needsAttention = next.attention; await refresh();
      await expect(action).toHaveText(locale === 'en' ? next.en : next.zh);
      await expect(action).toBeFocused();
      expect(await original!.evaluate(element => element === document.activeElement)).toBe(true);
      await expect(action).toHaveCSS('color', 'rgb(128, 91, 39)');
      await expect(status).toHaveCount(1);
    }
    canOpen = false; await refresh();
    await expect(action).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(status).toContainText(locale === 'en' ? 'Needs checking' : '需要检查');
    await expect(status.locator('.task-row-status-lifecycle')).toHaveText(locale === 'en' ? ', In progress' : '，进行中');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
