import { expect, test, type Locator, type Page } from '@playwright/test';
import { botAttentionHeaders, botDefaults } from '../helpers/bots';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';
import { installTools, targetWorker } from './worker-tool-paths-fixture';

const projectId = '00000000-0000-4000-8000-000000000101';
const taskId = '00000000-0000-4000-8000-000000000201';
const personalId = '00000000-0000-4000-8000-000000000701';
const otherUser = '00000000-0000-4000-8000-000000000202';
const time = '2026-11-19T12:00:00Z';
const file = 'long-attachment-name-附件名称-'.repeat(4) + '.txt';
const base = `/api/v1/projects/${projectId}/tasks/${taskId}`;
const taskPath = `/projects/${projectId}/tasks/${taskId}`;
const font = (element: Locator, size: number) => expect(element.first()).toHaveCSS('font-size', `${size}px`);
const noOverflow = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
const reachable = async (element: Locator) => {
  await element.scrollIntoViewIfNeeded();
  expect(await element.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
  })).toBe(true);
};

const install = async (page: Page, locale: 'en' | 'zh-CN', invalidLocale = false) => {
  let actor = TEST_VIEWER_ID;
  const task = detailFixture(projectId, taskId, {
    title: 'Long task title 需要保持可读的任务标题 '.repeat(5),
    description: '## Reading heading\n\nReading content 正文保持阅读字号。\n\n`interface code`',
  });
  const graph = graphFixture([task]);
  const writes: string[] = [];
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), invalidLocale ? 'invalid-locale' : locale);
  await page.context().route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: {
      'Content-Type': 'application/json', 'Daynight-User-ID': actor, ...botAttentionHeaders(request.headers(), status), ...extra,
    } });
    const personal = { id: personalId, kind: 'personal', name: null };
    if (path === '/api/v1/me') return send({ id: actor, personalTeam: personal, name: actor === TEST_VIEWER_ID ? 'Reader' : 'Other account', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ ...personal, version: 1n, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: actor, role: 'admin', version: 1n, createdAt: time, updatedAt: time } });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => task.version }));
    if (path === base) return send(task, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${base}/attachments`) return send({ items: [{ path: file, contentType: 'text/plain', sizeBytes: 12345, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path === `${base}/attachments/files/${file}` || decodeURI(path) === `${base}/attachments/files/${file}`) return route.fulfill({ contentType: 'text/plain', body: 'Readable code content\n'.repeat(20), headers: { 'Daynight-User-ID': actor } });
    if (path === '/api/v1/me/bots') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/assistant-tasks') return send({ items: [], nextCursor: null, observedAt: time });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'typography-ownership' } }, 404);
  });
  return { writes, switchAccount: () => { actor = otherUser; } };
};

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test.describe(`${locale} ${width}px remaining typography`, () => {
    test.use({ viewport: { width, height: 900 }, locale: locale === 'en' ? 'en-US' : 'zh-CN', hasTouch: width === 320 });

    test('task controls and attachment metadata retain roles, drafts and local scrolling', async ({ page }, info) => {
      const state = await install(page, locale);
      await page.goto(`${taskPath}/attachments/${encodeURIComponent(file)}`);
      await font(page.locator('.task-detail-title'), 22);
      await font(page.locator('.task-detail-tab'), 14);
      await font(page.locator('.attachment-section-heading h4'), 18);
      await font(page.locator('.attachment-file-name'), 14);
      await font(page.locator('.attachment-file-size'), 12);
      await font(page.locator('.attachment-timestamps'), 12);
      await font(page.locator('.attachment-preview-header h5'), 14);
      await font(page.locator('.attachment-text'), 14);
      await noOverflow(page);
      const attachments = page.locator('.task-attachments');
      await attachments.locator('.attachment-upload-disclosure > summary').click();
      await attachments.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Unsent draft') });
      const input = attachments.locator('input[type=text]');
      const draft = '保留草稿/long-draft-path.txt';
      await input.fill(draft); await input.focus();
      await input.evaluate((node: HTMLInputElement) => node.setSelectionRange(2, 8));
      const original = await input.elementHandle();
      await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
      await font(page.locator('.attachment-file-name'), 17.5);
      await font(page.locator('.attachment-timestamps'), 15);
      await expect(input).toHaveValue(draft); await expect(input).toBeFocused();
      expect(await input.evaluate((node, old) => node === old, original)).toBe(true);
      expect(await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([2, 8]);
      await reachable(input); await noOverflow(page);
      await info.attach('attachments-font-preference', { body: await page.screenshot(), contentType: 'image/png' });
      await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
      const action = page.locator('.attachment-actions-trigger').first();
      await action.click();
      const remove = page.locator('.attachment-menu-delete');
      await font(remove, 14); await remove.click();
      const dialog = page.locator('.attachment-delete-dialog');
      await font(dialog.locator('h2'), 22);
      await font(dialog.locator('.attachment-delete-path'), 14);
      await noOverflow(page);
      await dialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
      await expect(input).toHaveValue(draft);
      expect(state.writes).toEqual([]);
      await original?.dispose();
    });

    test('Bot creation headings, labels and drafts scale without clipping actions', async ({ page }, info) => {
      const state = await install(page, locale);
      await page.goto('/bots');
      const trigger = page.locator('.bot-create'); await trigger.click();
      const dialog = page.locator('.bot-create-dialog'), name = page.locator('#bot-name');
      await expect(name).toBeFocused();
      await font(dialog.locator('h2'), 22);
      await font(dialog.locator('.field label'), 14);
      await font(name, width === 320 ? 16 : 14);
      const draft = 'Long assistant name 保留助手草稿 '.repeat(5);
      await name.fill(draft); await name.focus();
      await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
      await expect(name).toHaveValue(draft); await expect(name).toBeFocused();
      await font(dialog.locator('h2'), 33);
      await font(dialog.locator('.field label'), 21);
      await reachable(dialog.locator('.bot-create-actions .primary')); await noOverflow(page);
      await info.attach('bot-create-enlarged-font', { body: await page.screenshot(), contentType: 'image/png' });
      await dialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click();
      await expect(trigger).toBeFocused();
      expect(state.writes).toEqual([]);
    });

    test('language failure notice remains readable and retry clears the notice', async ({ page }, info) => {
      await install(page, locale, true);
      await page.goto('/projects');
      const notice = page.locator('.locale-notice').first();
      await font(notice, 14); await reachable(notice); await noOverflow(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
      await font(notice, 21); await reachable(notice.getByRole('button')); await noOverflow(page);
      await info.attach('language-notice-enlarged-font', { body: await page.screenshot(), contentType: 'image/png' });
      await notice.getByRole('button').click();
      await expect(page.locator('.locale-notice')).toHaveCount(0);
    });

    test('labelled shared copy buttons retain their role and copy the complete value', async ({ page, context }, info) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await installTools(page, { locale });
      await page.goto(`/workers/${targetWorker}`);
      await page.locator('[data-worker-tab="system"]:visible').click();
      await page.locator('.worker-tool-software-details > summary').first().click();
      await page.locator('.worker-tool-path-value > summary').first().click();
      const content = page.locator('.worker-tool-path-content').first();
      const copy = content.locator('.copy-button--labelled');
      await font(copy, 14);
      const value = await content.locator('code').innerText();
      await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
      await font(copy, 21); await reachable(copy); await noOverflow(page);
      await copy.click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
      await info.attach('labelled-copy-enlarged-font', { body: await page.screenshot(), contentType: 'image/png' });
    });
  });
}

test('account-change notice scales while preserving an attachment draft', async ({ page, context }, info) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const state = await install(page, 'en');
  await page.goto(`${taskPath}/attachments/${encodeURIComponent(file)}`);
  const attachments = page.locator('.task-attachments');
  await attachments.locator('.attachment-upload-disclosure > summary').click();
  await attachments.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('draft') });
  const input = attachments.locator('input[type=text]');
  await input.fill('draft/retained.txt'); await input.focus();
  const other = await context.newPage();
  try {
    state.switchAccount();
    await other.goto('/auth/complete?returnPath=%2Fprojects&callbackPath=%2Fauth%2Fcallback');
    const notice = page.locator('.account-change-banner').filter({ hasText: 'Account changed' }).first();
    await font(notice, 14);
    await expect(input).toHaveValue('draft/retained.txt');
    await page.evaluate(() => { document.documentElement.style.fontSize = '24px'; });
    await font(notice, 21); await reachable(notice.getByRole('button')); await noOverflow(page);
    await info.attach('account-notice-enlarged-font', { body: await page.screenshot(), contentType: 'image/png' });
    expect(state.writes).toEqual([]);
  } finally { await other.close(); }
});
