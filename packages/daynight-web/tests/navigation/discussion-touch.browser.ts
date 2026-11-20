import { expect, test, type Locator, type Page } from '@playwright/test';
import type { TaskDetail } from '../../src/api/types';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000200';
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-22T10:00:00Z';
const messages = [
  { displayName: 'Alex', Agent: false },
  { displayName: 'Reviewer coordinating the cross-project release verification 负责检查跨项目发布流程的审查员', Agent: true, execution: { provider: 'codex', claimId: '00000000-0000-4000-8000-000000000801', workerId: '00000000-0000-4000-8000-000000000802' } },
  { displayName: null, Agent: false },
].map((author, index) => ({ id: `00000000-0000-4000-8000-00000000030${index}`, author: { userId: index === 0 ? TEST_VIEWER_ID : `00000000-0000-4000-8000-00000000040${index}`, ...author }, body: `Discussion message ${index + 1}`, createdAt: `2026-11-03T08:01:0${index}.123Z` }));

const install = async (page: Page, locale: string, type: 'task' | 'goal' = 'task', status: TaskDetail['status'] = 'in_progress') => {
  const detail = detailFixture(projectId, taskId, { type, title: 'Discussion target', status, ready: false, ...(status === 'done' ? { completedAt: time } : { startedAt: time }) });
  const graph = graphFixture([detail]);
  const state = { mode: 'ready' as 'ready' | 'empty' | 'failure' | 'loading', writes: [] as string[], release: () => {} };
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, statusCode = 200, extra: Record<string, string> = {}) => route.fulfill({ status: statusCode, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (!['GET', 'HEAD'].includes(request.method())) { state.writes.push(`${request.method()} ${path}`); return send({ error: { code: 'invalid_input', message: 'Unexpected write', requestId: 'discussion-touch' } }, 400); }
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alex', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 1n, propertiesForTask: () => detail.properties }));
    const base = `/api/v1/projects/${projectId}/tasks/${taskId}`;
    if (path === base) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path === `${base}/thread/messages`) {
      if (state.mode === 'loading') await new Promise<void>(resolve => { state.release = resolve; });
      if (state.mode === 'failure') return send({ error: { code: 'internal_error', message: 'Controlled read failure', requestId: 'discussion-touch-read' } }, 500);
      return send({ items: state.mode === 'empty' || url.searchParams.has('afterId') ? [] : messages, hasMoreBefore: false, hasMoreAfter: false });
    }
    if (path === `${base}/steps`) return send({ projectId, taskId, version: 1, steps: [] });
    if (path === `${base}/attachments` || path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Unconfigured fixture route', requestId: path } }, 404);
  });
  return state;
};

const open = async (page: Page, type: 'task' | 'goal', surface: 'page' | 'modal' | 'fullscreen', locale: string) => {
  if (surface === 'page') await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=discussion`);
  else {
    await page.goto(`/projects/${projectId}`);
    await page.getByRole('tab', { name: /^(Task list|任务列表)$/ }).click();
    await page.getByRole('tab', { name: type === 'task' ? /^(Standalone tasks|独立任务)$/ : /^Goal/ }).click();
    await page.locator(type === 'task' ? `#standalone-task-${taskId}` : `#project-goal-detail-${taskId}`).click();
    const detail = page.locator(type === 'task' ? '.task-detail-dialog' : '.goal-detail-surface');
    await detail.getByRole('tab', { name: locale === 'en' ? 'Discussion' : '讨论', exact: true }).click();
    if (surface === 'fullscreen') await detail.getByRole('button', { name: /^(Enter fullscreen|进入全屏)$/ }).click();
  }
  await expect(page.locator('.thread-message')).toHaveCount(3);
};

const geometry = async (article: Locator, narrow: boolean) => {
  await article.scrollIntoViewIfNeeded();
  const measured = await article.evaluate(element => {
    const box = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('.thread-message-actions button')].map(button => { const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top }; });
    const main = box('.thread-message-main'), body = box('.thread-message-markdown'), author = element.querySelector<HTMLElement>('.thread-author')!;
    return { buttons, gap: buttons[1]!.left - buttons[0]!.right, sameRow: buttons[0]!.top === buttons[1]!.top, bodyWidth: body.width, mainWidth: main.width, authorHeight: author.getBoundingClientRect().height, within: buttons.every(button => button.left >= main.left && button.right <= main.right + 1), overflow: author.scrollWidth > author.clientWidth + 1 || element.scrollWidth > element.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth };
  });
  expect(measured.buttons.map(button => [button.width, button.height])).toEqual(narrow ? [[30, 30], [30, 30]] : [[25, 25], [25, 25]]);
  expect(measured.gap).toBe(narrow ? 4 : 2);
  expect(measured.sameRow).toBe(true); expect(measured.within).toBe(true); expect(measured.overflow).toBe(false);
  expect(measured.bodyWidth).toBeCloseTo(measured.mainWidth, 0);
  return measured;
};

for (const locale of ['en', 'zh-CN']) test(`bilingual mobile geometry and touch actions in ${locale}`, async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:4204', viewport: { width: 320, height: 844 }, hasTouch: true });
  try {
    const page = await context.newPage(), state = await install(page, locale);
    await open(page, 'task', 'page', locale);
    const measurements = [];
    for (const width of [320, 375, 390, 600]) {
      await page.setViewportSize({ width, height: 844 });
      for (const article of await page.locator('.thread-message').all()) measurements.push({ width, ...await geometry(article, true) });
      const input = page.locator('.thread-composer textarea'); await input.fill('Retained draft');
      const article = page.locator('.thread-message').first(), buttons = article.locator('.thread-message-actions button');
      await buttons.first().tap(); await expect(input).toBeFocused(); await expect(input).toHaveValue('Retained draft');
      await expect(page.locator('.thread-reply-preview')).toContainText('Alex');
      await buttons.last().tap(); await expect(page.locator('dialog.thread-metadata-dialog')).toBeVisible();
      await expect(page.locator('.thread-metadata-body')).toContainText(messages[0]!.id);
      await page.keyboard.press('Escape'); await expect(page.locator('dialog.thread-metadata-dialog')).toHaveCount(0); await expect(buttons.last()).toBeFocused();
      await expect(input).toHaveValue('Retained draft');
      if (width === 320) await page.screenshot({ path: info.outputPath(`task-${locale}-320.png`) });
    }
    await info.attach('geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
    expect(state.writes).toEqual([]);
  } finally { await context.close(); }
});

for (const type of ['task', 'goal'] as const) for (const surface of ['modal', 'fullscreen', 'page'] as const) test(`${type} ${surface} preserves pointer and keyboard discussion actions`, async ({ page }) => {
  const locale = type === 'task' ? 'en' : 'zh-CN';
  await page.setViewportSize({ width: 320, height: 844 }); const state = await install(page, locale, type);
  await open(page, type, surface, locale);
  const article = page.locator('.thread-message').first(), buttons = article.locator('.thread-message-actions button'), input = page.locator('.thread-composer textarea');
  for (const root of [12, 16, 24]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, root);
    await expect(page.locator('.task-detail-title')).toHaveCSS('font-size', `${root * 1.375}px`);
    await expect(article.locator('.thread-author')).toHaveCSS('font-size', `${root * 0.875}px`);
    await expect(article.locator('.thread-message-time')).toHaveCSS('font-size', `${root * 0.75}px`);
    await expect(article.locator('.markdown-content')).toHaveCSS('font-size', `${root * 0.875}px`);
    await expect(input).toHaveCSS('font-size', `${root}px`);
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await geometry(article, true); await input.fill('Existing draft');
  await buttons.first().click(); await expect(input).toBeFocused(); await expect(input).toHaveValue('Existing draft');
  await expect(page.locator('.thread-reply-preview p')).toHaveCSS('font-size', '16px');
  await article.locator('.thread-message-time').focus(); await page.keyboard.press('Tab'); await expect(buttons.first()).toBeFocused();
  await page.keyboard.press('Enter'); await expect(input).toBeFocused(); await expect(input).toHaveValue('Existing draft');
  await buttons.first().focus(); await page.keyboard.press('Tab'); await expect(buttons.last()).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.locator('dialog.thread-metadata-dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(buttons.last()).toBeFocused();
  expect(state.writes).toEqual([]);
});

test('desktop breakpoint preserves sizes and hover or focus disclosure', async ({ page }) => {
  await install(page, 'en'); await open(page, 'task', 'page', 'en');
  const article = page.locator('.thread-message').first(), actions = article.locator('.thread-message-actions');
  for (const width of [601, 768, 1360]) {
    await page.setViewportSize({ width, height: 900 }); await geometry(article, false);
    await page.mouse.move(0, 0); await page.locator('.thread-composer textarea').focus(); await expect(actions).toHaveCSS('opacity', '0');
    await article.hover(); await expect(actions).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0); await actions.locator('button').first().focus(); await expect(actions).toHaveCSS('opacity', '1');
  }
});

test('empty, loading and failed reads retain feedback and recovery', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); const state = await install(page, 'en'); state.mode = 'loading';
  await page.goto(`/projects/${projectId}/tasks/${taskId}?tab=discussion`);
  await expect(page.locator('.thread-skeleton-message')).toHaveCount(4); await expect(page.locator('.thread-composer textarea')).toBeDisabled();
  state.mode = 'empty'; state.release(); await expect(page.locator('.thread-empty')).toBeVisible(); await expect(page.locator('.thread-composer textarea')).toBeEnabled();
  state.mode = 'failure'; await page.locator('.thread-bar button').click(); await expect(page.locator('.thread-read-error')).toBeVisible();
  state.mode = 'ready'; await page.locator('.thread-read-error button').click(); await expect(page.locator('.thread-message')).toHaveCount(3);
  expect(state.writes).toEqual([]);
});

test('completed task without Worker keeps local replies and sends available', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 }); const state = await install(page, 'zh-CN', 'task', 'done'); await open(page, 'task', 'page', 'zh-CN');
  const input = page.locator('.thread-composer textarea'); await input.fill('Completed task draft'); await page.locator('.thread-message-actions button').first().click();
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Completed task draft'); await expect(page.locator('.thread-send-button')).toBeEnabled(); expect(state.writes).toEqual([]);
});
