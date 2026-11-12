import { expect, test, type Page, type Route } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000200';
const personalId = '00000000-0000-4000-8000-000000000701';
const messageId = '00000000-0000-4000-8000-000000000301';
const time = '2026-10-22T10:00:00Z';
const detail = detailFixture(projectId, taskId, { title: 'Discussion task' });
const graph = graphFixture([detail]);
const profile = { id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const message = { id: messageId, author: { userId: TEST_VIEWER_ID, displayName: 'Alice', Agent: false }, body: Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: the existing message remains readable.`).join('\n\n'), createdAt: '2026-11-03T08:01:00.123Z' };
type State = { reads: number; writes: number; meReads: number };
const install = async (page: Page): Promise<State> => {
  const state: State = { reads: 0, writes: 0, meReads: 0 };
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) state.writes++;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') { state.meReads++; return send(profile); }
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 1n, propertiesForTask: () => detail.properties }));
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}`) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `/api/v1/projects/${projectId}/tasks/${taskId}/thread/messages`) {
      state.reads++;
      await send({ items: url.searchParams.has('afterId') ? [] : [message], hasMoreBefore: false, hasMoreAfter: false });
      return;
    }
    if (path.endsWith('/sessions') || path.endsWith('/attachments') || path.endsWith('/steps')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: '00000000-0000-4000-8000-000000000099' } }, 404);
  });
  return state;
};
const foreground = async (page: Page, state: State, onHidden: () => Promise<void>) => {
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage();
  await other.route('**/api/v1/me', route => route.fulfill({ json: profile, headers: { 'Daynight-User-ID': TEST_VIEWER_ID } }));
  await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
  await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await onHidden();
  const meReads = state.meReads, reads = state.reads;
  await other.evaluate(() => localStorage.setItem('daynight.activeUser', JSON.stringify('00000000-0000-4000-8000-000000000002')));
  await page.bringToFront();
  return { other, meReads, reads };
};

for (const [locale, width, surface] of [['en', 1280, 'page'], ['zh-CN', 390, 'page'], ['en', 1280, 'modal'], ['zh-CN', 390, 'fullscreen']] as const) test(`${locale} ${width}px ${surface} preserves message dialog after account change`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  const state = await install(page);
  if (surface === 'page') await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=discussion`);
  else {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
    await page.getByRole('tab', { name: /^(Standalone tasks|独立任务)$/ }).click();
    await page.locator(`#standalone-task-${taskId}`).click();
    const taskDialog = page.locator('.task-detail-dialog');
    await taskDialog.getByRole('tab', { name: /^(Discussion|讨论)$/ }).click();
    if (surface === 'fullscreen') await taskDialog.getByRole('button', { name: /^(Enter fullscreen|进入全屏)$/ }).click();
  }
  const article = page.locator(`[data-entry-key="${messageId}"]`); await expect(article).toBeVisible();
  const input = page.locator('.thread-composer textarea'); await input.fill('Retained draft');
  await article.locator('.thread-message-actions button').first().click();
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(2, 8));
  const timeline = page.locator('.thread-timeline'); await timeline.evaluate(element => { element.scrollTop = 90; });
  await article.locator('.thread-message-time').click();
  const dialog = page.locator('dialog.thread-metadata-dialog'), close = dialog.locator('header .thread-icon-button'), body = dialog.locator('.thread-metadata-body');
  await expect(dialog).toBeVisible(); await expect(close).toBeFocused();
  await dialog.evaluate(element => { element.scrollTop = 100; });
  const original = await dialog.elementHandle(), bodyOriginal = await body.elementHandle(), timelineOriginal = await timeline.elementHandle();
  const box = await dialog.boundingBox(); const scroll = await dialog.evaluate(element => element.scrollTop), timelineScroll = await timeline.evaluate(element => element.scrollTop);
  const bodyTop = await body.evaluate(element => element.getBoundingClientRect().top);
  expect(scroll).toBeGreaterThan(0);
  const check = await foreground(page, state, async () => {
    expect(await dialog.evaluate((element, node) => element === node && element instanceof HTMLDialogElement && element.open, original)).toBe(true);
    expect(await body.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(bodyTop, 0);
    expect(await timeline.evaluate(element => element.scrollTop)).toBe(timelineScroll);
    expect(await input.inputValue()).toBe('Retained draft');
  });
  const assertStable = async () => {
    await expect(dialog).toBeVisible(); await expect(close).toBeFocused();
    expect(await dialog.evaluate((element, node) => element === node, original)).toBe(true);
    expect(await body.evaluate((element, node) => element === node, bodyOriginal)).toBe(true);
    expect(await timeline.evaluate((element, node) => element === node, timelineOriginal)).toBe(true);
    expect(await dialog.boundingBox()).toEqual(box);
    expect(await body.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(bodyTop, 0);
    expect(await timeline.evaluate(element => element.scrollTop)).toBe(timelineScroll);
    expect(await input.inputValue()).toBe('Retained draft');
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 8]);
    await expect(page.locator('.thread-reply-preview')).toHaveCount(1);
    await expect(page.locator(surface === 'page' ? '.task-detail-page' : '.task-detail-dialog')).toHaveAttribute('inert', '');
  };
  try {
    await assertStable();
    await expect(page.locator('.thread-send-button')).toBeDisabled();
    await expect(page.locator('.thread-bar button')).toBeDisabled();
    await expect(dialog.getByText(locale === 'en' ? 'Account changed' : '账户已变化', { exact: true })).toBeVisible();
    expect(state.meReads).toBe(check.meReads); expect(state.reads).toBe(check.reads);
    expect(state.writes).toBe(0);
    await page.screenshot({ path: info.outputPath(`discussion-${surface}-${locale}-${width}.png`) });
    const refresh = dialog.getByRole('button', { name: locale === 'en' ? 'Refresh page' : '刷新页面', exact: true });
    for (let i = 0; i < 10 && !await refresh.evaluate(node => node === document.activeElement); i++) await page.keyboard.press('Tab');
    await expect(refresh).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  } finally { await check.other.close(); }
});

for (const [locale, width] of [['en', 1280], ['zh-CN', 390]] as const) test(`${locale} ${width}px allows local draft edits while checks block sends`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  const state = await install(page);
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=discussion`);
  await expect(page.locator(`[data-entry-key="${messageId}"]`)).toBeVisible();
  const input = page.locator('.thread-composer textarea'); await input.fill('Before check');
  await input.focus(); await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 6));
  const original = await input.elementHandle(), box = await input.boundingBox();
  const check = await foreground(page, state, async () => {
    expect(await input.evaluate((element, node) => element === node, original)).toBe(true);
    expect(await input.inputValue()).toBe('Before check');
  });
  try {
    await expect(page.getByText(locale === 'en' ? 'Account changed' : '账户已变化', { exact: true })).toBeVisible();
    await expect(input).toBeEnabled(); await expect(input).toBeFocused();
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 6]);
    expect(await input.boundingBox()).toEqual(box);
    await page.keyboard.type('During');
    await expect(input).toHaveValue('During check');
    await expect(page.locator('.thread-send-button')).toBeDisabled();
    await page.keyboard.press('Control+Enter'); expect(state.writes).toBe(0);
    const selection = await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd]);
    await expect(input).toBeFocused(); await expect(input).toHaveValue('During check');
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual(selection);
    expect(state.meReads).toBe(check.meReads); expect(state.reads).toBe(check.reads);
    await expect(input).toBeFocused(); await expect(input).toHaveValue('During check');
    expect(await input.evaluate((element, node) => element === node, original)).toBe(true);
    expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual(selection);
    expect(state.writes).toBe(0);
  } finally { await check.other.close(); }
});
