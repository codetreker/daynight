import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031', taskId = '00000000-0000-4000-8000-000000000041';
const otherId = '00000000-0000-4000-8000-000000000042', personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-20T09:00:00Z', base = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const task = detailFixture(projectId, taskId, { title: 'Private task', version: 5n });
const successor = detailFixture(projectId, otherId, { title: 'Successor', version: 5n, dependsOn: [taskId], blockedBy: [taskId], ready: false });
const graph = graphFixture([task, successor]);

async function install(page: Page) {
  const state = { failGraph: false, failDetail: false, graphReads: 0, writes: 0, gate: Promise.withResolvers<void>(), current: task };
  const currentGraph = () => graphFixture([state.current, successor]);
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) { state.graphReads++; return state.failGraph ? send({ error: { code: 'internal_error', message: 'Failure', requestId: 'graph-error-123' } }, 500) : send(taskSyncFixture(currentGraph(), { query: taskSyncQuery(url), versionForTask: row => row.id === taskId ? state.current.version : successor.version, propertiesForTask: row => row.id === taskId ? state.current.properties : successor.properties })); }
    if (path === base) return state.failDetail ? send({ error: { code: 'internal_error', message: 'Failure', requestId: 'detail-error-123' } }, 500) : send(state.current);
    if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${base}/attachments`) return send({ items: [{ path: 'index.html', contentType: 'text/html', sizeBytes: 40, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path === `${base}/preview/index.html`) return route.fulfill({ body: request.method() === 'HEAD' ? '' : '<button id="inner" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>', headers: { 'Content-Type': 'text/html', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${base}/attachments/files/draft.txt` && request.method() === 'PUT') { state.writes++; await state.gate.promise; return send({ error: { code: 'internal_error', message: 'Failed', requestId: 'upload-error-123' } }, 500); }
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return state;
}

// Locale can be changed by another subscriber while an overlay owns focus.
// This dispatch exercises that supported state transition without disabling the modal's inert boundary.
async function setLocale(page: Page, locale: string) {
  await page.locator('.topbar select').evaluate((element: HTMLSelectElement, value) => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }, locale);
}

test('locale changes retain graph viewport, HTML frame, draft selection and pending write', async ({ page }) => {
  const state = await install(page); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-chain-graph-${taskId}`).click();
  const graphDialog = page.locator('.task-chain-dialog'), viewport = page.locator('.react-flow__viewport');
  const body = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-body`), details = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`);
  await body.click(); await expect(body).toHaveAttribute('aria-pressed', 'true');
  const beforeZoom = await viewport.getAttribute('style');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforeZoom);
  const transform = await viewport.getAttribute('style'); const viewportHandle = await viewport.elementHandle();
  const nodeHandle = await body.elementHandle(), paths = await page.locator('.task-dependency-edge path.react-flow__edge-path').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  const graphReads = state.graphReads; await setLocale(page, 'zh-CN');
  await expect(page.getByRole('button', { name: '放大', exact: true })).toBeVisible(); await expect(body).toHaveAttribute('aria-pressed', 'true');
  expect(await viewport.getAttribute('style')).toBe(transform); expect(state.graphReads).toBe(graphReads);
  expect(await viewportHandle!.evaluate(element => element === document.querySelector('.react-flow__viewport'))).toBe(true);
  expect(await nodeHandle!.evaluate(element => element === document.querySelector('.react-flow__node[data-id="00000000-0000-4000-8000-000000000041"] .task-node-body'))).toBe(true);
  expect(await page.locator('.task-dependency-edge path.react-flow__edge-path').evaluateAll(elements => elements.map(element => element.getAttribute('d')))).toEqual(paths);
  await details.click(); const dialog = page.locator('.task-detail-dialog'); await dialog.getByRole('tab', { name: '附件', exact: true }).click();
  const attachments = dialog.locator('.task-attachments'); await attachments.getByRole('button', { name: /^index\.html/ }).click();
  const frame = attachments.locator('iframe'), counter = frame.contentFrame().locator('#inner'); await counter.click(); await expect(counter).toHaveText('1');
  const frameHandle = await frame.elementHandle(); await attachments.locator('.attachment-upload-disclosure > summary').click();
  const input = attachments.locator('input[type=file]'); await input.setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') });
  const inputHandle = await input.elementHandle(); const path = attachments.locator('input[type=text]'); await path.focus(); await path.evaluate((element: HTMLInputElement) => element.setSelectionRange(1, 5));
  await setLocale(page, 'en'); await expect(path).toHaveValue('draft.txt'); await expect(path).toBeFocused();
  expect(await path.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 5]);
  expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
  await expect(counter).toHaveText('1'); await attachments.getByRole('button', { name: 'Upload file', exact: true }).click();
  try {
    await expect.poll(() => state.writes).toBe(1); await expect(path).toBeDisabled();
    await setLocale(page, 'zh-CN'); await expect(attachments.getByRole('button', { name: '正在上传…' })).toBeDisabled();
    expect(await inputHandle!.evaluate(element => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
    expect(await input.evaluate((element: HTMLInputElement) => element.files?.[0]?.name)).toBe('draft.txt');
    expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(counter).toHaveText('1'); await expect(viewport).toHaveAttribute('style', transform!);
    state.gate.resolve(); await expect(attachments.getByRole('alert')).toContainText('upload-error-123');
    await expect(attachments.getByRole('alert')).toContainText('附件操作失败'); await expect(path).toHaveValue('draft.txt');
    expect(state.writes).toBe(1);
  } finally { state.gate.resolve(); await viewportHandle!.dispose(); await nodeHandle!.dispose(); await frameHandle!.dispose(); await inputHandle!.dispose(); }
  await expect(graphDialog).toBeVisible();
});

test('project graph error translates in place while preserving request ID and snapshot', async ({ page }) => {
  const state = await install(page); await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: graph.project.name, exact: true })).toBeVisible();
  state.failGraph = true; await page.locator('.project-title-actions>button').click();
  const alert = page.locator('.snapshot-error'); await expect(alert).toContainText('Refresh failed'); await expect(alert).toContainText('graph-error-123');
  const reads = state.graphReads; await page.locator('.topbar select').selectOption('zh-CN');
  await expect(alert).toContainText('刷新失败'); await expect(alert).toContainText('graph-error-123');
  await expect(page.getByRole('heading', { name: graph.project.name, exact: true })).toBeVisible(); expect(state.graphReads).toBe(reads);
});

test('graph advances and recovers from a failed refresh while an attachment write stays owned', async ({ page }) => {
  const state = await install(page); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${taskId}`).click();
  const viewport = page.locator('.react-flow__viewport'), graphDialog = page.locator('.task-chain-dialog');
  await page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-body`).click();
  await page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`).click();
  const dialog = page.locator('.task-detail-dialog'); await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
  const attachments = dialog.locator('.task-attachments'); await attachments.getByRole('button', { name: /^index\.html/ }).click();
  const frame = attachments.locator('iframe'), counter = frame.contentFrame().locator('#inner'); await counter.click();
  const frameHandle = await frame.elementHandle(); await attachments.locator('.attachment-upload-disclosure > summary').click();
  const input = attachments.locator('input[type=file]'); await input.setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') });
  const path = attachments.locator('input[type=text]'), transform = await viewport.getAttribute('style');
  await attachments.getByRole('button', { name: 'Upload file', exact: true }).click();
  try {
    await expect.poll(() => state.writes).toBe(1); await expect(path).toBeDisabled();
    state.current = { ...task, title: 'Updated private task', version: 6n, updatedAt: '2026-10-22T10:00:01Z' };
    const refresh = page.locator('.project-title-actions>button');
    const changed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
    await refresh.evaluate((button: HTMLButtonElement) => button.click()); await changed;
    await expect(dialog.locator('.task-detail-title')).toHaveText('Updated private task');
    await expect(dialog.getByRole('tab', { name: 'Attachments', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(path).toHaveValue('draft.txt'); await expect(path).toBeDisabled(); await expect(counter).toHaveText('1');
    expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(viewport).toHaveAttribute('style', transform!); expect(state.writes).toBe(1);
    state.failGraph = true;
    const failure = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 500);
    await refresh.evaluate((button: HTMLButtonElement) => button.click()); await failure;
    const error = page.locator('.snapshot-error'); await expect(error).toContainText('graph-error-123');
    await expect(dialog.locator('.task-detail-title')).toHaveText('Updated private task'); await expect(counter).toHaveText('1');
    expect(await frameHandle!.evaluate(element => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(viewport).toHaveAttribute('style', transform!); await expect(graphDialog).toBeVisible();
    state.failGraph = false;
    const recovered = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/projects/${projectId}/task-sync` && response.status() === 200);
    await error.getByRole('button', { name: 'Retry refresh', exact: true }).evaluate((button: HTMLButtonElement) => button.click()); await recovered;
    await expect(error).toHaveCount(0); await expect(dialog.locator('.task-detail-title')).toHaveText('Updated private task');
    await expect(counter).toHaveText('1'); await expect(path).toBeDisabled(); expect(state.writes).toBe(1);
    state.gate.resolve(); await expect(attachments.getByRole('alert')).toContainText('upload-error-123');
    await expect(path).toHaveValue('draft.txt'); expect(state.writes).toBe(1);
  } finally { state.gate.resolve(); await frameHandle!.dispose(); }
});

test('detail read failure is local to the graph and retry restores the same focus owner', async ({ page }) => {
  const state = await install(page); await page.goto(`/projects/${projectId}`);
  await page.locator('#project-section-tab-tasks').click(); await page.locator(`#task-chain-graph-${taskId}`).click();
  const viewport = page.locator('.react-flow__viewport'), graphDialog = page.locator('.task-chain-dialog');
  const details = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`);
  state.failDetail = true; await details.click();
  const dialog = page.locator('.task-detail-dialog'), alert = dialog.getByRole('alert');
  await expect(alert).toContainText('detail-error-123');
  await expect(graphDialog).toBeVisible(); await expect(viewport).toBeVisible();
  const close = dialog.getByRole('button', { name: 'Close task details', exact: true }); await expect(close).toBeFocused();
  state.failDetail = false; await dialog.getByRole('button', { name: 'Retry details', exact: true }).click();
  await expect(dialog.locator('.task-detail-title')).toHaveText(task.title); await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(close).toBeFocused(); await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await expect(details).toBeFocused();
  const before = await viewport.getAttribute('style'); await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
});

test('graph fullscreen, task fullscreen, menus and confirmations yield Escape one layer at a time', async ({ page }) => {
  await install(page); const writes: string[] = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); });
  await page.goto(`/projects/${projectId}`); await page.locator('#project-section-tab-tasks').click();
  const graphTrigger = page.locator(`#task-chain-graph-${taskId}`); await graphTrigger.click();
  const graph = page.locator('.task-chain-dialog'), enterGraph = page.getByRole('button', { name: 'View fullscreen', exact: true });
  await enterGraph.click(); await expect(graph).toHaveClass(/task-chain-dialog-fullscreen/);
  const details = page.locator(`.react-flow__node[data-id="${taskId}"] .task-node-details`); await details.click();
  const dialog = page.locator('.task-detail-dialog');
  const close = dialog.getByRole('button', { name: 'Close task details', exact: true }); await expect(close).toBeFocused();
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true); }
  const fullscreen = dialog.locator('.task-detail-fullscreen-toggle'); await fullscreen.click();
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  const more = dialog.getByRole('button', { name: 'More task actions', exact: true }); await more.click();
  await page.getByRole('menuitem', { name: 'Delete task', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(more).toBeFocused();
  await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  const status = dialog.locator('.task-status-trigger'); await status.click(); await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menu')).toHaveCount(0); await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await status.click(); await page.getByRole('menuitemradio', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0); await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); await expect(fullscreen).toHaveAttribute('aria-pressed', 'false'); await expect(fullscreen).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(details).toBeFocused();
  await expect(graph).toHaveClass(/task-chain-dialog-fullscreen/); await page.keyboard.press('Escape');
  await expect(graph).not.toHaveClass(/task-chain-dialog-fullscreen/); await expect(enterGraph).toBeFocused();
  await page.keyboard.press('Escape'); await expect(graph).toHaveCount(0); await expect(graphTrigger).toBeFocused();
  expect(writes).toEqual([]);
});

test('short mobile drawer and account menu retain focus and the graph fullscreen fits resized viewports', async ({ page }) => {
  await install(page); await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: graph.project.name, exact: true })).toBeVisible();
  await expect(page.locator('.stats .stat')).toHaveCount(6);
  const sidebar = page.locator('.sidebar'), workspace = page.locator('.workspace');
  for (const viewport of [{ width: 390, height: 700 }, { width: 320, height: 360 }]) {
    await page.setViewportSize(viewport); await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(60);
    const opener = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    const background = await workspace.boundingBox(), overflow = await page.locator('body').evaluate(element => element.style.overflow), scroll = await page.evaluate(() => scrollY);
    await opener.click(); const drawer = page.getByRole('dialog', { name: 'Workspace navigation', exact: true });
    await expect(drawer).toHaveAttribute('aria-modal', 'true'); await expect.poll(async () => (await drawer.boundingBox())?.width).toBe(220);
    await expect(workspace).toHaveAttribute('inert', ''); await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
    expect(await workspace.boundingBox()).toEqual(background);
    const toggle = drawer.locator('button[aria-expanded="true"]'); await toggle.focus(); await page.keyboard.press('Tab');
    await expect(drawer.locator('a').first()).toBeFocused(); await page.keyboard.press('Shift+Tab'); await expect(toggle).toBeFocused();
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0); await expect(opener).toBeFocused();
    await expect(workspace).not.toHaveAttribute('inert', ''); expect(await page.locator('body').evaluate(element => element.style.overflow)).toBe(overflow); expect(await page.evaluate(() => scrollY)).toBe(scroll);
    await opener.click(); await page.locator('.sidebar-backdrop').click({ position: { x: viewport.width - 12, y: 20 } }); await expect(opener).toBeFocused();
    const account = page.getByRole('button', { name: /^Account menu:/ }); await account.click(); const menu = page.getByRole('menu');
    const settings = menu.getByRole('menuitem', { name: 'Account settings', exact: true }), signOut = menu.getByRole('menuitem', { name: 'Sign out', exact: true });
    await expect(settings).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(signOut).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(settings).toBeFocused(); await page.keyboard.press('End'); await expect(signOut).toBeFocused();
    const bounds = (await menu.boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width); expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(account).toBeFocused();
  }
  await page.setViewportSize({ width: 320, height: 800 }); await page.locator('#project-section-tab-tasks').click();
  await page.locator(`#task-chain-graph-${taskId}`).click(); const graphDialog = page.locator('.task-chain-dialog');
  await expect.poll(() => graphDialog.boundingBox()).toEqual({ x: 12, y: 12, width: 296, height: 776 });
  await page.getByRole('button', { name: 'View fullscreen', exact: true }).click();
  for (const width of [320, 768, 1280, 1440, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(async () => { const bounds = await graphDialog.boundingBox(); return bounds !== null && Math.abs(bounds.x) <= 0.5 && Math.abs(bounds.y) <= 0.5 && Math.abs(bounds.width - width) <= 0.5 && Math.abs(bounds.height - 800) <= 0.5; }).toBe(true);
    expect(await graphDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
  }
});
