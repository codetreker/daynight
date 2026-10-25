import { selectTaskList } from './project-view';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { attachmentDownloadUrl, attachmentPreviewUrl } from '../../src/api/client';
import { createProject, createTask, expect, test, withDependencyFailure } from './fixtures';
import { panPoint } from './graph-pan';
import { attachmentFileButton, attachmentFileActions } from './attachment-tree';

const scenario = (description: string) => ({ annotation: { type: 'scenario', description } });
const language = (scope: Page | Locator): Locator => scope.getByRole('combobox', { name: '语言 / Language', exact: true });
const card = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"] .task-node`);
const inspectTask = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"] button.task-node-body`);
const details = (page: Page, id: string): Locator => card(page, id).locator('button.task-node-details');
const screenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const within = async (promise: Promise<unknown>, label: string): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
};
const expectPageWidth = async (page: Page): Promise<void> => {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
};
const expectDialogLayout = async (page: Page, dialog: Locator): Promise<void> => {
  await expect.poll(() => dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const gutter = window.innerWidth <= 600 ? 12 : 24;
    return Math.abs(bounds.x + bounds.width / 2 - window.innerWidth / 2) <= 0.5
      && Math.abs(bounds.y + bounds.height / 2 - window.innerHeight / 2) <= 0.5
      && bounds.width > 0 && bounds.width <= 960.5
      && bounds.x >= gutter - 0.5 && bounds.right <= window.innerWidth - gutter + 0.5
      && bounds.y >= gutter - 0.5 && bounds.bottom <= window.innerHeight - gutter + 0.5
      && bounds.height <= window.innerHeight - gutter * 2 + 0.5;
  })).toBe(true);
  await expect(dialog.locator('.task-detail-header,.task-detail-footer')).toHaveCount(2);
  await expect(dialog.locator('.task-detail-header')).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator('.task-detail-close')).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator('.task-detail-footer')).toBeInViewport({ ratio: 1 });
  expect(await dialog.locator('.task-detail-body').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expectPageWidth(page);
};

test.describe('Web language journeys', () => {
  test.use({ locale: 'en-US' });

  test('language-startup-preferences', scenario('language-startup-preferences'), async ({ page, api: request }, info) => {
    const project = await createProject(request, { name: `原始项目 Raw project ${randomUUID()}` });
    const task = await createTask(request, project.id, { title: '原始任务 Raw task', description: '原始描述 Raw description' });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('My projects · Daynight');
    await expect(language(page)).toHaveValue('en');
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.locale'))).toBeNull();
    const link = page.locator(`a.project-card[href="/projects/${project.id}"]`);
    await expect(link).toContainText(project.name);
    await link.click();
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Project tasks · Daynight');
    await selectTaskList(page);
    await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
    const trigger = page.locator(`#standalone-task-${task.id}`);
    await expect(trigger).toContainText(task.title);
    await expect(trigger).toContainText('To do');
    await language(page).selectOption('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page).toHaveTitle('项目任务 · Daynight');
    await expect(page.getByRole('tab', { name: '独立任务', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(trigger).toContainText(task.title);
    await expect(trigger).toContainText('待处理');
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.locale'))).toBe('zh-CN');
    await page.reload();
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await expect(language(page)).toHaveValue('zh-CN');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await selectTaskList(page);
    await trigger.click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog.locator('.task-detail-title')).toHaveText(task.title);
    await expect(dialog.locator('.task-description')).toHaveText(task.description);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: '← 项目', exact: true }).click();
    await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
    await expect(page).toHaveTitle('我的项目 · Daynight');
    await expect(language(page)).toHaveValue('zh-CN');
    await screenshot(page, info, 'language-startup-preferences');
  });

  test('language-state-preservation', scenario('language-state-preservation'), async ({ page, api: request, allowAttachmentWrites }, info) => {
    const project = await createProject(request, { name: `Language lifecycle ${randomUUID()}` });
    const pullRequests = Array.from({ length: 101 }, (_, index) => ({ title: `原始 PR ${index + 1}`, url: `https://example.com/pull/${index + 1}` }));
    const task = await createTask(request, project.id, { title: '根任务 Raw root', description: '原始描述 Raw description', properties: { pullRequests } });
    await createTask(request, project.id, { title: '后续任务 Raw successor', dependsOn: [task.id] });
    for (let index = 0; index < 79; index++) await createTask(request, project.id, { title: `Language successor ${index}`, dependsOn: [task.id] });
    const htmlPath = 'preview.html';
    const htmlUrl = attachmentDownloadUrl(project.id, task.id, htmlPath);
    const seeded = await request.put(htmlUrl, { headers: { 'content-type': 'text/html' }, data: '<!doctype html><html lang="en"><body><button id="counter" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><p>原始附件 Raw attachment</p></body></html>' });
    expect(seeded.status()).toBe(201);
    const baseURL = info.project.use.baseURL;
    if (typeof baseURL !== 'string') throw new Error('Language acceptance requires the actual service base URL.');
    const uploadPath = 'uploads/语言 Raw.txt';
    const uploadUrl = new URL(attachmentDownloadUrl(project.id, task.id, uploadPath), baseURL).href;
    allowAttachmentWrites([
      { origin: new URL(baseURL).origin, method: 'PUT', projectId: project.id, taskId: task.id, path: uploadPath, count: 2 },
      { origin: new URL(baseURL).origin, method: 'DELETE', projectId: project.id, taskId: task.id, path: uploadPath, count: 1 },
    ]);
    const reads: string[] = [];
    page.on('request', (request) => {
      if (['GET', 'HEAD'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/v1/')) reads.push(`${request.method()} ${request.url()}`);
    });
    // Keep locale request-isolation assertions independent of the task polling timer.
    const clockTime = new Date('2030-01-01T00:00:00Z');
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
    await page.clock.runFor(100);
    await expect(inspectTask(page, task.id)).toBeVisible();
    await expect(page.locator('.task-graph')).toHaveAttribute('data-visible-task-count', '50');
    await expect(page.locator('.task-graph')).toHaveAttribute('data-total-task-count', '81');
    const expansion = card(page, task.id).locator('.task-node-expand[data-direction="successors"]');
    await expect(expansion).toHaveAccessibleName('Expand 20 successor tasks and 20 dependencies, 11 successors still hidden');
    await expansion.click();
    await expect(page.locator('.task-graph')).toHaveAttribute('data-visible-task-count', '70');
    await expect(expansion).toHaveAccessibleName('Expand 11 successor tasks and 11 dependencies');
    await inspectTask(page, task.id).click();
    await expect(inspectTask(page, task.id)).toHaveAttribute('aria-pressed', 'true');
    const visibleState = () => page.evaluate(() => ({
      nodes: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.dataset.id!).sort(),
      edges: [...document.querySelectorAll<SVGGElement>('.task-dependency-edge')].map((edge) => [edge.dataset.id, edge.dataset.inspection]).sort(),
      selected: document.querySelector<HTMLElement>('.task-node-selected')?.closest<HTMLElement>('.react-flow__node')?.dataset.id,
      hidden: document.querySelector<HTMLElement>('.task-graph')!.dataset.hiddenUpstreamCount,
    }));
    const expandedState = await visibleState();
    await expect(page.locator('.graph-reset-overview')).toHaveText('Reset overview');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.clock.runFor(500);
    const point = await panPoint(page);
    const viewport = page.locator('.react-flow__viewport');
    const beforePan = await viewport.getAttribute('style');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 60, point.y + 35, { steps: 4 });
    await page.mouse.up();
    await page.clock.runFor(100);
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan);
    const viewportElement = await viewport.elementHandle();
    const taskElement = await inspectTask(page, task.id).elementHandle();
    if (viewportElement === null || taskElement === null) throw new Error('Graph elements are absent.');
    const transform = await viewport.getAttribute('style');
    const paths = await page.locator('.task-dependency-edge path.react-flow__edge-path').evaluateAll((elements) => elements.map((element) => element.getAttribute('d')));
    const beforeSwitch = [...reads];
    await language(page).selectOption('zh-CN');
    await expect(inspectTask(page, task.id).locator('.graph-status')).toHaveText('待处理');
    expect(await visibleState()).toEqual(expandedState);
    await expect(expansion).toHaveAccessibleName('展开后续 11 个任务、11 条依赖');
    await expect(page.locator('.graph-reset-overview')).toHaveText('收起到概览');
    await expect(viewport).toHaveAttribute('style', transform!);
    expect(await taskElement.evaluate((element, id) => element === document.querySelector(`.react-flow__node[data-id="${id}"] button.task-node-body`), task.id)).toBe(true);
    expect(await page.locator('.task-dependency-edge path.react-flow__edge-path').evaluateAll((elements) => elements.map((element) => element.getAttribute('d')))).toEqual(paths);
    expect(reads).toEqual(beforeSwitch);
    await page.getByRole('button', { name: '全屏查看', exact: true }).click();
    const fullscreen = page.locator('.task-graph-fullscreen');
    await language(fullscreen).selectOption('en');
    await expect(fullscreen).toHaveAttribute('aria-label', 'Task dependency graph fullscreen view');
    expect(await visibleState()).toEqual(expandedState);
    await expect(expansion).toHaveAccessibleName('Expand 11 successor tasks and 11 dependencies');
    await expect(page.locator('.graph-reset-overview')).toHaveText('Reset overview');
    await expect(viewport).toHaveAttribute('style', transform!);
    expect(await viewportElement.evaluate((element) => element === document.querySelector('.react-flow__viewport'))).toBe(true);
    expect(reads).toEqual(beforeSwitch);
    await details(page, task.id).click();
    const dialog = page.locator('.task-detail-dialog');
    await expect(dialog.locator('.task-detail-title')).toHaveText(task.title);
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    const pagination = dialog.getByRole('combobox', { name: 'Linked PR page', exact: true });
    await pagination.selectOption('1');
    await expect(dialog.locator('.task-detail-pr-title')).toHaveText(['原始 PR 101']);
    const attachments = dialog.locator('.task-attachments');
    const changeDetailLanguage = async (locale: 'en' | 'zh-CN'): Promise<void> => {
      await (await attachmentFileActions(attachments, htmlPath)).click();
      await page.getByRole('menuitem', { name: /^(Delete|删除)$/, exact: true }).click();
      const confirmation = dialog.locator('.attachment-delete-dialog');
      await expect(confirmation).toContainText(htmlPath);
      await language(confirmation).selectOption(locale);
      await confirmation.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消', exact: true }).click();
      await expect(confirmation).toBeHidden();
    };
    await expect(dialog.locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
    await dialog.getByRole('tab', { name: 'Attachments', exact: true }).click();
    await (await attachmentFileButton(attachments, htmlPath)).click();
    const frame = attachments.locator('iframe');
    await expect(frame).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, htmlPath));
    await frame.contentFrame().locator('#counter').click();
    await expect(frame.contentFrame().locator('#counter')).toHaveText('1');
    const frameElement = await frame.elementHandle();
    const fileInput = attachments.locator('input[type=file]');
    const pathInput = attachments.locator('input[type=text]');
    await attachments.locator('.attachment-upload-disclosure>summary').click();
    await fileInput.setInputFiles({ name: 'original.txt', mimeType: 'text/plain', buffer: Buffer.from('First 原始 bytes\n') });
    await pathInput.fill(uploadPath);
    const inputElement = await fileInput.elementHandle();
    if (frameElement === null || inputElement === null) throw new Error('Attachment elements are absent.');
    const beforeModalSwitch = [...reads];
    await changeDetailLanguage('zh-CN');
    await dialog.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: '关联 PR 页码', exact: true })).toHaveValue('1');
    await expect(dialog.locator('.task-detail-pr-title')).toHaveText(['原始 PR 101']);
    await dialog.getByRole('tab', { name: '附件', exact: true }).click();
    await expect(frame).toHaveAttribute('title', `HTML 预览：${htmlPath}`);
    await expect(frame).toHaveAttribute('src', attachmentPreviewUrl(project.id, task.id, htmlPath));
    expect(await frameElement.evaluate((element) => element === document.querySelector('.task-attachments iframe'))).toBe(true);
    await expect(frame.contentFrame().locator('#counter')).toHaveText('1');
    expect(await inputElement.evaluate((element) => element === document.querySelector('.task-attachments input[type=file]'))).toBe(true);
    expect(await fileInput.evaluate((element) => (element as HTMLInputElement).files?.[0]?.name)).toBe('original.txt');
    await expect(pathInput).toHaveValue(uploadPath);
    expect(reads).toEqual(beforeModalSwitch);

    let hold: { readonly method: 'PUT' | 'DELETE'; readonly started: ReturnType<typeof deferred>; readonly release: ReturnType<typeof deferred> } | null = null;
    await page.route(uploadUrl, async (route) => {
      const current = hold;
      if (current !== null && route.request().method() === current.method) {
        current.started.resolve();
        await current.release.promise;
      }
      await route.continue();
    });
    const write = async (method: 'PUT' | 'DELETE', locale: 'en' | 'zh-CN', expectedStatus: number): Promise<void> => {
      if (method === 'PUT') await changeDetailLanguage(locale);
      const current = { method, started: deferred(), release: deferred() };
      hold = current;
      const response = page.waitForResponse((response) => response.url() === uploadUrl && response.request().method() === method);
      const confirmation = dialog.locator('.attachment-delete-dialog');
      if (method === 'PUT') await attachments.locator('button[type=submit]').click();
      else {
        const english = await page.locator('html').getAttribute('lang') === 'en';
        await (await attachmentFileActions(attachments, uploadPath)).click();
        await page.getByRole('menuitem', { name: english ? 'Delete' : '删除', exact: true }).click();
        await expect(confirmation).toContainText(uploadPath);
        await confirmation.getByRole('button', { name: english ? 'Delete attachment' : '删除附件', exact: true }).click();
      }
      try {
        await within(current.started.promise, `pending ${method}`);
        const pendingReads = [...reads];
        const selectedPath = await attachments.locator('.attachment-preview h5').textContent();
        if (method === 'DELETE') {
          await language(confirmation).selectOption(locale);
          await expect(confirmation).toHaveAccessibleName(locale === 'en' ? 'Delete attachment?' : '删除附件？');
          await expect(confirmation).toContainText(uploadPath);
          await expect(confirmation.getByRole('button', { name: locale === 'en' ? 'Deleting…' : '正在删除…', exact: true })).toBeDisabled();
        }
        await expect(attachments.locator('button[type=submit]')).toBeDisabled();
        await expect(pathInput).toBeDisabled();
        await expect(attachments.locator('.attachment-preview h5')).toHaveText(selectedPath!);
        expect(reads).toEqual(pendingReads);
        if (method === 'PUT') {
          await expect(pathInput).toHaveValue(uploadPath);
          expect(await fileInput.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(1);
        }
      } finally { current.release.resolve(); }
      expect((await response).status()).toBe(expectedStatus);
      hold = null;
      await expect(attachments.locator('button[type=submit]')).toHaveText(locale === 'en' ? 'Upload file' : '上传文件');
      if (method === 'PUT') {
        await expect(pathInput).toHaveValue('');
        expect(await fileInput.evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(0);
      }
    };
    await write('PUT', 'en', 201);
    await expect(attachments.getByRole('heading', { name: uploadPath, exact: true })).toBeVisible();
    await expect(attachments.locator('pre')).toHaveText('First 原始 bytes\n');
    await fileInput.setInputFiles({ name: 'replacement.txt', mimeType: 'text/plain', buffer: Buffer.from('Replacement 原始 bytes\n') });
    await pathInput.fill(uploadPath);
    await write('PUT', 'zh-CN', 200);
    await expect(attachments.locator('pre')).toHaveText('Replacement 原始 bytes\n');
    await write('DELETE', 'en', 204);
    await expect(attachments.locator('.attachment-preview')).toHaveCount(0);
    const listed = await request.get(`/api/v1/projects/${project.id}/tasks/${task.id}/attachments`);
    expect(listed.status()).toBe(200);
    expect((await listed.json() as { items: { path: string }[] }).items.map(({ path }) => path)).toEqual([htmlPath]);
    expect(reads.filter((value) => new URL(value.slice(value.indexOf(' ') + 1)).pathname === `/api/v1/projects/${project.id}/task-sync`)).toHaveLength(1);
    expect(reads.filter((value) => new URL(value.slice(value.indexOf(' ') + 1)).pathname === `/api/v1/projects/${project.id}/tasks/${task.id}`)).toHaveLength(1);
    await screenshot(page, info, 'language-state-preservation');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(fullscreen).toHaveCount(1);
    await expect(details(page, task.id)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(fullscreen).toHaveCount(0);
    await viewportElement.dispose();
    await taskElement.dispose();
    await frameElement.dispose();
    await inputElement.dispose();
  });

  test('language-errors-and-narrow', scenario('language-errors-and-narrow'), async ({ page, api: request }, info) => {
    await page.clock.install({ time: new Date('2029-01-01T00:00:00Z') });
    await page.addInitScript(() => {
      const fault = new URL(location.href).searchParams.get('localeFault');
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      const control = { value: fault };
      Object.defineProperty(window, 'localeStorageFault', { value: control });
      if (fault === 'invalid') setItem.call(localStorage, 'daynight.web.locale', 'invalid');
      else localStorage.removeItem('daynight.web.locale');
      Storage.prototype.getItem = function (key) {
        if (key === 'daynight.web.locale' && control.value === 'read') throw new DOMException('Owned language read fault', 'SecurityError');
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === 'daynight.web.locale' && control.value === 'write') throw new DOMException('Owned language write fault', 'QuotaExceededError');
        setItem.call(this, key, value);
      };
    });
    const clearFault = async (): Promise<void> => { await page.evaluate(() => {
      (window as unknown as { localeStorageFault: { value: string | null } }).localeStorageFault.value = null;
    }); };
    await page.goto('/?localeFault=read');
    await expect(page.locator('.locale-notice')).toContainText('The saved language could not be read.');
    await clearFault();
    await language(page).selectOption('zh-CN');
    await expect(page.locator('.locale-notice')).toHaveCount(0);
    await page.goto('/?localeFault=invalid');
    await expect(page.locator('.locale-notice')).toContainText('The saved language is invalid.');
    await language(page).selectOption('zh-CN');
    await expect(page.locator('.locale-notice')).toHaveCount(0);
    await page.goto('/?localeFault=write');
    await language(page).selectOption('zh-CN');
    await expect(page.locator('.locale-notice')).toContainText('语言无法保存到浏览器');
    await language(page).selectOption('en');
    await expect(page.locator('.locale-notice')).toContainText('The language could not be saved.');
    await clearFault();
    await page.getByRole('button', { name: 'Retry saving language', exact: true }).click();
    await expect(page.locator('.locale-notice')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('daynight.web.locale'))).toBe('en');

    const project = await createProject(request, { name: `Narrow 原始项目 ${randomUUID()}` });
    const task = await createTask(request, project.id, { title: 'Narrow 原始任务', description: '原始描述 Raw description\n'.repeat(100) });
    await createTask(request, project.id, { title: '后续 Raw successor', dependsOn: [task.id] });
    const seed = await request.put(attachmentDownloadUrl(project.id, task.id, '原始.txt'), { headers: { 'content-type': 'text/plain' }, data: '原始附件 Raw attachment\n' });
    expect(seed.status()).toBe(201);
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await expect(inspectTask(page, task.id)).toBeVisible();
    await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'));
    await expect(page.locator('.snapshot-time time')).toHaveAttribute('datetime', /^2030-/);
    await withDependencyFailure(async () => {
      const failed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1/projects/${project.id}/task-sync`);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      const response = await failed;
      expect(response.status()).toBe(500);
      const body = await response.json() as { error: { requestId: string } };
      const alert = page.locator('.snapshot-error');
      await expect(alert).toContainText('Refresh failed');
      await expect(alert).toContainText(body.error.requestId);
      await language(page).selectOption('zh-CN');
      await expect(alert).toContainText('刷新失败');
      await expect(alert).toContainText(body.error.requestId);
      await expect(alert).not.toContainText('task_dependencies');
      await info.attach('language-error-request', { body: Buffer.from(JSON.stringify({ projectId: project.id, requestId: body.error.requestId })), contentType: 'application/json' });
    });
    await page.getByRole('button', { name: '重试刷新', exact: true }).click();
    await expect(page.locator('.snapshot-error')).toHaveCount(0);
    await page.clock.resume();
    for (const locale of ['en', 'zh-CN'] as const) {
      await language(page).selectOption(locale);
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await expectPageWidth(page);
        const fullscreenToggle = page.locator('.graph-fullscreen-toggle');
        await expect(fullscreenToggle).toBeVisible();
        const selected = await inspectTask(page, task.id).getAttribute('aria-pressed');
        await fullscreenToggle.click();
        const fullscreen = page.locator('.task-graph-fullscreen');
        await page.evaluate(() => {
          (window as unknown as { localeStorageFault: { value: string | null } }).localeStorageFault.value = 'write';
        });
        await language(fullscreen).selectOption(locale);
        const notice = fullscreen.locator('.locale-notice');
        await expect(notice).toContainText(locale === 'en' ? 'The language could not be saved.' : '语言无法保存到浏览器');
        const controls = fullscreen.locator('.react-flow__controls');
        const noticeBounds = await notice.boundingBox();
        const controlsBounds = await controls.boundingBox();
        if (noticeBounds === null || controlsBounds === null) throw new Error('Fullscreen language notice or viewport controls are absent.');
        expect(noticeBounds.x + noticeBounds.width <= controlsBounds.x
          || controlsBounds.x + controlsBounds.width <= noticeBounds.x
          || noticeBounds.y + noticeBounds.height <= controlsBounds.y
          || controlsBounds.y + controlsBounds.height <= noticeBounds.y).toBe(true);
        const viewport = fullscreen.locator('.react-flow__viewport');
        const zoom = () => viewport.evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
        const initialZoom = await zoom();
        await fullscreen.getByRole('button', { name: locale === 'en' ? 'Zoom in' : '放大', exact: true }).click();
        await expect.poll(zoom).toBeGreaterThan(initialZoom);
        for (let step = 0; step < 2; step++) {
          const previousZoom = await zoom();
          await fullscreen.getByRole('button', { name: locale === 'en' ? 'Zoom out' : '缩小', exact: true }).click();
          await expect.poll(zoom).toBeLessThan(previousZoom);
        }
        const beforeFit = await viewport.getAttribute('style');
        await fullscreen.getByRole('button', { name: locale === 'en' ? 'Fit to canvas' : '适应画布', exact: true }).click();
        await expect(viewport).not.toHaveAttribute('style', beforeFit!);
        const fitted = await viewport.getAttribute('style');
        await expect(notice).toBeVisible();
        const retrySave = notice.getByRole('button', { name: locale === 'en' ? 'Retry saving language' : '重试保存语言', exact: true });
        await retrySave.click();
        await expect(notice).toBeVisible();
        await clearFault();
        await retrySave.click();
        await expect(notice).toHaveCount(0);
        expect(await page.evaluate(() => localStorage.getItem('daynight.web.locale'))).toBe(locale);
        await fullscreenToggle.focus();
        await expect(fullscreenToggle).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(fullscreen).toHaveCount(0);
        await expect(fullscreenToggle).toBeFocused();
        await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', fitted!);
        await expect(inspectTask(page, task.id)).toHaveAttribute('aria-pressed', selected!);
        await details(page, task.id).click();
        const dialog = page.locator('.task-detail-dialog');
        await expect(dialog.locator('.task-detail-title')).toHaveText(task.title);
        await expect(dialog.locator('.task-detail-header').getByRole('combobox')).toHaveCount(0);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const attachments = dialog.locator('.task-attachments');
        await dialog.getByRole('tab', { name: locale === 'en' ? 'Attachments' : '附件', exact: true }).click();
        await (await attachmentFileButton(attachments, '原始.txt')).click();
        await expect(attachments.locator('pre')).toHaveText('原始附件 Raw attachment\n');
        await expectDialogLayout(page, dialog);
        await expect(attachments.locator('input[type=text]')).toHaveAttribute('placeholder', locale === 'en' ? 'For example, docs/design.md' : '例如 docs/design.md');
        await screenshot(page, info, `language-layout-${locale}-${width}`);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(details(page, task.id)).toBeFocused();
      }
    }
  });
});
