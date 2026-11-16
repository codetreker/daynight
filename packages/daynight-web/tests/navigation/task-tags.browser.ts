import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TaskDetail } from '../../src/api/types';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const personalId = '00000000-0000-4000-8000-000000000701';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const longName = 'UnbrokenLongTagName'.repeat(3);
const goal = detailFixture(projectId, id(10), { type: 'goal', title: 'Release goal', ready: false, tags: [{ id: id(90), name: 'Goal label' }] });
const standalone = detailFixture(projectId, id(11), { title: 'Independent task', tags: [{ id: id(91), name: longName }, { id: id(92), name: 'Another label' }] });
const child = detailFixture(projectId, id(12), { title: 'Goal child', parentId: goal.id, tags: [{ id: id(93), name: 'Child label' }] });
const root = detailFixture(projectId, id(13), { title: 'Chain root', parentId: goal.id, tags: [{ id: id(94), name: 'Root label' }] });
const outsider = detailFixture(projectId, id(15), { title: 'Outside context', tags: [{ id: id(95), name: 'Outside label' }] });
const chained = detailFixture(projectId, id(14), { title: 'Chain child', parentId: goal.id, dependsOn: [root.id, outsider.id], blockedBy: [root.id, outsider.id], ready: false, tags: [] });
const time = '2026-10-22T10:00:00Z';
const taskRow = (link: Locator) => link.locator('..').locator('..').locator('..');

for (const width of [320, 390, 1280]) for (const locale of ['en', 'zh-CN'] as const) test(`project status choices persist and remain usable at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  const completed = detailFixture(projectId, id(51), { title: 'Completed standalone', status: 'done', completedAt: time, ready: false });
  const excluded = detailFixture(projectId, id(50), { title: 'Cancelled standalone', status: 'cancelled', cancelledAt: time, ready: false });
  state.tasks = [...state.tasks, completed, excluded];
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const root = page.locator('.task-status-multifilter');
  const trigger = root.locator('.task-status-filter-trigger');
  const all = root.getByRole('checkbox', { name: locale === 'en' ? 'All statuses' : '全部状态', exact: true });
  const todo = root.getByRole('checkbox', { name: locale === 'en' ? 'To do' : '待办', exact: true });
  const done = root.getByRole('checkbox', { name: locale === 'en' ? 'Done' : '已完成', exact: true });
  await trigger.click(); await expect(all).toBeChecked();
  await all.uncheck(); await todo.check(); await done.check();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await expect(trigger).toContainText(locale === 'en' ? '2 selected' : '已选 2 项');
  await expect(page.locator(`#standalone-task-${standalone.id}`)).toBeVisible();
  await expect(page.locator(`#standalone-task-${completed.id}`)).toBeVisible();
  await expect(page.locator(`#standalone-task-${excluded.id}`)).toHaveCount(0);
  const panel = root.locator('.task-status-filter-panel');
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await done.focus();
  const response = page.waitForResponse(item => new URL(item.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && item.status() === 200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
  await expect(trigger).toHaveAttribute('aria-expanded', 'true'); await expect(done).toBeFocused(); await expect(done).toBeChecked();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(trigger).toContainText(locale === 'en' ? '2 selected' : '已选 2 项');
  await expect(page.locator(`#standalone-task-${standalone.id}`)).toBeVisible();
  await expect(page.locator(`#standalone-task-${completed.id}`)).toBeVisible();
  await expect(page.locator(`#standalone-task-${excluded.id}`)).toHaveCount(0);
  await trigger.click(); await todo.uncheck(); await done.uncheck();
  await expect(trigger).toContainText(locale === 'en' ? 'No statuses selected' : '未选择状态');
  await expect(page.locator(`#standalone-task-${standalone.id}`)).toHaveCount(0);
  await page.reload(); await expect(trigger).toContainText(locale === 'en' ? 'No statuses selected' : '未选择状态');
  await trigger.click(); await all.check();
  await expect(page.locator(`#standalone-task-${excluded.id}`)).toBeVisible();
  expect(state.writes).toEqual([]);
});

async function install(page: Page, locale: 'en' | 'zh-CN') {
  const state = { tasks: [goal, standalone, child, root, chained, outsider] as TaskDetail[], tags: [goal, standalone, child, root, outsider].flatMap(item => item.tags), syncReads: 0, hold: false, held: false, release: () => {}, holdDetail: false, heldDetail: false, releaseDetail: () => {}, holdCatalog: false, heldCatalog: false, releaseCatalog: () => {}, failCatalog: false, writes: [] as string[], tagCreates: [] as { name: string; color?: string }[], observedAt: time, colors: new Map([[id(90), '#D85656'], [id(91), '#FFFFFF'], [id(92), '#000000'], [id(93), '#12A4CD'], [id(94), '#9AA3B2'], [id(95), '#00FF00']]) };
  await page.addInitScript(language => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method()) && !path.endsWith('/tags/resolve') && !path.endsWith('/tags/colors/resolve')) state.writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    const graph = () => ({ ...graphFixture(state.tasks), observedAt: state.observedAt });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph().project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph().project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: TEST_VIEWER_ID, name: 'Reader', avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    const catalogPath = `/api/v1/projects/${projectId}/tags`;
    if (path === catalogPath && request.method() === 'GET') {
      if (state.holdCatalog) { state.holdCatalog = false; state.heldCatalog = true; await new Promise<void>(resolve => { state.releaseCatalog = resolve; }); state.heldCatalog = false; }
      if (state.failCatalog) return send({ error: { code: 'unavailable', message: 'Unavailable', requestId: 'fixture' } }, 500);
      const query = url.searchParams.get('query')?.toLowerCase() ?? '';
      return send({ items: state.tags.filter(tag => tag.name.toLowerCase().includes(query)).map(tag => ({ ...tag, projectId, version: 1, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } })), catalogEpoch: id(999), nextCursor: null });
    }
    if (path === `${catalogPath}/colors/resolve` && request.method() === 'POST') {
      const body = request.postDataJSON() as { tagIds: string[]; catalogEpoch?: string };
      if (body.catalogEpoch && body.catalogEpoch !== id(999)) return send({ error: { code: 'catalog_changed', message: 'Changed', requestId: 'fixture' } }, 409);
      return send({ catalogEpoch: id(999), items: body.tagIds.map(tagId => state.tags.some(tag => tag.id === tagId) ? { id: tagId, state: 'found', version: 1, color: state.colors.get(tagId) ?? '#9AA3B2' } : { id: tagId, state: 'missing' }) });
    }
    if (path === `${catalogPath}/resolve` && request.method() === 'POST') {
      const body = request.postDataJSON() as { tagIds: string[] };
      return send({ items: state.tags.filter(tag => body.tagIds.includes(tag.id)) });
    }
    if (path === catalogPath && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string; color?: string }; state.tagCreates.push(body);
      const tag = { id: id(96), name: body.name }; state.tags.push(tag);
      state.colors.set(tag.id, body.color ?? '#9AA3B2');
      return send({ ...tag, projectId, version: 1, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } }, 201);
    }
    if (path === `/api/v1/projects/${projectId}/task-sync`) {
      state.syncReads++;
      if (state.hold) { state.hold = false; state.held = true; await new Promise<void>(resolve => { state.release = resolve; }); state.held = false; }
      return send(taskSyncFixture(graph(), { query: taskSyncQuery(url), versionForTask: task => state.tasks.find(item => item.id === task.id)!.version, propertiesForTask: task => state.tasks.find(item => item.id === task.id)!.properties, tagsForTask: task => state.tasks.find(item => item.id === task.id)!.tags }));
    }
    if (path === `/api/v1/projects/${projectId}/tasks` && request.method() === 'POST') {
      const body = request.postDataJSON() as { title: string; description?: string; type?: 'task' | 'goal'; parentId?: string | null; assignedTo?: string | null; tagIds?: string[] };
      const kind = body.type ?? 'task';
      const created = detailFixture(projectId, id(100 + state.tasks.length), { type: kind, title: body.title, description: body.description ?? '', status: kind === 'goal' ? 'todo' : 'proposed', ready: false, parentId: body.parentId ?? null, assignedTo: body.assignedTo === undefined ? TEST_VIEWER_ID : body.assignedTo, tags: state.tags.filter(tag => (body.tagIds ?? []).includes(tag.id)) });
      state.tasks.push(created); state.observedAt = '2026-10-22T10:00:04Z';
      return send(created, 201);
    }
    if (path === `/api/v1/projects/${projectId}/tasks/search`) return send({ projectId, total: 0, items: [], nextCursor: null });
    const base = `/api/v1/projects/${projectId}/tasks/`;
    if (path.startsWith(base)) {
      const parts = path.slice(base.length).split('/'), detail = state.tasks.find(item => item.id === parts[0]);
      if (detail && parts.length === 1) {
        if (request.method() === 'PATCH') {
          const body = request.postDataJSON() as { version: number; tagIds: string[] };
          if (BigInt(body.version) !== detail.version) return send({ error: { code: 'version_conflict', message: 'Conflict', requestId: 'fixture' } }, 409);
          const updated = { ...detail, version: detail.version + 1n, updatedAt: '2026-10-22T10:00:02Z', tags: state.tags.filter(tag => body.tagIds.includes(tag.id)) };
          state.tasks = state.tasks.map(item => item.id === detail.id ? updated : item); state.observedAt = '2026-10-22T10:00:04Z';
          return send(updated);
        }
        if (state.holdDetail) { state.holdDetail = false; state.heldDetail = true; await new Promise<void>(resolve => { state.releaseDetail = resolve; }); state.heldDetail = false; }
        return send(state.tasks.find(item => item.id === detail.id)!, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
      }
      if (detail && parts[1] === 'steps') return send({ projectId, taskId: detail.id, version: detail.version, steps: [] });
      if (detail && (parts[1] === 'sessions' || parts[1] === 'attachments')) return send({ items: [], nextCursor: null });
    }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}

for (const width of [1100, 600, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`Goal creation remains in the project toolbar at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale), zh = locale === 'zh-CN';
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const task = page.getByRole('button', { name: zh ? '新建 Task' : 'New Task', exact: true });
  const entry = page.getByRole('button', { name: zh ? '新建 Goal' : 'New Goal', exact: true });
  await expect(entry).toHaveCount(1);
  await expect(task).toBeVisible(); await expect(entry).toBeVisible();
  const taskBox = (await task.boundingBox())!, goalBox = (await entry.boundingBox())!;
  expect(taskBox.y <= goalBox.y + 1).toBe(true);
  if (Math.abs(taskBox.y - goalBox.y) < 1) expect(taskBox.x + taskBox.width).toBeLessThanOrEqual(goalBox.x + 1);
  const actionsWidth = await page.locator('.project-title-actions').evaluate(element => element.getBoundingClientRect().width);
  if (actionsWidth >= taskBox.width + goalBox.width + 8) expect(Math.abs(taskBox.y - goalBox.y)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  for (const view of ['standalone', 'chains', 'goals']) {
    await page.locator(`#project-task-tab-${view}`).click();
    await expect(entry).toHaveCount(1); await expect(entry).toBeVisible();
  }
  const search = page.locator('.task-search-form input');
  await search.fill('no matching task'); await search.press('Enter');
  await expect(page.locator('.task-search-results')).toBeVisible();
  await expect(entry).toBeVisible();
  await entry.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: zh ? '新建 Goal' : 'New Goal' });
  await dialog.getByRole('textbox', { name: zh ? '名称' : 'Name', exact: true }).first().fill('Created from search');
  const syncReads = state.syncReads;
  await dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.syncReads).toBeGreaterThan(syncReads);
  await expect(entry).toBeFocused();
  await expect(search).toHaveValue('no matching task');
  await expect(page.locator('.task-search-results')).toBeVisible();
  expect(state.tasks.find(item => item.title === 'Created from search')?.type).toBe('goal');
  expect(state.writes.filter(write => write === `POST /api/v1/projects/${projectId}/tasks`)).toHaveLength(1);
});

async function assertSummary(summary: Locator, names: readonly string[], viewportWidth: number) {
  const chips = summary.locator('.task-tag'), button = summary.locator(':scope > button');
  await expect(chips).toHaveText([...names]);
  await expect(button).toBeVisible();
  await expect(summary.locator('.task-tag-list')).toHaveCount(names.length === 0 ? 0 : 1);
  const { bounds, boxes } = await summary.evaluate(element => {
    const rect = (item: Element) => {
      const box = item.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, w: item.clientWidth, sw: item.scrollWidth, h: item.clientHeight, sh: item.scrollHeight };
    };
    return { bounds: rect(element), boxes: [...element.querySelectorAll('.task-tag'), element.querySelector(':scope > button')!].map(rect) };
  });
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(box.sw).toBeLessThanOrEqual(box.w + 1);
    expect(box.sh).toBeLessThanOrEqual(box.h + 1);
    for (let j = 0; j < i; j++) {
      const previous = boxes[j]!;
      const overlap = Math.min(box.x + box.width, previous.x + previous.width) > Math.max(box.x, previous.x) + 1 && Math.min(box.y + box.height, previous.y + previous.height) > Math.max(box.y, previous.y) + 1;
      expect(overlap).toBe(false);
    }
  }
  for (let i = 1; i < boxes.length; i++) {
    const previous = boxes[i - 1]!, current = boxes[i]!;
    if (Math.abs(previous.y + previous.height / 2 - current.y - current.height / 2) <= 1) {
      expect(current.x - previous.x - previous.width).toBeCloseTo(8, 0);
    } else {
      const previousCenter = previous.y + previous.height / 2;
      const previousRow = boxes.slice(0, i).filter(box => Math.abs(box!.y + box!.height / 2 - previousCenter) <= 1);
      expect(current.y - Math.max(...previousRow.map(box => box!.y + box!.height))).toBeGreaterThanOrEqual(5);
    }
  }
  expect(await summary.page().evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
  return boxes;
}

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) for (const kind of ['task', 'goal'] as const) test(`detail tag summary wraps independently at ${width}px in ${locale} for ${kind}`, async ({ page }) => {
  const state = await install(page, locale), target = kind === 'task' ? standalone : goal;
  const samples = [
    ['P0'], [], ['P0', 'P1'], ['中文'.repeat(32)],
    ['中文长标签'.repeat(12), 'UnbrokenEnglishTag'.repeat(3), 'P0'],
  ];
  await page.setViewportSize({ width, height: 700 });
  for (const [sampleIndex, names] of samples.entries()) {
    const tags = names.map((name, index) => ({ id: id(300 + index), name }));
    state.observedAt = `2026-10-22T10:00:0${sampleIndex + 1}Z`;
    state.tasks = state.tasks.map(item => item.id === target.id ? { ...item, tags, version: BigInt(sampleIndex + 1), updatedAt: state.observedAt } : item);
    state.tags = tags;
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    if (kind === 'task') {
      await page.locator('#project-task-tab-standalone').click();
      await page.locator(`#standalone-task-${target.id}`).click();
    } else {
      await page.locator('#project-task-tab-goals').click();
      await page.locator(`#project-goal-detail-${target.id}`).click();
    }
    const dialog = page.locator('.task-detail-dialog');
    const summary = dialog.locator('.task-tags-summary');
    const boxes = await assertSummary(summary, names, width);
    if (names[0] === 'P0') {
      const last = boxes[names.length - 1]!, edit = boxes[names.length]!;
      expect(Math.abs(last.y + last.height / 2 - edit.y - edit.height / 2)).toBeLessThanOrEqual(1);
      expect(edit.x - last.x - last.width).toBeCloseTo(8, 0);
    }
    if (names[0] === '中文'.repeat(32)) expect(boxes[1]!.y - (boxes[0]!.y + boxes[0]!.height)).toBeGreaterThanOrEqual(5);
    if (names[0] === 'P0' && names.length === 1) {
      await dialog.locator('.task-detail-fullscreen-toggle').click();
      await assertSummary(summary, names, width);
      await dialog.locator('.task-detail-fullscreen-toggle').click();
      await summary.locator('button').click();
      const editor = dialog.locator('.task-tags-editor');
      await expect(editor).toBeVisible();
      await expect(summary.locator('.task-tags-editor')).toHaveCount(0);
      expect((await editor.boundingBox())!.y).toBeGreaterThanOrEqual((await summary.boundingBox())!.y + (await summary.boundingBox())!.height);
      await editor.getByRole('searchbox').focus();
      await page.keyboard.press('Escape');
      await expect(summary.locator('button')).toBeFocused();
      await page.goto(`/projects/${projectId}/tasks/${target.id}?tab=overview`);
      await assertSummary(page.locator('.task-detail-page .task-tags-summary'), names, width);
    }
  }
  expect(state.writes).toEqual([]);
});

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`own tags remain readable in lists and details at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const row = page.locator(`#standalone-task-${standalone.id}`);
  await expect(taskRow(row).locator('.task-tag')).toHaveText([longName, 'Another label']);
  await page.keyboard.press('Tab'); await row.focus(); await expect(row).toBeFocused();
  await expect(row).toHaveAccessibleName(standalone.title);
  const focusOutline = await row.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  expect(focusOutline.style).not.toBe('none'); expect(focusOutline.width).toBeGreaterThan(0);
  await expect(taskRow(row).locator('.task-tag').first()).toBeVisible();
  const geometry = await taskRow(row).locator('.task-tag').first().evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.keyboard.press('Enter');
  const taskDialog = page.locator('.task-detail-dialog');
  await expect(taskDialog.locator('.task-tag')).toHaveText([longName, 'Another label']);
  await taskDialog.locator('.task-detail-close').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`);
  await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Goal label']);
  await card.locator('.goal-list-toggle').click();
  const childRow = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  await expect(taskRow(childRow).locator('.task-tag')).toHaveText(['Child label']);
  await expect(taskRow(childRow).locator('.task-tag')).not.toContainText('Goal label');
  await expect(taskRow(card.locator(`#chain-task-goal-${goal.id}-${root.id}`)).locator('.task-tag')).toHaveText(['Root label']);
  const emptyRow = card.locator(`#chain-task-goal-${goal.id}-${chained.id}`);
  await expect(taskRow(emptyRow).locator('.task-tag-list')).toHaveCount(0);
  await expect(emptyRow).toHaveAccessibleName(chained.title);
  await card.locator(`#project-goal-detail-${goal.id}`).click();
  const goalDialog = page.locator('.goal-detail-surface');
  await expect(goalDialog.locator('.task-tag')).toHaveText(['Goal label']);
  await expect(goalDialog.locator('.task-tag')).not.toContainText('Child label');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(state.writes).toEqual([]);
});

test('delta updates each row without losing expanded state or clearing content while a refresh waits', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`), toggle = card.locator('.goal-list-toggle');
  await toggle.click(); await toggle.focus();
  const childRow = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  await expect(taskRow(childRow).locator('.task-tag')).toHaveText(['Child label']);
  state.hold = true;
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
  try {
    await expect.poll(() => state.held).toBe(true);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Goal label']);
    await expect(taskRow(childRow).locator('.task-tag')).toHaveText(['Child label']);
    state.observedAt = '2026-10-22T10:00:04Z';
    state.tasks = state.tasks.map(item => item.id === goal.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(90), name: 'Renamed goal label' }] }
      : item.id === child.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [] }
        : item.id === root.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(94), name: 'Renamed root label' }] } : item);
    state.release();
    await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Renamed goal label']);
    await expect(taskRow(childRow).locator('.task-tag')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(taskRow(card.locator(`#chain-task-goal-${goal.id}-${root.id}`)).locator('.task-tag')).toHaveText(['Renamed root label']);
    state.tasks = state.tasks.map(item => item.id === child.id ? { ...item, version: 3n, updatedAt: '2026-10-22T10:00:06Z', tags: [{ id: id(93), name: 'Restored child label' }] } : item);
    state.observedAt = '2026-10-22T10:00:08Z';
    await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
    await expect(taskRow(childRow).locator('.task-tag')).toHaveText(['Restored child label']);
    await expect(childRow).toHaveAccessibleName(child.title);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    expect(state.writes).toEqual([]);
  } finally { state.release(); }
});


test('open details use current synced tags while Task detail read waits', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  await page.locator(`#standalone-task-${standalone.id}`).click();
  const taskDialog = page.locator('.task-detail-dialog');
  await expect(taskDialog.locator('.task-tag')).toHaveText([longName, 'Another label']);
  state.tasks = state.tasks.map(item => item.id === standalone.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(91), name: 'Renamed task label' }] } : item);
  state.observedAt = '2026-10-22T10:00:04Z'; state.holdDetail = true;
  try {
    await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
    await expect.poll(() => state.heldDetail).toBe(true);
    await expect(taskDialog.locator('.task-tag')).toHaveText(['Renamed task label']);
    await expect(taskDialog).toBeVisible();
    state.releaseDetail();
    await taskDialog.locator('.task-detail-close').click();
    await page.locator('#project-task-tab-goals').click();
    const card = page.locator(`[data-goal-id="${goal.id}"]`);
    await card.locator(`#project-goal-detail-${goal.id}`).click();
    const goalDialog = page.locator('.goal-detail-surface');
    await expect(goalDialog.locator('.task-tag')).toHaveText(['Goal label']);
    state.tasks = state.tasks.map(item => item.id === goal.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:05Z', tags: [] } : item);
    state.observedAt = '2026-10-22T10:00:07Z';
    await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
    await expect(goalDialog.locator('.task-tag')).toHaveCount(0);
    await expect(goalDialog.locator('.task-tag-list')).toHaveCount(0);
    await expect(goalDialog).toBeVisible();
    state.releaseDetail();
    expect(state.writes).toEqual([]);
  } finally { state.releaseDetail(); }
});

test('Goal graph preserves direct and outside dependency context with tags', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  await page.locator(`#project-goal-graph-${goal.id}`).click();
  const graph = page.locator(`#task-graph-${goal.id}`);
  for (const task of [root, chained, child, outsider]) await expect(graph.locator(`.react-flow__node[data-id="${task.id}"]`)).toHaveCount(1);
  await expect(graph.locator(`.react-flow__node[data-id="${outsider.id}"] .task-node-external`)).toBeVisible();
  const rootEdge = graph.locator(`.react-flow__edge[data-source="${root.id}"][data-target="${chained.id}"], .react-flow__edge[data-source="${chained.id}"][data-target="${root.id}"]`);
  const outsideEdge = graph.locator(`.react-flow__edge[data-source="${outsider.id}"][data-target="${chained.id}"], .react-flow__edge[data-source="${chained.id}"][data-target="${outsider.id}"]`);
  await expect(rootEdge).toHaveCount(1); await expect(outsideEdge).toHaveCount(1);
  expect(state.writes).toEqual([]);
});

test('changing Parent preserves the Task own tags', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`);
  await card.locator('.goal-list-toggle').click();
  const childRow = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  await expect(taskRow(childRow).locator('.task-tag')).toHaveText(['Child label']);
  state.observedAt = '2026-10-22T10:00:04Z';
  state.tasks = state.tasks.map(item => item.id === child.id ? { ...item, parentId: null, version: 2n, updatedAt: '2026-10-22T10:00:02Z' } : item);
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
  await expect(childRow).toHaveCount(0);
  await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Goal label']);
  await page.locator('#project-task-tab-standalone').click();
  await expect(taskRow(page.locator(`#standalone-task-${child.id}`)).locator('.task-tag')).toHaveText(['Child label']);
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`long Goal and child tags do not obscure controls at 320px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  state.tasks = state.tasks.map(item => item.id === goal.id ? { ...item, tags: [{ id: id(90), name: longName }] }
    : item.id === child.id ? { ...item, tags: [{ id: id(93), name: longName }] } : item);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`), toggle = card.locator('.goal-list-toggle');
  const summary = card.locator('.goal-list-summary');
  await expect(summary.locator('.task-tag')).toHaveText([longName]);
  await page.keyboard.press('Tab'); await toggle.focus(); await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleDescription(new RegExp(longName));
  const outline = await toggle.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  expect(outline.style).not.toBe('none'); expect(outline.width).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  const childRow = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  await expect(taskRow(childRow).locator('.task-tag')).toHaveText([longName]);
  for (const tag of [summary.locator('.task-tag'), taskRow(childRow).locator('.task-tag')]) {
    await expect(tag).toBeVisible();
    const dimensions = await tag.evaluate(element => ({ w: element.clientWidth, sw: element.scrollWidth, h: element.clientHeight, sh: element.scrollHeight }));
    expect(dimensions.sw).toBeLessThanOrEqual(dimensions.w + 1); expect(dimensions.sh).toBeLessThanOrEqual(dimensions.h + 1);
  }
  for (const control of [summary.locator('.goal-list-title'), card.locator('.goal-list-session .root-status'), card.locator('.goal-list-detail'), card.locator('.goal-list-graph'), childRow, taskRow(childRow).locator('.root-status')]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  }
  const tagBox = (await summary.locator('.task-tag').boundingBox())!;
  for (const control of [card.locator('.goal-list-session .root-status'), card.locator('.goal-list-detail'), card.locator('.goal-list-graph')]) {
    const box = (await control.boundingBox())!;
    const overlap = Math.min(tagBox.x + tagBox.width, box.x + box.width) > Math.max(tagBox.x, box.x) && Math.min(tagBox.y + tagBox.height, box.y + box.height) > Math.max(tagBox.y, box.y);
    expect(overlap).toBe(false);
  }
  const childTagBox = (await taskRow(childRow).locator('.task-tag').boundingBox())!;
  const childStatusBox = (await taskRow(childRow).locator('.root-status').boundingBox())!;
  const childOverlap = Math.min(childTagBox.x + childTagBox.width, childStatusBox.x + childStatusBox.width) > Math.max(childTagBox.x, childStatusBox.x) && Math.min(childTagBox.y + childTagBox.height, childStatusBox.y + childStatusBox.height) > Math.max(childTagBox.y, childStatusBox.y);
  expect(childOverlap).toBe(false);
  await expect(childRow).toHaveAccessibleName(child.title);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(state.writes).toEqual([]);
});


test('outside interactions and competing filters preserve independent state and overlay ownership', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const toolbar = page.locator('.project-tasks .task-list-filters').filter({ visible: true });
  const main = toolbar.locator('.tag-filter').nth(0), childFilter = toolbar.locator('.tag-filter').nth(1);
  const mainTrigger = main.locator('summary'), childTrigger = childFilter.locator('summary');
  const mainSearch = main.locator('input[type="search"]'), childSearch = childFilter.locator('input[type="search"]');
  await mainTrigger.click();
  await main.getByLabel('Goal label').check();
  await main.getByLabel('Another label').check();
  await main.getByRole('radio', { name: 'Any selected' }).check();
  await main.getByLabel('Another label').uncheck();
  await mainSearch.fill('Goal');
  await expect(main).toHaveAttribute('open', '');
  await childTrigger.focus(); await page.keyboard.press('Enter');
  await expect(main).not.toHaveAttribute('open', ''); await expect(childFilter).toHaveAttribute('open', '');
  await childSearch.fill('Child'); await childFilter.getByLabel('Child label').check();
  await mainTrigger.focus(); await page.keyboard.press('Enter');
  await expect(childFilter).not.toHaveAttribute('open', ''); await expect(main).toHaveAttribute('open', '');
  await expect(mainSearch).toHaveValue('Goal'); await expect(main.getByLabel('Goal label')).toBeChecked();
  await expect(main.getByRole('radio', { name: 'Any selected' })).toBeChecked();
  await expect(main.getByRole('radio', { name: 'Any selected' })).toBeDisabled();
  await childTrigger.click();
  await expect(main).not.toHaveAttribute('open', ''); await expect(childFilter).toHaveAttribute('open', '');
  await expect(childSearch).toHaveValue('Child'); await expect(childFilter.getByLabel('Child label')).toBeChecked();
  const card = page.locator(`[data-goal-id="${goal.id}"]`), toggle = card.locator('.goal-list-toggle');
  await toggle.click();
  await expect(childFilter).not.toHaveAttribute('open', ''); await expect(toggle).toBeFocused();
  await expect(card.locator(`#chain-task-goal-${goal.id}-${child.id}`)).toBeVisible();
  await childTrigger.click();
  const outsideInput = page.locator('.task-search-form input[type="text"]');
  await outsideInput.click();
  await expect(childFilter).not.toHaveAttribute('open', ''); await expect(outsideInput).toBeFocused();
  await childTrigger.click();
  await outsideInput.focus(); await page.keyboard.press('Escape');
  await expect(childFilter).not.toHaveAttribute('open', ''); await expect(childTrigger).toBeFocused();
  await childTrigger.click();
  await card.locator(`#project-goal-detail-${goal.id}`).evaluate((element: HTMLButtonElement) => element.click());
  const dialog = page.locator('.goal-detail-surface');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(childFilter).toHaveAttribute('open', '');
  const overview = page.locator('#project-section-tab-overview');
  await overview.evaluate((element: HTMLButtonElement) => element.click());
  await overview.focus();
  const consumed = await overview.evaluate(element => !element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(consumed).toBe(false); await expect(overview).toBeFocused();
  await page.locator('#project-section-tab-tasks').evaluate((element: HTMLButtonElement) => element.click());
  await expect(childFilter).toHaveAttribute('open', '');
  await expect(childSearch).toHaveValue('Child'); await expect(childFilter.getByLabel('Child label')).toBeChecked();
  await toolbar.evaluate(element => element.setAttribute('inert', ''));
  await outsideInput.focus();
  const inertConsumed = await outsideInput.evaluate(element => !element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(inertConsumed).toBe(false); await expect(outsideInput).toBeFocused(); await expect(childFilter).toHaveAttribute('open', '');
  await toolbar.evaluate(element => element.removeAttribute('inert'));
  await childFilter.evaluate(filter => document.querySelector('.project-title-actions a[href$="/settings"]')!.addEventListener('click', () => {
    (window as unknown as { filterOpenAtLinkClick: boolean }).filterOpenAtLinkClick = filter.hasAttribute('open');
  }, { once: true }));
  await page.locator('.project-title-actions a[href$="/settings"]').click();
  expect(await page.evaluate(() => (window as unknown as { filterOpenAtLinkClick: boolean }).filterOpenAtLinkClick)).toBe(false);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings$`));
  expect(state.writes).toEqual([]);
});

for (const scenario of ['empty', 'no matches', 'loading', 'failure', 'untagged'] as const) test(`the tag filter can close in the ${scenario} state`, async ({ page }) => {
  const state = await install(page, 'en');
  if (scenario === 'empty') state.tags = [];
  if (scenario === 'loading') state.holdCatalog = true;
  if (scenario === 'failure') state.failCatalog = true;
  try {
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').click();
    const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
    const trigger = filter.locator('summary'); await trigger.click();
    const outside = page.locator('#project-task-tab-standalone');
    if (scenario === 'empty') await expect(filter.getByText('No tags yet.')).toBeVisible();
    if (scenario === 'no matches') {
      await filter.getByLabel('Goal label').check();
      await filter.locator('input[type="search"]').fill('not found');
      await expect(filter.getByText('No matching tags.')).toBeVisible();
      await filter.locator('.tag-filter-message').getByRole('button', { name: 'Clear tag search' }).click();
      await expect(filter.getByLabel('Goal label')).toBeChecked();
      await filter.locator('input[type="search"]').fill('not found');
    }
    if (scenario === 'loading') await expect(filter.getByText('Loading tags…')).toBeVisible();
    if (scenario === 'failure') {
      await expect(filter.getByText('Could not load tags.')).toBeVisible();
      await outside.click(); await expect(filter).not.toHaveAttribute('open', '');
      await trigger.click(); await expect(filter.getByText('Could not load tags.')).toBeVisible();
      state.failCatalog = false; await filter.getByRole('button', { name: 'Retry' }).click();
      await expect(filter.getByLabel('Goal label')).toBeVisible(); await expect(filter).toHaveAttribute('open', '');
    }
    if (scenario === 'untagged') {
      await filter.getByLabel('Untagged only').check();
      await expect(filter.getByRole('radio', { name: 'All selected' })).toBeDisabled(); await expect(filter).toHaveAttribute('open', '');
    }
    await outside.click();
    await expect(filter).not.toHaveAttribute('open', '');
    if (scenario === 'loading') state.releaseCatalog();
    await trigger.click(); await expect(filter).toHaveAttribute('open', '');
    await page.keyboard.press('Escape'); await expect(filter).not.toHaveAttribute('open', '');
    await trigger.click(); await page.keyboard.press('Escape'); await expect(filter).not.toHaveAttribute('open', '');
    expect(state.writes).toEqual([]);
  } finally { state.releaseCatalog(); }
});

test('a failed background catalog read keeps the current page and selection until retry', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
  await filter.locator('summary').click();
  const search = filter.locator('input[type="search"]');
  await search.fill('Goal');
  const option = filter.getByLabel('Goal label'); await option.check();
  state.failCatalog = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(filter.getByText('Could not load tags.')).toBeVisible();
  await expect(option).toBeVisible(); await expect(option).toBeChecked(); await expect(search).toHaveValue('Goal');
  state.failCatalog = false;
  await filter.getByRole('button', { name: 'Retry' }).click();
  await expect(filter.getByText('Could not load tags.')).toHaveCount(0);
  await expect(option).toBeChecked(); await expect(search).toHaveValue('Goal');
  expect(state.writes).toEqual([]);
});

for (const locale of ['en', 'zh-CN'] as const) test(`native match radios support arrow keys and retain a disabled value in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
  await filter.locator('summary').click();
  await filter.getByLabel('Goal label').check(); await filter.getByLabel('Another label').check();
  const all = filter.getByRole('radio', { name: locale === 'zh-CN' ? '全部满足' : 'All selected' });
  const any = filter.getByRole('radio', { name: locale === 'zh-CN' ? '满足任一' : 'Any selected' });
  await all.focus(); await page.keyboard.press('ArrowRight');
  await expect(any).toBeFocused(); await expect(any).toBeChecked();
  await filter.getByLabel('Another label').uncheck();
  await expect(any).toBeDisabled(); await expect(any).toBeChecked();
  await filter.getByLabel('Another label').check();
  await expect(any).toBeEnabled(); await expect(any).toBeChecked();
  expect(state.writes).toEqual([]);
});

test('opening the status filter dismisses the tag filter and Escape restores status focus', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const toolbar = page.locator('.project-tasks .task-list-filters:visible');
  const filter = toolbar.locator('.tag-filter').first();
  await filter.locator('summary').click(); await expect(filter.getByLabel('Goal label')).toBeVisible();
  const status = toolbar.locator('.task-status-filter-trigger');
  await status.click();
  await expect(filter).not.toHaveAttribute('open', '');
  await expect(status).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(status).toHaveAttribute('aria-expanded', 'false'); await expect(status).toBeFocused();
  expect(state.writes).toEqual([]);
});

test('keyboard opening either filter dismisses the other and Escape restores its trigger', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const toolbar = page.locator('.project-tasks .task-list-filters:visible');
  const tag = toolbar.locator('.tag-filter').first(), tagTrigger = tag.locator('summary');
  const status = toolbar.locator('.task-status-filter-trigger');
  await tagTrigger.focus(); await page.keyboard.press('Enter');
  await expect(tag).toHaveAttribute('open', '');
  await status.focus(); await page.keyboard.press('Enter');
  await expect(tag).not.toHaveAttribute('open', ''); await expect(status).toHaveAttribute('aria-expanded', 'true');
  await tagTrigger.focus(); await page.keyboard.press('Enter');
  await expect(status).toHaveAttribute('aria-expanded', 'false'); await expect(tag).toHaveAttribute('open', '');
  await page.keyboard.press('Escape'); await expect(tag).not.toHaveAttribute('open', ''); await expect(tagTrigger).toBeFocused();
  expect(state.writes).toEqual([]);
});

test('capture-phase outside dismissal preserves the target action even when propagation stops', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
  await filter.locator('summary').click();
  await page.evaluate(() => {
    const element = document.createElement('button'); element.textContent = 'Outside test action';
    Object.assign(element.style, { position: 'fixed', top: '0', left: '0', zIndex: '1000' });
    element.addEventListener('pointerdown', event => event.stopPropagation());
    element.addEventListener('click', () => element.setAttribute('data-activated', 'true'));
    document.body.appendChild(element);
  });
  const target = page.getByRole('button', { name: 'Outside test action' });
  await target.click();
  await expect(filter).not.toHaveAttribute('open', '');
  await expect(target).toHaveAttribute('data-activated', 'true');
  expect(state.writes).toEqual([]);
});

test('switching from task search preserves focus and an open tag filter without refocusing its search', async ({ page }) => {
  const state = await install(page, 'en');
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const taskSearch = page.locator('.task-search-form input[type="text"]');
  await taskSearch.fill('goal'); await taskSearch.press('Enter');
  const searchFilter = page.locator('.task-search-filters .tag-filter');
  await searchFilter.locator('summary').click();
  const tagSearch = searchFilter.locator('input[type="search"]');
  await expect(tagSearch).toBeFocused(); await tagSearch.fill('Goal');
  await searchFilter.getByLabel('Goal label').check();
  await tagSearch.focus();
  for (let count = 0; count < 12 && !await taskSearch.evaluate(element => element === document.activeElement); count++) await page.keyboard.press('Shift+Tab');
  await expect(taskSearch).toBeFocused(); await expect(searchFilter).toHaveAttribute('open', '');
  await taskSearch.press('ControlOrMeta+A'); await taskSearch.press('Backspace');
  await expect(taskSearch).toHaveValue(''); await expect(taskSearch).toBeFocused();
  const listFilter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
  await expect(listFilter).toHaveAttribute('open', '');
  const listSearch = listFilter.locator('input[type="search"]');
  await expect(listSearch).toHaveValue('Goal'); await expect(listFilter.getByLabel('Goal label')).toBeChecked();
  await expect(taskSearch).toBeFocused();
  await page.keyboard.press('Escape'); await expect(listFilter).not.toHaveAttribute('open', '');
  await listFilter.locator('summary').click();
  await expect(listSearch).toBeFocused(); await expect(listSearch).toHaveValue('Goal');
  await expect(listFilter.getByLabel('Goal label')).toBeChecked();
  for (let count = 0; count < 16 && !await taskSearch.evaluate(element => element === document.activeElement); count++) await page.keyboard.press('Shift+Tab');
  await expect(taskSearch).toBeFocused(); await expect(listFilter).toHaveAttribute('open', '');
  await taskSearch.fill('another'); await taskSearch.press('Enter');
  await expect(searchFilter).toHaveAttribute('open', ''); await expect(taskSearch).toBeFocused();
  await expect(tagSearch).toHaveValue('Goal'); await expect(searchFilter.getByLabel('Goal label')).toBeChecked();
  await expect(taskSearch).toBeFocused();
  expect(state.writes.every(write => write === `POST /api/v1/projects/${projectId}/tasks/search`)).toBe(true);
});

test.describe('touch filter dismissal', () => {
  test.use({ hasTouch: true });
  test('tapping outside closes the panel and activates the target', async ({ page }) => {
    const state = await install(page, 'en');
    await page.goto(`/projects/${projectId}`);
    await page.locator('#project-section-tab-tasks').tap();
    const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
    await filter.locator('summary').tap(); await expect(filter).toHaveAttribute('open', '');
    await expect(filter.getByLabel('Goal label')).toBeVisible();
    const targets = filter.locator('.tag-filter-options label, .tag-filter-untagged, .tag-filter-radios label');
    for (const target of await targets.all()) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await filter.locator('input[type="search"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    const standaloneTab = page.locator('#project-task-tab-standalone'); await standaloneTab.tap();
    await expect(filter).not.toHaveAttribute('open', ''); await expect(standaloneTab).toHaveAttribute('aria-selected', 'true');
    expect(state.writes).toEqual([]);
  });
});

test('the filter remains usable in an offset, short visible viewport with an offscreen anchor', async ({ page }) => {
  const state = await install(page, 'en');
  state.tags = Array.from({ length: 30 }, (_, index) => ({ id: id(300 + index), name: `Label ${String(index).padStart(2, '0')}` }));
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  // This controlled visualViewport exercises the geometry path; it is not a physical keyboard.
  await page.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 390, height: 700, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  const filter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
  const trigger = filter.locator('summary'), panel = filter.locator('.tag-filter-panel');
  await trigger.click();
  const search = filter.locator('input[type="search"]');
  await expect(search).toBeFocused(); await search.fill('Label');
  await filter.getByLabel('Label 00').check();
  const options = filter.locator('.tag-filter-options');
  await expect.poll(() => options.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await options.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(filter.getByLabel('Label 29')).toBeInViewport();
  await search.focus(); await search.evaluate((element: HTMLInputElement) => {
    element.setSelectionRange(1, 4);
    (window as unknown as { originalSearch: HTMLInputElement }).originalSearch = element;
  });

  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.assign(viewport, { offsetLeft: 45, offsetTop: 90, width: 280, height: 220 });
    viewport.dispatchEvent(new Event('resize'));
  });
  const insideVisibleViewport = async () => {
    const box = await panel.boundingBox();
    return box !== null && box.x >= 60 && box.x + box.width <= 310 && box.y >= 89 && box.y + box.height <= 311;
  };
  await expect.poll(insideVisibleViewport).toBe(true);
  for (const offset of [-1000, 1000]) {
    await filter.evaluate((element: HTMLElement, top) => { element.style.top = `${top}px`; }, offset);
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    await expect.poll(insideVisibleViewport).toBe(true);
    expect(await search.evaluate(element => element === (window as unknown as { originalSearch: HTMLInputElement }).originalSearch)).toBe(true);
    await expect(search).toBeFocused(); await expect(search).toHaveValue('Label');
    expect(await search.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
    await expect(filter.getByLabel('Label 00')).toBeChecked();
  }
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const lastAction = filter.getByRole('button', { name: 'Manage tags' });
  await expect.poll(async () => {
    const box = await lastAction.boundingBox(), container = await panel.boundingBox();
    return box !== null && container !== null && box.y >= container.y - 1 && box.y + box.height <= container.y + container.height + 1;
  }).toBe(true);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.assign(viewport, { width: 40 }); viewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    return box !== null && box.x >= 44 && box.x + box.width <= 86;
  }).toBe(true);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.assign(viewport, { width: 280, height: 40 }); viewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = await panel.boundingBox();
    return box !== null && box.y >= 89 && box.y + box.height <= 131;
  }).toBe(true);
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => {
    const box = await lastAction.boundingBox(), container = await panel.boundingBox();
    return box !== null && container !== null && box.y >= container.y - 1 && box.y + box.height <= container.y + container.height + 1;
  }).toBe(true);
  await lastAction.click();
  await expect(page.locator('#project-section-tab-tags')).toHaveAttribute('aria-selected', 'true');
  expect(state.writes).toEqual([]);
});

for (const width of [1280, 736, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`tag filters retain keyboard focus and layout during checks at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  const childLongName = `${longName}X`;
  state.tasks = state.tasks.map(item => item.id === child.id ? { ...item, tags: [{ id: id(93), name: childLongName }] } : item);
  state.tags = state.tags.map(tag => tag.id === id(93) ? { ...tag, name: childLongName } : tag);
  const secondGoal = detailFixture(projectId, id(20), { type: 'goal', title: 'Second goal', ready: false });
  const secondChild = detailFixture(projectId, id(21), { title: 'Second child', parentId: secondGoal.id, tags: [{ id: id(93), name: childLongName }] });
  const hiddenChild = detailFixture(projectId, id(22), { title: 'Unmatched child', parentId: secondGoal.id, tags: [] });
  state.tasks.push(secondGoal, secondChild, hiddenChild);
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const toolbar = page.locator('.project-tasks .task-list-filters').filter({ visible: true });
  await expect(toolbar.locator(':scope > .task-assignee-filter, :scope > .task-status-filter, :scope > .tag-filter-wrap')).toHaveCount(4);
  const status = toolbar.locator('.task-status-filter');
  const checkSelect = async (container: Locator) => {
    const wrapper = container.locator('.native-select');
    await expect(wrapper).toHaveAttribute('data-density', 'filter');
    await expect(wrapper).toHaveAttribute('data-focus-tone', 'task');
    const geometry = await wrapper.evaluate(element => {
      const select = element.querySelector('select')!, arrow = element.querySelector('svg')!;
      const control = select.getBoundingClientRect(), icon = arrow.getBoundingClientRect();
      return { height: control.height, inset: control.right - icon.right, center: (control.top + control.bottom - icon.top - icon.bottom) / 2,
        arrows: element.querySelectorAll('svg').length, appearance: getComputedStyle(select).appearance };
    });
    expect(geometry.height).toBe(32); expect(geometry.inset).toBeCloseTo(12, 0);
    expect(Math.abs(geometry.center)).toBeLessThanOrEqual(1);
    expect(geometry.arrows).toBe(1); expect(geometry.appearance).toBe('none');
  };
  await expect(status.locator('.task-status-filter-trigger')).toBeVisible();
  const main = toolbar.locator('.tag-filter').nth(0);
  const filter = toolbar.locator('.tag-filter').nth(1);
  expect(await status.evaluate(element => element.nextElementSibling?.className)).toBe('tag-filter-wrap');
  expect(await main.evaluate(element => element.parentElement?.nextElementSibling?.className)).toBe('tag-filter-wrap');
  const mainTrigger = main.locator('summary');
  await mainTrigger.focus(); await page.keyboard.press('Enter');
  await expect(main).toHaveAttribute('open', '');
  await expect.poll(async () => {
    const bounds = await main.locator('.tag-filter-panel').boundingBox();
    return bounds !== null && Math.abs(bounds.width - Math.min(352, width - 32)) <= 1 && bounds.x >= 15 && bounds.x + bounds.width <= width - 15;
  }).toBe(true);
  await page.keyboard.press('Escape'); await expect(mainTrigger).toBeFocused();
  const card = page.locator(`[data-goal-id="${goal.id}"]`);
  await card.locator('.goal-list-toggle').click();
  await expect(card.locator('.tag-filter')).toHaveCount(0);
  const trigger = filter.locator('summary');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(filter).toHaveAttribute('open', '');
  const search = filter.locator('input[type="search"]');
  await search.focus(); await search.fill('Unbroken');
  await expect(filter.getByText(childLongName, { exact: true })).toBeVisible();
  const option = filter.getByLabel(childLongName); await option.check();
  const colorDot = option.locator('..').locator('.task-tag-dot');
  await expect(colorDot).toHaveCSS('background-color', 'rgb(18, 164, 205)');
  const contentGeometry = await option.evaluate(input => {
    const panel = input.closest('.tag-filter-panel')!, row = input.closest('label')!, chip = row.querySelector('.task-tag')!;
    const box = (element: Element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth });
    return { panel: box(panel), row: box(row), chip: box(chip), text: chip.textContent };
  });
  expect(contentGeometry.text).toContain(childLongName);
  for (const box of [contentGeometry.panel, contentGeometry.row, contentGeometry.chip]) expect(box.scrollWidth).toBeLessThanOrEqual(box.width + 1);
  const all = filter.getByRole('radio', { name: locale === 'zh-CN' ? '全部满足' : 'All selected' });
  const any = filter.getByRole('radio', { name: locale === 'zh-CN' ? '满足任一' : 'Any selected' });
  await expect(all).toBeDisabled(); await expect(all).toBeChecked(); await expect(any).toBeDisabled();
  await expect(search).toHaveValue('Unbroken'); await expect(option).toBeChecked();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await expect(filter).not.toHaveAttribute('open', '');
  const secondCard = page.locator(`[data-goal-id="${secondGoal.id}"]`);
  await secondCard.locator('.goal-list-toggle').click();
  await expect(secondCard.locator(`#chain-task-goal-${secondGoal.id}-${secondChild.id}`)).toBeVisible();
  await expect(secondCard.locator(`#chain-task-goal-${secondGoal.id}-${hiddenChild.id}`)).toHaveCount(0);
  await card.locator('.goal-list-toggle').click(); await card.locator('.goal-list-toggle').click();
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(filter).toHaveAttribute('open', '');
  await expect(option).toBeChecked();
  await page.locator('#project-task-tab-standalone').click(); await page.locator('#project-task-tab-goals').click();
  await expect(filter).not.toHaveAttribute('open', '');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(search).toHaveValue('Unbroken'); await expect(option).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(filter).not.toHaveAttribute('open', '');
  await card.locator('.goal-list-toggle').click();
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(filter).toHaveAttribute('open', '');
  await search.focus(); await search.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 4));
  await search.evaluate(element => { (window as unknown as { filterSearchBeforeRefresh: Element }).filterSearchBeforeRefresh = element; });
  const bounds = await filter.locator('.tag-filter-panel').boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  state.holdCatalog = true;
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => state.heldCatalog).toBe(true);
    await expect(filter).toHaveAttribute('open', ''); await expect(search).toHaveValue('Unbroken'); await expect(search).toBeFocused();
    expect(await search.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
    await expect(option).toBeChecked();
    await expect(card.locator(`#chain-task-goal-${goal.id}-${child.id}`)).toBeVisible();
    // The catalog response stays unchanged; its completion invalidates the color
    // projection, whose visible update provides a barrier after React processes it.
    state.colors.set(id(93), '#BA1335');
    await expect(colorDot).toHaveCSS('background-color', 'rgb(18, 164, 205)');
    const catalogResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/tags`);
    state.releaseCatalog();
    expect((await catalogResponse).ok()).toBe(true);
    await expect(colorDot).toHaveCSS('background-color', 'rgb(186, 19, 53)');
    await expect(search).toHaveValue('Unbroken'); await expect(search).toBeFocused();
    expect(await search.evaluate(element => element === (window as unknown as { filterSearchBeforeRefresh: Element }).filterSearchBeforeRefresh)).toBe(true);
    expect(await search.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 4]);
    await expect(option).toBeChecked();
    await page.keyboard.press('Escape'); await expect(trigger).toBeFocused(); await expect(filter).not.toHaveAttribute('open', '');
  } finally { state.releaseCatalog(); }
  const input = page.locator('.task-search-form input[type="text"]');
  await input.fill('goal'); await input.press('Enter');
  const searchToolbar = page.locator('.task-search-filters');
  await expect(searchToolbar.locator('.tag-filter')).toHaveCount(1);
  await checkSelect(searchToolbar.locator('.task-status-filter'));
  expect(await searchToolbar.locator('.task-status-filter').evaluate(element => element.nextElementSibling?.className)).toBe('tag-filter-wrap');
  await expect(page.locator('.tag-filter-trigger').filter({ hasText: locale === 'zh-CN' ? '子 Task' : 'Child task' })).toHaveCount(0);
  await input.fill('');
  await expect(filter).not.toHaveAttribute('open', '');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(filter).toHaveAttribute('open', '');
  await expect(filter.locator('input[type="search"]')).toHaveValue('Unbroken');
  await expect(filter.getByLabel(childLongName)).toBeChecked();
});

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`edit Task and Goal tags with keyboard and retain independently created tags at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  const zh = locale === 'zh-CN';
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  await page.locator(`#standalone-task-${standalone.id}`).click();
  const taskDialog = page.locator('.task-detail-dialog');
  const edit = taskDialog.getByRole('button', { name: zh ? '编辑标签' : 'Edit tags' });
  await expect(edit).toBeEnabled(); await edit.focus(); await page.keyboard.press('Enter');
  const editor = taskDialog.locator('.task-tags-editor');
  const search = editor.getByRole('searchbox', { name: zh ? '搜索标签' : 'Search tags' });
  await expect(search).toBeVisible(); await search.focus();
  await expect(editor.getByRole('checkbox', { name: 'Goal label' })).toBeVisible();
  await editor.getByRole('checkbox', { name: 'Goal label' }).focus(); await page.keyboard.press('Space');
  await expect(editor.getByRole('checkbox', { name: 'Goal label' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0); await expect(edit).toBeFocused();
  expect(state.tasks.find(item => item.id === standalone.id)!.tags).toEqual(standalone.tags);
  await edit.click();
  await editor.getByRole('textbox', { name: zh ? '名称' : 'Name', exact: true }).fill('Browser created');
  await editor.getByRole('button', { name: zh ? '新建标签' : 'New tag' }).click();
  await expect(editor.locator('.tag-picker-selected')).toContainText('Browser created');
  await editor.getByRole('button', { name: zh ? '取消' : 'Cancel' }).click();
  await expect(edit).toBeFocused();
  expect(state.tags.some(tag => tag.name === 'Browser created')).toBe(true);
  expect(state.tasks.find(item => item.id === standalone.id)!.tags).toEqual(standalone.tags);
  expect(state.writes.filter(write => write.startsWith('PATCH '))).toEqual([]);
  await taskDialog.locator('.task-detail-close').click();
  await page.locator('#project-task-tab-goals').click();
  await page.locator(`[data-goal-id="${goal.id}"] #project-goal-detail-${goal.id}`).click();
  const goalDialog = page.locator('.goal-detail-surface');
  const goalEdit = goalDialog.getByRole('button', { name: zh ? '编辑标签' : 'Edit tags' });
  await expect(goalEdit).toBeEnabled(); await goalEdit.click();
  const goalEditor = goalDialog.locator('.task-tags-editor');
  const created = goalEditor.getByRole('checkbox', { name: 'Browser created' });
  await expect(created).toBeVisible(); await created.check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await goalEditor.getByRole('button', { name: zh ? '保存' : 'Save', exact: true }).click();
  await expect(goalEditor).toHaveCount(0);
  await expect(goalDialog.locator('.task-tag')).toHaveText(['Goal label', 'Browser created']);
  expect(state.writes.filter(write => write.startsWith('PATCH '))).toEqual([`PATCH /api/v1/projects/${projectId}/tasks/${goal.id}`]);
  expect(state.tasks.find(item => item.id === goal.id)!.tags.map(tag => tag.name)).toEqual(['Goal label', 'Browser created']);
});

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) for (const kind of ['task', 'goal'] as const) test(`create ${kind} with tags using the keyboard at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  const zh = locale === 'zh-CN';
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  if (kind === 'goal') await page.locator('#project-task-tab-goals').click();
  const open = page.getByRole('button', { name: kind === 'goal' ? (zh ? '新建 Goal' : 'New Goal') : (zh ? '新建 Task' : 'New Task'), exact: true });
  await expect(open).toBeEnabled();
  await open.focus(); await page.keyboard.press('Enter');
  const dialog = page.locator('.task-organization-dialog');
  const picker = dialog.locator('.tag-picker');
  await expect(picker.getByRole('checkbox', { name: 'Goal label' })).toBeVisible();
  await dialog.getByRole('textbox', { name: kind === 'goal' ? (zh ? '名称' : 'Name') : (zh ? '标题' : 'Title'), exact: true }).first().fill(`Created ${kind}`);
  const form = dialog.locator('form');
  await form.evaluate(element => { element.dataset.submits = '0'; element.addEventListener('submit', () => { element.dataset.submits = String(Number(element.dataset.submits) + 1); }); });
  const search = picker.getByRole('searchbox', { name: zh ? '搜索标签' : 'Search tags' });
  await search.fill('Goal');
  await expect(picker.getByRole('checkbox', { name: 'Goal label' })).toBeVisible();
  await search.press('Enter');
  await expect(search).toBeFocused(); await expect(form).toHaveAttribute('data-submits', '0');
  await search.fill('');
  const tagName = picker.getByRole('textbox', { name: zh ? '名称' : 'Name', exact: true });
  await tagName.fill('Created independently');
  const hex = picker.getByRole('textbox', { name: zh ? '十六进制颜色' : 'Hex color' });
  await expect(hex).toHaveValue('#9AA3B2');
  if (kind === 'task') {
    const blue = picker.getByRole('button', { name: zh ? '蓝色 #4C88C7' : 'Blue #4C88C7' });
    await blue.focus(); await page.keyboard.press('Space');
    await expect(blue).toHaveAttribute('aria-pressed', 'true');
    await expect(hex).toHaveValue('#4C88C7');
  } else {
    await hex.fill('#12a4cd');
    await expect(picker.locator('.tag-color-preview .task-tag-dot')).toHaveCSS('background-color', 'rgb(18, 164, 205)');
  }
  await tagName.press('Enter');
  await expect(tagName).toBeFocused(); await expect(form).toHaveAttribute('data-submits', '0');
  expect(state.writes.filter(write => write === `POST /api/v1/projects/${projectId}/tasks` || write === `POST /api/v1/projects/${projectId}/tags`)).toEqual([]);
  const createTag = picker.getByRole('button', { name: zh ? '新建标签' : 'New tag' });
  await createTag.focus(); await page.keyboard.press('Enter');
  await expect(picker.locator('.tag-picker-selected')).toContainText('Created independently');
  await expect(hex).toHaveValue('#9AA3B2');
  expect(state.tagCreates).toEqual([{ name: 'Created independently', color: kind === 'task' ? '#4C88C7' : '#12A4CD' }]);
  await dialog.getByRole('button', { name: zh ? '取消' : 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.tags.some(tag => tag.name === 'Created independently')).toBe(true);
  expect(state.tasks).toHaveLength(6);
  expect(state.writes.filter(write => write === `POST /api/v1/projects/${projectId}/tasks`)).toEqual([]);

  await open.focus(); await page.keyboard.press('Enter');
  await expect(picker.getByRole('checkbox', { name: 'Goal label' })).toBeVisible();
  const removeCreated = picker.getByRole('button', { name: zh ? '移除 Created independently' : 'Remove Created independently' });
  if (await removeCreated.count()) { await removeCreated.focus(); await page.keyboard.press('Enter'); }
  if (kind === 'task') {
    await dialog.getByRole('combobox', { name: zh ? 'Goal' : 'Goal', exact: true }).selectOption(goal.id);
    await expect(picker.getByRole('checkbox', { name: 'Goal label' })).not.toBeChecked();
  }
  const first = picker.getByRole('checkbox', { name: 'Goal label' });
  await first.focus(); await page.keyboard.press('Space'); await expect(first).toBeChecked();
  const second = picker.getByRole('checkbox', { name: 'Child label' });
  await second.focus(); await page.keyboard.press('Space'); await expect(second).toBeChecked();
  await dialog.getByRole('textbox', { name: kind === 'goal' ? (zh ? '名称' : 'Name') : (zh ? '标题' : 'Title'), exact: true }).first().fill(`Created ${kind}`);
  const submit = dialog.getByRole('button', { name: zh ? '创建' : 'Create', exact: true });
  await submit.focus(); await expect(submit).toBeFocused();
  const box = (await submit.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  const created = state.tasks.find(item => item.title === `Created ${kind}`)!;
  expect(created.type).toBe(kind);
  expect(created.parentId).toBe(kind === 'task' ? goal.id : null);
  expect(created.tags.map(tag => tag.name)).toEqual(['Goal label', 'Child label']);
  expect(state.writes.filter(write => write === `POST /api/v1/projects/${projectId}/tasks`)).toHaveLength(1);
  expect(state.writes.filter(write => write.startsWith('PATCH '))).toEqual([]);
  if (kind === 'task') {
    await page.locator('#project-task-tab-goals').click();
    const card = page.locator(`[data-goal-id="${goal.id}"]`);
    await card.locator('.goal-list-toggle').click();
    await expect(taskRow(card.locator(`#chain-task-goal-${goal.id}-${created.id}`)).locator('.task-tag')).toHaveText(['Goal label', 'Child label']);
  } else {
    await expect(page.locator(`[data-goal-id="${created.id}"] .goal-list-summary .task-tag`)).toHaveText(['Goal label', 'Child label']);
  }
});

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`empty production rows reclaim placeholder height at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  state.tasks = state.tasks.map(item => item.id === goal.id || item.id === child.id ? { ...item, tags: [] } : item);
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`), toggle = card.locator('.goal-list-toggle');
  await toggle.click();
  const row = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  const summary = card.locator('.goal-list-summary');
  await expect(summary.locator('.task-tag-list')).toHaveCount(0);
  await expect(taskRow(row).locator('.task-tag-list')).toHaveCount(0);
  expect(await toggle.getAttribute('aria-describedby')).not.toContain(`project-goal-tags-${goal.id}`);
  await expect(row).toHaveAccessibleName(child.title);
  for (const [control, container, before] of [[summary, '.goal-list-main', '.goal-list-meta'], [taskRow(row), '.task-row-content', null]] as const) {
    const heights = await control.evaluate((element, args) => {
      const target = element.querySelector(args.container)!;
      const compact = element.getBoundingClientRect().height;
      const old = document.createElement('span'); old.className = 'task-tag-list';
      const label = document.createElement('span'); label.textContent = args.locale === 'en' ? 'Untagged' : '无标签';
      label.style.cssText = `font-size:${args.width <= 320 ? 10 : 11}px;line-height:1.4`;
      old.append(label); target.insertBefore(old, args.before === null ? null : target.querySelector(args.before));
      const placeholder = element.getBoundingClientRect().height; old.remove();
      return { compact, placeholder, restored: element.getBoundingClientRect().height };
    }, { container, before, locale, width });
    expect(heights.placeholder).toBeGreaterThan(heights.compact);
    expect(heights.restored).toBe(heights.compact);
  }
  await row.focus(); await expect(row).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`tag colors agree across catalog, task and controls at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  const zh = locale === 'zh-CN';
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const row = page.locator(`#standalone-task-${standalone.id}`);
  const white = taskRow(row).locator('.task-tag').filter({ hasText: longName });
  const black = taskRow(row).locator('.task-tag').filter({ hasText: 'Another label' });
  await expect(white.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(black.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  for (const chip of [white, black]) {
    const ratios = await chip.evaluate(element => {
      const rgb = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
      const luminance = (value: string) => rgb(value).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
      const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const style = getComputedStyle(element), dot = getComputedStyle(element.querySelector('.task-tag-dot')!);
      return { text: contrast(style.color, style.backgroundColor), outline: contrast(dot.borderColor, style.backgroundColor) };
    });
    expect(ratios.text).toBeGreaterThanOrEqual(4.5);
    expect(ratios.outline).toBeGreaterThanOrEqual(3);
  }
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`);
  const goalChip = card.locator('.goal-list-summary .task-tag').filter({ hasText: 'Goal label' });
  await expect(goalChip.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(216, 86, 86)');
  const mainFilter = page.locator('.project-tasks .task-list-filters:visible .tag-filter').first();
  await mainFilter.locator('summary').focus(); await page.keyboard.press('Enter');
  const option = mainFilter.getByRole('checkbox', { name: 'Goal label' });
  await expect(option).toBeVisible();
  await expect(option.locator('..').locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(216, 86, 86)');
  await option.focus(); await page.keyboard.press('Space'); await expect(option).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(mainFilter.locator('summary')).toBeFocused();
  const selected = mainFilter.locator('..').locator('.tag-filter-selected .task-tag').filter({ hasText: 'Goal label' });
  await expect(selected.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(216, 86, 86)');
  await card.locator(`#project-goal-detail-${goal.id}`).click();
  const dialog = page.locator('.goal-detail-surface');
  await dialog.getByRole('button', { name: zh ? '编辑标签' : 'Edit tags' }).click();
  const picker = dialog.locator('.tag-picker');
  const selectedChip = picker.locator('.tag-picker-selected .task-tag').filter({ hasText: 'Goal label' });
  await expect(selectedChip.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(216, 86, 86)');
  await expect(picker.getByRole('checkbox', { name: 'Goal label' }).locator('..').locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(216, 86, 86)');
  await dialog.locator('.task-detail-close').click();
  await page.getByRole('tab', { name: zh ? '标签' : 'Tags', exact: true }).click();
  const catalogChip = page.locator('.project-tags-list .task-tag').filter({ hasText: 'Goal label' });
  await expect(catalogChip.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(216, 86, 86)');
  state.colors.set(id(90), '#00FF00');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(catalogChip.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(0, 255, 0)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});

test('the same tag color is consistent across standalone, chain and Goal task rows', async ({ page }) => {
  const state = await install(page, 'en');
  const shared = [{ id: id(93), name: 'Child label' }];
  state.tasks = [goal, { ...standalone, tags: shared }, child,
    { ...root, parentId: null }, { ...chained, parentId: null, dependsOn: [root.id], externalDependsOn: [], blockedBy: [root.id], tags: shared }];
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  const color = async (link: Locator) => {
    const chip = taskRow(link).locator('.task-tag').filter({ hasText: 'Child label' });
    await expect(chip).toBeVisible();
    await expect(chip.locator('.task-tag-dot')).toHaveCSS('background-color', 'rgb(18, 164, 205)');
    return chip.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor, text: getComputedStyle(element).color }));
  };
  await page.locator('#project-task-tab-standalone').click();
  const standaloneColor = await color(page.locator(`#standalone-task-${standalone.id}`));
  await page.locator('#project-task-tab-chains').click();
  await page.locator(`#task-root-${root.id}`).click();
  expect(await color(page.locator(`#chain-task-${root.id}-${chained.id}`))).toEqual(standaloneColor);
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`);
  await card.locator('.goal-list-toggle').click();
  expect(await color(card.locator(`#chain-task-goal-${goal.id}-${child.id}`))).toEqual(standaloneColor);
  expect(state.writes).toEqual([]);
});
