import { openChain } from './chain-dialog';
import { selectTaskList } from './project-view';
import type { Browser, Locator, Page, Request, TestInfo } from '@playwright/test';
import { attachmentDownloadUrl, attachmentPageUrl } from '../../src/api/client';
import { parseApiJson } from '../../src/api/json';
import { parseTaskDetail } from '../../src/api/parse';
import type { TaskStatus } from '../../src/api/types';
import { createProject, createTask, expect, test, updateTask, type Task } from './fixtures';
import { authenticatedAPI, fulfillAuthenticatedResponse } from './authentication';
import { attachmentFileButton, attachmentFileActions } from './attachment-tree';

const taskPath = (project: string, task: string): string => `/api/v1/projects/${project}/tasks/${task}`;
const pagePath = (project: string, task: string): string => `/projects/${project}/tasks/${task}`;
const surface = (page: Page): Locator => page.locator('.task-detail-page');
const tab = (page: Page, value: 'overview' | 'attachments'): Locator => surface(page).getByRole('tab', {
  name: value === 'overview' ? /^(概览|Overview)$/ : /^(附件|Attachments)$/, exact: true,
});
const selectFile = async (root: Locator, path: string): Promise<void> => {
  const button = await attachmentFileButton(root, path);
  await button.click();
  await expect(root.getByRole('heading', { name: path, exact: true })).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
};
const openUpload = async (root: Locator): Promise<void> => {
  const disclosure = root.locator('.attachment-upload-disclosure');
  if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click();
};
const expectAddress = async (page: Page, project: string, task: string, active: 'overview' | 'attachments', path: string | null): Promise<void> => {
  await expect.poll(() => {
    const actual = new URL(page.url());
    return { pathname: actual.pathname, tab: actual.searchParams.get('tab') ?? (path === null ? 'overview' : 'attachments') };
  }).toEqual({ pathname: path === null ? pagePath(project, task) : attachmentPageUrl(project, task, path), tab: active });
  await expect(tab(page, active)).toHaveAttribute('aria-selected', 'true');
};
const statusLabels: Readonly<Record<TaskStatus, string>> = { todo: '待处理', in_progress: '进行中', done: '已完成' };
const statusTrigger = (page: Page): Locator => surface(page).locator('.task-status-trigger');
const confirmation = (page: Page): Locator => page.getByRole('alertdialog', { name: '设置任务状态', exact: true });
const selectStatus = async (page: Page, status: TaskStatus): Promise<void> => {
  await statusTrigger(page).click();
  await page.getByRole('menuitemradio', { name: statusLabels[status], exact: true }).click();
  await expect(confirmation(page)).toBeVisible();
};
const setStatus = async (page: Page, status: TaskStatus): Promise<void> => {
  await selectStatus(page, status);
  await confirmation(page).getByRole('button', { name: '确认设置', exact: true }).click();
  await expect(statusTrigger(page)).toHaveText(new RegExp(statusLabels[status]));
  await expect(statusTrigger(page)).toBeEnabled();
};
const platformSelect = (page: Page): Locator => surface(page).getByRole('combobox', { name: '执行平台', exact: true });
const platformConfirmation = (page: Page): Locator => page.getByRole('alertdialog', { name: '修改执行平台？', exact: true });
const reviewPlatform = async (page: Page, target: string): Promise<void> => {
  const select = platformSelect(page);
  // Opening reads can display cached details before editing is enabled; focus() does not wait.
  await expect(select).toBeEnabled();
  const saved = await select.inputValue();
  await select.focus(); await expect(select).toBeFocused();
  await select.selectOption(target);
  await expect(platformConfirmation(page)).toBeVisible();
  await expect(select).toHaveValue(saved);
};
const confirmPlatform = async (page: Page): Promise<void> => {
  await platformConfirmation(page).getByRole('button', { name: '修改平台', exact: true }).click();
};
const picture = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};

const loginReturn = async (browser: Browser, origin: string, target: string, title: string): Promise<void> => {
  const context = await browser.newContext({ baseURL: origin, locale: 'zh-CN' });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const writes: string[] = [];
  context.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const controlledProvider = new Promise<void>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('The task-page login did not reach the controlled external provider.')), 15_000);
    session.once('Fetch.requestPaused', event => {
      void (async () => {
        const upstream = new URL(event.request.url);
        if (upstream.origin !== 'https://github.com' || upstream.pathname !== '/login/oauth/authorize'
          || upstream.searchParams.get('code_challenge_method') !== 'S256') throw new Error('Task-page login changed its external provider or PKCE protocol.');
        const challenge = upstream.searchParams.get('code_challenge');
        const state = upstream.searchParams.get('state');
        const callback = upstream.searchParams.get('redirect_uri');
        if (challenge === null || state === null || callback === null) throw new Error('Task-page login omitted required provider fields.');
        const location = new URL(callback);
        location.search = new URLSearchParams({ state, code: `alice:${challenge}` }).toString();
        await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 302, responseHeaders: [{ name: 'Location', value: location.href }], body: '' });
      })().then(resolve, reject);
    });
  });
  try {
    await session.send('Fetch.enable', { patterns: [{ urlPattern: 'https://github.com/login/oauth/authorize*', requestStage: 'Request' }] });
    const failedReturn = new URL(target, origin);
    failedReturn.searchParams.set('authError', 'login_failed');
    await page.goto(failedReturn.href);
    await expect(page.getByRole('heading', { name: '登录你的工作空间', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new URL(target, origin).href);
    await Promise.all([page.getByRole('button', { name: '使用 GitHub 登录', exact: true }).click(), controlledProvider]);
    await expect(page).toHaveURL(new URL(target, origin).href);
    await expect(surface(page).locator('.task-detail-title')).toHaveText(title);
    await expect(tab(page, 'overview')).toHaveAttribute('aria-selected', 'true');
    expect(writes).toEqual([]);
  } finally {
    clearTimeout(deadline);
    await session.send('Fetch.disable');
    await session.detach();
    await context.close();
  }
};

test('task-detail-page', { annotation: { type: 'scenario', description: 'task-detail-page' } }, async ({ page, context, browser, api }, info) => {
  const origin = info.project.use.baseURL;
  if (typeof origin !== 'string') throw new Error('Standalone task acceptance requires the actual product origin.');
  const project = await createProject(api, { name: 'Complete task detail acceptance' });
  const description = `# 独立详情正文\n\n[阅读方案](docs/guide.md) · [无效附件](../outside.md)\n\n${Array.from({ length: 36 }, (_, index) => `## 验收记录 ${index + 1}\n\n完整概览保留正文、状态、平台、自动执行和附件操作。`).join('\n\n')}`;
  const title = `完整任务详情：${'可独立阅读并保留现有操作 '.repeat(14)}`;
  let task = await createTask(api, project.id, { title, description, properties: { pullRequests: [{ title: 'Review reference', url: 'https://github.com/example/project/pull/7' }] } });
  const next = await createTask(api, project.id, { title: '关联任务历史', dependsOn: [task.id] });
  const guide = `# 独立详情附件\n\n${Array.from({ length: 60 }, (_, index) => `段落 ${index + 1}：附件与任务详情共享生命周期。`).join('\n\n')}`;
  for (const [path, content] of [['docs/guide.md', guide], ['docs/next.txt', 'Another task attachment\n'], ['folded/reference.txt', 'Directory disclosure fixture\n']]) {
    const response = await api.put(attachmentDownloadUrl(project.id, task.id, path!), { headers: { 'Content-Type': path!.endsWith('.md') ? 'text/markdown' : 'text/plain' }, data: content });
    expect(response.status()).toBe(201);
  }

  const endpoint = new URL(taskPath(project.id, task.id), origin).href;
  const uploadedPath = 'uploads/完整 # %.txt';
  const uploadedEndpoint = new URL(attachmentDownloadUrl(project.id, task.id, uploadedPath), origin).href;
  const expectedWrites = new Map([
    [`PATCH ${endpoint}`, 5], [`PUT ${endpoint}/status`, 3],
    [`PUT ${uploadedEndpoint}`, 1], [`DELETE ${uploadedEndpoint}`, 1],
  ]);
  const writes: string[] = [];
  const errors: string[] = [];
  const pages: Page[] = [];
  const watch = (request: Request): void => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${request.url()}`); };
  context.on('request', watch);
  const opened = async (trigger: Locator): Promise<Page> => {
    const [child] = await Promise.all([page.waitForEvent('popup'), trigger.click()]);
    pages.push(child); child.on('pageerror', error => errors.push(error.name));
    expect(await child.evaluate(() => window.opener === null)).toBe(true);
    return child;
  };
  let reader: Page | undefined;
  let mode: 'ordinary' | 'conflict' | 'unknown' = 'ordinary';
  let blockReconciliation = false;
  const platformWrites: { version: string; requiredPlatform: Task['requiredPlatform']; status: number }[] = [];
  const statusWrites: { version: string; status: TaskStatus; result: number }[] = [];
  try {
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await openChain(page, task.id);
    await page.locator(`.react-flow__node[data-id="${task.id}"] .task-node-details`).click();
    const modal = page.locator('.task-detail-dialog');
    await expect(modal.locator('.task-detail-title')).toHaveText(title);
    const originalAddress = page.url(); const originalHistory = await page.evaluate(() => history.length);
    const popout = modal.locator('.task-detail-popout');
    const moreActions = modal.getByRole('button', { name: '更多任务操作', exact: true });
    await moreActions.click();
    await expect(popout).toHaveAttribute('target', '_blank'); await expect(popout).toHaveAttribute('rel', 'noopener noreferrer');
    const overview = await opened(popout);
    await expectAddress(overview, project.id, task.id, 'overview', null);
    await expect(surface(overview).getByRole('heading', { name: '独立详情正文', exact: true })).toBeVisible();
    await expect(surface(overview).getByText('Review reference', { exact: true })).toBeVisible();
    await expect(surface(overview).locator('.task-detail-pr-value')).toHaveAttribute('href', 'https://github.com/example/project/pull/7');
    await expect(overview.getByRole('dialog')).toHaveCount(0);
    await overview.close();

    await modal.getByRole('tab', { name: '附件', exact: true }).click();
    const embeddedAttachments = modal.locator('.task-attachments');
    await selectFile(embeddedAttachments, 'docs/guide.md');
    await openUpload(embeddedAttachments);
    await embeddedAttachments.getByLabel('选择一个文件', { exact: true }).setInputFiles({ name: 'source-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Source draft') });
    await embeddedAttachments.getByLabel('目标相对路径', { exact: true }).fill('drafts/source.txt');
    await moreActions.click();
    await expect(popout).toHaveAttribute('href', attachmentPageUrl(project.id, task.id, 'docs/guide.md'));
    await expect(embeddedAttachments.getByRole('link', { name: '在新标签页打开', exact: true })).toHaveAttribute('href', attachmentPageUrl(project.id, task.id, 'docs/guide.md'));
    reader = await opened(popout);
    await expectAddress(reader, project.id, task.id, 'attachments', 'docs/guide.md');
    await expect(surface(reader).locator('.task-detail-title')).toHaveText(title);
    await expect(statusTrigger(reader)).toBeVisible();
    await expect(surface(reader).locator('.task-detail-status-row .task-platform-select')).toBeVisible();
    expect(page.url()).toBe(originalAddress); expect(await page.evaluate(() => history.length)).toBe(originalHistory);
    await expect(modal.getByRole('tab', { name: '附件', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(embeddedAttachments.getByLabel('目标相对路径', { exact: true })).toHaveValue('drafts/source.txt');

    const attachments = surface(reader).locator('.task-attachments');
    await openUpload(attachments);
    const input = attachments.getByLabel('选择一个文件', { exact: true });
    await input.setInputFiles({ name: 'reader-draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Reader draft') });
    await attachments.getByLabel('目标相对路径', { exact: true }).fill('drafts/retained.txt');
    const inputHandle = await input.elementHandle();
    if (inputHandle === null) throw new Error('The standalone upload input is absent.');
    const directory = attachments.locator('summary').filter({ hasText: /^▱ folded$/ }).locator('..');
    await expect(directory).not.toHaveAttribute('open');
    await directory.locator('summary').click(); await expect(directory).toHaveAttribute('open');
    await directory.locator('summary').click(); await expect(directory).not.toHaveAttribute('open');
    await selectFile(attachments, 'docs/next.txt');
    await expectAddress(reader, project.id, task.id, 'attachments', 'docs/next.txt');
    const historyLength = await reader.evaluate(() => history.length);
    await selectFile(attachments, 'docs/next.txt'); expect(await reader.evaluate(() => history.length)).toBe(historyLength);
    await reader.goBack(); await expectAddress(reader, project.id, task.id, 'attachments', 'docs/guide.md');
    await reader.goForward(); await expectAddress(reader, project.id, task.id, 'attachments', 'docs/next.txt');
    expect(await inputHandle.evaluate(element => element.isConnected && (element as HTMLInputElement).files?.[0]?.name === 'reader-draft.txt')).toBe(true);
    await expect(attachments.getByLabel('目标相对路径', { exact: true })).toHaveValue('drafts/retained.txt');
    await expect(directory).not.toHaveAttribute('open');
    await selectFile(attachments, 'docs/guide.md');
    const body = attachments.locator('.attachment-preview-body');
    await expect(body.locator('.attachment-markdown')).toContainText('段落 60：附件与任务详情共享生命周期。');
    await body.evaluate(element => { element.scrollTop = 180; });
    const before = await body.evaluate(element => element.scrollTop); expect(before).toBeGreaterThan(0);
    await tab(reader, 'overview').click(); await expectAddress(reader, project.id, task.id, 'overview', 'docs/guide.md');
    await tab(reader, 'attachments').click(); await expectAddress(reader, project.id, task.id, 'attachments', 'docs/guide.md');
    expect(await body.evaluate(element => element.scrollTop)).toBe(before);
    await reader.goBack(); await expectAddress(reader, project.id, task.id, 'overview', 'docs/guide.md');
    await surface(reader).getByRole('link', { name: '无效附件', exact: true }).click();
    await expectAddress(reader, project.id, task.id, 'attachments', null);
    await expect(attachments.locator('.attachment-preview-pane')).toContainText('此附件引用无效或超出了任务附件根目录。');
    await reader.goBack(); await expectAddress(reader, project.id, task.id, 'overview', 'docs/guide.md');
    await tab(reader, 'attachments').click();
    await expect(attachments.getByRole('heading', { name: 'docs/guide.md', exact: true })).toBeVisible();
    await expect(attachments.locator('.attachment-preview-pane')).not.toContainText('此附件引用无效或超出了任务附件根目录。');
    await tab(reader, 'overview').click();
    await surface(reader).locator('.task-detail-relation').filter({ hasText: next.title }).first().click();
    await expectAddress(reader, project.id, next.id, 'overview', null);
    await expect(surface(reader).locator('.task-detail-title')).toHaveText(next.title);
    await reader.goBack(); await expectAddress(reader, project.id, task.id, 'overview', 'docs/guide.md');
    await page.close(); await reader.reload();
    await expectAddress(reader, project.id, task.id, 'overview', 'docs/guide.md');
    await expect(surface(reader).locator('.task-detail-title')).toHaveText(title);
    await reader.keyboard.press('Escape'); await expect(surface(reader)).toBeVisible();
    await expect(surface(reader)).not.toHaveAttribute('inert');
    await inputHandle.dispose();

    await reader.route(endpoint, async route => {
      if (route.request().method() === 'GET') { if (blockReconciliation) await route.abort('connectionfailed'); else await route.continue(); return; }
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      const raw = route.request().postData();
      if (raw === null) throw new Error('A standalone detail mutation requires an exact body.');
      const data = parseApiJson(raw) as { version: bigint; requiredPlatform?: Task['requiredPlatform']; allowAgents?: boolean };
      expect(typeof data.version).toBe('bigint');
      if (mode === 'conflict') {
        const current = await (await api.get(taskPath(project.id, task.id))).json() as Task;
        task = await updateTask(api, project.id, task.id, { version: current.version, description: `${description}\n\n另一个客户端修改了任务。` });
        mode = 'ordinary';
      }
      const response = await authenticatedAPI(reader!.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      if ('requiredPlatform' in data) platformWrites.push({ version: String(data.version), requiredPlatform: data.requiredPlatform!, status: response.status() });
      if (mode === 'unknown') { mode = 'ordinary'; blockReconciliation = true; await route.abort('connectionfailed'); return; }
      await fulfillAuthenticatedResponse(route, response);
    });
    const platform = platformSelect(reader);
    await expect(surface(reader).getByRole('button', { name: '保存平台', exact: true })).toHaveCount(0);
    await expect(surface(reader).locator('.task-detail-panel-overview .task-platform-select')).toHaveCount(0);
    await reviewPlatform(reader, 'linux');
    await platformConfirmation(reader).getByRole('button', { name: '取消', exact: true }).click();
    await expect(platform).toHaveValue(''); await expect(platform).toBeFocused();
    expect(writes.filter(value => value === `PATCH ${endpoint}`)).toHaveLength(0);
    await reviewPlatform(reader, 'linux'); await confirmPlatform(reader);
    await expect(platform).toHaveValue('linux'); await expect(platform).toBeEnabled();
    const automatic = surface(reader).getByRole('switch');
    await automatic.click();
    const permission = reader.getByRole('alertdialog', { name: '开启自动执行', exact: true });
    await expect(permission).toBeVisible(); await reader.keyboard.press('Escape');
    await expect(permission).toHaveCount(0); await expect(automatic).not.toBeChecked(); await expect(automatic).toBeFocused();
    await automatic.click(); await permission.getByRole('button', { name: '开启自动执行', exact: true }).click();
    await expect(automatic).toBeChecked();
    mode = 'conflict'; await reviewPlatform(reader, 'windows'); await confirmPlatform(reader);
    await expect(surface(reader).getByText('任务已发生变化，请检查当前平台后重新确认修改。')).toBeVisible();
    await expect(platform).toHaveValue('linux');
    await expect(platformConfirmation(reader)).toHaveCount(0);
    await reviewPlatform(reader, 'windows'); await confirmPlatform(reader);
    await expect(platform).toHaveValue('windows'); await expect(platform).toBeEnabled();
    mode = 'unknown'; await reviewPlatform(reader, 'macos'); await confirmPlatform(reader);
    const reconcile = surface(reader).getByRole('button', { name: '核对实际任务', exact: true });
    await expect(reconcile).toBeEnabled(); await expect(platform).toBeDisabled(); await expect(automatic).toBeDisabled();
    expect((await (await api.get(taskPath(project.id, task.id))).json() as Task).requiredPlatform).toBe('macos');
    await surface(reader).locator('.task-detail-toast').filter({ has: reader.getByRole('button', { name: '核对实际任务', exact: true }) }).getByRole('button', { name: '关闭提示', exact: true }).click();
    await expect(reconcile).toHaveCount(0); await expect(platform).toBeDisabled();
    await surface(reader).getByRole('button', { name: '查看任务提示', exact: true }).first().click();
    await expect(reconcile).toBeEnabled();
    blockReconciliation = false; await reconcile.click(); await expect(platform).toHaveValue('macos'); await expect(platform).toBeEnabled();
    expect(platformWrites.map(write => write.status)).toEqual([200, 409, 200, 200]);
    await selectStatus(reader, 'in_progress');
    await confirmation(reader).getByRole('button', { name: '取消', exact: true }).click();
    expect(writes.filter(value => value === `PUT ${endpoint}/status`)).toHaveLength(0);
    await expect(statusTrigger(reader)).toBeFocused();
    await reader.route(`${endpoint}/status`, async route => {
      expect(route.request().method()).toBe('PUT');
      const data = parseApiJson(route.request().postData()!) as { version: bigint; status: TaskStatus };
      expect(Object.keys(data).sort()).toEqual(['status', 'version']);
      expect(typeof data.version).toBe('bigint');
      const response = await authenticatedAPI(reader!.context().request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      statusWrites.push({ version: String(data.version), status: data.status, result: response.status() });
      await fulfillAuthenticatedResponse(route, response);
    });
    const read = async () => {
      const response = await api.get(taskPath(project.id, task.id)); expect(response.status()).toBe(200);
      return parseTaskDetail(parseApiJson(await response.text()), project.id, task.id);
    };
    const beforeStatus = await read();
    await setStatus(reader, 'in_progress');
    const running = await read();
    expect(running).toMatchObject({ status: 'in_progress', version: beforeStatus.version + 1n, allowAgents: true, requiredPlatform: 'macos', completedAt: null });
    expect(running.startedAt).not.toBeNull();
    await expect(platform).toBeDisabled(); await expect(automatic).toBeDisabled();
    await setStatus(reader, 'done');
    const done = await read();
    expect(done).toMatchObject({ status: 'done', version: running.version + 1n, startedAt: running.startedAt });
    expect(done.completedAt).not.toBeNull();
    await setStatus(reader, 'todo');
    expect(await read()).toMatchObject({ status: 'todo', version: done.version + 1n, allowAgents: true, requiredPlatform: 'macos', startedAt: null, completedAt: null });
    expect(statusWrites.map(write => ({ status: write.status, result: write.result }))).toEqual([
      { status: 'in_progress', result: 200 }, { status: 'done', result: 200 }, { status: 'todo', result: 200 },
    ]);
    expect(statusWrites.map(write => write.version)).toEqual([String(beforeStatus.version), String(running.version), String(done.version)]);

    await tab(reader, 'attachments').click(); await openUpload(attachments);
    await attachments.getByLabel('选择一个文件', { exact: true }).setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Full detail upload\n') });
    await attachments.getByLabel('目标相对路径', { exact: true }).fill(uploadedPath);
    await attachments.getByRole('button', { name: '上传文件', exact: true }).click();
    await expectAddress(reader, project.id, task.id, 'attachments', uploadedPath);
    await expect(attachments.locator('.attachment-text')).toHaveText('Full detail upload\n');
    expect(await (await api.get(attachmentDownloadUrl(project.id, task.id, uploadedPath))).text()).toBe('Full detail upload\n');
    await (await attachmentFileActions(attachments, uploadedPath)).click();
    await reader.getByRole('menuitem', { name: '删除', exact: true }).click();
    const deletion = reader.locator('.attachment-delete-dialog');
    await deletion.getByRole('button', { name: '删除附件', exact: true }).click();
    await expect(deletion).toHaveCount(0); await expect(attachments.locator('.attachment-preview-pane')).toContainText('找不到此附件');
    await selectFile(attachments, 'docs/guide.md');
    await tab(reader, 'overview').click();
    const loginTarget = `${attachmentPageUrl(project.id, task.id, 'docs/guide.md')}?tab=overview`;
    await loginReturn(browser, origin, loginTarget, title);

    const layouts: unknown[] = [];
    for (const locale of ['zh-CN', 'en']) {
      await surface(reader).getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      for (const viewport of [{ width: 1440, height: 800 }, { width: 320, height: 800 }, { width: 844, height: 390 }]) {
        await reader.setViewportSize(viewport); await tab(reader, 'overview').click();
        await expect(surface(reader).locator('.task-detail-header')).toBeInViewport({ ratio: 1 });
        expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const overviewBody = surface(reader).locator('.task-detail-panel-overview');
        await overviewBody.evaluate(element => { element.scrollTop = element.scrollHeight; });
        expect(await overviewBody.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await expect(surface(reader).locator('.task-detail-header')).toBeInViewport({ ratio: 1 });
        await tab(reader, 'attachments').click();
        const panes = await attachments.locator('.attachment-sidebar,.attachment-preview-pane').evaluateAll(elements => elements.map(element => {
          const bounds = element.getBoundingClientRect(); return { x: bounds.x, right: bounds.right, y: bounds.y, height: bounds.height };
        }));
        expect(panes[0]!.right).toBeLessThanOrEqual(panes[1]!.x + 1); expect(panes[0]!.y).toBe(panes[1]!.y); expect(panes[1]!.height).toBeGreaterThan(80);
        expect(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await picture(reader, info, `task-detail-page-${locale}-${viewport.width}x${viewport.height}`);
        layouts.push({ locale, viewport, panes });
      }
    }
    expect(errors).toEqual([]);
    for (const [key, count] of expectedWrites) expect(writes.filter(write => write === key), `Exact standalone browser writes: ${key}`).toHaveLength(count);
    expect(writes.filter(write => !expectedWrites.has(write))).toEqual([]);
    await info.attach('standalone-task-detail-evidence', { contentType: 'application/json', body: JSON.stringify({ project: project.id, task: task.id, next: next.id, writes, platformWrites, statusWrites, layouts, errors }, null, 2) });
  } finally {
    context.removeListener('request', watch);
    if (reader !== undefined && !reader.isClosed()) await reader.unroute(endpoint);
    if (reader !== undefined && !reader.isClosed()) await reader.unroute(`${endpoint}/status`);
    await Promise.all(pages.filter(value => !value.isClosed()).map(value => value.close()));
  }
});
