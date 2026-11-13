import { expect, test, type Page } from '@playwright/test';
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

async function install(page: Page, locale: 'en' | 'zh-CN') {
  const state = { tasks: [goal, standalone, child, root, chained, outsider] as TaskDetail[], tags: [goal, standalone, child, root, outsider].flatMap(item => item.tags), hold: false, held: false, release: () => {}, holdDetail: false, heldDetail: false, releaseDetail: () => {}, writes: [] as string[], observedAt: time };
  await page.addInitScript(language => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes.push(`${request.method()} ${path}`);
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
      const query = url.searchParams.get('query')?.toLowerCase() ?? '';
      return send({ items: state.tags.filter(tag => tag.name.toLowerCase().includes(query)).map(tag => ({ ...tag, projectId, version: 1, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } })), catalogEpoch: id(999), nextCursor: null });
    }
    if (path === `${catalogPath}/resolve` && request.method() === 'POST') {
      const body = request.postDataJSON() as { tagIds: string[] };
      return send({ items: state.tags.filter(tag => body.tagIds.includes(tag.id)) });
    }
    if (path === catalogPath && request.method() === 'POST') {
      const body = request.postDataJSON() as { name: string };
      const tag = { id: id(96), name: body.name }; state.tags.push(tag);
      return send({ ...tag, projectId, version: 1, createdAt: time, updatedAt: time, usage: { tasks: 0, goals: 0 } }, 201);
    }
    if (path === `/api/v1/projects/${projectId}/task-sync`) {
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

for (const width of [1100, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`own tags remain readable in lists and details at ${width}px in ${locale}`, async ({ page }) => {
  const state = await install(page, locale);
  await page.setViewportSize({ width, height: 700 });
  await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator('#project-task-tab-standalone').click();
  const row = page.locator(`#standalone-task-${standalone.id}`);
  await expect(row.locator('.task-tag')).toHaveText([longName, 'Another label']);
  await page.keyboard.press('Tab'); await row.focus(); await expect(row).toBeFocused();
  await expect(row).toHaveAccessibleName(new RegExp(longName));
  const focusOutline = await row.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  expect(focusOutline.style).not.toBe('none'); expect(focusOutline.width).toBeGreaterThan(0);
  await expect(row.locator('.task-tag').first()).toBeVisible();
  const geometry = await row.locator('.task-tag').first().evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.keyboard.press('Enter');
  const taskDialog = page.locator('.task-detail-dialog');
  await expect(taskDialog.locator('.task-tag')).toHaveText([longName, 'Another label']);
  await taskDialog.locator('.task-detail-close').click();
  await page.locator('#project-task-tab-goals').click();
  const card = page.locator(`[data-goal-id="${goal.id}"]`);
  await expect(card.locator('.goal-list-toggle .task-tag')).toHaveText(['Goal label']);
  await card.locator('.goal-list-toggle').click();
  const childRow = card.locator(`#goal-${goal.id}-task-${child.id}`);
  await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
  await expect(childRow.locator('.task-tag')).not.toContainText('Goal label');
  const chainToggle = card.locator(`#task-root-goal-${goal.id}-chain-${root.id}`);
  await chainToggle.click();
  await expect(card.locator(`#chain-task-goal-${goal.id}-chain-${root.id}-${root.id} .task-tag`)).toHaveText(['Root label']);
  const emptyRow = card.locator(`#chain-task-goal-${goal.id}-chain-${root.id}-${chained.id}`);
  await expect(emptyRow.locator('.task-tag')).toHaveCount(0);
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
  const childRow = card.locator(`#goal-${goal.id}-task-${child.id}`);
  await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
  state.hold = true;
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
  try {
    await expect.poll(() => state.held).toBe(true);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(toggle.locator('.task-tag')).toHaveText(['Goal label']);
    await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
    state.observedAt = '2026-10-22T10:00:04Z';
    state.tasks = state.tasks.map(item => item.id === goal.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(90), name: 'Renamed goal label' }] }
      : item.id === child.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [] }
        : item.id === root.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(94), name: 'Renamed root label' }] } : item);
    state.release();
    await expect(toggle.locator('.task-tag')).toHaveText(['Renamed goal label']);
    await expect(childRow.locator('.task-tag')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await card.locator(`#task-root-goal-${goal.id}-chain-${root.id}`).click();
    await expect(card.locator(`#chain-task-goal-${goal.id}-chain-${root.id}-${root.id} .task-tag`)).toHaveText(['Renamed root label']);
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
    await expect(goalDialog.locator('.task-tag-empty')).toBeVisible();
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
  const childRow = card.locator(`#goal-${goal.id}-task-${child.id}`);
  await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
  state.observedAt = '2026-10-22T10:00:04Z';
  state.tasks = state.tasks.map(item => item.id === child.id ? { ...item, parentId: null, version: 2n, updatedAt: '2026-10-22T10:00:02Z' } : item);
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
  await expect(childRow).toHaveCount(0);
  await expect(card.locator('.goal-list-toggle .task-tag')).toHaveText(['Goal label']);
  await page.locator('#project-task-tab-standalone').click();
  await expect(page.locator(`#standalone-task-${child.id} .task-tag`)).toHaveText(['Child label']);
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
  await expect(toggle.locator('.task-tag')).toHaveText([longName]);
  await page.keyboard.press('Tab'); await toggle.focus(); await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleDescription(new RegExp(longName));
  const outline = await toggle.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  expect(outline.style).not.toBe('none'); expect(outline.width).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  const childRow = card.locator(`#goal-${goal.id}-task-${child.id}`);
  await expect(childRow.locator('.task-tag')).toHaveText([longName]);
  for (const tag of [toggle.locator('.task-tag'), childRow.locator('.task-tag')]) {
    await expect(tag).toBeVisible();
    const dimensions = await tag.evaluate(element => ({ w: element.clientWidth, sw: element.scrollWidth, h: element.clientHeight, sh: element.scrollHeight }));
    expect(dimensions.sw).toBeLessThanOrEqual(dimensions.w + 1); expect(dimensions.sh).toBeLessThanOrEqual(dimensions.h + 1);
  }
  for (const control of [toggle.locator('.goal-list-title'), toggle.locator('.root-status'), card.locator('.goal-list-detail'), card.locator('.goal-list-graph'), childRow.locator('.root-title'), childRow.locator('.root-status')]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  }
  const tagBox = (await toggle.locator('.task-tag').boundingBox())!;
  for (const control of [toggle.locator('.root-status'), card.locator('.goal-list-detail'), card.locator('.goal-list-graph')]) {
    const box = (await control.boundingBox())!;
    const overlap = Math.min(tagBox.x + tagBox.width, box.x + box.width) > Math.max(tagBox.x, box.x) && Math.min(tagBox.y + tagBox.height, box.y + box.height) > Math.max(tagBox.y, box.y);
    expect(overlap).toBe(false);
  }
  const childTagBox = (await childRow.locator('.task-tag').boundingBox())!;
  const childStatusBox = (await childRow.locator('.root-status').boundingBox())!;
  const childOverlap = Math.min(childTagBox.x + childTagBox.width, childStatusBox.x + childStatusBox.width) > Math.max(childTagBox.x, childStatusBox.x) && Math.min(childTagBox.y + childTagBox.height, childStatusBox.y + childStatusBox.height) > Math.max(childTagBox.y, childStatusBox.y);
  expect(childOverlap).toBe(false);
  await expect(childRow).toHaveAccessibleName(new RegExp(longName));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(state.writes).toEqual([]);
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
  await open.focus(); await page.keyboard.press('Enter');
  const dialog = page.locator('.task-organization-dialog');
  const picker = dialog.locator('.tag-picker');
  await expect(picker.getByRole('checkbox', { name: 'Goal label' })).toBeVisible();
  const tagName = picker.getByRole('textbox', { name: zh ? '名称' : 'Name', exact: true });
  await tagName.fill('Created independently');
  const createTag = picker.getByRole('button', { name: zh ? '新建标签' : 'New tag' });
  await createTag.focus(); await page.keyboard.press('Enter');
  await expect(picker.locator('.tag-picker-selected')).toContainText('Created independently');
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
    await expect(card.locator(`#goal-${goal.id}-task-${created.id} .task-tag`)).toHaveText(['Goal label', 'Child label']);
  } else {
    await expect(page.locator(`[data-goal-id="${created.id}"] .goal-list-toggle .task-tag`)).toHaveText(['Goal label', 'Child label']);
  }
});
