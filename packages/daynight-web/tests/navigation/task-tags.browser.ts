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

async function install(page: Page, locale: 'en' | 'zh-CN') {
  const state = { tasks: [goal, standalone, child, root, chained, outsider] as TaskDetail[], tags: [goal, standalone, child, root, outsider].flatMap(item => item.tags), hold: false, held: false, release: () => {}, holdDetail: false, heldDetail: false, releaseDetail: () => {}, holdCatalog: false, heldCatalog: false, releaseCatalog: () => {}, writes: [] as string[], observedAt: time };
  await page.addInitScript(language => localStorage.setItem('daynight.web.locale', language), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method()) && !path.endsWith('/tags/resolve')) state.writes.push(`${request.method()} ${path}`);
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
  await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Goal label']);
  await card.locator('.goal-list-toggle').click();
  const childRow = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
  await expect(childRow.locator('.task-tag')).not.toContainText('Goal label');
  await expect(card.locator(`#chain-task-goal-${goal.id}-${root.id} .task-tag`)).toHaveText(['Root label']);
  const emptyRow = card.locator(`#chain-task-goal-${goal.id}-${chained.id}`);
  await expect(emptyRow.locator('.task-tag-list')).toHaveCount(0);
  expect(await emptyRow.getAttribute('aria-labelledby')).not.toContain('-tags');
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
  await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
  state.hold = true;
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
  try {
    await expect.poll(() => state.held).toBe(true);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Goal label']);
    await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
    state.observedAt = '2026-10-22T10:00:04Z';
    state.tasks = state.tasks.map(item => item.id === goal.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(90), name: 'Renamed goal label' }] }
      : item.id === child.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [] }
        : item.id === root.id ? { ...item, version: 2n, updatedAt: '2026-10-22T10:00:02Z', tags: [{ id: id(94), name: 'Renamed root label' }] } : item);
    state.release();
    await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Renamed goal label']);
    await expect(childRow.locator('.task-tag')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
    await expect(card.locator(`#chain-task-goal-${goal.id}-${root.id} .task-tag`)).toHaveText(['Renamed root label']);
    state.tasks = state.tasks.map(item => item.id === child.id ? { ...item, version: 3n, updatedAt: '2026-10-22T10:00:06Z', tags: [{ id: id(93), name: 'Restored child label' }] } : item);
    state.observedAt = '2026-10-22T10:00:08Z';
    await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
    await expect(childRow.locator('.task-tag')).toHaveText(['Restored child label']);
    await expect(childRow).toHaveAccessibleName(/Restored child label/);
    expect(await childRow.getAttribute('aria-labelledby')).toContain('-tags');
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
  await expect(childRow.locator('.task-tag')).toHaveText(['Child label']);
  state.observedAt = '2026-10-22T10:00:04Z';
  state.tasks = state.tasks.map(item => item.id === child.id ? { ...item, parentId: null, version: 2n, updatedAt: '2026-10-22T10:00:02Z' } : item);
  await page.locator('.project-title-actions>button').evaluate((element: HTMLButtonElement) => element.click());
  await expect(childRow).toHaveCount(0);
  await expect(card.locator('.goal-list-summary .task-tag')).toHaveText(['Goal label']);
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
  const summary = card.locator('.goal-list-summary');
  await expect(summary.locator('.task-tag')).toHaveText([longName]);
  await page.keyboard.press('Tab'); await toggle.focus(); await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAccessibleDescription(new RegExp(longName));
  const outline = await toggle.evaluate(element => { const style = getComputedStyle(element); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) }; });
  expect(outline.style).not.toBe('none'); expect(outline.width).toBeGreaterThan(0);
  await page.keyboard.press('Enter');
  const childRow = card.locator(`#chain-task-goal-${goal.id}-${child.id}`);
  await expect(childRow.locator('.task-tag')).toHaveText([longName]);
  for (const tag of [summary.locator('.task-tag'), childRow.locator('.task-tag')]) {
    await expect(tag).toBeVisible();
    const dimensions = await tag.evaluate(element => ({ w: element.clientWidth, sw: element.scrollWidth, h: element.clientHeight, sh: element.scrollHeight }));
    expect(dimensions.sw).toBeLessThanOrEqual(dimensions.w + 1); expect(dimensions.sh).toBeLessThanOrEqual(dimensions.h + 1);
  }
  for (const control of [summary.locator('.goal-list-title'), card.locator('.goal-list-session .root-status'), card.locator('.goal-list-detail'), card.locator('.goal-list-graph'), childRow.locator('.root-title'), childRow.locator('..').locator('.root-status')]) {
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
  const childTagBox = (await childRow.locator('.task-tag').boundingBox())!;
  const childStatusBox = (await childRow.locator('..').locator('.root-status').boundingBox())!;
  const childOverlap = Math.min(childTagBox.x + childTagBox.width, childStatusBox.x + childStatusBox.width) > Math.max(childTagBox.x, childStatusBox.x) && Math.min(childTagBox.y + childTagBox.height, childStatusBox.y + childStatusBox.height) > Math.max(childTagBox.y, childStatusBox.y);
  expect(childOverlap).toBe(false);
  await expect(childRow).toHaveAccessibleName(new RegExp(longName));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(state.writes).toEqual([]);
});


for (const width of [1280, 768, 390, 320]) for (const locale of ['en', 'zh-CN'] as const) test(`tag filters retain keyboard focus and layout during checks at ${width}px in ${locale}`, async ({ page }) => {
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
  await checkSelect(status);
  const main = toolbar.locator('.tag-filter').nth(0);
  const filter = toolbar.locator('.tag-filter').nth(1);
  expect(await status.evaluate(element => element.nextElementSibling?.className)).toBe('tag-filter-wrap');
  expect(await main.evaluate(element => element.parentElement?.nextElementSibling?.className)).toBe('tag-filter-wrap');
  const mainTrigger = main.locator('summary');
  await mainTrigger.focus(); await page.keyboard.press('Enter');
  await expect(main).toHaveAttribute('open', '');
  const mainBounds = await main.locator('.tag-filter-panel').boundingBox();
  expect(mainBounds).not.toBeNull(); expect(mainBounds!.width).toBeGreaterThanOrEqual(Math.min(285, width - 32)); expect(mainBounds!.x).toBeGreaterThanOrEqual(0); expect(mainBounds!.x + mainBounds!.width).toBeLessThanOrEqual(width + 1);
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
  await checkSelect(filter);
  const match = filter.locator('select');
  const arrow = filter.locator('.native-select__arrow');
  const arrowBox = (await arrow.boundingBox())!;
  await page.mouse.click(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2);
  await expect.poll(() => match.evaluate(element => element.matches(':open'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => match.evaluate(element => element.matches(':open'))).toBe(false);
  await expect(filter).toHaveAttribute('open', '');
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
  await expect(filter).toHaveAttribute('open', '');
  await trigger.focus(); await page.keyboard.press('Escape');
  await expect(filter).not.toHaveAttribute('open', '');
  await card.locator('.goal-list-toggle').click();
  await expect(option).toBeChecked();
  await expect(filter).not.toHaveAttribute('open', '');
  await trigger.focus(); await page.keyboard.press('Enter');
  await expect(filter).toHaveAttribute('open', '');
  await search.focus(); await search.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 4));
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
    state.releaseCatalog();
    await expect(search).toHaveValue('Unbroken'); await expect(search).toBeFocused();
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
  await tagName.press('Enter');
  await expect(tagName).toBeFocused(); await expect(form).toHaveAttribute('data-submits', '0');
  expect(state.writes.filter(write => write === `POST /api/v1/projects/${projectId}/tasks` || write === `POST /api/v1/projects/${projectId}/tags`)).toEqual([]);
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
    await expect(card.locator(`#chain-task-goal-${goal.id}-${created.id} .task-tag`)).toHaveText(['Goal label', 'Child label']);
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
  await expect(row.locator('.task-tag-list')).toHaveCount(0);
  expect(await toggle.getAttribute('aria-describedby')).not.toContain(`project-goal-tags-${goal.id}`);
  expect(await row.getAttribute('aria-labelledby')).not.toContain('-tags');
  for (const [control, container, before] of [[summary, '.goal-list-main', '.goal-list-meta'], [row, '.root-heading', null]] as const) {
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
